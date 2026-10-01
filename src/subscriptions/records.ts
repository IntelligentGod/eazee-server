import { FieldPath, FieldValue, getFirestore, type DocumentSnapshot, type Query } from "firebase-admin/firestore";
import { getFirebaseAuth } from "../auth/firebase";
import type { AppleTransaction } from "./appleTransactions";
import { APPLE_PRODUCT_PLANS, getAppAccountTokenForUser, type ProPlanId } from "./entitlement";

/**
 * Subscription records in Firestore (documented in FIRESTORE.md). Only the
 * server writes them; Firestore rules deny every client write.
 *
 *   users/{uid}                              profile + current subscription
 *   users/{uid}/transactions/{transactionId} one per App Store transaction
 *   revenueDaily/{environment}_{YYYY-MM-DD}  totals for the income screen
 *   appleNotifications/{notificationUUID}    App Store notifications already handled
 */

export type SubscriptionState = "none" | "active" | "cancelled" | "billing_retry" | "expired" | "refunded";
export type TransactionKind = "purchase" | "renewal" | "upgrade" | "downgrade" | "crossgrade";
export type TransactionState = "active" | "cancelled" | "expired" | "upgraded" | "refunded";
export type TransactionSource = "app" | "apple_notification";

/** Higher ranks are upgrades; must match the subscription group levels (yearly is level 1, the top). */
export const PLAN_RANK: Record<ProPlanId, number> = { monthly: 1, yearly: 2 };

export type UserProfile = {
  email: string | null;
  displayName: string | null;
  providers: string[];
  authCreatedAt: number | null;
};

export type UserRecord = UserProfile & {
  uid: string;
  emailLower: string;
  appAccountToken: string;
  plan: "free" | ProPlanId;
  currentProductId: string | null;
  currentTransactionId: string | null;
  currentPurchaseDate: number | null;
  originalTransactionId: string | null;
  currentPriceMilli: number | null;
  currency: string | null;
  expiresAt: number | null;
  autoRenew: boolean | null;
  autoRenewSource: "device" | "apple" | null;
  pendingProductId: string | null;
  billingRetry: boolean;
  revokedAt: number | null;
  environment: string | null;
  createdAt: number;
  updatedAt: number;
};

export type TransactionRecord = {
  transactionId: string;
  originalTransactionId: string;
  uid: string;
  email: string | null;
  productId: string;
  planId: ProPlanId | null;
  priceMilli: number | null;
  currency: string | null;
  storefront: string | null;
  purchaseDate: number;
  originalPurchaseDate: number | null;
  expiresDate: number | null;
  revocationDate: number | null;
  type: TransactionKind;
  /** Only the states that time does not change; see transactionDisplayStatus. */
  status: "active" | "upgraded" | "refunded";
  autoRenew: boolean | null;
  isTrial: boolean;
  environment: string;
  source: TransactionSource;
  createdAt: number;
  updatedAt: number;
};

export type RevenueDay = {
  environment: string;
  day: string;
  count: number;
  refundCount: number;
  grossMilli: Record<string, number>;
  refundMilli: Record<string, number>;
  byProduct: Record<string, { productId: string; count: number; grossMilli: Record<string, number> }>;
};

export type RenewalUpdate = {
  autoRenew: boolean;
  pendingProductId: string | null;
  billingRetry?: boolean;
  source: "device" | "apple";
};

export const planForProduct = (productId: string | null | undefined): ProPlanId | null =>
  (productId && APPLE_PRODUCT_PLANS[productId]) || null;

export const utcDay = (epochMs: number) => new Date(epochMs).toISOString().slice(0, 10);

/** Firestore map keys must not contain dots, and product ids do. */
export const productKey = (productId: string) => productId.replace(/[^A-Za-z0-9]/g, "_");

export function newUserRecord(uid: string, profile: UserProfile, now: number): UserRecord {
  return {
    ...profile,
    uid,
    emailLower: (profile.email || "").trim().toLowerCase(),
    appAccountToken: getAppAccountTokenForUser(uid),
    plan: "free",
    currentProductId: null,
    currentTransactionId: null,
    currentPurchaseDate: null,
    originalTransactionId: null,
    currentPriceMilli: null,
    currency: null,
    expiresAt: null,
    autoRenew: null,
    autoRenewSource: null,
    pendingProductId: null,
    billingRetry: false,
    revokedAt: null,
    environment: null,
    createdAt: now,
    updatedAt: now,
  };
}

