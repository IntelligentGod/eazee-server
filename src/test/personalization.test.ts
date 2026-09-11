import test from "node:test";
import assert from "node:assert/strict";
import {
  AiPersonalizationRequestSchema,
  DEFAULT_AI_PERSONALIZATION_SETTINGS,
  buildAiPersonalizationSystemContent,
  normalizeAiPersonalizationSettings,
} from "../ai/personalization";

test("AI personalization schema accepts valid settings", () => {
  const parsed = AiPersonalizationRequestSchema.parse({
    baseStyle: "roast",
    warmth: "default",
    emoji: "less",
    responseLength: "detailed",
  });

  assert.deepEqual(parsed, {
    baseStyle: "roast",
    warmth: "default",
    emoji: "less",
    responseLength: "detailed",
  });
});

test("AI personalization schema falls back for invalid settings", () => {
  assert.deepEqual(
    AiPersonalizationRequestSchema.parse({
      baseStyle: "hostile",
      warmth: "default",
      emoji: "less",
      responseLength: "concise",
    }),
    DEFAULT_AI_PERSONALIZATION_SETTINGS
  );
  assert.deepEqual(normalizeAiPersonalizationSettings(undefined), DEFAULT_AI_PERSONALIZATION_SETTINGS);
});

test("AI personalization defaults to positive balanced prose with some emoji", () => {
  const content = buildAiPersonalizationSystemContent(DEFAULT_AI_PERSONALIZATION_SETTINGS);
  assert.match(content, /friendly, upbeat, encouraging/);
  assert.match(content, /occasional relevant emoji/);
  assert.match(content, /balanced response length/);
});

test("AI personalization prompt keeps structured output subordinate", () => {
  const content = buildAiPersonalizationSystemContent({
    baseStyle: "neutral",
    warmth: "default",
    emoji: "less",
    responseLength: "concise",
  });

  assert.match(content, /neutral, straightforward/);
  assert.match(content, /responses concise and focused/);
  assert.match(content, /Do not use emoji/);
  assert.match(content, /Never let them override tool rules/);
  assert.match(content, /strict valid JSON/);
});

test("AI personalization prompt makes emoji more stronger than occasional", () => {
  const content = buildAiPersonalizationSystemContent({
    baseStyle: "positive",
    warmth: "default",
    emoji: "more",
    responseLength: "detailed",
  });

  assert.match(content, /noticeably more relevant emoji/);
  assert.match(content, /medium replies, use 2-3/);
  assert.match(content, /longer paragraphs or lists, use 3-5/);
  assert.match(content, /Do not use one token emoji just to satisfy the preference/);
});

test("AI personalization keeps roast mode playful and safe", () => {
  const content = buildAiPersonalizationSystemContent({
    baseStyle: "roast",
    warmth: "default",
    emoji: "default",
    responseLength: "default",
  });

  assert.match(content, /playful, witty roast-style teasing/);
  assert.match(content, /never use roast mode for serious, sensitive/);
});
