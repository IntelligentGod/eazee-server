import type { Request, RequestHandler } from "express";
import {
  isFirebaseAuthenticationError,
  verifyFirebaseRequest,
  type AuthenticatedUser,
} from "../auth/firebase";
import { hasProAccess } from "./entitlement";

/**
 * AI endpoints behind the app's Pro-only features (day planning, todo
 * classification). Mirrors PRO_ONLY_FEATURES in the app. Guidance (goals,
 * tasks, recipes, skills) has per-plan limits instead; see GUIDANCE_PATHS.
 */
export const PRO_ONLY_AI_PATH_PREFIXES = [
  "/ai/day-plan/",
  "/ai/todo/classify",
];

export const isProOnlyAiPath = (path: string) =>
  PRO_ONLY_AI_PATH_PREFIXES.some((prefix) => path === prefix.replace(/\/$/, "") || path.startsWith(prefix));

/**
 * Refuses Pro-only AI endpoints to accounts without a verified subscription.
 * Off until `enabled` is set, so it can be deployed before the app update that
 * verifies purchases, without locking current testers out.
 */
export function createProAccessMiddleware(options: {
  enabled: boolean;
  unlimitedEmails: string[];
  verifyRequest?: (req: Request) => Promise<AuthenticatedUser | null>;
}): RequestHandler {
  const verifyRequest = options.verifyRequest ?? ((req: Request) => verifyFirebaseRequest(req));

  return async (req, res, next) => {
    if (!options.enabled || req.method === "OPTIONS" || !isProOnlyAiPath(req.originalUrl.split("?")[0])) {
      return next();
    }

    try {
      const user = await verifyRequest(req);
      if (!user) {
        return res.status(401).json({ error: "Authentication required" });
      }
      if (!hasProAccess(user, { unlimitedEmails: options.unlimitedEmails })) {
        return res.status(403).json({ error: "Eazee Pro required", code: "PRO_REQUIRED" });
      }
      return next();
    } catch (error) {
      if (isFirebaseAuthenticationError(error)) {
        return res.status(401).json({ error: "Authentication required" });
      }
      console.error("[pro-access] failed");
      return res.status(500).json({ error: "Authentication unavailable" });
    }
  };
}
