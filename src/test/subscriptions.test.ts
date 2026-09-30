import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { SignJWT, generateKeyPair } from "jose";
import {
  AppleTransactionVerificationError,
  verifyAppleSignedTransaction,
  type AppleTransaction,
} from "../subscriptions/appleTransactions";
import { decideEntitlement, getAppAccountTokenForUser, hasProAccess } from "../subscriptions/entitlement";
import { createSubscriptionsRouter } from "../subscriptions/router";
import { createProAccessMiddleware, isProOnlyAiPath } from "../subscriptions/proAccess";

const UID = "user-1";
const NOW = Date.UTC(2026, 8, 30);
const baseTransaction = (overrides: Partial<AppleTransaction> = {}): AppleTransaction => ({
  bundleId: "com.eazee.ai",
  productId: "com.eazee.subscription.pro.yearly",
  transactionId: "t-2",
  originalTransactionId: "t-1",
  expiresDate: NOW + 86_400_000,
  appAccountToken: getAppAccountTokenForUser(UID),
  ...overrides,
});

async function listen(app: express.Express) {
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

test("app account tokens are stable UUIDs, different per user", () => {
  const token = getAppAccountTokenForUser(UID);
  assert.match(token, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(getAppAccountTokenForUser(UID), token);
  assert.notEqual(getAppAccountTokenForUser("user-2"), token);
});

test("entitlement is active only for this app, a known plan, this account, and an unexpired period", () => {
  const options = { uid: UID, bundleId: "com.eazee.ai", now: NOW };
  assert.deepEqual(decideEntitlement(baseTransaction(), options), {
    status: "active",
    claim: { plan: "yearly", expiresAt: NOW + 86_400_000, originalTransactionId: "t-1" },
  });
  assert.equal((decideEntitlement(baseTransaction({ bundleId: "com.other" }), options) as any).reason, "wrong_app");
  assert.equal((decideEntitlement(baseTransaction({ productId: "coins" }), options) as any).reason, "unknown_product");
  assert.equal(
    (decideEntitlement(baseTransaction({ appAccountToken: getAppAccountTokenForUser("user-2") }), options) as any).reason,
    "other_account"
  );
  assert.equal((decideEntitlement(baseTransaction({ appAccountToken: undefined }), options) as any).reason, "other_account");
  assert.equal((decideEntitlement(baseTransaction({ expiresDate: NOW - 1 }), options) as any).reason, "expired");
  assert.equal((decideEntitlement(baseTransaction({ revocationDate: NOW - 1 }), options) as any).reason, "revoked");
});

test("Pro access comes from an unexpired claim or the unlimited-email list", () => {
  const options = { unlimitedEmails: ["developer_sandbox@eazee.ai"], now: NOW };
  const claim = { plan: "monthly" as const, expiresAt: NOW + 1, originalTransactionId: "t-1" };
  assert.equal(hasProAccess({ proEntitlement: claim }, options), true);
  assert.equal(hasProAccess({ proEntitlement: { ...claim, expiresAt: NOW } }, options), false);
  assert.equal(hasProAccess({ email: " Developer_Sandbox@eazee.ai " }, options), true);
  assert.equal(hasProAccess({ email: "someone@eazee.ai" }, options), false);
});

test("the verifier rejects anything not signed with an App Store certificate chain", async () => {
  const { privateKey } = await generateKeyPair("ES256");
  const unchained = await new SignJWT(baseTransaction() as any).setProtectedHeader({ alg: "ES256" }).sign(privateKey);

  await assert.rejects(verifyAppleSignedTransaction("not-a-jws"), AppleTransactionVerificationError);
  await assert.rejects(verifyAppleSignedTransaction(unchained), /App Store certificate chain/);
});

test("Xcode StoreKit test transactions are accepted only when explicitly allowed", async () => {
  const { privateKey } = await generateKeyPair("ES256");
  const xcodeTransaction = await new SignJWT({ ...baseTransaction(), environment: "Xcode" } as any)
    .setProtectedHeader({ alg: "ES256" })
    .sign(privateKey);

  await assert.rejects(verifyAppleSignedTransaction(xcodeTransaction), AppleTransactionVerificationError);
  const transaction = await verifyAppleSignedTransaction(xcodeTransaction, { allowXcodeEnvironment: true });
  assert.equal(transaction.environment, "Xcode");
  assert.equal(transaction.productId, "com.eazee.subscription.pro.yearly");
});

test("the verify endpoint saves Pro for the buyer and refuses other accounts' transactions", async () => {
  const savedClaims: Array<[string, unknown]> = [];
  let nextTransaction = baseTransaction({ expiresDate: Date.now() + 86_400_000 });
  const app = express();
  app.use(express.json());
  app.use("/subscriptions", createSubscriptionsRouter({
    bundleId: "com.eazee.ai",
    allowXcodeTransactions: false,
    verifyRequest: async (req) => (req.header("authorization") ? { uid: UID, authTime: 0 } : null),
    verifyTransaction: async (jws) => {
      if (jws === "bad") throw new AppleTransactionVerificationError("Transaction signature is invalid");
      return nextTransaction;
    },
    setProClaim: async (uid, claim) => { savedClaims.push([uid, claim]); },
  }));
  const { server, url } = await listen(app);
  const post = (body: unknown, auth = true) => fetch(`${url}/subscriptions/apple/verify`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(auth ? { authorization: "Bearer token" } : {}) },
    body: JSON.stringify(body),
  });

  try {
    assert.equal((await post({ signedTransaction: "jws" }, false)).status, 401);

    const tokenResponse = await fetch(`${url}/subscriptions/apple/account-token`, { headers: { authorization: "Bearer token" } });
    assert.deepEqual(await tokenResponse.json(), { appAccountToken: getAppAccountTokenForUser(UID) });

    const active = await post({ signedTransaction: "jws" });
    assert.equal(active.status, 200);
    assert.deepEqual(await active.json(), { isPro: true, planId: "yearly", expiresAt: nextTransaction.expiresDate });
    assert.equal((savedClaims.at(-1)?.[1] as any)?.plan, "yearly");

    nextTransaction = baseTransaction({ appAccountToken: getAppAccountTokenForUser("user-2") });
    const otherAccount = await post({ signedTransaction: "jws" });
    assert.equal(otherAccount.status, 403);
    assert.equal(savedClaims.length, 1, "a mismatched transaction must not change this account's claim");

    nextTransaction = baseTransaction({ expiresDate: Date.now() - 1 });
    const expired = await post({ signedTransaction: "jws" });
    assert.deepEqual(await expired.json(), { isPro: false, planId: null, reason: "expired" });
    assert.equal(savedClaims.at(-1)?.[1], null);

    assert.equal((await post({ signedTransaction: "bad" })).status, 400);
  } finally {
    server.close();
  }
});

