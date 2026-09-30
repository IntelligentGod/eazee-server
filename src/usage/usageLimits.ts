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
  FREE_DAILY_AI_ACTIONS,
  FREE_DAILY_UNCHARGED_REQUESTS,
  FREE_DAILY_VOICE_SECONDS,
  getUsageDay,
  type UsageStore,
} from "./usageStore";

/** Same wording as the app's SUBSCRIPTION_REQUIRED_MESSAGES, since it is shown to the user. */
export const AI_ACTIONS_EXHAUSTED_MESSAGE =
  `You have used today's ${FREE_DAILY_AI_ACTIONS} free AI actions. They reset tomorrow, or upgrade to Eazee Pro for unlimited.`;
export const VOICE_EXHAUSTED_MESSAGE =
  `You have used today's ${FREE_DAILY_VOICE_SECONDS / 60} minutes of free voice input. It resets tomorrow, or upgrade to Eazee Pro for unlimited.`;

/** Requests the app sends as free follow-ups; see FREE_DAILY_UNCHARGED_REQUESTS. */
const UNCHARGED_FEATURES = new Set(["aiChatTitle", "aiChatSummary", "aiChatToolResult"]);
/** Finishing a turn that was already charged, or limited another way (home suggestions by days). */
const UNMETERED_AI_PATH_PREFIXES = ["/ai/tools/", "/ai/home-suggestions"];

type UsageLimitOptions = {
  enabled: boolean;
  unlimitedEmails: string[];
  store: UsageStore;
  verifyRequest?: (req: Request) => Promise<AuthenticatedUser | null>;
};

const requestPath = (req: Request) => req.originalUrl.split("?")[0];
const usageDay = (req: Request) => getUsageDay(req.header("x-eazee-timezone") || undefined);

async function authenticateFreeUser(
  req: Request,
  res: Response,
  options: UsageLimitOptions
): Promise<AuthenticatedUser | "pro" | null> {
  const verifyRequest = options.verifyRequest ?? ((request: Request) => verifyFirebaseRequest(request));
  try {
    const user = await verifyRequest(req);
    if (!user) {
      res.status(401).json({ error: "Authentication required" });
      return null;
    }
    return hasProAccess(user, { unlimitedEmails: options.unlimitedEmails }) ? "pro" : user;
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
 * Counts free users' AI actions per local day in Firestore and refuses the
 * request once the daily allowance is used. Pro users are not metered.
 */
export function createAiUsageLimitMiddleware(options: UsageLimitOptions): RequestHandler {
  return async (req, res, next) => {
    const path = requestPath(req);
    if (
      !options.enabled
      || req.method === "OPTIONS"
      || isProOnlyAiPath(path) // free users are refused these by the Pro check
      || UNMETERED_AI_PATH_PREFIXES.some((prefix) => path.startsWith(prefix))
    ) {
      return next();
    }

    const user = await authenticateFreeUser(req, res, options);
    if (!user) return;
    if (user === "pro") return next();

    try {
      const day = usageDay(req);
      const feature = req.header("x-eazee-ai-feature") || "";
      if (UNCHARGED_FEATURES.has(feature)
        && await options.store.consume(user.uid, day, "unchargedRequests", FREE_DAILY_UNCHARGED_REQUESTS)) {
        return next();
      }
      if (!await options.store.consume(user.uid, day, "aiActions", FREE_DAILY_AI_ACTIONS)) {
        return res.status(403).json({ error: AI_ACTIONS_EXHAUSTED_MESSAGE, code: "AI_ACTIONS_EXHAUSTED" });
      }
      return next();
    } catch (error) {
      // A usage-store outage should not take AI down for everyone.
      console.error("[usage] could not record AI action", error);
      return next();
    }
  };
}

/** Refuses new Deepgram tokens to free users past today's voice allowance. */
export function createVoiceUsageLimitMiddleware(options: UsageLimitOptions): RequestHandler {
  return async (req, res, next) => {
    if (!options.enabled || req.method === "OPTIONS" || !requestPath(req).startsWith("/deepgram/token")) {
      return next();
    }

    const user = await authenticateFreeUser(req, res, options);
    if (!user) return;
    if (user === "pro") return next();

    try {
      const { voiceSeconds } = await options.store.get(user.uid, usageDay(req));
      if (voiceSeconds >= FREE_DAILY_VOICE_SECONDS) {
        return res.status(403).json({ error: VOICE_EXHAUSTED_MESSAGE, code: "VOICE_EXHAUSTED" });
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
export function createUsageRouter(options: UsageLimitOptions) {
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
