import express, { type Request, type RequestHandler, type Response } from "express";
import { z } from "zod";
import {
  isFirebaseAuthenticationError,
  verifyFirebaseRequest,
  type AuthenticatedUser,
} from "../auth/firebase";
import { hasProAccess } from "../subscriptions/entitlement";
import { isProOnlyAiPath } from "../subscriptions/proAccess";
import {
  getPlanLimits,
  type GuidanceFeature,
  type SubscriptionConfigProvider,
} from "./limitsConfig";
import {
  FREE_DAILY_UNCHARGED_REQUESTS,
  getUsageDay,
  type UsageCounter,
  type UsageStore,
} from "./usageStore";

/** Shown to the user, so worded like the app's own messages. */
export const aiActionsExhaustedMessage = (limit: number, isPro: boolean) =>
  isPro
    ? `You have reached today's fair-use limit of ${limit} AI actions. It resets tomorrow.`
    : `You have used today's ${limit} free AI actions. They reset tomorrow, or upgrade to Eazee Pro for more.`;
export const voiceExhaustedMessage = (minutes: number, isPro: boolean) =>
  isPro
    ? `You have reached today's fair-use limit of ${minutes} minutes of voice input. It resets tomorrow.`
    : `You have used today's ${minutes} minutes of free voice input. It resets tomorrow, or upgrade to Eazee Pro for more.`;

const GUIDANCE_LABELS: Record<GuidanceFeature, string> = {
  goalGuidance: "goal plans",
  taskGuidance: "task guides",
  recipeSkillGuide: "recipe and skill guides",
  guidanceQuestions: "guide questions",
};

export const guidanceExhaustedMessage = (feature: GuidanceFeature, limit: number, isPro: boolean) =>
  `You have used today's ${limit} ${GUIDANCE_LABELS[feature]}. ${isPro ? "It resets tomorrow." : "It resets tomorrow, or upgrade to Eazee Pro for more."}`;

/**
 * Guidance endpoints and the allowance each one draws on. Video search starts
 * a recipe or skill guide, so it needs allowance left but only generating the
 * guide is counted.
 */
export const GUIDANCE_PATHS: Record<string, { feature: GuidanceFeature; counter: UsageCounter; charged: boolean }> = {
  "/ai/goal-guidance": { feature: "goalGuidance", counter: "guidanceGoal", charged: true },
  "/ai/task-guidance": { feature: "taskGuidance", counter: "guidanceTask", charged: true },
  "/ai/recipe/videos": { feature: "recipeSkillGuide", counter: "guidanceRecipeSkill", charged: false },
  "/ai/skill/videos": { feature: "recipeSkillGuide", counter: "guidanceRecipeSkill", charged: false },
  "/ai/recipe/generate": { feature: "recipeSkillGuide", counter: "guidanceRecipeSkill", charged: true },
  "/ai/skill/generate": { feature: "recipeSkillGuide", counter: "guidanceRecipeSkill", charged: true },
  "/ai/guidance/answer": { feature: "guidanceQuestions", counter: "guidanceQuestions", charged: true },
  "/ai/recipe/answer": { feature: "guidanceQuestions", counter: "guidanceQuestions", charged: true },
  "/ai/skill/answer": { feature: "guidanceQuestions", counter: "guidanceQuestions", charged: true },
};

export const getGuidancePath = (path: string) => GUIDANCE_PATHS[path.replace(/\/+$/, "")] ?? null;

/**
 * The app walkthrough's demo task and goal (TUTORIAL_DEMO_TODO_TITLE and
 * TUTORIAL_DEMO_GOAL_TITLE in the app). Guidance on exactly these works on every
 * plan and is not counted, so a Free user can finish the tutorial.
 */
export const TUTORIAL_DEMO_TITLES = ["pack for a weekend trip", "learn basic guitar"] as const;

export const isTutorialDemoRequest = (body: unknown) => {
  const record = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const title = typeof record.title === "string" ? record.title : typeof record.goalTitle === "string" ? record.goalTitle : "";
  return (TUTORIAL_DEMO_TITLES as readonly string[]).includes(title.trim().toLowerCase());
};

/** Requests the app sends as free follow-ups; see FREE_DAILY_UNCHARGED_REQUESTS. */
const UNCHARGED_FEATURES = new Set(["aiChatTitle", "aiChatSummary", "aiChatToolResult"]);
/** Finishing a turn that was already charged, or limited another way (home suggestions by days). */
const UNMETERED_AI_PATH_PREFIXES = ["/ai/tools/", "/ai/home-suggestions"];

type UsageLimitOptions = {
  enabled: boolean;
  unlimitedEmails: string[];
  store: UsageStore;
  config: SubscriptionConfigProvider;
  verifyRequest?: (req: Request) => Promise<AuthenticatedUser | null>;
};

const requestPath = (req: Request) => req.originalUrl.split("?")[0];
const usageDay = (req: Request) => getUsageDay(req.header("x-eazee-timezone") || undefined);

async function authenticateMeteredUser(
  req: Request,
  res: Response,
  options: UsageLimitOptions
): Promise<{ user: AuthenticatedUser; isPro: boolean } | null> {
  const verifyRequest = options.verifyRequest ?? ((request: Request) => verifyFirebaseRequest(request));
  try {
    const user = await verifyRequest(req);
    if (!user) {
      res.status(401).json({ error: "Authentication required" });
      return null;
    }
    return { user, isPro: hasProAccess(user, { unlimitedEmails: options.unlimitedEmails }) };
  } catch (error) {
    if (isFirebaseAuthenticationError(error)) {
      res.status(401).json({ error: "Authentication required" });
    } else {
      console.error("[usage] auth failed");
      res.status(500).json({ error: "Authentication unavailable" });
    }
    return null;
  }
}

