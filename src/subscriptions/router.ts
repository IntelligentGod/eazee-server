import express, { type Request, type Response } from "express";
import { z } from "zod";
import {
  isFirebaseAuthenticationError,
  verifyFirebaseRequest,
  getFirebaseAuth,
  type AuthenticatedUser,
} from "../auth/firebase";
import {
  AppleTransactionVerificationError,
  toRenewalInfo,
  toTransaction,
  verifyAppleJws,
  verifyAppleSignedTransaction,
  type AppleTransaction,
} from "./appleTransactions";
import {
  PRO_CLAIM_KEY,
  decideEntitlement,
  getAppAccountTokenForUser,
  hasProAccess,
  type EntitlementDecision,
  type ProEntitlementClaim,
} from "./entitlement";
import {
  deriveSubscriptionState,
  hasProEntitlement,
  transactionDisplayStatus,
  type SubscriptionRecordsStore,
  type TransactionRecord,
  type UserProfile,
  type UserRecord,
} from "./records";
import { getPlanLimits, type SubscriptionConfigProvider } from "../usage/limitsConfig";
import { migrateLegacyClaims } from "../auth/roles";
import { EMPTY_USAGE, getUsageDay, type UsageStore } from "../usage/usageStore";

const RenewalSchema = z.object({
  productId: z.string().min(1).max(200),
  willAutoRenew: z.boolean(),
  pendingProductId: z.string().min(1).max(200).nullable().optional(),
  isInBillingRetry: z.boolean().optional(),
});

/**
 * Renewal info comes from the device unsigned, so it only ever changes what is
 * shown (auto-renew on or off, a plan change due at renewal), never whether the
 * account has Pro. App Store notifications overwrite it with signed data.
 */
const VerifyBodySchema = z.object({
  signedTransaction: z.string().min(1).max(20_000),
  renewal: RenewalSchema.optional(),
});
const SyncBodySchema = z.object({
  signedTransactions: z.array(z.string().min(1).max(20_000)).min(1).max(25),
  renewal: RenewalSchema.optional(),
});
const HistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(200).optional(),
});
const NotificationBodySchema = z.object({ signedPayload: z.string().min(1).max(100_000) });

type SubscriptionsRouterOptions = {
  bundleId: string;
  allowXcodeTransactions: boolean;
  unlimitedEmails: string[];
  records: SubscriptionRecordsStore;
  config: SubscriptionConfigProvider;
  usage: UsageStore;
  verifyRequest?: (req: Request) => Promise<AuthenticatedUser | null>;
  verifyTransaction?: (signedTransaction: string) => Promise<AppleTransaction>;
  /** Writes or clears the Pro claim, keeping the user's other custom claims. */
  setProClaim?: (uid: string, claim: ProEntitlementClaim | null) => Promise<void>;
  loadProfile?: (uid: string, user?: AuthenticatedUser) => Promise<UserProfile>;
  now?: () => number;
};

async function setProClaimInFirebase(uid: string, claim: ProEntitlementClaim | null) {
  const auth = getFirebaseAuth();
  const { customClaims = {} } = await auth.getUser(uid);
  const { [PRO_CLAIM_KEY]: _previous, ...otherClaims } = customClaims;
  await auth.setCustomUserClaims(uid, claim ? { ...otherClaims, [PRO_CLAIM_KEY]: claim } : otherClaims);
}

/** Profile fields for `users/{uid}`, from Firebase Auth. */
export async function loadProfileFromFirebase(uid: string): Promise<UserProfile> {
  const record = await getFirebaseAuth().getUser(uid);
  const created = Date.parse(record.metadata.creationTime);
  return {
    email: record.email ?? null,
    displayName: record.displayName ?? null,
    providers: record.providerData.map((provider) => provider.providerId),
    authCreatedAt: Number.isFinite(created) ? created : null,
    role: migrateLegacyClaims(record.customClaims),
  };
}

/**
 * The claim follows the stored subscription, so an old transaction replayed later
 * cannot switch Pro off. A cancelled subscription has no claim (see hasProEntitlement).
 */
export function claimForUser(user: UserRecord, now: number): ProEntitlementClaim | null {
  if (!hasProEntitlement(deriveSubscriptionState(user, now))) return null;
  if (user.plan === "free" || !user.expiresAt || !user.originalTransactionId) return null;
  return { plan: user.plan, expiresAt: user.expiresAt, originalTransactionId: user.originalTransactionId };
}

