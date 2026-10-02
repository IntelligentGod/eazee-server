import express, { type Request, type RequestHandler } from "express";
import { z } from "zod";
import {
  getFirebaseAuth,
  isFirebaseAuthenticationError,
  verifyFirebaseRequest,
  type AuthenticatedUser,
} from "../auth/firebase";
import {
  deriveSubscriptionState,
  hasProEntitlement,
  transactionDisplayStatus,
  utcDay,
  type RevenueDay,
  type SubscriptionRecordsStore,
  type TransactionState,
  type UserRecord,
} from "../subscriptions/records";
import { presentTransaction, summarizeSubscription } from "../subscriptions/router";
import {
  ProductDisplaySettingsSchema,
  SubscriptionLimitsSchema,
  type SubscriptionConfigProvider,
} from "../usage/limitsConfig";
import type { UsageStore } from "../usage/usageStore";
import { ASSIGNABLE_ROLES, isStaffRole, migrateLegacyClaims, type Role } from "../auth/roles";
import { RoleChangeError, changeUserRole, createFirebaseRoleAuth, type RoleAuth } from "./roleService";

type AdminRequest = Request & { admin?: AuthenticatedUser };

/**
 * Admin endpoints require the `role` custom claim `admin` or `superAdmin` on a
 * fresh, unrevoked ID token. Only this server sets that claim (the super admin
 * bootstrap and POST /admin/users/:uid/role), so no client can grant it to itself.
 */
export function createRequireAdminMiddleware(options: {
  verifyRequest?: (req: Request) => Promise<AuthenticatedUser | null>;
} = {}): RequestHandler {
  const verifyRequest = options.verifyRequest ?? ((req: Request) => verifyFirebaseRequest(req, { checkRevoked: true }));
  return async (req, res, next) => {
    if (req.method === "OPTIONS") return next();
    try {
      const user = await verifyRequest(req);
      if (!user) return res.status(401).json({ error: "Authentication required" });
      if (!isStaffRole(user.role ?? "customer")) {
        return res.status(403).json({ error: "Admin access required", code: "ADMIN_REQUIRED" });
      }
      (req as AdminRequest).admin = user;
      return next();
    } catch (error) {
      if (isFirebaseAuthenticationError(error)) return res.status(401).json({ error: "Authentication required" });
      console.error("[admin] auth failed");
      return res.status(500).json({ error: "Authentication unavailable" });
    }
  };
}

/** Role management: only a super admin, checked on top of the admin check. */
const requireSuperAdmin: RequestHandler = (req, res, next) =>
  (req as AdminRequest).admin?.role === "superAdmin"
    ? next()
    : res.status(403).json({ error: "Super admin access required", code: "SUPER_ADMIN_REQUIRED" });

const DaySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const EnvironmentSchema = z.enum(["Production", "Sandbox", "Xcode"]);
const StatusSchema = z.enum(["active", "cancelled", "expired", "upgraded", "refunded"]);

const UsersQuerySchema = z.object({
  search: z.string().trim().max(200).optional(),
  role: z.enum(ASSIGNABLE_ROLES).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(200).optional(),
});
const PurchasesQuerySchema = z.object({
  productId: z.string().min(1).max(200).optional(),
  status: StatusSchema.optional(),
  environment: EnvironmentSchema.optional(),
  from: DaySchema.optional(),
  to: DaySchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(300).optional(),
});
const IncomeQuerySchema = z.object({
  granularity: z.enum(["day", "month"]).default("day"),
  environment: EnvironmentSchema.default("Production"),
  from: DaySchema.optional(),
  to: DaySchema.optional(),
});

const RoleBodySchema = z.object({ role: z.enum(ASSIGNABLE_ROLES) });
const RoleChangesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(200).optional(),
});

const DAY_MS = 86_400_000;
const MAX_INCOME_DAYS = 400;
/** How many transactions one purchases request may read to fill a page filtered by status. */
const MAX_PURCHASES_SCANNED = 1000;

const toMajor = (milli: Record<string, number>) =>
  Object.fromEntries(Object.entries(milli).map(([currency, value]) => [currency, Math.round(value) / 1000]));

