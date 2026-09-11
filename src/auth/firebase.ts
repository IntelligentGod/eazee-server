import {
  applicationDefault,
  cert,
  getApps,
  initializeApp,
} from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import type { Request } from "express";
import { getConfig } from "../config";

export type AuthenticatedUser = {
  uid: string;
  email?: string;
  displayName?: string;
  authTime: number;
};

const FIREBASE_AUTHENTICATION_ERROR_CODES = new Set([
  "auth/argument-error",
  "auth/id-token-expired",
  "auth/id-token-revoked",
  "auth/invalid-id-token",
  "auth/user-disabled",
  "auth/user-not-found",
]);

let firebaseAppInitialized = false;

function getFirebaseCredential() {
  const { firebaseServiceAccountJson } = getConfig();
  if (!firebaseServiceAccountJson) {
    return applicationDefault();
  }

  const serviceAccount = JSON.parse(firebaseServiceAccountJson);
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
  };
}
