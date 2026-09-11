import type { UserRecord } from "firebase-admin/auth";
import { SignJWT, createRemoteJWKSet, importPKCS8, jwtVerify, type JWTPayload } from "jose";
import { getFirebaseAuth, type AuthenticatedUser } from "./auth/firebase";
import { getConfig } from "./config";

const APPLE_ISSUER = "https://appleid.apple.com";
const APPLE_TOKEN_ENDPOINT = `${APPLE_ISSUER}/auth/token`;
const APPLE_REVOKE_ENDPOINT = `${APPLE_ISSUER}/auth/revoke`;
const APPLE_JWKS = createRemoteJWKSet(new URL(`${APPLE_ISSUER}/auth/keys`));
const ACCOUNT_DELETION_RECOVERY_ISSUER = "eazee-server";
const ACCOUNT_DELETION_RECOVERY_AUDIENCE = "eazee-account-deletion";
export const ACCOUNT_DELETION_MAX_AUTH_AGE_SECONDS = 5 * 60;
export const ACCOUNT_DELETION_RECOVERY_TOKEN_TTL_SECONDS = 30 * 60;
export const APPLE_ACCOUNT_DELETION_NOT_CONFIGURED = "Sign in with Apple account deletion is not configured";
export const ACCOUNT_DELETION_RECOVERY_INVALID = "Invalid account deletion recovery token";
export const ACCOUNT_DELETION_RECOVERY_MISMATCH = "Account deletion recovery token does not match account";

type AccountDeletionDependencies = {
  getUser: (uid: string) => Promise<Pick<UserRecord, "providerData">>;
  revokeApple: (authorizationCode: string, expectedAppleUid: string) => Promise<void>;
  deleteFirebaseUser: (uid: string) => Promise<void>;
};

function getAppleConfig() {
  const { appleTeamId, appleKeyId, applePrivateKey, appleClientId } = getConfig();
  if (!appleTeamId || !appleKeyId || !applePrivateKey || !appleClientId) {
    throw new Error(APPLE_ACCOUNT_DELETION_NOT_CONFIGURED);
  }
  return { appleTeamId, appleKeyId, applePrivateKey, appleClientId };
}

function getAccountDeletionSigningKey() {
  const secret = getConfig().accountDeletionSigningSecret;
  if (!secret || secret.length < 32) {
    throw new Error("Account deletion recovery is not configured");
  }
  return new TextEncoder().encode(secret);
}

export async function createAccountDeletionRecoveryToken(
  uid: string,
  nowSeconds = Math.floor(Date.now() / 1000)
) {
  return new SignJWT({ purpose: "account-deletion-recovery" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(ACCOUNT_DELETION_RECOVERY_ISSUER)
    .setAudience(ACCOUNT_DELETION_RECOVERY_AUDIENCE)
    .setSubject(uid)
    .setIssuedAt(nowSeconds)
    .setExpirationTime(nowSeconds + ACCOUNT_DELETION_RECOVERY_TOKEN_TTL_SECONDS)
    .sign(getAccountDeletionSigningKey());
}

export async function getAccountDeletionRecoveryUid(token: string) {
  const verified = await jwtVerify(token, getAccountDeletionSigningKey(), {
    issuer: ACCOUNT_DELETION_RECOVERY_ISSUER,
    audience: ACCOUNT_DELETION_RECOVERY_AUDIENCE,
  });
  if (
    verified.payload.purpose !== "account-deletion-recovery" ||
    typeof verified.payload.sub !== "string" ||
    !verified.payload.sub
  ) {
    throw new Error(ACCOUNT_DELETION_RECOVERY_INVALID);
  }
  return verified.payload.sub;
}

export function isAccountDeletionRecoveryError(error: unknown) {
  const message = String((error as any)?.message || "");
  return message === ACCOUNT_DELETION_RECOVERY_INVALID || message === ACCOUNT_DELETION_RECOVERY_MISMATCH;
}

export async function getAccountDeletionStatus(
  uid: string,
  getUser: (uid: string) => Promise<unknown> = (firebaseUid) => getFirebaseAuth().getUser(firebaseUid)
) {
  try {
    await getUser(uid);
    return false;
  } catch (error: any) {
    if (String(error?.code || "") === "auth/user-not-found") {
      return true;
    }
    throw error;
  }
}

async function createAppleClientSecret() {
  const { appleTeamId, appleKeyId, applePrivateKey, appleClientId } = getAppleConfig();
  const privateKey = await importPKCS8(applePrivateKey, "ES256");

  return new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid: appleKeyId })
    .setIssuer(appleTeamId)
    .setAudience(APPLE_ISSUER)
    .setSubject(appleClientId)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
}