export function summarizeSubscription(user: UserRecord | null, options: { now: number; unlimited: boolean }) {
  const state = user ? deriveSubscriptionState(user, options.now) : "none";
  const entitled = hasProEntitlement(state);
  return {
    isPro: entitled || options.unlimited,
    isUnlimitedAccount: options.unlimited,
    plan: user && user.plan !== "free" ? user.plan : null,
    state,
    productId: user?.currentProductId ?? null,
    expiresAt: user?.expiresAt ?? null,
    autoRenew: user?.autoRenew ?? null,
    pendingProductId: user?.pendingProductId ?? null,
    environment: user?.environment ?? null,
  };
}

export const presentTransaction = (record: TransactionRecord, now: number) => ({
  transactionId: record.transactionId,
  originalTransactionId: record.originalTransactionId,
  uid: record.uid,
  email: record.email,
  productId: record.productId,
  planId: record.planId,
  price: record.priceMilli === null ? null : record.priceMilli / 1000,
  currency: record.currency,
  purchaseDate: record.purchaseDate,
  expiresDate: record.expiresDate,
  revocationDate: record.revocationDate,
  type: record.type,
  status: transactionDisplayStatus(record, now),
  isTrial: record.isTrial,
  environment: record.environment,
  source: record.source,
});

/**
 * App Store subscription endpoints. The app sends each StoreKit transaction here;
 * only a transaction verified against Apple's signing chain, for this app, and
 * bought by this Eazee account turns Pro on for the account. Every verified
 * transaction is also recorded in Firestore for purchase history and the admin panel.
 */
