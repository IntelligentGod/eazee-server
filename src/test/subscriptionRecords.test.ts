import test from "node:test";
import assert from "node:assert/strict";
import type { AppleTransaction } from "../subscriptions/appleTransactions";
import { getAppAccountTokenForUser } from "../subscriptions/entitlement";
import {
  applyRenewalUpdate,
  classifyTransaction,
  createMemorySubscriptionRecordsStore,
  deriveSubscriptionState,
  hasProEntitlement,
  newUserRecord,
  transactionDisplayStatus,
} from "../subscriptions/records";

const UID = "buyer";
const DAY = 86_400_000;
const START = Date.UTC(2026, 9, 1, 12);
const MONTHLY = "com.eazee.subscription.pro.monthly";
const YEARLY = "com.eazee.subscription.pro.yearly";
const profile = { email: "Buyer@Example.com", displayName: "Buyer", providers: ["apple.com"], authCreatedAt: START - DAY };

const tx = (overrides: Partial<AppleTransaction> = {}): AppleTransaction => ({
  bundleId: "com.eazee.ai",
  productId: MONTHLY,
  transactionId: "1000",
  originalTransactionId: "1000",
  transactionReason: "PURCHASE",
  purchaseDate: START,
  expiresDate: START + 30 * DAY,
  priceMilli: 9990,
  currency: "USD",
  environment: "Xcode",
  appAccountToken: getAppAccountTokenForUser(UID),
  ...overrides,
});

test("new users get a searchable email and their StoreKit account token", () => {
  const user = newUserRecord(UID, profile, START);
  assert.equal(user.emailLower, "buyer@example.com");
  assert.equal(user.appAccountToken, getAppAccountTokenForUser(UID));
  assert.equal(user.plan, "free");
  assert.equal(deriveSubscriptionState(user, START), "none");
});

test("transactions are classified as purchase, renewal, upgrade or downgrade", () => {
  const subscribedMonthly = { ...newUserRecord(UID, profile, START), currentProductId: MONTHLY, currentPurchaseDate: START, originalTransactionId: "1000" };
  const subscribedYearly = { ...subscribedMonthly, currentProductId: YEARLY };
  assert.equal(classifyTransaction(tx(), null), "purchase");
  assert.equal(classifyTransaction(tx({ transactionId: "1001", transactionReason: "RENEWAL", purchaseDate: START + 30 * DAY }), subscribedMonthly), "renewal");
  assert.equal(classifyTransaction(tx({ transactionId: "1002", productId: YEARLY, purchaseDate: START + DAY }), subscribedMonthly), "upgrade");
  assert.equal(
    classifyTransaction(tx({ transactionId: "1003", transactionReason: "RENEWAL", purchaseDate: START + 365 * DAY }), subscribedYearly),
    "downgrade",
    "a downgrade takes effect at renewal"
  );
  assert.equal(classifyTransaction(tx({ transactionId: "2000", originalTransactionId: "2000", productId: YEARLY }), subscribedMonthly), "purchase",
    "a new subscription is not a plan change");
});