const addInto = (target: Record<string, number>, source: Record<string, number>, sign = 1) => {
  for (const [currency, value] of Object.entries(source)) target[currency] = (target[currency] || 0) + sign * value;
};

export type IncomeBucket = {
  period: string;
  count: number;
  refundCount: number;
  grossMilli: Record<string, number>;
  refundMilli: Record<string, number>;
  byProduct: Record<string, { count: number; grossMilli: Record<string, number> }>;
};

/**
 * Revenue per day or month from the server's own transaction records, plus
 * subscriber counts. "Estimated": real proceeds after Apple's commission and
 * taxes only come from App Store Connect reports. Amounts stay per currency.
 */
export function summarizeIncome(input: {
  days: RevenueDay[];
  subscribers: UserRecord[];
  granularity: "day" | "month";
  environment: string;
  now: number;
}) {
  const buckets = new Map<string, IncomeBucket>();
  const totals: IncomeBucket = { period: "total", count: 0, refundCount: 0, grossMilli: {}, refundMilli: {}, byProduct: {} };
  for (const day of input.days) {
    const period = input.granularity === "month" ? day.day.slice(0, 7) : day.day;
    const bucket = buckets.get(period) ?? { period, count: 0, refundCount: 0, grossMilli: {}, refundMilli: {}, byProduct: {} };
    for (const target of [bucket, totals]) {
      target.count += day.count;
      target.refundCount += day.refundCount;
      addInto(target.grossMilli, day.grossMilli);
      addInto(target.refundMilli, day.refundMilli);
      for (const product of Object.values(day.byProduct)) {
        const entry = (target.byProduct[product.productId] ??= { count: 0, grossMilli: {} });
        entry.count += product.count;
        addInto(entry.grossMilli, product.grossMilli);
      }
    }
    buckets.set(period, bucket);
  }

  const present = (bucket: IncomeBucket) => {
    const net: Record<string, number> = {};
    addInto(net, bucket.grossMilli);
    addInto(net, bucket.refundMilli, -1);
    return {
      period: bucket.period,
      count: bucket.count,
      refundCount: bucket.refundCount,
      gross: toMajor(bucket.grossMilli),
      refunds: toMajor(bucket.refundMilli),
      net: toMajor(net),
      byProduct: Object.fromEntries(Object.entries(bucket.byProduct).map(([productId, entry]) => [
        productId, { count: entry.count, gross: toMajor(entry.grossMilli) },
      ])),
    };
  };

  const subscribers = { active: 0, cancelled: 0, billingRetry: 0, trial: 0, byPlan: { monthly: 0, yearly: 0 } };
  const mrrMilli: Record<string, number> = {};
  for (const user of input.subscribers) {
    if ((user.environment || "Production") !== input.environment) continue;
    const state = deriveSubscriptionState(user, input.now);
    // Cancelled subscriptions no longer have Pro; they are counted but not as subscribers.
    if (state === "cancelled") subscribers.cancelled += 1;
    if (!hasProEntitlement(state)) continue;
    if (state === "active") subscribers.active += 1;
    if (state === "billing_retry") subscribers.billingRetry += 1;
    if (user.plan === "monthly" || user.plan === "yearly") subscribers.byPlan[user.plan] += 1;
    const isTrial = user.currentPriceMilli === 0;
    if (isTrial) subscribers.trial += 1;
    // MRR counts paying subscriptions that will renew: no trials, no cancelled ones.
    if (state === "active" && !isTrial && user.currentPriceMilli && user.currency) {
      const monthly = user.plan === "yearly" ? user.currentPriceMilli / 12 : user.currentPriceMilli;
      mrrMilli[user.currency] = (mrrMilli[user.currency] || 0) + monthly;
    }
  }

  return {
    estimated: true,
    note: "Estimated from Eazee's own transaction records, before Apple's commission and taxes. Real proceeds come from App Store Connect reports.",
    environment: input.environment,
    granularity: input.granularity,
    buckets: [...buckets.values()].sort((a, b) => a.period.localeCompare(b.period)).map(present),
    totals: present(totals),
    subscribers: { ...subscribers, mrr: toMajor(mrrMilli) },
  };
}

