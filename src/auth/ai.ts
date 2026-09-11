import type { RequestHandler } from "express";
import {
  isFirebaseAuthenticationError,
  verifyFirebaseRequest,
  type AuthenticatedUser,
} from "./firebase";

type VerifyFirebaseRequest = (
  req: Parameters<typeof verifyFirebaseRequest>[0],
  options?: { checkRevoked?: boolean }
) => Promise<AuthenticatedUser | null>;

export function createAiAuthMiddleware(options: {
  aiAuthRequired: boolean;
  verifyRequest?: VerifyFirebaseRequest;
}): RequestHandler {
  const verifyRequest = options.verifyRequest ?? verifyFirebaseRequest;

  return async (req, res, next) => {
    if (req.method === "OPTIONS" || !options.aiAuthRequired) {
      return next();
    }

    try {
      const user = await verifyRequest(req, { checkRevoked: true });
      if (!user) {
        return res.status(401).json({ error: "Authentication required" });
      }
      return next();
    } catch (error) {
      if (isFirebaseAuthenticationError(error)) {
        return res.status(401).json({ error: "Authentication required" });
      }
      console.error("[ai-auth] failed");
      return res.status(500).json({ error: "Authentication unavailable" });
    }
  };
}
