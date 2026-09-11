import test from "node:test";
import assert from "node:assert/strict";
import {
  GoalWishlistSuggestionsRequestSchema,
  buildGoalWishlistSuggestionsMessages,
  normalizeGoalWishlistSuggestionItemName,
  normalizeGoalWishlistSuggestionsResponse,
} from "../ai/goalWishlistSuggestions";

test("goal wishlist suggestions request accepts goal context", () => {
  const parsed = GoalWishlistSuggestionsRequestSchema.safeParse({
    goalTitle: "Learn guitar",
    goalDetails: "Practice chords every day",
    timeframe: "thisMonth",
    taskKind: "skill",
  });

  assert.equal(parsed.success, true);
});

test("goal wishlist suggestions request rejects invalid timeframe and task kind", () => {
  assert.equal(GoalWishlistSuggestionsRequestSchema.safeParse({
    goalTitle: "Learn guitar",
    timeframe: "nextWeek",
  }).success, false);

  assert.equal(GoalWishlistSuggestionsRequestSchema.safeParse({
    goalTitle: "Learn guitar",
    taskKind: "shopping",
  }).success, false);
});

test("goal wishlist suggestions prompt requires useful concrete suggestions or none", () => {
  const messages = buildGoalWishlistSuggestionsMessages({
    goalTitle: "Improve sleep",
    goalDetails: "",
    timeframe: "thisMonth",
    taskKind: "normal",
    userTimezone: "Asia/Kolkata",
    locale: "en-US",
  });

  const system = String(messages[0]?.content || "");
  const user = String(messages[1]?.content || "");
  assert.match(system, /Amazon wishlist searches/i);
  assert.match(system, /0 to 3 concrete products/i);
  assert.match(system, /physicalRetailGood true means the item is a tangible product that can be shipped/i);
  assert.match(system, /amazonSearchLikelyUseful true means searching itemName on Amazon is likely/i);
  assert.match(system, /Return an empty suggestions array/i);
  assert.match(system, /Do not rely on canned mappings/i);
  assert.match(user, /Improve sleep/i);
});

test("goal wishlist suggestions prompt avoids venue-provided equipment", () => {
  const messages = buildGoalWishlistSuggestionsMessages({
    goalTitle: "Bench press 100 kg",
    goalDetails: "",
    timeframe: "thisMonth",
    taskKind: "normal",
    userTimezone: "Asia/Kolkata",
    locale: "en-US",
  });

  const system = String(messages[0]?.content || "");
  const user = String(messages[1]?.content || "");
  assert.match(system, /Do not suggest infrastructure, large equipment, venue equipment/i);
  assert.match(system, /normally provided by a gym/i);
  assert.match(system, /unless the goal explicitly says the user wants to buy, own, replace, or build/i);
  assert.match(system, /otherwise return an empty suggestions array/i);
  assert.match(user, /Bench press 100 kg/i);
});

test("goal wishlist suggestions prompt avoids weak learning-gimmick products", () => {
  const messages = buildGoalWishlistSuggestionsMessages({
    goalTitle: "Learn Python",
    goalDetails: "",
    timeframe: "thisYear",
    taskKind: "skill",
    userTimezone: "Asia/Kolkata",
    locale: "en-US",
  });

  const system = String(messages[0]?.content || "");
  const user = String(messages[1]?.content || "");
  assert.match(system, /For learning goals, prefer substantial physical books, workbooks, kits, or tools/i);
  assert.match(system, /do not suggest cheat sheets, shortcut sheets, posters, laminated cards/i);
  assert.match(system, /Do not suggest software, apps, platforms, websites, online tools, digital downloads, programming environments/i);
  assert.match(system, /specific titled retail item is the best Amazon query/i);
  assert.match(user, /Learn Python/i);
});

test("goal wishlist suggestions prompt prioritizes a missing primary personal object", () => {
  const messages = buildGoalWishlistSuggestionsMessages({
    goalTitle: "Learn basic guitar",
    goalDetails: "",
    timeframe: "thisYear",
    taskKind: "skill",
    userTimezone: "Asia/Kolkata",
    locale: "en-US",
  });

  const system = String(messages[0]?.content || "");
  const user = String(messages[1]?.content || "");
  assert.match(system, /physical object that is normally personally owned/i);
  assert.match(system, /primary object is more important than accessories or learning materials/i);
  assert.match(system, /include it as the first suggestion/i);
  assert.match(user, /Learn basic guitar/i);
});

