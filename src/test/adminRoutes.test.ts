import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import type { AppleTransaction } from "../subscriptions/appleTransactions";
import { getAppAccountTokenForUser } from "../subscriptions/entitlement";
import { createMemorySubscriptionRecordsStore } from "../subscriptions/records";
import { createAdminRouter, summarizeIncome } from "../admin/router";
import {
  DEFAULT_SUBSCRIPTION_CONFIG,
  createMemoryConfigStore,
  createSubscriptionConfigProvider,
} from "../usage/limitsConfig";
import { createMemoryUsageStore } from "../usage/usageStore";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 15, 12);
const MONTHLY = "com.eazee.subscription.pro.monthly";
const YEARLY = "com.eazee.subscription.pro.yearly";

const tx = (uid: string, overrides: Partial<AppleTransaction> = {}): AppleTransaction => ({
  bundleId: "com.eazee.ai",
  productId: MONTHLY,
  transactionId: `${uid}-1`,
  originalTransactionId: `${uid}-1`,
  transactionReason: "PURCHASE",
  purchaseDate: NOW - 2 * DAY,
  expiresDate: NOW + 28 * DAY,
  priceMilli: 9990,
  currency: "USD",
  environment: "Production",
  appAccountToken: getAppAccountTokenForUser(uid),
  ...overrides,
});