export function createSubscriptionsRouter(options: SubscriptionsRouterOptions) {
  const verifyRequest = options.verifyRequest ?? ((req: Request) => verifyFirebaseRequest(req, { checkRevoked: true }));
  const verifyTransaction = options.verifyTransaction
    ?? ((signedTransaction: string) =>
      verifyAppleSignedTransaction(signedTransaction, { allowXcodeEnvironment: options.allowXcodeTransactions }));
  const setProClaim = options.setProClaim ?? setProClaimInFirebase;
  const loadProfile = options.loadProfile ?? loadProfileFromFirebase;
  const now = options.now ?? Date.now;
  const router = express.Router();

  const authenticate = async (req: Request, res: Response) => {
    try {
      const user = await verifyRequest(req);
      if (!user) res.status(401).json({ error: "Authentication required" });
      return user;
    } catch (error) {
      if (isFirebaseAuthenticationError(error)) {
        res.status(401).json({ error: "Authentication required" });
      } else {
        console.error("[subscriptions] auth failed");
        res.status(500).json({ error: "Authentication unavailable" });
      }
      return null;
    }
  };

  // Staff (admin, super admin) and unlimited-access emails are Pro without a purchase.
  const isUnlimited = (user: AuthenticatedUser) =>
    hasProAccess({ email: user.email, role: user.role }, { unlimitedEmails: options.unlimitedEmails });

  const ensureUser = (user: AuthenticatedUser) => options.records.ensureUser(user.uid, () => loadProfile(user.uid, user));

  /**
   * Records each transaction that belongs to this account, applies the device's
   * renewal info, then sets the Pro claim from the stored subscription. If the
   * records cannot be written, the claim still follows Apple's answer, so a
   * Firestore outage never blocks a purchase.
   */
  async function applyTransactions(
    user: AuthenticatedUser,
    transactions: AppleTransaction[],
    renewal: z.infer<typeof RenewalSchema> | undefined
  ) {
    const at = now();
    const decisions = transactions.map((transaction) => ({
      transaction,
      decision: decideEntitlement(transaction, { uid: user.uid, bundleId: options.bundleId, now: at }),
    }));
    const owned = decisions.filter(({ decision }) => decision.status !== "rejected");

    let stored: UserRecord | null = null;
    try {
      await ensureUser(user);
      // Oldest first, so plan changes are classified against the plan they replaced.
      for (const { transaction } of [...owned].sort((a, b) => (a.transaction.purchaseDate ?? 0) - (b.transaction.purchaseDate ?? 0))) {
        stored = (await options.records.saveTransaction({ uid: user.uid, transaction, source: "app", now: at })).user;
      }
      stored ??= await options.records.getUser(user.uid);
      if (stored && renewal && (renewal.productId === stored.currentProductId || renewal.productId === stored.pendingProductId)) {
        stored = await options.records.updateRenewal(user.uid, {
          autoRenew: renewal.willAutoRenew,
          pendingProductId: renewal.pendingProductId ?? null,
          billingRetry: renewal.isInBillingRetry,
          source: "device",
        }, at);
      }
    } catch (error) {
      console.error("[subscriptions] could not record transactions", error);
      stored = null;
    }

    let claim: ProEntitlementClaim | null;
    if (stored) {
      claim = claimForUser(stored, at);
    } else {
      const active = owned
        .map(({ decision }) => decision)
        .filter((decision): decision is Extract<EntitlementDecision, { status: "active" }> => decision.status === "active")
        .sort((a, b) => b.claim.expiresAt - a.claim.expiresAt)[0];
      claim = active?.claim ?? null;
    }
    // Only this account's own transactions may change its claim; a subscriber from
    // before records existed keeps Pro until one of theirs is synced.
    if (owned.length > 0) {
      await setProClaim(user.uid, claim);
    }
    return { claim, stored, owned, rejected: decisions.filter(({ decision }) => decision.status === "rejected") };
  }

  const respondWithSubscription = (res: Response, user: AuthenticatedUser, result: Awaited<ReturnType<typeof applyTransactions>>) => {
    const at = now();
    const state = result.stored ? deriveSubscriptionState(result.stored, at) : "none";
    const reason = result.claim ? undefined : state === "refunded" ? "revoked" : "expired";
    return res.json({
      isPro: !!result.claim,
      planId: result.claim?.plan ?? null,
      ...(result.claim ? { expiresAt: result.claim.expiresAt } : { reason }),
      subscription: summarizeSubscription(result.stored, { now: at, unlimited: isUnlimited(user) }),
    });
  };

  const verifyAll = async (res: Response, signedTransactions: string[]) => {
    try {
      return await Promise.all(signedTransactions.map((jws) => verifyTransaction(jws)));
    } catch (error) {
      if (error instanceof AppleTransactionVerificationError) {
        res.status(400).json({ error: "Transaction could not be verified", reason: error.message });
      } else {
        console.error("[subscriptions] verification failed", error);
        res.status(500).json({ error: "Verification unavailable" });
      }
      return null;
    }
  };

  // The app passes this to StoreKit as appAccountToken when purchasing.
  router.get("/apple/account-token", async (req, res) => {
    const user = await authenticate(req, res);
    if (!user) return;
    res.json({ appAccountToken: getAppAccountTokenForUser(user.uid) });
  });

  router.post("/apple/verify", async (req, res) => {
    const user = await authenticate(req, res);
    if (!user) return;

    const body = VerifyBodySchema.safeParse(req.body);
    if (!body.success) {
      return res.status(400).json({ error: "signedTransaction is required" });
    }

    const transactions = await verifyAll(res, [body.data.signedTransaction]);
    if (!transactions) return;

    const decision = decideEntitlement(transactions[0], { uid: user.uid, bundleId: options.bundleId, now: now() });
    if (decision.status === "rejected") {
      // Never clear the claim here: a mismatched transaction says nothing about this account's own subscription.
      return res.status(403).json({ error: "Transaction does not belong to this account", reason: decision.reason });
    }

    try {
      return respondWithSubscription(res, user, await applyTransactions(user, transactions, body.data.renewal));
    } catch (error) {
      console.error("[subscriptions] could not save entitlement", error);
      return res.status(500).json({ error: "Could not save subscription" });
    }
  });

  /**
   * The device's current entitlement and recent transactions, sent at launch and
   * after the manage-subscriptions sheet closes. Transactions bought by another
   * Eazee account on the same Apple ID are skipped, not refused.
   */
  router.post("/apple/sync", async (req, res) => {
    const user = await authenticate(req, res);
    if (!user) return;

    const body = SyncBodySchema.safeParse(req.body);
    if (!body.success) {
      return res.status(400).json({ error: "signedTransactions must list 1 to 25 transactions" });
    }

    const transactions = await verifyAll(res, body.data.signedTransactions);
    if (!transactions) return;

    try {
      const result = await applyTransactions(user, transactions, body.data.renewal);
      if (result.owned.length === 0 && result.rejected.length > 0) {
        return res.status(403).json({ error: "Transaction does not belong to this account", reason: (result.rejected[0].decision as any).reason });
      }
      return respondWithSubscription(res, user, result);
    } catch (error) {
      console.error("[subscriptions] could not sync", error);
      return res.status(500).json({ error: "Could not save subscription" });
    }
  });

  /** Plan, limits, today's usage and product display settings, for the paywall and limits UI. */
  router.get("/status", async (req, res) => {
    const user = await authenticate(req, res);
    if (!user) return;
    try {
      const at = now();
      const [stored, config] = await Promise.all([ensureUser(user), options.config.get()]);
      const subscription = summarizeSubscription(stored, { now: at, unlimited: isUnlimited(user) });
      const usage = await options.usage.get(user.uid, getUsageDay(req.header("x-eazee-timezone") || undefined))
        .catch(() => EMPTY_USAGE);
      return res.json({
        subscription,
        limits: config.limits,
        planLimits: getPlanLimits(config, subscription.isPro),
        usage,
        products: config.products,
      });
    } catch (error) {
      console.error("[subscriptions] status failed", error);
      return res.status(500).json({ error: "Could not load subscription" });
    }
  });

  router.get("/history", async (req, res) => {
    const user = await authenticate(req, res);
    if (!user) return;
    const query = HistoryQuerySchema.safeParse(req.query);
    if (!query.success) return res.status(400).json({ error: "Invalid history query" });
    try {
      const records = await options.records.listUserTransactions(user.uid, query.data);
      const at = now();
      return res.json({
        transactions: records.map((record) => presentTransaction(record, at)),
        nextCursor: records.length === query.data.limit ? records[records.length - 1].transactionId : null,
      });
    } catch (error) {
      console.error("[subscriptions] history failed", error);
      return res.status(500).json({ error: "Could not load purchase history" });
    }
  });

  return router;
}

