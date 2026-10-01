import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SUBSCRIPTION_CONFIG,
  createMemoryConfigStore,
  createSubscriptionConfigProvider,
  parseSubscriptionConfig,
  type SubscriptionConfigStore,
} from "../usage/limitsConfig";
import { assertXcodeTransactionsAllowed } from "../config";

test("a missing or invalid stored config falls back to the defaults, section by section", () => {
  assert.deepEqual(parseSubscriptionConfig(undefined).limits, DEFAULT_SUBSCRIPTION_CONFIG.limits);
  const products = { "com.eazee.subscription.pro.yearly": { displayOrder: 3, badge: null, marketingText: null } };
  const parsed = parseSubscriptionConfig({ limits: { free: { chatMessagesPerDay: "lots" } }, products });
  assert.deepEqual(parsed.limits, DEFAULT_SUBSCRIPTION_CONFIG.limits);
  assert.deepEqual(parsed.products, products);
});

test("the config is cached for the TTL and re-read after it", async () => {
  let reads = 0;
  let clock = 0;
  const store: SubscriptionConfigStore = {
    async read() {
      reads += 1;
      return { limits: { ...DEFAULT_SUBSCRIPTION_CONFIG.limits, free: { ...DEFAULT_SUBSCRIPTION_CONFIG.limits.free, chatMessagesPerDay: reads } } };
    },
    async write() {},
  };
  const provider = createSubscriptionConfigProvider({ store, ttlMs: 60_000, now: () => clock });
  assert.equal((await provider.get()).limits.free.chatMessagesPerDay, 1);
  clock = 59_999;
  assert.equal((await provider.get()).limits.free.chatMessagesPerDay, 1);
  clock = 60_000;
  assert.equal((await provider.get()).limits.free.chatMessagesPerDay, 2);
});

test("an unreadable config keeps the last good copy, then the defaults", async () => {
  let failing = false;
  let clock = 0;
  const store: SubscriptionConfigStore = {
    async read() {
      if (failing) throw new Error("Firestore unavailable");
      return { limits: { ...DEFAULT_SUBSCRIPTION_CONFIG.limits, free: { ...DEFAULT_SUBSCRIPTION_CONFIG.limits.free, chatMessagesPerDay: 9 } } };
    },
    async write() {},
  };
  const provider = createSubscriptionConfigProvider({ store, ttlMs: 10, now: () => clock });
  assert.equal((await provider.get()).limits.free.chatMessagesPerDay, 9);
  failing = true;
  clock = 100;
  assert.equal((await provider.get()).limits.free.chatMessagesPerDay, 9);

  const cold = createSubscriptionConfigProvider({ store, ttlMs: 10 });
  assert.deepEqual((await cold.get()).limits, DEFAULT_SUBSCRIPTION_CONFIG.limits);
});

test("saving the config takes effect immediately, without waiting for the cache", async () => {
  const provider = createSubscriptionConfigProvider({ store: createMemoryConfigStore(), ttlMs: 60_000 });
  await provider.get();
  const limits = structuredClone(DEFAULT_SUBSCRIPTION_CONFIG.limits);
  limits.free.voiceMinutesPerDay = 10;
  const saved = await provider.update({ limits }, "admin@eazee.ai");
  assert.equal(saved.limits.free.voiceMinutesPerDay, 10);
  assert.equal((await provider.get()).limits.free.voiceMinutesPerDay, 10);
});

test("Xcode StoreKit transactions can only be allowed on a development server", () => {
  assert.doesNotThrow(() => assertXcodeTransactionsAllowed("development", true));
  assert.doesNotThrow(() => assertXcodeTransactionsAllowed("production", false));
  assert.throws(() => assertXcodeTransactionsAllowed("production", true), /APP_ENV=development/);
  assert.throws(() => assertXcodeTransactionsAllowed("staging", true), /APP_ENV=development/);
});