test("buying monthly, upgrading to yearly and cancelling are recorded", async () => {
  const store = createMemorySubscriptionRecordsStore();
  await store.ensureUser(UID, async () => profile);

  const bought = await store.saveTransaction({ uid: UID, transaction: tx(), source: "app", now: START });
  assert.equal(bought.created, true);
  assert.equal(bought.record.type, "purchase");
  assert.equal(bought.user.plan, "monthly");
  assert.equal(deriveSubscriptionState(bought.user, START), "active");

  const upgradedAt = START + 3 * DAY;
  const upgrade = await store.saveTransaction({
    uid: UID,
    transaction: tx({ transactionId: "1001", productId: YEARLY, purchaseDate: upgradedAt, expiresDate: upgradedAt + 365 * DAY, priceMilli: 79990 }),
    source: "app",
    now: upgradedAt,
  });
  assert.equal(upgrade.record.type, "upgrade");
  assert.equal(upgrade.user.plan, "yearly");
  assert.equal(upgrade.user.currentPriceMilli, 79990);

  const history = await store.listUserTransactions(UID, { limit: 10 });
  assert.deepEqual(history.map((record) => record.transactionId), ["1001", "1000"]);
  assert.equal(transactionDisplayStatus(history[1], upgradedAt), "upgraded");
  assert.equal(transactionDisplayStatus(history[0], upgradedAt), "active");

  const cancelled = await store.updateRenewal(UID, { autoRenew: false, pendingProductId: null, source: "device" }, upgradedAt + DAY);
  assert.equal(deriveSubscriptionState(cancelled!, upgradedAt + DAY), "cancelled");
  assert.equal(hasProEntitlement(deriveSubscriptionState(cancelled!, upgradedAt + DAY)), false, "cancelling ends Pro at once");
  assert.equal(hasProEntitlement("active"), true);
  assert.equal(hasProEntitlement("billing_retry"), true);
  const [current] = await store.listUserTransactions(UID, { limit: 1 });
  assert.equal(transactionDisplayStatus(current, upgradedAt + DAY), "cancelled");
  assert.equal(deriveSubscriptionState(cancelled!, upgradedAt + 366 * DAY), "expired");
  assert.equal(transactionDisplayStatus(current, upgradedAt + 366 * DAY), "expired");
});

test("replaying a transaction never changes its type or counts its revenue twice", async () => {
  const store = createMemorySubscriptionRecordsStore();
  await store.saveTransaction({ uid: UID, transaction: tx(), source: "app", now: START });
  const replay = await store.saveTransaction({ uid: UID, transaction: tx(), source: "apple_notification", now: START + 1000 });
  assert.equal(replay.created, false);
  assert.equal(replay.record.source, "app");
  const day = store.revenue.get("Xcode_2026-10-01")!;
  assert.equal(day.count, 1);
  assert.deepEqual(day.grossMilli, { USD: 9990 });
  assert.equal(Object.values(day.byProduct)[0].productId, MONTHLY);
});

test("an older transaction replayed later does not replace the current plan", async () => {
  const store = createMemorySubscriptionRecordsStore();
  await store.saveTransaction({ uid: UID, transaction: tx({ transactionId: "1001", transactionReason: "RENEWAL", purchaseDate: START + 30 * DAY, expiresDate: START + 60 * DAY }), source: "app", now: START + 30 * DAY });
  const old = await store.saveTransaction({ uid: UID, transaction: tx(), source: "app", now: START + 31 * DAY });
  assert.equal(old.user.currentTransactionId, "1001");
  assert.equal(old.user.expiresAt, START + 60 * DAY);
});

test("a refund marks the transaction refunded and is subtracted from revenue", async () => {
  const store = createMemorySubscriptionRecordsStore();
  await store.saveTransaction({ uid: UID, transaction: tx(), source: "app", now: START });
  const refundedAt = START + 5 * DAY;
  const refund = await store.saveTransaction({ uid: UID, transaction: tx({ revocationDate: refundedAt }), source: "apple_notification", now: refundedAt });
  assert.equal(refund.record.status, "refunded");
  assert.equal(deriveSubscriptionState(refund.user, refundedAt), "refunded");
  assert.deepEqual(store.revenue.get("Xcode_2026-10-06")?.refundMilli, { USD: 9990 });
});

test("free trials are recorded with no revenue", async () => {
  const store = createMemorySubscriptionRecordsStore();
  const trial = await store.saveTransaction({
    uid: UID, transaction: tx({ priceMilli: 0, offerType: 1, offerDiscountType: "FREE_TRIAL" }), source: "app", now: START,
  });
  assert.equal(trial.record.isTrial, true);
  assert.equal(store.revenue.size, 0);
});

test("renewal info records a plan change due at renewal, but not the current product", () => {
  const user = { ...newUserRecord(UID, profile, START), currentProductId: YEARLY };
  assert.equal(applyRenewalUpdate(user, { autoRenew: true, pendingProductId: MONTHLY, source: "device" }, START).pendingProductId, MONTHLY);
  assert.equal(applyRenewalUpdate(user, { autoRenew: true, pendingProductId: YEARLY, source: "device" }, START).pendingProductId, null);
});