type AdminRouterOptions = {
  records: SubscriptionRecordsStore;
  config: SubscriptionConfigProvider;
  usage: UsageStore;
  unlimitedEmails: string[];
  verifyRequest?: (req: Request) => Promise<AuthenticatedUser | null>;
  /** Firebase Auth details for the user detail page. */
  getAuthUser?: (uid: string) => Promise<Record<string, unknown> | null>;
  roleAuth?: RoleAuth;
  now?: () => number;
};

async function getAuthUserFromFirebase(uid: string) {
  try {
    const record = await getFirebaseAuth().getUser(uid);
    return {
      uid: record.uid,
      email: record.email ?? null,
      displayName: record.displayName ?? null,
      emailVerified: record.emailVerified,
      disabled: record.disabled,
      providers: record.providerData.map((provider) => provider.providerId),
      createdAt: Date.parse(record.metadata.creationTime) || null,
      lastSignInAt: Date.parse(record.metadata.lastSignInTime) || null,
      role: migrateLegacyClaims(record.customClaims),
    };
  } catch (error: any) {
    if (error?.code === "auth/user-not-found") return null;
    throw error;
  }
}

export function createAdminRouter(options: AdminRouterOptions) {
  const router = express.Router();
  const now = options.now ?? Date.now;
  const getAuthUser = options.getAuthUser ?? getAuthUserFromFirebase;
  let roleAuth = options.roleAuth;
  const getRoleAuth = () => (roleAuth ??= createFirebaseRoleAuth());
  const isUnlimited = (email: string | null) =>
    !!email && options.unlimitedEmails.includes(email.trim().toLowerCase());

  router.use(createRequireAdminMiddleware({ verifyRequest: options.verifyRequest }));

  const presentUser = (user: UserRecord, at: number) => ({
    uid: user.uid,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    providers: user.providers,
    createdAt: user.authCreatedAt ?? user.createdAt,
    subscription: summarizeSubscription(user, { now: at, unlimited: isUnlimited(user.email) }),
  });

  const handle = (fn: RequestHandler): RequestHandler => async (req, res, next) => {
    try {
      await fn(req, res, next);
    } catch (error) {
      console.error(`[admin] ${req.method} ${req.path} failed`, error);
      if (!res.headersSent) res.status(500).json({ error: "Admin request failed" });
    }
  };

  router.get("/me", (req, res) => {
    const admin = (req as AdminRequest).admin!;
    res.json({ uid: admin.uid, email: admin.email ?? null, role: admin.role as Role });
  });

  router.get("/users", handle(async (req, res) => {
    const query = UsersQuerySchema.safeParse(req.query);
    if (!query.success) return void res.status(400).json({ error: "Invalid users query" });
    const users = await options.records.listUsers(query.data);
    const at = now();
    res.json({
      // The Super Admin is never listed: its role cannot be changed, and it is not managed here.
      users: users.filter((user) => user.role !== "superAdmin").map((user) => presentUser(user, at)),
      nextCursor: users.length === query.data.limit ? users[users.length - 1].uid : null,
    });
  }));

  router.get("/users/:uid", handle(async (req, res) => {
    const uid = z.string().min(1).max(128).safeParse(req.params.uid);
    if (!uid.success) return void res.status(400).json({ error: "Invalid uid" });
    const [authUser, user, transactions, usage] = await Promise.all([
      getAuthUser(uid.data),
      options.records.getUser(uid.data),
      options.records.listUserTransactions(uid.data, { limit: 100 }),
      options.usage.listRecent(uid.data, 14),
    ]);
    if (!authUser && !user) return void res.status(404).json({ error: "User not found" });
    const at = now();
    res.json({
      auth: authUser,
      user: user ? presentUser(user, at) : null,
      transactions: transactions.map((record) => presentTransaction(record, at)),
      usage,
    });
  }));

  router.post("/users/:uid/role", requireSuperAdmin, handle(async (req, res) => {
    const uid = z.string().min(1).max(128).safeParse(req.params.uid);
    const body = RoleBodySchema.safeParse(req.body);
    if (!uid.success || !body.success) {
      return void res.status(400).json({ error: "role must be customer or admin" });
    }
    const admin = (req as AdminRequest).admin!;
    try {
      const result = await changeUserRole({
        actor: { uid: admin.uid, email: admin.email },
        targetUid: uid.data,
        role: body.data.role,
        auth: getRoleAuth(),
        records: options.records,
        now: now(),
      });
      res.json(result);
    } catch (error) {
      if (error instanceof RoleChangeError) {
        return void res.status(error.status).json({ error: error.message, code: error.code });
      }
      throw error;
    }
  }));

  router.get("/role-changes", requireSuperAdmin, handle(async (req, res) => {
    const query = RoleChangesQuerySchema.safeParse(req.query);
    if (!query.success) return void res.status(400).json({ error: "Invalid query" });
    const changes = await options.records.listRoleChanges(query.data);
    res.json({ changes, nextCursor: changes.length === query.data.limit ? changes[changes.length - 1].id : null });
  }));

  router.get("/purchases", handle(async (req, res) => {
    const query = PurchasesQuerySchema.safeParse(req.query);
    if (!query.success) return void res.status(400).json({ error: "Invalid purchases query" });
    const { status, limit, from, to, ...filters } = query.data;
    const at = now();
    const page: ReturnType<typeof presentTransaction>[] = [];
    let cursor = filters.cursor;
    let scanned = 0;
    let exhausted = false;
    // Status depends on the current time, so it is filtered here rather than in the query.
    while (page.length < limit && scanned < MAX_PURCHASES_SCANNED) {
      const batch = await options.records.listTransactions({
        ...filters,
        from: from ? Date.parse(`${from}T00:00:00Z`) : undefined,
        to: to ? Date.parse(`${to}T00:00:00Z`) + DAY_MS - 1 : undefined,
        limit: status ? 100 : limit,
        cursor,
      });
      scanned += batch.length;
      for (const record of batch) {
        cursor = `${record.uid}/${record.transactionId}`;
        if (status && transactionDisplayStatus(record, at) !== (status as TransactionState)) continue;
        page.push(presentTransaction(record, at));
        if (page.length === limit) break;
      }
      if (batch.length < (status ? 100 : limit)) {
        exhausted = true;
        break;
      }
    }
    res.json({ purchases: page, nextCursor: exhausted && page.length < limit ? null : cursor ?? null });
  }));

  router.get("/income", handle(async (req, res) => {
    const query = IncomeQuerySchema.safeParse(req.query);
    if (!query.success) return void res.status(400).json({ error: "Invalid income query" });
    const at = now();
    const to = query.data.to ?? utcDay(at);
    const from = query.data.from ?? utcDay(Date.parse(`${to}T00:00:00Z`) - 29 * DAY_MS);
    const span = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS;
    if (!(span >= 0) || span > MAX_INCOME_DAYS) {
      return void res.status(400).json({ error: `from must be before to, at most ${MAX_INCOME_DAYS} days apart` });
    }
    const [days, subscribers] = await Promise.all([
      options.records.listRevenueDays({ environment: query.data.environment, from, to }),
      options.records.listSubscribedUsers(at),
    ]);
    res.json({
      from,
      to,
      ...summarizeIncome({ days, subscribers, granularity: query.data.granularity, environment: query.data.environment, now: at }),
    });
  }));

  router.get("/config", handle(async (_req, res) => {
    res.json(await options.config.get());
  }));

  router.put("/config/limits", handle(async (req, res) => {
    const limits = SubscriptionLimitsSchema.safeParse(req.body?.limits);
    if (!limits.success) return void res.status(400).json({ error: "Invalid limits", details: limits.error.flatten() });
    const admin = (req as AdminRequest).admin!;
    res.json(await options.config.update({ limits: limits.data }, admin.email || admin.uid));
  }));

  router.put("/config/products", handle(async (req, res) => {
    const products = ProductDisplaySettingsSchema.safeParse(req.body?.products);
    if (!products.success) return void res.status(400).json({ error: "Invalid product settings", details: products.error.flatten() });
    const admin = (req as AdminRequest).admin!;
    res.json(await options.config.update({ products: products.data }, admin.email || admin.uid));
  }));

  return router;
}
