import { FieldValue, getFirestore, Timestamp } from "firebase-admin/firestore";
import { getFirebaseAuth } from "../auth/firebase";

/** Mirrors the app's free plan (lib/subscription.ts). */
export const FREE_DAILY_AI_ACTIONS = 5;
export const FREE_DAILY_VOICE_SECONDS = 2 * 60;
/**
 * Follow-up requests the app marks as free (chat titles, summaries). The mark
 * comes from the client, so it is capped: past this, they count as AI actions.
 */
export const FREE_DAILY_UNCHARGED_REQUESTS = 40;
/** Days a usage document is kept; set a Firestore TTL policy on `expireAt` to delete old ones. */
const USAGE_RETENTION_DAYS = 7;

export type DailyUsage = { aiActions: number; voiceSeconds: number; unchargedRequests: number };

export interface UsageStore {
  /** Adds one to `field` unless that would pass `limit`; returns whether it was added. */
  consume(uid: string, day: string, field: "aiActions" | "unchargedRequests", limit: number): Promise<boolean>;
  addVoiceSeconds(uid: string, day: string, seconds: number): Promise<void>;
  get(uid: string, day: string): Promise<DailyUsage>;
}

const EMPTY_USAGE: DailyUsage = { aiActions: 0, voiceSeconds: 0, unchargedRequests: 0 };

const readUsage = (data: FirebaseFirestore.DocumentData | undefined): DailyUsage => ({
  aiActions: Number(data?.aiActions) || 0,
  voiceSeconds: Number(data?.voiceSeconds) || 0,
  unchargedRequests: Number(data?.unchargedRequests) || 0,
});

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
        if (usage[field] >= limit) return false;
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
  };
}

/** For tests and local runs without Firestore. */
export function createMemoryUsageStore(): UsageStore {
  const days = new Map<string, DailyUsage>();
  const read = (uid: string, day: string) => days.get(`${uid}/${day}`) ?? { ...EMPTY_USAGE };
  return {
    async consume(uid, day, field, limit) {
      const usage = read(uid, day);
      if (usage[field] >= limit) return false;
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