export function validateAppleIdentityClaims(
  payload: Pick<JWTPayload, "iss" | "aud" | "sub">,
  expectedAppleUid: string,
  appleClientId: string
) {
  const audience = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (payload.iss !== APPLE_ISSUER || !audience.includes(appleClientId) || payload.sub !== expectedAppleUid) {
    throw new Error("Apple account verification failed");
  }
}

export function isRecentAuthentication(authTime: number, nowSeconds = Math.floor(Date.now() / 1000)) {
  const authAgeSeconds = nowSeconds - authTime;
  return Number.isFinite(authAgeSeconds) && authAgeSeconds >= 0 && authAgeSeconds <= ACCOUNT_DELETION_MAX_AUTH_AGE_SECONDS;
}

async function postAppleForm(url: string, values: Record<string, string>) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(values).toString(),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(typeof body?.error === "string" ? `Apple request failed: ${body.error}` : "Apple request failed");
  }
  return body;
}

async function revokeAppleAuthorization(authorizationCode: string, expectedAppleUid: string) {
  const { appleClientId } = getAppleConfig();
  const clientSecret = await createAppleClientSecret();
  const tokenResponse = await postAppleForm(APPLE_TOKEN_ENDPOINT, {
    client_id: appleClientId,
    client_secret: clientSecret,
    code: authorizationCode,
    grant_type: "authorization_code",
  });

  if (typeof tokenResponse?.refresh_token !== "string" || typeof tokenResponse?.id_token !== "string") {
    throw new Error("Apple did not return revocable account tokens");
  }

  const verified = await jwtVerify(tokenResponse.id_token, APPLE_JWKS, {
    issuer: APPLE_ISSUER,
    audience: appleClientId,
  });
  validateAppleIdentityClaims(verified.payload, expectedAppleUid, appleClientId);

  await postAppleForm(APPLE_REVOKE_ENDPOINT, {
    client_id: appleClientId,
    client_secret: clientSecret,
    token: tokenResponse.refresh_token,
    token_type_hint: "refresh_token",
  });
}

const productionDependencies: AccountDeletionDependencies = {
  getUser: (uid) => getFirebaseAuth().getUser(uid),
  revokeApple: revokeAppleAuthorization,
  deleteFirebaseUser: (uid) => getFirebaseAuth().deleteUser(uid),
};

export async function deleteAccountData(
  uid: string,
  appleAuthorizationCode: string | undefined,
  dependencies: AccountDeletionDependencies = productionDependencies
) {
  const user = await dependencies.getUser(uid);
  const appleProvider = user.providerData.find((provider) => provider.providerId === "apple.com");

  if (appleProvider) {
    if (!appleAuthorizationCode) {
      throw new Error("Apple authorization is required to delete this account");
    }
    await dependencies.revokeApple(appleAuthorizationCode, appleProvider.uid);
  }

  await dependencies.deleteFirebaseUser(uid);
}

export async function deleteAuthenticatedAccount(
  user: AuthenticatedUser,
  appleAuthorizationCode?: string,
  recoveryToken?: string
) {
  if (recoveryToken) {
    let recoveryUid: string;
    try {
      recoveryUid = await getAccountDeletionRecoveryUid(recoveryToken);
    } catch {
      throw new Error(ACCOUNT_DELETION_RECOVERY_INVALID);
    }
    if (recoveryUid !== user.uid) {
      throw new Error(ACCOUNT_DELETION_RECOVERY_MISMATCH);
    }
  }
  await deleteAccountData(user.uid, appleAuthorizationCode);
}
