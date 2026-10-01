import { z } from "zod";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { getFirebaseAuth } from "../auth/firebase";

/**
 * Guidance features with their own daily allowance. Each maps to the AI
 * endpoints that do that work (see GUIDANCE_PATHS in usageLimits.ts).
 */
export const GUIDANCE_FEATURES = ["goalGuidance", "taskGuidance", "recipeSkillGuide", "guidanceQuestions"] as const;
export type GuidanceFeature = (typeof GUIDANCE_FEATURES)[number];

/** null means unlimited. */
const LimitSchema = z.number().int().min(0).max(100_000).nullable();

const PlanLimitsSchema = z.object({
  chatMessagesPerDay: LimitSchema,
  voiceMinutesPerDay: LimitSchema,
  guidance: z.object({
    goalGuidance: LimitSchema,
    taskGuidance: LimitSchema,
    recipeSkillGuide: LimitSchema,
    guidanceQuestions: LimitSchema,
  }),
});

export const SubscriptionLimitsSchema = z.object({ free: PlanLimitsSchema, pro: PlanLimitsSchema });

/** App-side display settings only; prices always come from the App Store. */
export const ProductDisplaySchema = z.object({
  displayOrder: z.number().int().min(0).max(100),
  badge: z.string().trim().max(30).nullable(),
  marketingText: z.string().trim().max(160).nullable(),
});

export const ProductDisplaySettingsSchema = z.record(
  z.string().regex(/^[A-Za-z0-9._-]{1,120}$/),
  ProductDisplaySchema
);

export type PlanLimits = z.infer<typeof PlanLimitsSchema>;
export type SubscriptionLimits = z.infer<typeof SubscriptionLimitsSchema>;
export type ProductDisplay = z.infer<typeof ProductDisplaySchema>;
export type ProductDisplaySettings = z.infer<typeof ProductDisplaySettingsSchema>;

export type SubscriptionConfig = {
  limits: SubscriptionLimits;
  products: ProductDisplaySettings;
  updatedAt: number | null;
  updatedBy: string | null;
};

/**
 * Used until an admin saves `config/subscription`, and whenever it cannot be
 * read. Matches the limits the app shipped with: free gets 5 AI actions and 2
 * voice minutes a day and no guidance; Pro is unlimited.
 */
export const DEFAULT_SUBSCRIPTION_CONFIG: SubscriptionConfig = {
  limits: {
    free: {
      chatMessagesPerDay: 5,
      voiceMinutesPerDay: 2,
      guidance: { goalGuidance: 0, taskGuidance: 0, recipeSkillGuide: 0, guidanceQuestions: 0 },
    },
    pro: {
      chatMessagesPerDay: null,
      voiceMinutesPerDay: null,
      guidance: { goalGuidance: null, taskGuidance: null, recipeSkillGuide: null, guidanceQuestions: null },
    },
  },
  products: {
    "com.eazee.subscription.pro.yearly": { displayOrder: 0, badge: "Best value", marketingText: null },
    "com.eazee.subscription.pro.monthly": { displayOrder: 1, badge: null, marketingText: "Cancel anytime" },
  },
  updatedAt: null,
  updatedBy: null,
};

/**
 * Reads a stored config, keeping the default for any part that is missing or
 * invalid, so one bad field never removes every limit.
 */
export function parseSubscriptionConfig(raw: unknown): SubscriptionConfig {
  const data = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const limits = SubscriptionLimitsSchema.safeParse(data.limits);
  const products = ProductDisplaySettingsSchema.safeParse(data.products);
  const updatedAt = data.updatedAt as { toMillis?: () => number } | number | undefined;
  return {
    limits: limits.success ? limits.data : DEFAULT_SUBSCRIPTION_CONFIG.limits,
    products: products.success ? products.data : DEFAULT_SUBSCRIPTION_CONFIG.products,
    updatedAt: typeof updatedAt === "number" ? updatedAt : updatedAt?.toMillis?.() ?? null,
    updatedBy: typeof data.updatedBy === "string" ? data.updatedBy : null,
  };
}

export interface SubscriptionConfigStore {
  read(): Promise<unknown>;
  write(update: { limits?: SubscriptionLimits; products?: ProductDisplaySettings }, updatedBy: string): Promise<void>;
}

/** `config/subscription`. Only the server writes it, through the admin endpoints. */
export function createFirestoreConfigStore(): SubscriptionConfigStore {
  getFirebaseAuth();
  const ref = getFirestore().collection("config").doc("subscription");
  return {
    async read() {
      return (await ref.get()).data();
    },
    async write(update, updatedBy) {
      const data = { ...update, updatedBy, updatedAt: FieldValue.serverTimestamp() };
      // mergeFields replaces each given section whole, so a removed product setting does not linger.
      await ref.set(data, { mergeFields: Object.keys(data) });
    },
  };
}

export function createMemoryConfigStore(initial?: unknown): SubscriptionConfigStore {
  let stored = initial as Record<string, unknown> | undefined;
  return {
    async read() {
      return stored;
    },
    async write(update, updatedBy) {
      stored = { ...(stored || {}), ...update, updatedBy, updatedAt: Date.now() };
    },
  };
}

export type SubscriptionConfigProvider = {
  get(): Promise<SubscriptionConfig>;
  update(update: { limits?: SubscriptionLimits; products?: ProductDisplaySettings }, updatedBy: string): Promise<SubscriptionConfig>;
};

/**
 * Limits are read on every metered request, so the stored config is cached for
 * `ttlMs`. When it cannot be read, the last good copy is used, then the defaults:
 * a Firestore outage must not lift or zero out the limits.
 */
export function createSubscriptionConfigProvider(options: {
  store: SubscriptionConfigStore;
  ttlMs?: number;
  now?: () => number;
}): SubscriptionConfigProvider {
  const ttlMs = options.ttlMs ?? 60_000;
  const now = options.now ?? Date.now;
  let cached: { value: SubscriptionConfig; readAt: number } | null = null;
  let inFlight: Promise<SubscriptionConfig> | null = null;

  const load = async () => {
    try {
      const value = parseSubscriptionConfig(await options.store.read());
      cached = { value, readAt: now() };
      return value;
    } catch (error) {
      console.error("[limits] could not read config/subscription", error);
      return cached?.value ?? DEFAULT_SUBSCRIPTION_CONFIG;
    } finally {
      inFlight = null;
    }
  };

  return {
    async get() {
      if (cached && now() - cached.readAt < ttlMs) return cached.value;
      inFlight ??= load();
      return inFlight;
    },
    async update(update, updatedBy) {
      await options.store.write(update, updatedBy);
      cached = null;
      return load();
    },
  };
}

/** Pro and the unlimited-access accounts use the Pro limits; everyone else the free ones. */
export const getPlanLimits = (config: SubscriptionConfig, isPro: boolean): PlanLimits =>
  isPro ? config.limits.pro : config.limits.free;
