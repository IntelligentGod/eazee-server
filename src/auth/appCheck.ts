import type { RequestHandler } from "express";
import { getAppCheck } from "firebase-admin/app-check";
import { getFirebaseAuth } from "./firebase";

type AppCheckVerification = {
  appId: string;
};

type VerifyAppCheckToken = (token: string) => Promise<AppCheckVerification>;

async function verifyAppCheckToken(token: string) {
  getFirebaseAuth();
  return getAppCheck().verifyToken(token);
}

export function createAppCheckMiddleware(options: {
  required: boolean;
  allowedAppIds: string[];
  verifyToken?: VerifyAppCheckToken;
}): RequestHandler {
  const verifyToken = options.verifyToken ?? verifyAppCheckToken;
  const allowedAppIds = new Set(options.allowedAppIds);

  return async (req, res, next) => {
    if (req.method === "OPTIONS") {
      return next();
    }

    if (!options.required) {
      return next();
    }

    const token = (req.header("x-firebase-appcheck") || "").trim();
    if (!token) {
      console.warn(`[app-check] ${req.method} ${req.originalUrl}: no App Check token`);
      return res.status(401).json({ error: "App verification required" });
    }

    if (allowedAppIds.size === 0) {
      console.error("[app-check] APP_CHECK_ALLOWED_APP_IDS is required when App Check enforcement is enabled");
      return res.status(503).json({ error: "App verification unavailable" });
    }

    try {
      const verified = await verifyToken(token);
      if (allowedAppIds.size > 0 && !allowedAppIds.has(verified.appId)) {
        console.warn(`[app-check] ${req.method} ${req.originalUrl}: app ${verified.appId} is not in APP_CHECK_ALLOWED_APP_IDS`);
        return res.status(401).json({ error: "App verification required" });
      }
      return next();
    } catch (error) {
      console.warn(`[app-check] ${req.method} ${req.originalUrl}: token rejected:`, (error as Error)?.message || error);
      return res.status(401).json({ error: "App verification required" });
    }
  };
}