/**
 * Counts AI actions per user per local day in Firestore and refuses the request
 * once the plan's daily limit (from `config/subscription`) is used. Pro is
 * counted too, against its own (by default unlimited) limits.
 */
export function createAiUsageLimitMiddleware(options: UsageLimitOptions): RequestHandler {
  return async (req, res, next) => {
    const path = requestPath(req);
    if (
      !options.enabled
      || req.method === "OPTIONS"
      || isProOnlyAiPath(path) // free users are refused these by the Pro check
      || getGuidancePath(path) // counted by the guidance limit instead
      || UNMETERED_AI_PATH_PREFIXES.some((prefix) => path.startsWith(prefix))
    ) {
      return next();
    }

    const caller = await authenticateMeteredUser(req, res, options);
    if (!caller) return;

    try {
      const limits = getPlanLimits(await options.config.get(), caller.isPro);
      const day = usageDay(req);
      const feature = req.header("x-eazee-ai-feature") || "";
      if (UNCHARGED_FEATURES.has(feature)
        && await options.store.consume(caller.user.uid, day, "unchargedRequests", FREE_DAILY_UNCHARGED_REQUESTS)) {
        return next();
      }
      if (!await options.store.consume(caller.user.uid, day, "aiActions", limits.chatMessagesPerDay)) {
        return res.status(403).json({
          error: aiActionsExhaustedMessage(limits.chatMessagesPerDay ?? 0, caller.isPro),
          code: "AI_ACTIONS_EXHAUSTED",
        });
      }
      return next();
    } catch (error) {
      // A usage-store outage should not take AI down for everyone.
      console.error("[usage] could not record AI action", error);
      return next();
    }
  };
}

/**
 * Applies the per-feature guidance limits. A limit of 0 on the free plan reads
 * as "Pro only", so the app shows its upgrade prompt.
 */
export function createGuidanceLimitMiddleware(options: UsageLimitOptions): RequestHandler {
  return async (req, res, next) => {
    const guidance = getGuidancePath(requestPath(req));
    if (!options.enabled || req.method === "OPTIONS" || !guidance) {
      return next();
    }

    const caller = await authenticateMeteredUser(req, res, options);
    if (!caller) return;
    if (isTutorialDemoRequest(req.body)) return next();

    try {
      const limit = getPlanLimits(await options.config.get(), caller.isPro).guidance[guidance.feature];
      if (limit === 0) {
        return caller.isPro
          ? res.status(403).json({ error: "This feature is turned off right now.", code: "GUIDANCE_UNAVAILABLE" })
          : res.status(403).json({ error: "Eazee Pro required", code: "PRO_REQUIRED" });
      }
      const uid = caller.user.uid;
      const day = usageDay(req);
      const allowed = guidance.charged
        ? await options.store.consume(uid, day, guidance.counter, limit)
        : limit === null || (await options.store.get(uid, day))[guidance.counter] < limit;
      if (!allowed) {
        return res.status(403).json({
          error: guidanceExhaustedMessage(guidance.feature, limit ?? 0, caller.isPro),
          code: "GUIDANCE_LIMIT_REACHED",
          feature: guidance.feature,
        });
      }
      return next();
    } catch (error) {
      console.error("[usage] could not record guidance use", error);
      return next();
    }
  };
}

/** Refuses new Deepgram tokens once today's voice allowance is used. */
export function createVoiceUsageLimitMiddleware(options: UsageLimitOptions): RequestHandler {
  return async (req, res, next) => {
    if (!options.enabled || req.method === "OPTIONS" || !requestPath(req).startsWith("/deepgram/token")) {
      return next();
    }

    const caller = await authenticateMeteredUser(req, res, options);
    if (!caller) return;

    try {
      const minutes = getPlanLimits(await options.config.get(), caller.isPro).voiceMinutesPerDay;
      if (minutes === null) return next();
      const { voiceSeconds } = await options.store.get(caller.user.uid, usageDay(req));
      if (voiceSeconds >= minutes * 60) {
        return res.status(403).json({ error: voiceExhaustedMessage(minutes, caller.isPro), code: "VOICE_EXHAUSTED" });
      }
      return next();
    } catch (error) {
      console.error("[usage] could not read voice usage", error);
      return next();
    }
  };
}

const VoiceUsageBodySchema = z.object({ seconds: z.number().positive().max(600) });

/**
 * The app reports each recording's length here. Deepgram streams straight from
 * the phone, so the server cannot measure it itself.
 */
export function createUsageRouter(options: Omit<UsageLimitOptions, "config">) {
  const router = express.Router();

  router.post("/voice", async (req, res) => {
    const verifyRequest = options.verifyRequest ?? ((request: Request) => verifyFirebaseRequest(request));
    let user: AuthenticatedUser | null;
    try {
      user = await verifyRequest(req);
    } catch (error) {
      return res.status(isFirebaseAuthenticationError(error) ? 401 : 500).json({ error: "Authentication required" });
    }
    if (!user) return res.status(401).json({ error: "Authentication required" });

    const body = VoiceUsageBodySchema.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: "seconds must be between 0 and 600" });

    try {
      await options.store.addVoiceSeconds(user.uid, usageDay(req), Math.round(body.data.seconds));
      return res.json({ ok: true });
    } catch (error) {
      console.error("[usage] could not record voice usage", error);
      return res.status(500).json({ error: "Could not record voice usage" });
    }
  });

  return router;
}
