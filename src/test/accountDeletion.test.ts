import test from "node:test";
import assert from "node:assert/strict";
import {
  ACCOUNT_DELETION_RECOVERY_TOKEN_TTL_SECONDS,
  createAccountDeletionRecoveryToken,
  deleteAccountData,
  deleteAuthenticatedAccount,
  getAccountDeletionRecoveryUid,
  getAccountDeletionStatus,
  isAccountDeletionRecoveryError,
  isRecentAuthentication,
  validateAppleIdentityClaims,
} from "../accountDeletion";
import { isFirebaseAuthenticationError } from "../auth/firebase";

process.env.ACCOUNT_DELETION_SIGNING_SECRET = "test-account-deletion-signing-secret-1234567890";

function createDependencies(providerData: { providerId: string; uid: string }[]) {
  const calls: string[] = [];
  return {
    calls,
    dependencies: {
      getUser: async () => ({ providerData } as any),
      revokeApple: async () => {
        calls.push("apple");
      },
      deleteFirebaseUser: async () => {
        calls.push("firebase");
      },
    },
  };
}

test("account deletion deletes Firebase user", async () => {
  const { calls, dependencies } = createDependencies([{ providerId: "google.com", uid: "google-user" }]);

  await deleteAccountData("firebase-user", undefined, dependencies);

  assert.deepEqual(calls, ["firebase"]);
});

test("Apple-linked account requires authorization code", async () => {
  const { calls, dependencies } = createDependencies([{ providerId: "apple.com", uid: "apple-user" }]);

  await assert.rejects(
    deleteAccountData("firebase-user", undefined, dependencies),
    /Apple authorization is required/
  );
  assert.deepEqual(calls, []);
});

test("Apple revocation completes before Firebase deletion", async () => {
  const { calls, dependencies } = createDependencies([{ providerId: "apple.com", uid: "apple-user" }]);

  await deleteAccountData("firebase-user", "apple-code", dependencies);

  assert.deepEqual(calls, ["apple", "firebase"]);
});

test("Apple failure prevents Firebase deletion", async () => {
  const apple = createDependencies([{ providerId: "apple.com", uid: "apple-user" }]);
  apple.dependencies.revokeApple = async () => {
    apple.calls.push("apple");
    throw new Error("apple failed");
  };
  await assert.rejects(deleteAccountData("firebase-user", "apple-code", apple.dependencies), /apple failed/);
  assert.deepEqual(apple.calls, ["apple"]);
});

test("Apple identity claims must match linked provider", () => {
  assert.throws(
    () => validateAppleIdentityClaims(
      { iss: "https://appleid.apple.com", aud: "com.eazee.ai", sub: "other-user" },
      "apple-user",
      "com.eazee.ai"
    ),
    /Apple account verification failed/
  );
});

test("account deletion requires authentication within five minutes", () => {
  assert.equal(isRecentAuthentication(900, 1000), true);
  assert.equal(isRecentAuthentication(699, 1000), false);
  assert.equal(isRecentAuthentication(1001, 1000), false);
});

test("account deletion distinguishes credential failures from Firebase operational failures", () => {
  assert.equal(isFirebaseAuthenticationError({ code: "auth/invalid-id-token" }), true);
  assert.equal(isFirebaseAuthenticationError({ code: "auth/id-token-revoked" }), true);
  assert.equal(isFirebaseAuthenticationError({ code: "auth/user-disabled" }), true);
  assert.equal(isFirebaseAuthenticationError({ code: "auth/internal-error" }), false);
  assert.equal(isFirebaseAuthenticationError({ code: "auth/insufficient-permission" }), false);
});

test("account deletion recovery token securely preserves Firebase uid", async () => {
  const token = await createAccountDeletionRecoveryToken("firebase-user");

  assert.equal(await getAccountDeletionRecoveryUid(token), "firebase-user");
  await assert.rejects(getAccountDeletionRecoveryUid(`${token}invalid`));
});

test("account deletion recovery token expires", async () => {
  const expiredToken = await createAccountDeletionRecoveryToken(
    "firebase-user",
    Math.floor(Date.now() / 1000) - ACCOUNT_DELETION_RECOVERY_TOKEN_TTL_SECONDS - 1
  );

  await assert.rejects(getAccountDeletionRecoveryUid(expiredToken));
});

test("account deletion rejects stale or malformed recovery tokens as recovery errors", async () => {
  const staleToken = await createAccountDeletionRecoveryToken("other-user");
  const user = { uid: "firebase-user", authTime: 1000 };

  await assert.rejects(deleteAuthenticatedAccount(user, undefined, staleToken), /does not match account/);
  await assert.rejects(deleteAuthenticatedAccount(user, undefined, `${staleToken}invalid`), /Invalid account deletion recovery token/);

  assert.equal(isAccountDeletionRecoveryError(new Error("Account deletion recovery token does not match account")), true);
  assert.equal(isAccountDeletionRecoveryError(new Error("Invalid account deletion recovery token")), true);
  assert.equal(isAccountDeletionRecoveryError(new Error("Apple request failed")), false);
});

test("account deletion status positively confirms only missing Firebase users", async () => {
  assert.equal(await getAccountDeletionStatus("firebase-user", async () => ({})), false);
  assert.equal(
    await getAccountDeletionStatus("firebase-user", async () => {
      throw { code: "auth/user-not-found" };
    }),
    true
  );
  await assert.rejects(
    getAccountDeletionStatus("firebase-user", async () => {
      throw { code: "auth/invalid-user-token" };
    })
  );
});