type NotificationsOptions = {
  bundleId: string;
  records: SubscriptionRecordsStore;
  verifyJws?: (jws: string) => Promise<Record<string, unknown>>;
  setProClaim?: (uid: string, claim: ProEntitlementClaim | null) => Promise<void>;
  now?: () => number;
};

/**
 * App Store Server Notifications V2 (set this URL in App Store Connect). Apple
 * calls it without a Firebase token, so it is authenticated by verifying the
 * signed payload against Apple's root certificate instead, and it is mounted
 * outside App Check. Handling is idempotent: Apple retries until it gets a 200.
 */
export function createAppleNotificationsHandler(options: NotificationsOptions) {
  const verifyJws = options.verifyJws ?? ((jws: string) => verifyAppleJws(jws));
  const setProClaim = options.setProClaim ?? setProClaimInFirebase;
  const now = options.now ?? Date.now;

  return async (req: Request, res: Response) => {
    const body = NotificationBodySchema.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: "signedPayload is required" });

    let payload: Record<string, any>;
    let transaction: AppleTransaction | null = null;
    let renewal: ReturnType<typeof toRenewalInfo> | null = null;
    try {
      payload = await verifyJws(body.data.signedPayload);
      const data = (payload.data || {}) as Record<string, unknown>;
      if (typeof data.signedTransactionInfo === "string") {
        transaction = toTransaction(await verifyJws(data.signedTransactionInfo));
      }
      if (typeof data.signedRenewalInfo === "string") {
        renewal = toRenewalInfo(await verifyJws(data.signedRenewalInfo));
      }
    } catch (error) {
      console.warn("[apple-notifications] rejected payload", error instanceof Error ? error.message : error);
      return res.status(400).json({ error: "Notification could not be verified" });
    }

    const notificationType = String(payload.notificationType || "");
    const notificationUUID = String(payload.notificationUUID || "");
    const bundleId = (payload.data as any)?.bundleId;
    if (bundleId && bundleId !== options.bundleId) {
      return res.json({ ok: true, ignored: "wrong_app" });
    }
    if (!transaction) {
      return res.json({ ok: true, ignored: "no_transaction", notificationType });
    }

    try {
      const uid = await options.records.findUid({
        appAccountToken: transaction.appAccountToken,
        originalTransactionId: transaction.originalTransactionId,
      });
      if (!uid || (transaction.appAccountToken && transaction.appAccountToken !== getAppAccountTokenForUser(uid))) {
        console.warn(`[apple-notifications] no account for ${notificationType}`);
        return res.json({ ok: true, ignored: "unknown_account" });
      }

      const at = now();
      let user = (await options.records.saveTransaction({ uid, transaction, source: "apple_notification", now: at })).user;
      if (renewal && renewal.originalTransactionId === user.originalTransactionId) {
        user = (await options.records.updateRenewal(uid, {
          autoRenew: renewal.autoRenewStatus === 1,
          pendingProductId: renewal.autoRenewProductId ?? null,
          billingRetry: renewal.isInBillingRetryPeriod === true,
          source: "apple",
        }, at)) ?? user;
      }
      await setProClaim(uid, claimForUser(user, at));
      if (notificationUUID) {
        await options.records.claimNotification(notificationUUID, {
          notificationType,
          subtype: payload.subtype ?? null,
          uid,
          transactionId: transaction.transactionId,
        });
      }
      return res.json({ ok: true });
    } catch (error) {
      console.error("[apple-notifications] could not apply", error);
      return res.status(500).json({ error: "Could not apply notification" });
    }
  };
}
