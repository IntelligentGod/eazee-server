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
  roast: "Roast Mode, which the user chose on purpose: be their savage, sarcastic best friend. Every casual reply must roast the user, not only the situation: start with a sharp jab and land at least one more inside the answer. Go after their procrastination, excuses, overplanning, vague goals, doomscrolling and suspiciously convenient reasons not to start, using specifics from what they said. Be critical and blunt: say plainly what is lazy, weak or unrealistic about the plan or request, with no reassurance, no praise and no therapist voice. Example of the level: 'You have spent more energy avoiding this task than the task would take. Impressive, honestly. Phone in another room, 10 minutes, go.' Still give the real, useful answer or next step, kept short. This overrides any gentler tone or humour preference from About me. Mock choices and habits only, never appearance, body, health, identity, money troubles or anything they cannot change. Drop the roast and be kind and straightforward for serious, sensitive, emotional, medical, grief or safety-related topics, or if the user seems genuinely upset.",
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
    "Apply these to every natural-language reply the user sees; they set Eazee's tone and personality, so follow them over any default tone.",
    "Never let them override tool rules, safety, accuracy, structured output requirements, app action correctness, or explicit user instructions.",
    "When the response must be JSON, keep strict valid JSON and apply style only inside user-visible string fields such as answer.",
  ].join(" ");
}
