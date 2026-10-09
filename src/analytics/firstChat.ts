import express, { type Request } from "express";
import { z } from "zod";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { getFirebaseAuth, isFirebaseAuthenticationError, verifyFirebaseRequest, type AuthenticatedUser } from "../auth/firebase";
import { getUsageDay } from "../usage/usageStore";

/**
 * First-chat onboarding analytics. Only event names and small enum or number
 * properties are accepted, so no chat text, goal text or user id is ever stored:
 * each event just adds to a daily counter.
 */
export const FIRST_CHAT_EVENTS = [
  "welcome_shown",
  "starter_selected",
  "custom_request",
  "result_delivered",
  "result_used",
  "result_refined",
  "preference_saved",
  "preference_declined",
  "flow_left",
  "dismissed",
] as const;

export const FirstChatEventSchema = z.object({
  event: z.enum(FIRST_CHAT_EVENTS),
  props: z.object({
    intent: z.enum(["plan_day", "goal", "procrastination", "clear_head", "decision", "write", "custom"]).optional(),
    replies: z.number().int().min(0).max(50).optional(),
    kind: z.enum([
      "plan", "draft", "comparison", "first_step", "breakdown", "goal_plan",
      "draft_copied", "tasks_saved", "goal_saved", "schedule_confirmed",
    ]).optional(),
    step: z.enum(["welcome", "starter", "clarifying", "result"]).optional(),
    field: z.enum(["planStyle", "detail", "tone", "responseLength"]).optional(),
  }).strict().default({}),
}).strict();

export type FirstChatEvent = z.infer<typeof FirstChatEventSchema>;

export interface FirstChatAnalyticsStore {
  record(day: string, event: FirstChatEvent): Promise<void>;
}

/** The counters one event adds to: the event itself, and the event split by each property. */
export function getFirstChatCounterIncrements({ event, props }: FirstChatEvent) {
  const increments: Record<string, number> = { [event]: 1 };
  for (const key of ["intent", "kind", "step", "field"] as const) {
    const value = props[key];
    if (value) increments[`${event}__${key}_${value}`] = 1;
  }
  if (typeof props.replies === "number") increments[`${event}__replies_total`] = props.replies;
  return increments;
}

/** One document per day: `analytics/firstChat/days/{YYYY-MM-DD}`, a map of counters. */
export function createFirestoreFirstChatAnalyticsStore(): FirstChatAnalyticsStore {
  getFirebaseAuth(); // initializes the shared firebase-admin app
  const days = getFirestore().collection("analytics").doc("firstChat").collection("days");
  return {
    async record(day, event) {
      const counts = Object.fromEntries(
        Object.entries(getFirstChatCounterIncrements(event)).map(([key, amount]) => [key, FieldValue.increment(amount)])
      );
      await days.doc(day).set({ day, counts, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    },
  };
}

/** For tests and local runs without Firestore. */
export function createMemoryFirstChatAnalyticsStore() {
  const days = new Map<string, Record<string, number>>();
  return {
    days,
    async record(day: string, event: FirstChatEvent) {
      const counts = days.get(day) ?? {};
      for (const [key, amount] of Object.entries(getFirstChatCounterIncrements(event))) {
        counts[key] = (counts[key] ?? 0) + amount;
      }
      days.set(day, counts);
    },
  } satisfies FirstChatAnalyticsStore & { days: Map<string, Record<string, number>> };
}

export function createFirstChatAnalyticsRouter(options: {
  store: FirstChatAnalyticsStore;
  verifyRequest?: (req: Request) => Promise<AuthenticatedUser | null>;
}) {
  const router = express.Router();
  const verifyRequest = options.verifyRequest ?? ((request: Request) => verifyFirebaseRequest(request));

  router.post("/first-chat", async (req, res) => {
    let user: AuthenticatedUser | null;
    try {
      user = await verifyRequest(req);
    } catch (error) {
      return res.status(isFirebaseAuthenticationError(error) ? 401 : 500).json({ error: "Authentication required" });
    }
    if (!user) return res.status(401).json({ error: "Authentication required" });

    const parsed = FirstChatEventSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid event" });

    try {
      await options.store.record(getUsageDay(req.header("x-eazee-timezone") || undefined), parsed.data);
      return res.status(202).json({ ok: true });
    } catch (error) {
      console.error("[analytics] could not record a first-chat event", error);
      return res.status(500).json({ error: "Could not record the event" });
    }
  });

  return router;
}
