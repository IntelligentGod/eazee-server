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

/**
 * "Get to know me" profile events: counts only, never answers, profile text or scores.
 * Opening the share sheet is counted as that, not as a confirmed post.
 */
export const ABOUT_ME_EVENTS = [
  "invite_shown",
  "invite_accepted",
  "invite_dismissed",
  "flow_started",
  "question_skipped",
  "test_completed",
  "test_incomplete",
  "profile_saved",
  "profile_discarded",
  "profile_deleted",
  "card_saved",
  "share_sheet_opened",
] as const;

export const AboutMeEventSchema = z.object({
  event: z.enum(ABOUT_ME_EVENTS),
  props: z.object({
    entry: z.enum(["chat", "settings"]).optional(),
    route: z.enum(["test", "mbti", "big_five", "other", "skip"]).optional(),
    question: z.enum(["q1", "q2", "q3", "q4", "q5", "q6", "q7", "q8", "q9", "q10", "tipi"]).optional(),
  }).strict().default({}),
}).strict();

export type AboutMeEvent = z.infer<typeof AboutMeEventSchema>;

export interface FirstChatAnalyticsStore {
  record(day: string, event: FirstChatEvent): Promise<void>;
  /** Adds to the "Get to know me" counters, a separate daily document. */
  recordAboutMe?(day: string, event: AboutMeEvent): Promise<void>;
}

export function getAboutMeCounterIncrements({ event, props }: AboutMeEvent) {
  const increments: Record<string, number> = { [event]: 1 };
  for (const key of ["entry", "route", "question"] as const) {
    const value = props[key];
    if (value) increments[`${event}__${key}_${value}`] = 1;
  }
  return increments;
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
  const analytics = getFirestore().collection("analytics");
  const add = async (scope: string, day: string, increments: Record<string, number>) => {
    const counts = Object.fromEntries(Object.entries(increments).map(([key, amount]) => [key, FieldValue.increment(amount)]));
    await analytics.doc(scope).collection("days").doc(day).set({ day, counts, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  };
  return {
    record: (day, event) => add("firstChat", day, getFirstChatCounterIncrements(event)),
    recordAboutMe: (day, event) => add("aboutMe", day, getAboutMeCounterIncrements(event)),
  };
}

/** For tests and local runs without Firestore. */
export function createMemoryFirstChatAnalyticsStore() {
  const days = new Map<string, Record<string, number>>();
  const aboutMeDays = new Map<string, Record<string, number>>();
  const add = (target: Map<string, Record<string, number>>, day: string, increments: Record<string, number>) => {
    const counts = target.get(day) ?? {};
    for (const [key, amount] of Object.entries(increments)) counts[key] = (counts[key] ?? 0) + amount;
    target.set(day, counts);
  };
  return {
    days,
    aboutMeDays,
    async record(day: string, event: FirstChatEvent) {
      add(days, day, getFirstChatCounterIncrements(event));
    },
    async recordAboutMe(day: string, event: AboutMeEvent) {
      add(aboutMeDays, day, getAboutMeCounterIncrements(event));
    },
  } satisfies FirstChatAnalyticsStore & { days: Map<string, Record<string, number>>; aboutMeDays: Map<string, Record<string, number>> };
}

export function createFirstChatAnalyticsRouter(options: {
  store: FirstChatAnalyticsStore;
  verifyRequest?: (req: Request) => Promise<AuthenticatedUser | null>;
}) {
  const router = express.Router();
  const verifyRequest = options.verifyRequest ?? ((request: Request) => verifyFirebaseRequest(request));

  const isSignedIn = async (req: Request, res: express.Response) => {
    let user: AuthenticatedUser | null;
    try {
      user = await verifyRequest(req);
    } catch (error) {
      res.status(isFirebaseAuthenticationError(error) ? 401 : 500).json({ error: "Authentication required" });
      return false;
    }
    if (!user) {
      res.status(401).json({ error: "Authentication required" });
      return false;
    }
    return true;
  };

  router.post("/about-me", async (req, res) => {
    if (!(await isSignedIn(req, res))) return;
    const parsed = AboutMeEventSchema.safeParse(req.body);
    if (!parsed.success || !options.store.recordAboutMe) return res.status(400).json({ error: "Invalid event" });
    try {
      await options.store.recordAboutMe(getUsageDay(req.header("x-eazee-timezone") || undefined), parsed.data);
      return res.status(202).json({ ok: true });
    } catch (error) {
      console.error("[analytics] could not record an about-me event", error);
      return res.status(500).json({ error: "Could not record the event" });
    }
  });

  router.post("/first-chat", async (req, res) => {
    if (!(await isSignedIn(req, res))) return;

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