test("Pro-only AI paths are gated only when enforcement is on", async () => {
  assert.equal(isProOnlyAiPath("/ai/goal-guidance"), true);
  assert.equal(isProOnlyAiPath("/ai/recipe/generate"), true);
  assert.equal(isProOnlyAiPath("/ai/route"), false);

  let user: any = { uid: UID, authTime: 0 };
  const buildApp = (enabled: boolean) => {
    const app = express();
    app.use("/ai", createProAccessMiddleware({ enabled, unlimitedEmails: [], verifyRequest: async () => user }));
    app.post("/ai/*", (_req, res) => res.json({ ok: true }));
    return app;
  };

  const enforced = await listen(buildApp(true));
  const relaxed = await listen(buildApp(false));
  try {
    assert.equal((await fetch(`${enforced.url}/ai/goal-guidance`, { method: "POST" })).status, 403);
    assert.equal((await fetch(`${enforced.url}/ai/route`, { method: "POST" })).status, 200);
    assert.equal((await fetch(`${relaxed.url}/ai/goal-guidance`, { method: "POST" })).status, 200);

    user = { ...user, proEntitlement: { plan: "yearly", expiresAt: Date.now() + 60_000, originalTransactionId: "t-1" } };
    assert.equal((await fetch(`${enforced.url}/ai/goal-guidance`, { method: "POST" })).status, 200);
  } finally {
    enforced.server.close();
    relaxed.server.close();
  }
});
