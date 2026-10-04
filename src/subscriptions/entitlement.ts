import { createHash } from "node:crypto";
import type { AppleTransaction } from "./appleTransactions";
import { isStaffRole, type Role } from "../auth/roles";

export type ProPlanId = "monthly" | "yearly";

/** Must match App Store Connect (subscription group "Eazee Pro") and the app's SUBSCRIPTION_PLANS. */
export const APPLE_PRODUCT_PLANS: Record<string, ProPlanId> = {
  "com.eazee.subscription.pro.monthly": "monthly",
  "com.eazee.subscription.pro.yearly": "yearly",
};

/** Stored as a Firebase custom claim, so every ID token the app sends carries it. */
export type ProEntitlementClaim = {
  plan: ProPlanId;
  /** Epoch ms; Pro ends here unless a renewal is verified first. */
  expiresAt: number;
  originalTransactionId: string;
};

export const PRO_CLAIM_KEY = "eazeePro";

/**
 * A stable UUID per Eazee account, set as the StoreKit appAccountToken at
 * purchase time, so a subscription belongs to the Eazee account that bought it
 * rather than to whoever is signed in on the same Apple ID.
 */
export function getAppAccountTokenForUser(uid: string) {
  const bytes = createHash("sha256").update(`eazee-app-account-token:${uid}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export type EntitlementDecision =
  | { status: "active"; claim: ProEntitlementClaim }
  | { status: "inactive"; reason: "expired" | "revoked" }
  | { status: "rejected"; reason: "wrong_app" | "unknown_product" | "other_account" };

export function decideEntitlement(
  transaction: AppleTransaction,
  options: { uid: string; bundleId: string; now?: number }
): EntitlementDecision {
  const now = options.now ?? Date.now();
  if (transaction.bundleId !== options.bundleId) {
    return { status: "rejected", reason: "wrong_app" };
  }
  const plan = APPLE_PRODUCT_PLANS[transaction.productId];
  if (!plan) {
    return { status: "rejected", reason: "unknown_product" };
  }
  if (transaction.appAccountToken !== getAppAccountTokenForUser(options.uid)) {
    return { status: "rejected", reason: "other_account" };
  }
  if (transaction.revocationDate) {
    return { status: "inactive", reason: "revoked" };
  }
  if (!transaction.expiresDate || transaction.expiresDate <= now) {
    return { status: "inactive", reason: "expired" };
  }
  return {
    status: "active",
    claim: { plan, expiresAt: transaction.expiresDate, originalTransactionId: transaction.originalTransactionId },
  };
}

/** Pro when the claim has not expired, the account is staff (admin or super admin), or it is on the unlimited-access list. */
export function hasProAccess(
  user: { email?: string; role?: Role; proEntitlement?: ProEntitlementClaim | null },
  options: { unlimitedEmails: string[]; now?: number }
) {
  if (user.role && isStaffRole(user.role)) return true;
  const email = String(user.email || "").trim().toLowerCase();
  if (email && options.unlimitedEmails.includes(email)) return true;
  return !!user.proEntitlement && user.proEntitlement.expiresAt > (options.now ?? Date.now());
}
