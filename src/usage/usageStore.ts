import { FieldValue, getFirestore, Timestamp } from "firebase-admin/firestore";
import { getFirebaseAuth } from "../auth/firebase";

/**
 * Follow-up requests the app marks as free (chat titles, summaries). The mark
 * comes from the client, so it is capped: past this, they count as AI actions.
 */
export const FREE_DAILY_UNCHARGED_REQUESTS = 40;
/** Days a usage document is kept; set a Firestore TTL policy on `expireAt` to delete old ones. */
const USAGE_RETENTION_DAYS = 7;

/** Counters kept per user per day. Guidance counters are named after GUIDANCE_FEATURES. */
export const USAGE_COUNTERS = [
  "aiActions",
  "unchargedRequests",
  "guidanceGoal",
  "guidanceTask",
  "guidanceRecipeSkill",
  "guidanceQuestions",
] as const;
export type UsageCounter = (typeof USAGE_COUNTERS)[number];

export type DailyUsage = Record<UsageCounter, number> & { voiceSeconds: number };
export type DailyUsageEntry = DailyUsage & { day: string };

export interface UsageStore {
  /** Adds one to `field` unless that would pass `limit` (null: no limit); returns whether it was added. */
  consume(uid: string, day: string, field: UsageCounter, limit: number | null): Promise<boolean>;
  addVoiceSeconds(uid: string, day: string, seconds: number): Promise<void>;
  get(uid: string, day: string): Promise<DailyUsage>;
  /** Newest first, at most `limit` days (old days expire after USAGE_RETENTION_DAYS). */
  listRecent(uid: string, limit: number): Promise<DailyUsageEntry[]>;
}

export const EMPTY_USAGE: DailyUsage = {
  aiActions: 0,
  voiceSeconds: 0,
  unchargedRequests: 0,
  guidanceGoal: 0,
  guidanceTask: 0,
  guidanceRecipeSkill: 0,
  guidanceQuestions: 0,
};

const readUsage = (data: FirebaseFirestore.DocumentData | undefined): DailyUsage => {
  const usage = { ...EMPTY_USAGE };
  for (const field of [...USAGE_COUNTERS, "voiceSeconds"] as const) {
    usage[field] = Number(data?.[field]) || 0;
  }
  return usage;
};

const isWithinLimit = (used: number, limit: number | null) => limit === null || used < limit;

/** One document per user per day: `aiUsage/{uid}/days/{YYYY-MM-DD}`. Only the server writes these. */
export function createFirestoreUsageStore(): UsageStore {
  getFirebaseAuth(); // initializes the shared firebase-admin app
  const firestore = getFirestore();
  const dayDoc = (uid: string, day: string) => firestore.collection("aiUsage").doc(uid).collection("days").doc(day);
  const expireAt = () => Timestamp.fromMillis(Date.now() + USAGE_RETENTION_DAYS * 86_400_000);

  return {
    async consume(uid, day, field, limit) {
      const ref = dayDoc(uid, day);
      // A transaction, so two requests at once cannot both take the last free action.
      return firestore.runTransaction(async (transaction) => {
        const usage = readUsage((await transaction.get(ref)).data());
        if (!isWithinLimit(usage[field], limit)) return false;
        transaction.set(ref, { [field]: usage[field] + 1, day, updatedAt: FieldValue.serverTimestamp(), expireAt: expireAt() }, { merge: true });
        return true;
      });
    },
    async addVoiceSeconds(uid, day, seconds) {
      await dayDoc(uid, day).set(
        { voiceSeconds: FieldValue.increment(seconds), day, updatedAt: FieldValue.serverTimestamp(), expireAt: expireAt() },
        { merge: true }
      );
    },
    async get(uid, day) {
      return readUsage((await dayDoc(uid, day).get()).data());
    },
    async listRecent(uid, limit) {
      const snapshot = await firestore.collection("aiUsage").doc(uid).collection("days")
        .orderBy("day", "desc").limit(limit).get();
      return snapshot.docs.map((doc) => ({ ...readUsage(doc.data()), day: doc.id }));
    },
  };
}

/** For tests and local runs without Firestore. */
export function createMemoryUsageStore(): UsageStore {
  const days = new Map<string, DailyUsage>();
  const read = (uid: string, day: string) => days.get(`${uid}/${day}`) ?? { ...EMPTY_USAGE };
  return {
    async consume(uid, day, field, limit) {
      const usage = read(uid, day);
      if (!isWithinLimit(usage[field], limit)) return false;
      days.set(`${uid}/${day}`, { ...usage, [field]: usage[field] + 1 });
      return true;
    },
    async addVoiceSeconds(uid, day, seconds) {
      const usage = read(uid, day);
      days.set(`${uid}/${day}`, { ...usage, voiceSeconds: usage.voiceSeconds + seconds });
    },
    async get(uid, day) {
      return read(uid, day);
    },
    async listRecent(uid, limit) {
      return [...days.entries()]
        .filter(([key]) => key.startsWith(`${uid}/`))
        .map(([key, usage]) => ({ ...usage, day: key.slice(uid.length + 1) }))
        .sort((a, b) => b.day.localeCompare(a.day))
        .slice(0, limit);
    },
  };
}

/**
 * The user's local calendar day, which is what the app shows limits against.
 * An invalid or missing time zone falls back to UTC.
 */
export function getUsageDay(timeZone: string | undefined, now = new Date()) {
  const format = (zone: string) =>
    new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  try {
    return timeZone ? format(timeZone) : format("UTC");
  } catch {
    return format("UTC");
  }
}
