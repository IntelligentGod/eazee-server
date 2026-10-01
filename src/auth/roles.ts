/**
 * Account roles. The source of truth is the Firebase Auth custom claim `role`,
 * which only this server sets (firebase-admin); `users/{uid}.role` mirrors it
 * so the admin panel can list and filter by role.
 *
 *   superAdmin  everything an admin can do, plus changing other users' roles
 *   admin       the admin panel, without role management
 *   customer    everyone else (the default)
 */
export const ROLES = ["superAdmin", "admin", "customer"] as const;
export type Role = (typeof ROLES)[number];

/** Roles the admin panel can assign. superAdmin is set only by the startup bootstrap. */
export const ASSIGNABLE_ROLES = ["customer", "admin"] as const;
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

export const ROLE_CLAIM_KEY = "role";

/** Anything missing or unknown is a customer, so a bad claim never grants access. */
export const readRoleClaim = (value: unknown): Role =>
  value === "superAdmin" || value === "admin" ? value : "customer";

export const isStaffRole = (role: Role) => role === "admin" || role === "superAdmin";

/**
 * The full custom-claims object with `role` set, keeping every other claim
 * (notably eazeePro). Customer is stored as no claim at all, and the old
 * `admin: true` flag is dropped.
 */
export function withRoleClaim(claims: Record<string, unknown> | undefined, role: Role) {
  const { [ROLE_CLAIM_KEY]: _previous, admin: _legacyAdmin, ...others } = claims || {};
  return role === "customer" ? others : { ...others, [ROLE_CLAIM_KEY]: role };
}

/** Role implied by claims written before roles existed (`admin: true`). */
export const migrateLegacyClaims = (claims: Record<string, unknown> | undefined): Role =>
  claims?.[ROLE_CLAIM_KEY] !== undefined
    ? readRoleClaim(claims[ROLE_CLAIM_KEY])
    : claims?.admin === true ? "admin" : "customer";
