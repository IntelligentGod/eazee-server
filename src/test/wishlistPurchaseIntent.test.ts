import test from "node:test";
import assert from "node:assert/strict";
import {
  WishlistPurchaseIntentRequestSchema,
  buildWishlistPurchaseIntentMessages,
  normalizeWishlistPurchaseIntentResponse,
} from "../ai/wishlistPurchaseIntent";

test("wishlist purchase intent request accepts guidance surfaces", () => {
  assert.equal(WishlistPurchaseIntentRequestSchema.safeParse({
    message: "buy iphone 17",
    surface: "skill",
  }).success, true);
  assert.equal(WishlistPurchaseIntentRequestSchema.safeParse({
    message: "buy iphone 17",
    surface: "chat",
  }).success, false);
});

test("wishlist purchase intent prompt excludes research questions", () => {
  const messages = buildWishlistPurchaseIntentMessages({
    message: "where can I buy guitar strings?",
    surface: "skill",
    contextTitle: "learn guitar",
    contextDetails: "",
    recentMessages: [],
    userTimezone: "Asia/Kolkata",
    locale: "en-US",
  });

  const system = String(messages[0]?.content || "");
  assert.match(system, /where can I buy/i);
  assert.match(system, /Return false/i);
});

test("wishlist purchase intent prompt includes recent messages for references", () => {
  const messages = buildWishlistPurchaseIntentMessages({
    message: "can I buy the first one",
    surface: "skill",
    contextTitle: "learn python",
    contextDetails: "",
    recentMessages: [
      {
        role: "assistant",
        content: "Good options: 1. Automate the Boring Stuff with Python 2. Python Crash Course 3. Fluent Python",
      },
    ],
    userTimezone: "Asia/Kolkata",
    locale: "en-US",
  });

  const system = String(messages[0]?.content || "");
  const user = String(messages[1]?.content || "");
  assert.match(system, /first one/i);
  assert.match(system, /recentMessages/i);
  assert.match(user, /Automate the Boring Stuff with Python/i);
});

test("wishlist purchase intent prompt prefers newest assistant list for ordinal references", () => {
  const messages = buildWishlistPurchaseIntentMessages({
    message: "add the first one",
    surface: "skill",
    contextTitle: "learn python",
    contextDetails: "",
    recentMessages: [
      {
        role: "assistant",
        content: "Old list: 1. Automate the Boring Stuff with Python",
      },
      {
        role: "assistant",
        content: "New list: 1. Python Crash Course",
      },
    ],
    userTimezone: "Asia/Kolkata",
    locale: "en-US",
  });

  const system = String(messages[0]?.content || "");
  assert.match(system, /ignore older lists/i);
  assert.match(system, /newest assistant recommendation list/i);
});

test("wishlist purchase intent prompt prevents history-driven purchases", () => {
  const messages = buildWishlistPurchaseIntentMessages({
    message: "give me three more python book recommendations",
    surface: "skill",
    contextTitle: "learn python",
    contextDetails: "",
    recentMessages: [
      {
        role: "user",
        content: "can I buy the first one",
      },
      {
        role: "assistant",
        content: "Add Automate the Boring Stuff with Python to Wishlist?",
      },
    ],
    userTimezone: "Asia/Kolkata",
    locale: "en-US",
  });

  const system = String(messages[0]?.content || "");
  const user = String(messages[1]?.content || "");
  assert.match(system, /latest message is the only source of intent/i);
  assert.match(system, /never infer purchase intent from recentMessages/i);
  assert.match(user, /three more python book recommendations/i);
});

test("wishlist purchase intent prompt rejects generic find-and-add categories", () => {
  const messages = buildWishlistPurchaseIntentMessages({
    message: "find a beginner workbook and add it to wishlist",
    surface: "goal",
    contextTitle: "learn spanish",
    contextDetails: "",
    recentMessages: [
      {
        role: "assistant",
        content: "A workbook can help with daily practice.",
      },
    ],
    userTimezone: "Asia/Kolkata",
    locale: "en-US",
  });

  const system = String(messages[0]?.content || "");
  assert.match(system, /find, recommend, choose, pick, or suggest/i);
  assert.match(system, /beginner workbook/i);
});

test("wishlist purchase intent prompt asks for obvious typo correction", () => {
  const messages = buildWishlistPurchaseIntentMessages({
    message: "i want to buy roller smates",
    surface: "task",
    contextTitle: "",
    contextDetails: "",
    recentMessages: [],
    userTimezone: "Asia/Kolkata",
    locale: "en-US",
  });

  const system = String(messages[0]?.content || "");
  assert.match(system, /knif -> knife/i);
  assert.match(system, /roller smates -> roller skates/i);
  assert.match(system, /Do not autocorrect brand names/i);
});

test("wishlist purchase intent response requires an item for true intent", () => {
  assert.deepEqual(
    normalizeWishlistPurchaseIntentResponse({
      hasPurchaseIntent: true,
      itemName: "  iphone   17  ",
      confidence: 0.95,
    }),
    {
      hasPurchaseIntent: true,
      itemName: "iphone 17",
      confidence: 0.95,
    }
  );

  assert.deepEqual(
    normalizeWishlistPurchaseIntentResponse({
      hasPurchaseIntent: true,
      itemName: "roller smates",
      confidence: 0.8,
    }),
    {
      hasPurchaseIntent: true,
      itemName: "roller skates",
      confidence: 0.8,
    }
  );

  assert.deepEqual(
    normalizeWishlistPurchaseIntentResponse({
      hasPurchaseIntent: true,
      confidence: 0.6,
    }),
    {
      hasPurchaseIntent: false,
      confidence: 0.6,
    }
  );
});
