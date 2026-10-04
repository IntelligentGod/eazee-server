import {
  applicationDefault,
  cert,
  getApps,
  initializeApp,
} from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import type { Request } from "express";
import { getConfig } from "../config";
import { PRO_CLAIM_KEY, type ProEntitlementClaim } from "../subscriptions/entitlement";
import { ROLE_CLAIM_KEY, readRoleClaim, type Role } from "./roles";

export type AuthenticatedUser = {
  uid: string;
  email?: string;
  displayName?: string;
  authTime: number;
  /** Verified Eazee Pro subscription, from the user's custom claims. */
  proEntitlement?: ProEntitlementClaim | null;
  /** The `role` custom claim; only this server sets it (see auth/roles.ts). */
  role?: Role;
};

function readProEntitlementClaim(value: unknown): ProEntitlementClaim | null {
  const claim = value as Partial<ProEntitlementClaim> | undefined;
  return claim && (claim.plan === "monthly" || claim.plan === "yearly") && typeof claim.expiresAt === "number"
    ? { plan: claim.plan, expiresAt: claim.expiresAt, originalTransactionId: String(claim.originalTransactionId || "") }
    : null;
}

const FIREBASE_AUTHENTICATION_ERROR_CODES = new Set([
  "auth/argument-error",
  "auth/id-token-expired",
  "auth/id-token-revoked",
  "auth/invalid-id-token",
  "auth/user-disabled",
  "auth/user-not-found",
]);

let firebaseAppInitialized = false;

/**
 * FIREBASE_SERVICE_ACCOUNT_JSON holds the service account as JSON, or as that JSON
 * base64-encoded (easier to paste into hosting dashboards). The error never
 * repeats the value, since it is a secret.
 */
export function parseServiceAccount(value: string): Record<string, any> {
  const trimmed = value.trim();
  const json = trimmed.startsWith("{") ? trimmed : Buffer.from(trimmed, "base64").toString("utf8").trim();
  try {
    const parsed = JSON.parse(json);
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    // Reported below without the value.
  }
  throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON must be the service account JSON or that JSON base64-encoded.");
}

function getFirebaseCredential() {
  const { firebaseServiceAccountJson } = getConfig();
  if (!firebaseServiceAccountJson) {
    return applicationDefault();
  }

  const serviceAccount = parseServiceAccount(firebaseServiceAccountJson);
  if (typeof serviceAccount.private_key === "string") {
    serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");
  }
  return cert(serviceAccount);
}

function ensureFirebaseApp() {
  if (firebaseAppInitialized || getApps().length > 0) {
    firebaseAppInitialized = true;
    return;
  }

  initializeApp({
    credential: getFirebaseCredential(),
  });
  firebaseAppInitialized = true;
}

function getBearerToken(req: Request) {
  const value = req.header("authorization") || req.header("Authorization") || "";
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || "";
}

export function isFirebaseAuthenticationError(error: unknown) {
  return FIREBASE_AUTHENTICATION_ERROR_CODES.has(String((error as any)?.code || ""));
}

export function getFirebaseAuth() {
  ensureFirebaseApp();
  return getAuth();
}

export async function verifyFirebaseRequest(
  req: Request,
  options?: { checkRevoked?: boolean }
): Promise<AuthenticatedUser | null> {
  const token = getBearerToken(req);
  if (!token) return null;

  ensureFirebaseApp();
  const decoded = await getFirebaseAuth().verifyIdToken(token, options?.checkRevoked ?? false);
  const displayName =
    typeof decoded.name === "string" && decoded.name.trim()
      ? decoded.name.trim()
      : undefined;

  return {
    uid: decoded.uid,
    email: typeof decoded.email === "string" ? decoded.email : undefined,
    displayName,
    authTime: decoded.auth_time,
    proEntitlement: readProEntitlementClaim(decoded[PRO_CLAIM_KEY]),
    role: readRoleClaim(decoded[ROLE_CLAIM_KEY]),
  };
}