async function startApp() {
  const records = createMemorySubscriptionRecordsStore();
  const usage = createMemoryUsageStore();
  const config = createSubscriptionConfigProvider({ store: createMemoryConfigStore() });
  const profile = (email: string) => async () => ({ email, displayName: null, providers: ["password"], authCreatedAt: NOW - 30 * DAY });
  await records.ensureUser("alice", profile("alice@example.com"));
  await records.ensureUser("bob", profile("bob@example.com"));
  await records.ensureUser("carol", profile("carol@example.com"));
  await records.saveTransaction({ uid: "alice", transaction: tx("alice"), source: "app", now: NOW - 2 * DAY });
  await records.saveTransaction({
    uid: "bob",
    transaction: tx("bob", { productId: YEARLY, priceMilli: 79990, purchaseDate: NOW - DAY, expiresDate: NOW + 364 * DAY }),
    source: "app",
    now: NOW - DAY,
  });
  await records.updateRenewal("bob", { autoRenew: false, pendingProductId: null, source: "device" }, NOW);
  await usage.consume("alice", "2026-10-15", "aiActions", null);

  const app = express();
  app.use(express.json());
  app.use("/admin", createAdminRouter({
    records,
    config,
    usage,
    unlimitedEmails: [],
    now: () => NOW,
    verifyRequest: async (req) => {
      const role = req.header("x-test-role");
      if (!role) return null;
      return { uid: role === "admin" ? "admin-uid" : "alice", email: `${role}@eazee.ai`, authTime: 0, role: role === "admin" ? "admin" : "customer" };
    },
    getAuthUser: async (uid) => (uid === "ghost" ? null : { uid, providers: ["password"], disabled: false }),
  }));
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = (path: string, init: { method?: string; body?: unknown; role?: string | null } = {}) =>
    fetch(`${url}${path}`, {
      method: init.method ?? "GET",
      headers: { "content-type": "application/json", ...(init.role === null ? {} : { "x-test-role": init.role ?? "admin" }) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  return { server, request, config };
}

test("admin endpoints refuse signed-out users and customers", async () => {
  const { server, request } = await startApp();
  try {
    assert.equal((await request("/admin/users", { role: null })).status, 401);
    const customer = await request("/admin/users", { role: "customer" });
    assert.equal(customer.status, 403);
    assert.equal((await customer.json()).code, "ADMIN_REQUIRED");
    assert.equal((await request("/admin/config/limits", { method: "PUT", role: "customer", body: {} })).status, 403);
    assert.equal((await request("/admin/me")).status, 200);
  } finally {
    server.close();
  }
});

test("users can be listed, searched by email prefix, and opened", async () => {
  const { server, request } = await startApp();
  try {
    const all = await (await request("/admin/users")).json();
    assert.deepEqual(all.users.map((user: any) => user.email), ["alice@example.com", "bob@example.com", "carol@example.com"]);
    assert.equal(all.users[0].subscription.plan, "monthly");
    assert.equal(all.users[1].subscription.state, "cancelled");
    assert.equal(all.users[2].subscription.state, "none");

    const found = await (await request("/admin/users?search=BO")).json();
    assert.deepEqual(found.users.map((user: any) => user.uid), ["bob"]);

    const paged = await (await request("/admin/users?limit=2")).json();
    assert.equal(paged.nextCursor, "bob");
    const next = await (await request(`/admin/users?limit=2&cursor=${paged.nextCursor}`)).json();
    assert.deepEqual(next.users.map((user: any) => user.uid), ["carol"]);

    const detail = await (await request("/admin/users/alice")).json();
    assert.equal(detail.transactions.length, 1);
    assert.equal(detail.transactions[0].price, 9.99);
    assert.equal(detail.usage[0].aiActions, 1);
    assert.equal((await request("/admin/users/ghost")).status, 404);
  } finally {
    server.close();
  }
});

test("purchases filter by product, status and date", async () => {
  const { server, request } = await startApp();
  try {
    const all = await (await request("/admin/purchases")).json();
    assert.deepEqual(all.purchases.map((p: any) => p.uid), ["bob", "alice"]);
    const yearly = await (await request(`/admin/purchases?productId=${YEARLY}`)).json();
    assert.deepEqual(yearly.purchases.map((p: any) => p.uid), ["bob"]);
    const cancelled = await (await request("/admin/purchases?status=cancelled")).json();
    assert.deepEqual(cancelled.purchases.map((p: any) => p.uid), ["bob"]);
    const lastDay = await (await request("/admin/purchases?from=2026-10-14&to=2026-10-14")).json();
    assert.deepEqual(lastDay.purchases.map((p: any) => p.uid), ["bob"]);
    assert.equal((await request("/admin/purchases?status=bogus")).status, 400);
  } finally {
    server.close();
  }
});

test("income totals revenue per day and product, labelled estimated", async () => {
  const { server, request } = await startApp();
  try {
    const income = await (await request("/admin/income?from=2026-10-01&to=2026-10-15")).json();
    assert.equal(income.estimated, true);
    assert.deepEqual(income.totals.gross, { USD: 89.98 });
    assert.equal(income.totals.byProduct[YEARLY].count, 1);
    assert.deepEqual(income.buckets.map((b: any) => b.period), ["2026-10-13", "2026-10-14"]);
    assert.equal(income.subscribers.active, 1);
    assert.equal(income.subscribers.cancelled, 1);
    assert.deepEqual(income.subscribers.mrr, { USD: 9.99 }, "cancelled subscriptions are left out of MRR");

    const monthly = await (await request("/admin/income?granularity=month&from=2026-10-01&to=2026-10-15")).json();
    assert.deepEqual(monthly.buckets.map((b: any) => [b.period, b.count]), [["2026-10", 2]]);
    assert.equal((await request("/admin/income?from=2026-10-15&to=2026-10-01")).status, 400);
    const sandbox = await (await request("/admin/income?environment=Sandbox&from=2026-10-01&to=2026-10-15")).json();
    assert.equal(sandbox.totals.count, 0);
  } finally {
    server.close();
  }
});

test("MRR counts a yearly plan as a twelfth of its price and skips trials", () => {
  const base = { environment: "Production", expiresAt: NOW + DAY, currentProductId: YEARLY, autoRenew: true, currency: "USD", revokedAt: null, billingRetry: false } as any;
  const summary = summarizeIncome({
    days: [],
    subscribers: [{ ...base, plan: "yearly", currentPriceMilli: 120000 }, { ...base, plan: "monthly", currentPriceMilli: 0 }],
    granularity: "day",
    environment: "Production",
    now: NOW,
  });
  assert.deepEqual(summary.subscribers.mrr, { USD: 10 });
  assert.equal(summary.subscribers.trial, 1);
});

test("admins can change limits and product display settings, validated", async () => {
  const { server, request, config } = await startApp();
  try {
    const limits = structuredClone(DEFAULT_SUBSCRIPTION_CONFIG.limits);
    limits.free.chatMessagesPerDay = 10;
    limits.free.guidance.goalGuidance = 2;
    const saved = await request("/admin/config/limits", { method: "PUT", body: { limits } });
    assert.equal(saved.status, 200);
    assert.equal((await config.get()).limits.free.chatMessagesPerDay, 10);
    assert.equal((await config.get()).updatedBy, "admin@eazee.ai");

    const invalid = structuredClone(limits) as any;
    invalid.free.chatMessagesPerDay = -1;
    assert.equal((await request("/admin/config/limits", { method: "PUT", body: { limits: invalid } })).status, 400);

    const products = { [YEARLY]: { displayOrder: 0, badge: "Save 33%", marketingText: "Two months free" } };
    assert.equal((await request("/admin/config/products", { method: "PUT", body: { products } })).status, 200);
    assert.deepEqual((await (await request("/admin/config")).json()).products, products);
    assert.equal((await request("/admin/config/products", {
      method: "PUT", body: { products: { [YEARLY]: { displayOrder: 0, badge: "x".repeat(31), marketingText: null } } },
    })).status, 400);
  } finally {
    server.close();
  }
});