test("goal wishlist suggestions prompt steers fitness goals toward personal goods", () => {
  const messages = buildGoalWishlistSuggestionsMessages({
    goalTitle: "Increase my squat and deadlift",
    goalDetails: "",
    timeframe: "thisMonth",
    taskKind: "normal",
    userTimezone: "Asia/Kolkata",
    locale: "en-US",
  });

  const system = String(messages[0]?.content || "");
  assert.match(system, /For fitness or strength goals, prioritize personal consumables, recovery, safety, or tracking goods/i);
  assert.match(system, /over shared equipment/i);
});

test("goal wishlist suggestions prompt keeps item names as clean Amazon queries", () => {
  const messages = buildGoalWishlistSuggestionsMessages({
    goalTitle: "Learn Python",
    goalDetails: "",
    timeframe: "thisYear",
    taskKind: "skill",
    userTimezone: "Asia/Kolkata",
    locale: "en-US",
  });

  const system = String(messages[0]?.content || "");
  assert.match(system, /clean Amazon search query for the product itself/i);
  assert.match(system, /not a sentence or goal-specific label/i);
  assert.match(system, /Do not include the user's goal, activity, skill, or purpose in itemName/i);
  assert.match(system, /Avoid phrases like for practice, for beginners, for the gym, for Python, for fitness/i);
  assert.match(system, /use the simpler base product name/i);
});

test("goal wishlist suggestions prompt avoids redundant gadgets", () => {
  const messages = buildGoalWishlistSuggestionsMessages({
    goalTitle: "Improve gym consistency",
    goalDetails: "",
    timeframe: "thisMonth",
    taskKind: "normal",
    userTimezone: "Asia/Kolkata",
    locale: "en-US",
  });

  const system = String(messages[0]?.content || "");
  assert.match(system, /Do not suggest redundant gadgets/i);
  assert.match(system, /already covered by a normal phone, clock, calendar, notes app, or common household item/i);
  assert.match(system, /unless the specialized physical product is clearly more useful/i);
});

test("goal wishlist suggestions normalize names, trim to three, and dedupe", () => {
  assert.equal(normalizeGoalWishlistSuggestionItemName("  yoga    mat  "), "yoga mat");

  assert.deepEqual(
    normalizeGoalWishlistSuggestionsResponse({
      suggestions: [
        { itemName: "  Protein   powder ", reason: "Supports protein intake", confidence: 0.9, physicalRetailGood: true, amazonSearchLikelyUseful: true },
        { itemName: "the protein powder", reason: "Duplicate", confidence: 0.8, physicalRetailGood: true, amazonSearchLikelyUseful: true },
        { itemName: "Resistance bands", confidence: 2, physicalRetailGood: true, amazonSearchLikelyUseful: true },
        { itemName: "Workout gloves", confidence: 0.7, physicalRetailGood: true, amazonSearchLikelyUseful: true },
        { itemName: "Water bottle", confidence: 0.6, physicalRetailGood: true, amazonSearchLikelyUseful: true },
      ],
    }),
    {
      suggestions: [
        { itemName: "Protein powder", reason: "Supports protein intake", confidence: 0.9 },
        { itemName: "Resistance bands", confidence: 1 },
        { itemName: "Workout gloves", confidence: 0.7 },
      ],
    }
  );
});

test("goal wishlist suggestions drops non-physical or poor Amazon-fit suggestions", () => {
  assert.deepEqual(
    normalizeGoalWishlistSuggestionsResponse({
      suggestions: [
        { itemName: "Code editor", confidence: 0.8, physicalRetailGood: false, amazonSearchLikelyUseful: false },
        { itemName: "Notebook", confidence: 0.7, physicalRetailGood: true, amazonSearchLikelyUseful: false },
        { itemName: "Python Crash Course", confidence: 0.9, physicalRetailGood: true, amazonSearchLikelyUseful: true },
      ],
    }),
    {
      suggestions: [
        { itemName: "Python Crash Course", confidence: 0.9 },
      ],
    }
  );
});

test("goal wishlist suggestions returns empty for invalid or empty payloads", () => {
  assert.deepEqual(normalizeGoalWishlistSuggestionsResponse(null), { suggestions: [] });
  assert.deepEqual(normalizeGoalWishlistSuggestionsResponse({ suggestions: [] }), { suggestions: [] });
  assert.deepEqual(
    normalizeGoalWishlistSuggestionsResponse({
      suggestions: [
        { itemName: "", confidence: 0.9 },
        { reason: "missing item", confidence: 0.9 },
      ],
    }),
    { suggestions: [] }
  );
});
