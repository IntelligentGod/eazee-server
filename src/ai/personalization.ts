import { z } from "zod";

export const AiPersonalizationSettingsSchema = z.object({
  baseStyle: z.enum(["positive", "neutral", "roast"]),
  warmth: z.literal("default"),
  emoji: z.enum(["less", "default", "more"]),
  responseLength: z.enum(["concise", "default", "detailed"]),
});

export type AiPersonalizationSettings = z.infer<typeof AiPersonalizationSettingsSchema>;

export const DEFAULT_AI_PERSONALIZATION_SETTINGS: AiPersonalizationSettings = {
  baseStyle: "positive",
  warmth: "default",
  emoji: "default",
  responseLength: "default",
};

export const AiPersonalizationRequestSchema = z.unknown().optional().transform((value) =>
  normalizeAiPersonalizationSettings(value)
);

const baseStyleInstructions: Record<AiPersonalizationSettings["baseStyle"], string> = {
  positive: "Use a friendly, upbeat, encouraging tone.",
  neutral: "Use a neutral, straightforward, matter-of-fact tone.",
  roast: "Use playful, witty roast-style teasing in casual low-stakes replies. Keep it light and affectionate, roast the situation or idea rather than vulnerable personal traits, and never use roast mode for serious, sensitive, supportive, or safety-related contexts.",
};

const emojiInstructions: Record<AiPersonalizationSettings["emoji"], string> = {
  less: "Do not use emoji.",
  default: "Use occasional relevant emoji when they fit naturally. Usually use no more than 1-2 per reply, and skip them for serious, sensitive, terse status, code-heavy, or strictly structured replies.",
  more: "Use noticeably more relevant emoji in casual user-facing replies. For short replies, use about 1 emoji; for medium replies, use 2-3; for longer paragraphs or lists, use 3-5 spread naturally across the response. Do not use one token emoji just to satisfy the preference. Skip emoji for serious, sensitive, terse status, code-heavy, or strictly structured replies.",
};

const responseLengthInstructions: Record<AiPersonalizationSettings["responseLength"], string> = {
  concise: "Keep responses concise and focused, giving only the essential answer and next step.",
  default: "Use a balanced response length with enough context to be useful without unnecessary detail.",
  detailed: "Give more detailed, thorough responses with useful context and concrete explanation when appropriate.",
};

export function normalizeAiPersonalizationSettings(value: unknown): AiPersonalizationSettings {
  const parsed = AiPersonalizationSettingsSchema.safeParse(value);
  return parsed.success ? parsed.data : DEFAULT_AI_PERSONALIZATION_SETTINGS;
}

export function buildAiPersonalizationSystemContent(value: unknown) {
  const settings = normalizeAiPersonalizationSettings(value);

  const instructions = [
    baseStyleInstructions[settings.baseStyle],
    emojiInstructions[settings.emoji],
    responseLengthInstructions[settings.responseLength],
  ].filter(Boolean);

  return [
    "User AI Personalization:",
    ...instructions,
    "These are low-priority style preferences for natural-language assistant text only.",
    "Never let them override tool rules, safety, accuracy, structured output requirements, app action correctness, or explicit user instructions.",
    "When the response must be JSON, keep strict valid JSON and apply style only inside user-visible string fields such as answer.",
  ].join(" ");
}
