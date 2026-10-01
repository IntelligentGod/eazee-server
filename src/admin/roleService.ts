import { getFirebaseAuth } from "../auth/firebase";
import {
  migrateLegacyClaims,
  withRoleClaim,
  type AssignableRole,
  type Role,
} from "../auth/roles";
import type { RoleChange, SubscriptionRecordsStore } from "../subscriptions/records";

/** The parts of firebase-admin Auth that role management needs, so tests can supply a fake. */
export type RoleAuth = {
  getUser(uid: string): Promise<AuthAccount | null>;
  getUserByEmail(email: string): Promise<AuthAccount | null>;
  createUser(input: { email: string; password: string; emailVerified: boolean }): Promise<AuthAccount>;
  setCustomUserClaims(uid: string, claims: Record<string, unknown>): Promise<void>;
  revokeRefreshTokens(uid: string): Promise<void>;
};

export type AuthAccount = {
  uid: string;
  email: string | null;
  displayName: string | null;
  providers: string[];
  createdAt: number | null;
  customClaims: Record<string, unknown>;
};

const toAccount = (record: import("firebase-admin/auth").UserRecord): AuthAccount => ({
  uid: record.uid,
  email: record.email ?? null,
  displayName: record.displayName ?? null,
  providers: record.providerData.map((provider) => provider.providerId),
  createdAt: Date.parse(record.metadata.creationTime) || null,
  customClaims: record.customClaims ?? {},
});

const notFoundAsNull = (error: any) => {
  if (error?.code === "auth/user-not-found") return null;
  throw error;
};

export function createFirebaseRoleAuth(): RoleAuth {
  const auth = getFirebaseAuth();
  return {
    getUser: (uid) => auth.getUser(uid).then(toAccount, notFoundAsNull),
    getUserByEmail: (email) => auth.getUserByEmail(email).then(toAccount, notFoundAsNull),
    createUser: (input) => auth.createUser(input).then(toAccount),
    setCustomUserClaims: (uid, claims) => auth.setCustomUserClaims(uid, claims),
    revokeRefreshTokens: (uid) => auth.revokeRefreshTokens(uid),
  };
}

const profileOf = (account: AuthAccount, role: Role) => ({
  email: account.email,
  displayName: account.displayName,
  providers: account.providers,
  authCreatedAt: account.createdAt,
  role,
});

export class RoleChangeError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "RoleChangeError";
  }
}

/**
 * Changes another user's role between customer and admin. The caller must
 * already be verified as a super admin. The custom claim is the source of
 * truth and is written first; if the Firestore mirror then fails, the claim is
 * put back so the two never disagree. Refresh tokens are revoked so the new
 * role applies from the user's next sign-in.
 */
export async function changeUserRole(input: {
  actor: { uid: string; email?: string | null };
  targetUid: string;
  role: AssignableRole;
  auth: RoleAuth;
  records: SubscriptionRecordsStore;
  now?: number;
}): Promise<{ changed: boolean; from: Role; to: Role; change?: RoleChange }> {
  const { actor, targetUid, role, auth, records } = input;
  const now = input.now ?? Date.now();

  if (targetUid === actor.uid) {
    throw new RoleChangeError(400, "CANNOT_CHANGE_OWN_ROLE", "You cannot change your own role.");
  }
  const target = await auth.getUser(targetUid);
  if (!target) {
    throw new RoleChangeError(404, "USER_NOT_FOUND", "User not found.");
  }
  const from = migrateLegacyClaims(target.customClaims);
  // The super admin role is set only by the startup bootstrap, so the last super admin can never be removed here.
  if (from === "superAdmin") {
    throw new RoleChangeError(400, "CANNOT_CHANGE_SUPER_ADMIN", "The super admin's role cannot be changed.");
  }
  if (from === role && target.customClaims.admin === undefined) {
    await records.setUserRole(targetUid, role, profileOf(target, role), now);
    return { changed: false, from, to: role };
  }

  await auth.setCustomUserClaims(targetUid, withRoleClaim(target.customClaims, role));
  try {
    await records.setUserRole(targetUid, role, profileOf(target, role), now);
  } catch (error) {
    await auth.setCustomUserClaims(targetUid, target.customClaims).catch((revertError) => {
      console.error("[roles] could not restore the previous claims", revertError);
    });
    throw error;
  }
  await auth.revokeRefreshTokens(targetUid);
  const change = await records.addRoleChange({
    targetUid,
    targetEmail: target.email,
    from,
    to: role,
    changedBy: actor.uid,
    changedByEmail: actor.email ?? null,
    at: now,
  });
  return { changed: true, from, to: role, change };
}

/**
 * Makes sure the super admin account exists and has the superAdmin role.
 * Idempotent: an existing account keeps its password; only its role is fixed.
 * The password is used only to create a missing account and is never stored or logged.
 */
export async function bootstrapSuperAdmin(input: {
  email: string | undefined;
  password: string | undefined;
  auth: RoleAuth;
  records: SubscriptionRecordsStore;
  now?: number;
}): Promise<{ status: "skipped" } | { status: "created" | "promoted" | "unchanged"; uid: string; email: string }> {
  const email = input.email?.trim().toLowerCase();
  if (!email) return { status: "skipped" };
  const now = input.now ?? Date.now();

  let account = await input.auth.getUserByEmail(email);
  let status: "created" | "promoted" | "unchanged" = "unchanged";
  if (!account) {
    if (!input.password) {
      throw new Error("SUPER_ADMIN_PASSWORD is required to create the super admin account");
    }
    account = await input.auth.createUser({ email, password: input.password, emailVerified: true });
    status = "created";
  }
  if (migrateLegacyClaims(account.customClaims) !== "superAdmin" || account.customClaims.admin !== undefined) {
    await input.auth.setCustomUserClaims(account.uid, withRoleClaim(account.customClaims, "superAdmin"));
    if (status === "unchanged") status = "promoted";
  }
  await input.records.setUserRole(account.uid, "superAdmin", profileOf(account, "superAdmin"), now);
  await input.records.setSuperAdmin(account.uid, email, now);
  return { status, uid: account.uid, email };
}
