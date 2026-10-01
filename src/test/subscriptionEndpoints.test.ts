import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { AppleTransactionVerificationError, type AppleTransaction } from "../subscriptions/appleTransactions";
import { getAppAccountTokenForUser, type ProEntitlementClaim } from "../subscriptions/entitlement";
import { createAppleNotificationsHandler, createSubscriptionsRouter } from "../subscriptions/router";
import { createMemorySubscriptionRecordsStore } from "../subscriptions/records";
import { createMemoryConfigStore, createSubscriptionConfigProvider } from "../usage/limitsConfig";
import { createMemoryUsageStore, getUsageDay } from "../usage/usageStore";

const UID = "buyer";
const DAY = 86_400_000;
const MONTHLY = "com.eazee.subscription.pro.monthly";
const YEARLY = "com.eazee.subscription.pro.yearly";

async function startApp() {
  const now = Date.now();
  const records = createMemorySubscriptionRecordsStore();
  const usage = createMemoryUsageStore();
  const claims = new Map<string, ProEntitlementClaim | null>();
  // Each "JWS" in these tests is a JSON transaction; verification is stubbed.
  const decode = (jws: string) => {
    if (jws === "forged") throw new AppleTransactionVerificationError("Transaction signature is invalid");
    return JSON.parse(jws);
  };
  const app = express();
  app.use(express.json());
  app.post("/subscriptions/apple/notifications", createAppleNotificationsHandler({
    bundleId: "com.eazee.ai",
    records,
    verifyJws: async (jws) => decode(jws),
    setProClaim: async (uid, claim) => { claims.set(uid, claim); },
  }));
  app.use("/subscriptions", createSubscriptionsRouter({
    bundleId: "com.eazee.ai",
    allowXcodeTransactions: true,
    unlimitedEmails: ["developer_sandbox@eazee.ai"],
    records,
    usage,
    config: createSubscriptionConfigProvider({ store: createMemoryConfigStore() }),
    verifyRequest: async (req) => {
      const uid = req.header("x-test-uid");
      return uid ? { uid, email: req.header("x-test-email") || `${uid}@example.com`, authTime: 0 } : null;
    },
    verifyTransaction: async (jws) => decode(jws) as AppleTransaction,
    setProClaim: async (uid, claim) => { claims.set(uid, claim); },
    loadProfile: async (uid) => ({ email: `${uid}@example.com`, displayName: null, providers: ["apple.com"], authCreatedAt: now - DAY }),
  }));
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = (method: string, path: string, body?: unknown, uid: string | null = UID) =>
    fetch(`${url}${path}`, {
      method,
      headers: { "content-type": "application/json", "x-eazee-timezone": "UTC", ...(uid ? { "x-test-uid": uid } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { server, records, usage, claims, request, now };
}

const jws = (overrides: Partial<AppleTransaction> = {}) => JSON.stringify({
  bundleId: "com.eazee.ai",
  productId: MONTHLY,
  transactionId: "1000",
  originalTransactionId: "1000",
  transactionReason: "PURCHASE",
  purchaseDate: Date.now() - 1000,
  expiresDate: Date.now() + 30 * DAY,
  priceMilli: 9990,
  currency: "USD",
  environment: "Xcode",
  appAccountToken: getAppAccountTokenForUser(UID),
  ...overrides,
});

test("every subscription endpoint requires a signed-in user", async () => {
  const { server, request } = await startApp();
  try {
    assert.equal((await request("GET", "/subscriptions/status", undefined, null)).status, 401);
    assert.equal((await request("GET", "/subscriptions/history", undefined, null)).status, 401);
    assert.equal((await request("POST", "/subscriptions/apple/sync", { signedTransactions: [jws()] }, null)).status, 401);
  } finally {
    server.close();
  }
});

test("status reports the plan, limits and today's usage, creating the user record", async () => {
  const { server, request, records, usage } = await startApp();
  try {
    await usage.consume(UID, getUsageDay("UTC"), "aiActions", null);
    const body = await (await request("GET", "/subscriptions/status")).json();
    assert.equal(body.subscription.isPro, false);
    assert.equal(body.subscription.state, "none");
    assert.equal(body.planLimits.chatMessagesPerDay, 5);
    assert.equal(body.limits.pro.chatMessagesPerDay, null);
    assert.equal(body.usage.aiActions, 1);
    assert.equal(body.products[YEARLY].badge, "Best value");
    assert.equal((await records.getUser(UID))?.email, `${UID}@example.com`);

    const sandbox = await (await fetch(
      `http://127.0.0.1:${(server.address() as AddressInfo).port}/subscriptions/status`,
      { headers: { "x-test-uid": "sandbox", "x-test-email": "developer_sandbox@eazee.ai" } }
    )).json();
    assert.equal(sandbox.subscription.isPro, true);
    assert.equal(sandbox.subscription.isUnlimitedAccount, true);
    assert.equal(sandbox.planLimits.chatMessagesPerDay, null);
  } finally {
    server.close();
  }
});

test("buy monthly, upgrade to yearly, cancel: history, status and the Pro claim follow", async () => {
  const { server, request, claims } = await startApp();
  try {
    const bought = await (await request("POST", "/subscriptions/apple/verify", { signedTransaction: jws() })).json();
    assert.equal(bought.isPro, true);
    assert.equal(bought.planId, "monthly");
    assert.equal(claims.get(UID)?.plan, "monthly");

    const upgrade = jws({ transactionId: "1001", productId: YEARLY, purchaseDate: Date.now(), expiresDate: Date.now() + 365 * DAY, priceMilli: 79990 });
    const upgraded = await (await request("POST", "/subscriptions/apple/sync", {
      signedTransactions: [upgrade, jws()],
      renewal: { productId: YEARLY, willAutoRenew: true },
    })).json();
    assert.equal(upgraded.planId, "yearly");
    assert.equal(claims.get(UID)?.plan, "yearly");

    const cancelled = await (await request("POST", "/subscriptions/apple/sync", {
      signedTransactions: [upgrade],
      renewal: { productId: YEARLY, willAutoRenew: false },
    })).json();
    assert.equal(cancelled.isPro, true, "a cancelled subscription stays active until it expires");
    assert.equal(cancelled.subscription.state, "cancelled");
    assert.equal(cancelled.subscription.autoRenew, false);

    const history = await (await request("GET", "/subscriptions/history")).json();
    assert.deepEqual(
      history.transactions.map((t: any) => [t.productId, t.type, t.status, t.price]),
      [[YEARLY, "upgrade", "cancelled", 79.99], [MONTHLY, "purchase", "upgraded", 9.99]]
    );
    assert.equal(history.nextCursor, null);
  } finally {
    server.close();
  }
});

test("sync skips another account's transactions and refuses a forged one", async () => {
  const { server, request, claims } = await startApp();
  try {
    const other = jws({ appAccountToken: getAppAccountTokenForUser("someone-else") });
    assert.equal((await request("POST", "/subscriptions/apple/sync", { signedTransactions: [other] })).status, 403);
    assert.equal(claims.has(UID), false);

    const mixed = await request("POST", "/subscriptions/apple/sync", { signedTransactions: [other, jws()] });
    assert.equal(mixed.status, 200);
    assert.equal((await mixed.json()).planId, "monthly");

    assert.equal((await request("POST", "/subscriptions/apple/sync", { signedTransactions: ["forged"] })).status, 400);
    assert.equal((await request("POST", "/subscriptions/apple/sync", { signedTransactions: [] })).status, 400);
  } finally {
    server.close();
  }
});

test("App Store notifications renew, cancel and refund, and are verified first", async () => {
  const { server, request, claims, records } = await startApp();
  const notify = (notificationType: string, transaction: string, renewal?: Record<string, unknown>) =>
    request("POST", "/subscriptions/apple/notifications", {
      signedPayload: JSON.stringify({
        notificationType,
        notificationUUID: `${notificationType}-${transaction.length}`,
        data: {
          bundleId: "com.eazee.ai",
          signedTransactionInfo: transaction,
          signedRenewalInfo: renewal ? JSON.stringify({ originalTransactionId: "1000", ...renewal }) : undefined,
        },
      }),
    }, null);

  try {
    await request("POST", "/subscriptions/apple/verify", { signedTransaction: jws() });

    const renewalJws = jws({ transactionId: "1001", transactionReason: "RENEWAL", purchaseDate: Date.now(), expiresDate: Date.now() + 60 * DAY });
    assert.equal((await notify("DID_RENEW", renewalJws, { autoRenewStatus: 1, autoRenewProductId: MONTHLY })).status, 200);
    assert.equal((await records.getUser(UID))?.currentTransactionId, "1001");

    assert.equal((await notify("DID_CHANGE_RENEWAL_STATUS", renewalJws, { autoRenewStatus: 0 })).status, 200);
    const cancelled = await records.getUser(UID);
    assert.equal(cancelled?.autoRenew, false);
    assert.equal(cancelled?.autoRenewSource, "apple");
    assert.equal(claims.get(UID)?.plan, "monthly", "still Pro until the period ends");

    const refunded = jws({ transactionId: "1001", transactionReason: "RENEWAL", purchaseDate: Date.now(), expiresDate: Date.now() + 60 * DAY, revocationDate: Date.now() });
    assert.equal((await notify("REFUND", refunded)).status, 200);
    assert.equal(claims.get(UID), null, "a refund ends Pro");

    const forged = await request("POST", "/subscriptions/apple/notifications", { signedPayload: "forged" }, null);
    assert.equal(forged.status, 400);
    const unknown = await notify("DID_RENEW", jws({ appAccountToken: getAppAccountTokenForUser("nobody"), originalTransactionId: "9" }));
    assert.equal((await unknown.json()).ignored, "unknown_account");
  } finally {
    server.close();
  }
});