/** Fills fields missing from documents written before a field existed. */
export function readUserRecord(uid: string, data: Record<string, unknown> | undefined): UserRecord | null {
  if (!data) return null;
  const base = newUserRecord(uid, { email: null, displayName: null, providers: [], authCreatedAt: null }, 0);
  return { ...base, ...data, uid } as UserRecord;
}

export function deriveSubscriptionState(user: UserRecord, now: number): SubscriptionState {
  if (!user.currentProductId) return "none";
  if (user.revokedAt) return "refunded";
  if (!user.expiresAt || user.expiresAt <= now) return "expired";
  if (user.billingRetry) return "billing_retry";
  if (user.autoRenew === false) return "cancelled";
  return "active";
}

export function transactionDisplayStatus(record: TransactionRecord, now: number): TransactionState {
  if (record.status === "refunded" || record.revocationDate) return "refunded";
  if (record.status === "upgraded") return "upgraded";
  if (!record.expiresDate || record.expiresDate <= now) return "expired";
  if (record.autoRenew === false) return "cancelled";
  return "active";
}

/**
 * Purchase, renewal, or a plan change. A change is a transaction in the same
 * subscription for another product; comparing plan ranks tells which way.
 */
export function classifyTransaction(transaction: AppleTransaction, user: UserRecord | null): TransactionKind {
  const previousProductId = user?.currentProductId;
  const isNewest = !user?.currentPurchaseDate || (transaction.purchaseDate ?? 0) >= user.currentPurchaseDate;
  if (
    isNewest
    && previousProductId
    && previousProductId !== transaction.productId
    && user?.originalTransactionId === transaction.originalTransactionId
  ) {
    const from = PLAN_RANK[planForProduct(previousProductId) ?? "monthly"];
    const to = PLAN_RANK[planForProduct(transaction.productId) ?? "monthly"];
    return to > from ? "upgrade" : to < from ? "downgrade" : "crossgrade";
  }
  if (transaction.transactionReason === "RENEWAL") return "renewal";
  if (!transaction.transactionReason && transaction.transactionId !== transaction.originalTransactionId) return "renewal";
  return "purchase";
}

export type TransactionWrite = {
  user: UserRecord;
  record: TransactionRecord;
  created: boolean;
  /** A transaction this one replaced right away (an upgrade). */
  supersededTransactionId: string | null;
  revenue: Array<{ key: string; day: string; environment: string; grossMilli?: number; refundMilli?: number; currency: string; productId: string }>;
};

/**
 * Everything one verified transaction changes, computed without I/O so both
 * stores (and the tests) apply exactly the same rules. Replaying a transaction
 * is harmless: an existing record keeps its type and is never counted twice.
 */
export function computeTransactionWrite(input: {
  uid: string;
  user: UserRecord;
  existing: TransactionRecord | null;
  transaction: AppleTransaction;
  source: TransactionSource;
  now: number;
}): TransactionWrite {
  const { uid, existing, transaction: tx, source, now } = input;
  const user = { ...input.user };
  const purchaseDate = tx.purchaseDate ?? existing?.purchaseDate ?? now;
  const type = existing?.type ?? classifyTransaction(tx, user);
  const isNewest = !user.currentPurchaseDate || purchaseDate >= user.currentPurchaseDate
    || user.currentTransactionId === tx.transactionId;
  const environment = tx.environment || existing?.environment || "Production";
  const revoked = tx.revocationDate ?? existing?.revocationDate ?? null;

  const supersededTransactionId =
    !existing && type === "upgrade" && user.currentTransactionId && user.currentTransactionId !== tx.transactionId
      ? user.currentTransactionId
      : null;

  if (isNewest) {
    const startsNewPeriod = !existing;
    Object.assign(user, {
      plan: planForProduct(tx.productId) ?? user.plan,
      currentProductId: tx.productId,
      currentTransactionId: tx.transactionId,
      currentPurchaseDate: purchaseDate,
      originalTransactionId: tx.originalTransactionId,
      currentPriceMilli: tx.priceMilli ?? existing?.priceMilli ?? null,
      currency: tx.currency ?? existing?.currency ?? null,
      expiresAt: tx.expiresDate ?? null,
      revokedAt: revoked,
      environment,
      // A new period means the subscription renewed or was bought, so it was set to renew.
      autoRenew: startsNewPeriod ? true : user.autoRenew,
      pendingProductId: user.pendingProductId === tx.productId || startsNewPeriod ? null : user.pendingProductId,
      billingRetry: startsNewPeriod ? false : user.billingRetry,
    });
  }
  user.updatedAt = now;

  const record: TransactionRecord = {
    transactionId: tx.transactionId,
    originalTransactionId: tx.originalTransactionId,
    uid,
    email: user.email,
    productId: tx.productId,
    planId: planForProduct(tx.productId),
    priceMilli: tx.priceMilli ?? existing?.priceMilli ?? null,
    currency: tx.currency ?? existing?.currency ?? null,
    storefront: tx.storefront ?? existing?.storefront ?? null,
    purchaseDate,
    originalPurchaseDate: tx.originalPurchaseDate ?? existing?.originalPurchaseDate ?? null,
    expiresDate: tx.expiresDate ?? existing?.expiresDate ?? null,
    revocationDate: revoked,
    type,
    status: revoked ? "refunded" : tx.isUpgraded || existing?.status === "upgraded" ? "upgraded" : "active",
    autoRenew: isNewest ? user.autoRenew : existing?.autoRenew ?? null,
    isTrial: tx.offerType === 1 && (tx.offerDiscountType === "FREE_TRIAL" || tx.priceMilli === 0),
    environment,
    source: existing?.source ?? source,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  const revenue: TransactionWrite["revenue"] = [];
  const currency = record.currency || "XXX";
  if (!existing && record.priceMilli) {
    const day = utcDay(purchaseDate);
    revenue.push({ key: `${environment}_${day}`, day, environment, grossMilli: record.priceMilli, currency, productId: record.productId });
  }
  if (revoked && !existing?.revocationDate && record.priceMilli) {
    const day = utcDay(revoked);
    revenue.push({ key: `${environment}_${day}`, day, environment, refundMilli: record.priceMilli, currency, productId: record.productId });
  }

  return { user, record, created: !existing, supersededTransactionId, revenue };
}

export function applyRenewalUpdate(user: UserRecord, update: RenewalUpdate, now: number): UserRecord {
  return {
    ...user,
    autoRenew: update.autoRenew,
    autoRenewSource: update.source,
    pendingProductId: update.pendingProductId && update.pendingProductId !== user.currentProductId ? update.pendingProductId : null,
    billingRetry: update.billingRetry ?? user.billingRetry,
    updatedAt: now,
  };
}

export type TransactionQuery = {
  from?: number;
  to?: number;
  productId?: string;
  environment?: string;
  limit: number;
  /** `uid/transactionId` of the last item of the previous page. */
  cursor?: string;
};

export interface SubscriptionRecordsStore {
  getUser(uid: string): Promise<UserRecord | null>;
  /** Creates `users/{uid}` on first sight; refreshes the profile fields when given. */
  ensureUser(uid: string, loadProfile: () => Promise<UserProfile>): Promise<UserRecord>;
  saveTransaction(input: { uid: string; transaction: AppleTransaction; source: TransactionSource; now: number }): Promise<TransactionWrite>;
  updateRenewal(uid: string, update: RenewalUpdate, now: number): Promise<UserRecord | null>;
  listUserTransactions(uid: string, options: { limit: number; cursor?: string }): Promise<TransactionRecord[]>;
  findUid(match: { appAccountToken?: string; originalTransactionId?: string }): Promise<string | null>;
  /** True the first time a notification id is seen. */
  claimNotification(notificationUUID: string, meta: Record<string, unknown>): Promise<boolean>;
  listUsers(options: { search?: string; limit: number; cursor?: string }): Promise<UserRecord[]>;
  listTransactions(query: TransactionQuery): Promise<TransactionRecord[]>;
  listRevenueDays(options: { environment: string; from: string; to: string }): Promise<RevenueDay[]>;
  /** Users whose subscription period has not ended. */
  listSubscribedUsers(now: number): Promise<UserRecord[]>;
}

const emptyRevenueDay = (environment: string, day: string): RevenueDay => ({
  environment, day, count: 0, refundCount: 0, grossMilli: {}, refundMilli: {}, byProduct: {},
});

function addRevenue(day: RevenueDay, entry: TransactionWrite["revenue"][number]) {
  const product = (day.byProduct[productKey(entry.productId)] ??= { productId: entry.productId, count: 0, grossMilli: {} });
  if (entry.grossMilli) {
    day.count += 1;
    day.grossMilli[entry.currency] = (day.grossMilli[entry.currency] || 0) + entry.grossMilli;
    product.count += 1;
    product.grossMilli[entry.currency] = (product.grossMilli[entry.currency] || 0) + entry.grossMilli;
  }
  if (entry.refundMilli) {
    day.refundCount += 1;
    day.refundMilli[entry.currency] = (day.refundMilli[entry.currency] || 0) + entry.refundMilli;
  }
}

const matchesSearch = (user: UserRecord, search?: string) => {
  const term = (search || "").trim().toLowerCase();
  return !term || user.emailLower.startsWith(term) || user.uid === search?.trim();
};

/** For tests and local runs without Firestore. */
export function createMemorySubscriptionRecordsStore(): SubscriptionRecordsStore & { revenue: Map<string, RevenueDay> } {
  const users = new Map<string, UserRecord>();
  const transactions = new Map<string, TransactionRecord>();
  const revenue = new Map<string, RevenueDay>();
  const notifications = new Set<string>();
  const txKey = (uid: string, transactionId: string) => `${uid}/${transactionId}`;

  const page = <T>(items: T[], key: (item: T) => string, limit: number, cursor?: string) => {
    const start = cursor ? items.findIndex((item) => key(item) === cursor) + 1 : 0;
    return items.slice(start, start + limit);
  };

  return {
    revenue,
    async getUser(uid) {
      return users.get(uid) ?? null;
    },
    async ensureUser(uid, loadProfile) {
      const existing = users.get(uid);
      if (existing) return existing;
      const user = newUserRecord(uid, await loadProfile(), Date.now());
      users.set(uid, user);
      return user;
    },
    async saveTransaction({ uid, transaction, source, now }) {
      const user = users.get(uid) ?? newUserRecord(uid, { email: null, displayName: null, providers: [], authCreatedAt: null }, now);
      const write = computeTransactionWrite({
        uid, user, existing: transactions.get(txKey(uid, transaction.transactionId)) ?? null, transaction, source, now,
      });
      users.set(uid, write.user);
      transactions.set(txKey(uid, write.record.transactionId), write.record);
      if (write.supersededTransactionId) {
        const superseded = transactions.get(txKey(uid, write.supersededTransactionId));
        if (superseded) transactions.set(txKey(uid, superseded.transactionId), { ...superseded, status: "upgraded", updatedAt: now });
      }
      for (const entry of write.revenue) {
        const day = revenue.get(entry.key) ?? emptyRevenueDay(entry.environment, entry.day);
        addRevenue(day, entry);
        revenue.set(entry.key, day);
      }
      return write;
    },
    async updateRenewal(uid, update, now) {
      const user = users.get(uid);
      if (!user) return null;
      const next = applyRenewalUpdate(user, update, now);
      users.set(uid, next);
      const current = next.currentTransactionId && transactions.get(txKey(uid, next.currentTransactionId));
      if (current) transactions.set(txKey(uid, current.transactionId), { ...current, autoRenew: next.autoRenew, updatedAt: now });
      return next;
    },
    async listUserTransactions(uid, { limit, cursor }) {
      const items = [...transactions.values()].filter((t) => t.uid === uid).sort((a, b) => b.purchaseDate - a.purchaseDate);
      return page(items, (t) => t.transactionId, limit, cursor);
    },
    async findUid({ appAccountToken, originalTransactionId }) {
      for (const user of users.values()) {
        if (appAccountToken && user.appAccountToken === appAccountToken) return user.uid;
      }
      for (const user of users.values()) {
        if (originalTransactionId && user.originalTransactionId === originalTransactionId) return user.uid;
      }
      return null;
    },
    async claimNotification(notificationUUID) {
      if (notifications.has(notificationUUID)) return false;
      notifications.add(notificationUUID);
      return true;
    },
    async listUsers({ search, limit, cursor }) {
      const items = [...users.values()].filter((user) => matchesSearch(user, search))
        .sort((a, b) => a.emailLower.localeCompare(b.emailLower) || a.uid.localeCompare(b.uid));
      return page(items, (user) => user.uid, limit, cursor);
    },
    async listTransactions({ from, to, productId, environment, limit, cursor }) {
      const items = [...transactions.values()]
        .filter((t) => (from === undefined || t.purchaseDate >= from) && (to === undefined || t.purchaseDate <= to))
        .filter((t) => (!productId || t.productId === productId) && (!environment || t.environment === environment))
        .sort((a, b) => b.purchaseDate - a.purchaseDate);
      return page(items, (t) => txKey(t.uid, t.transactionId), limit, cursor);
    },
    async listRevenueDays({ environment, from, to }) {
      return [...revenue.values()]
        .filter((day) => day.environment === environment && day.day >= from && day.day <= to)
        .sort((a, b) => a.day.localeCompare(b.day));
    },
    async listSubscribedUsers(now) {
      return [...users.values()].filter((user) => (user.expiresAt ?? 0) > now);
    },
  };
}

/** Revenue increments as a merge, so concurrent writes to one day add up. */
function revenueMerge(entry: TransactionWrite["revenue"][number]) {
  const product = productKey(entry.productId);
  const data: Record<string, unknown> = { environment: entry.environment, day: entry.day };
  if (entry.grossMilli) {
    data.count = FieldValue.increment(1);
    data.grossMilli = { [entry.currency]: FieldValue.increment(entry.grossMilli) };
    data.byProduct = {
      [product]: {
        productId: entry.productId,
        count: FieldValue.increment(1),
        grossMilli: { [entry.currency]: FieldValue.increment(entry.grossMilli) },
      },
    };
  }
  if (entry.refundMilli) {
    data.refundCount = FieldValue.increment(1);
    data.refundMilli = { [entry.currency]: FieldValue.increment(entry.refundMilli) };
  }
  return data;
}

const readRevenueDay = (data: Record<string, any>): RevenueDay => ({
  ...emptyRevenueDay(String(data.environment || ""), String(data.day || "")),
  count: Number(data.count) || 0,
  refundCount: Number(data.refundCount) || 0,
  grossMilli: data.grossMilli || {},
  refundMilli: data.refundMilli || {},
  byProduct: data.byProduct || {},
});

export function createFirestoreSubscriptionRecordsStore(): SubscriptionRecordsStore {
  getFirebaseAuth(); // initializes the shared firebase-admin app
  const db = getFirestore();
  const usersRef = db.collection("users");
  const userRef = (uid: string) => usersRef.doc(uid);
  const txRef = (uid: string, transactionId: string) => userRef(uid).collection("transactions").doc(transactionId);

  const startAfterDoc = async (query: Query, path: string | undefined) => {
    if (!path) return query;
    const snapshot: DocumentSnapshot = await db.doc(path).get();
    return snapshot.exists ? query.startAfter(snapshot) : query;
  };

  return {
    async getUser(uid) {
      return readUserRecord(uid, (await userRef(uid).get()).data());
    },
    async ensureUser(uid, loadProfile) {
      const existing = readUserRecord(uid, (await userRef(uid).get()).data());
      if (existing) return existing;
      const user = newUserRecord(uid, await loadProfile(), Date.now());
      // create() fails if another request created it first; that copy is just as good.
      await userRef(uid).create(user).catch(async () => undefined);
      return readUserRecord(uid, (await userRef(uid).get()).data()) ?? user;
    },
    async saveTransaction({ uid, transaction, source, now }) {
      return db.runTransaction(async (t) => {
        const [userSnap, txSnap] = await Promise.all([t.get(userRef(uid)), t.get(txRef(uid, transaction.transactionId))]);
        const user = readUserRecord(uid, userSnap.data())
          ?? newUserRecord(uid, { email: null, displayName: null, providers: [], authCreatedAt: null }, now);
        const write = computeTransactionWrite({
          uid, user, existing: (txSnap.data() as TransactionRecord | undefined) ?? null, transaction, source, now,
        });
        t.set(userRef(uid), write.user);
        t.set(txRef(uid, write.record.transactionId), write.record);
        if (write.supersededTransactionId) {
          t.set(txRef(uid, write.supersededTransactionId), { status: "upgraded", updatedAt: now }, { merge: true });
        }
        for (const entry of write.revenue) {
          t.set(db.collection("revenueDaily").doc(entry.key), revenueMerge(entry), { merge: true });
        }
        return write;
      });
    },
    async updateRenewal(uid, update, now) {
      return db.runTransaction(async (t) => {
        const user = readUserRecord(uid, (await t.get(userRef(uid))).data());
        if (!user) return null;
        const next = applyRenewalUpdate(user, update, now);
        t.set(userRef(uid), next);
        if (next.currentTransactionId) {
          t.set(txRef(uid, next.currentTransactionId), { autoRenew: next.autoRenew, updatedAt: now }, { merge: true });
        }
        return next;
      });
    },
    async listUserTransactions(uid, { limit, cursor }) {
      let query: Query = userRef(uid).collection("transactions").orderBy("purchaseDate", "desc");
      query = await startAfterDoc(query, cursor ? txRef(uid, cursor).path : undefined);
      return (await query.limit(limit).get()).docs.map((doc) => doc.data() as TransactionRecord);
    },
    async findUid({ appAccountToken, originalTransactionId }) {
      if (appAccountToken) {
        const byToken = await usersRef.where("appAccountToken", "==", appAccountToken).limit(1).get();
        if (!byToken.empty) return byToken.docs[0].id;
      }
      if (originalTransactionId) {
        const byOriginal = await usersRef.where("originalTransactionId", "==", originalTransactionId).limit(1).get();
        if (!byOriginal.empty) return byOriginal.docs[0].id;
      }
      return null;
    },
    async claimNotification(notificationUUID, meta) {
      try {
        await db.collection("appleNotifications").doc(notificationUUID).create({ ...meta, receivedAt: Date.now() });
        return true;
      } catch (error: any) {
        if (error?.code === 6 /* ALREADY_EXISTS */) return false;
        throw error;
      }
    },
    async listUsers({ search, limit, cursor }) {
      const term = (search || "").trim();
      const results: UserRecord[] = [];
      // A search that is exactly a uid finds that user first.
      if (term && !cursor && /^[A-Za-z0-9_-]{10,128}$/.test(term)) {
        const byUid = readUserRecord(term, (await userRef(term).get()).data());
        if (byUid) results.push(byUid);
      }
      let query: Query = usersRef.orderBy("emailLower").orderBy(FieldPath.documentId());
      if (term) {
        const lower = term.toLowerCase();
        query = usersRef.where("emailLower", ">=", lower).where("emailLower", "<", `${lower}`)
          .orderBy("emailLower").orderBy(FieldPath.documentId());
      }
      query = await startAfterDoc(query, cursor ? userRef(cursor).path : undefined);
      const snapshot = await query.limit(limit).get();
      for (const doc of snapshot.docs) {
        if (!results.some((user) => user.uid === doc.id)) results.push(readUserRecord(doc.id, doc.data())!);
      }
      return results.slice(0, limit);
    },
    async listTransactions({ from, to, productId, environment, limit, cursor }) {
      let query: Query = db.collectionGroup("transactions");
      if (environment) query = query.where("environment", "==", environment);
      if (productId) query = query.where("productId", "==", productId);
      if (from !== undefined) query = query.where("purchaseDate", ">=", from);
      if (to !== undefined) query = query.where("purchaseDate", "<=", to);
      query = query.orderBy("purchaseDate", "desc");
      if (cursor) {
        const [uid, transactionId] = cursor.split("/");
        if (uid && transactionId) query = await startAfterDoc(query, txRef(uid, transactionId).path);
      }
      return (await query.limit(limit).get()).docs.map((doc) => doc.data() as TransactionRecord);
    },
    async listRevenueDays({ environment, from, to }) {
      const snapshot = await db.collection("revenueDaily")
        .where(FieldPath.documentId(), ">=", `${environment}_${from}`)
        .where(FieldPath.documentId(), "<=", `${environment}_${to}`)
        .get();
      return snapshot.docs.map((doc) => readRevenueDay(doc.data()));
    },
    async listSubscribedUsers(now) {
      const snapshot = await usersRef.where("expiresAt", ">", now).get();
      return snapshot.docs.map((doc) => readUserRecord(doc.id, doc.data())!);
    },
  };
}
