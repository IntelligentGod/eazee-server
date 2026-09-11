import { z } from "zod";
import type { ChatMessage } from "../providers/openai";

export const GoalWishlistSuggestionTimeframeSchema = z.enum(["thisWeek", "thisMonth", "thisYear", "longTerm"]);
export const GoalWishlistSuggestionTaskKindSchema = z.enum(["normal", "recipe", "skill"]);

export const GoalWishlistSuggestionsRequestSchema = z.object({
  goalTitle: z.string().min(1).max(300),
  goalDetails: z.string().max(4000).optional().default(""),
  timeframe: GoalWishlistSuggestionTimeframeSchema.optional(),
  taskKind: GoalWishlistSuggestionTaskKindSchema.optional(),
  userTimezone: z.string().max(100).optional().default("UTC"),
  locale: z.string().max(100).optional().default("en-US"),
});

const RawGoalWishlistSuggestionSchema = z.object({
  itemName: z.preprocess(
    (value) => typeof value === "string" && value.trim() ? normalizeGoalWishlistSuggestionItemName(value) : undefined,
    z.string().min(1).max(120).optional()
  ),
  reason: z.preprocess(
    (value) => typeof value === "string" && value.trim() ? value.trim().replace(/\s+/g, " ") : undefined,
    z.string().min(1).max(160).optional()
  ),
  confidence: z.preprocess(
    (value) => {
      const confidence = Number(value);
      return Number.isFinite(confidence) ? Math.max(0, Math.min(confidence, 1)) : 0;
    },
    z.number().min(0).max(1)
  ),
  physicalRetailGood: z.boolean().optional().default(false),
  amazonSearchLikelyUseful: z.boolean().optional().default(false),
});

const GoalWishlistSuggestionSchema = z.object({
  itemName: z.string().min(1).max(120),
  reason: z.string().min(1).max(160).optional(),
  confidence: z.number().min(0).max(1),
});

export const GoalWishlistSuggestionsResponseSchema = z.object({
  suggestions: z.array(GoalWishlistSuggestionSchema).max(3).default([]),
});

export type GoalWishlistSuggestionsRequest = z.infer<typeof GoalWishlistSuggestionsRequestSchema>;
export type GoalWishlistSuggestionsResponse = z.infer<typeof GoalWishlistSuggestionsResponseSchema>;

export function normalizeGoalWishlistSuggestionItemName(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function getGoalWishlistSuggestionDedupeKey(itemName: string): string {
  return itemName
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\b(a|an|the)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeGoalWishlistSuggestionsResponse(value: unknown): GoalWishlistSuggestionsResponse {
  if (!value || typeof value !== "object") {
    return { suggestions: [] };
  }

  const rawSuggestions = Array.isArray((value as any).suggestions) ? (value as any).suggestions : [];
  const suggestions: Array<{ itemName: string; reason?: string; confidence: number }> = [];
  const seen = new Set<string>();

  for (const rawSuggestion of rawSuggestions) {
    const parsed = RawGoalWishlistSuggestionSchema.safeParse(rawSuggestion);
    if (!parsed.success || !parsed.data.itemName) {
      continue;
    }
    if (!parsed.data.physicalRetailGood || !parsed.data.amazonSearchLikelyUseful) {
      continue;
    }

    const key = getGoalWishlistSuggestionDedupeKey(parsed.data.itemName);
    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    suggestions.push({
      itemName: parsed.data.itemName,
      ...(parsed.data.reason ? { reason: parsed.data.reason } : {}),
      confidence: parsed.data.confidence,
    });

    if (suggestions.length >= 3) {
      break;
    }
  }

  return { suggestions };
}

export function buildGoalWishlistSuggestionsMessages(input: GoalWishlistSuggestionsRequest): ChatMessage[] {
  return [
    {
      role: "system",
      content:
        "You suggest optional Wishlist items immediately after a user creates a goal. Return only strict JSON. " +
        "The items become Amazon wishlist searches, so suggest only physical retail goods that a person would reasonably buy for themselves. " +
        "Suggest 0 to 3 concrete products that would directly help the user make progress on the goal. " +
        "Only suggest items when the usefulness is clear from the goal title/details and the Amazon search result would likely be useful. Return an empty suggestions array when buying something would be forced, generic, irrelevant, speculative, gimmicky, or unnecessary. " +
        "Each suggestion must pass both checks: physicalRetailGood true means the item is a tangible product that can be shipped; amazonSearchLikelyUseful true means searching itemName on Amazon is likely to show that tangible product. If either check is false, do not include the suggestion. " +
        "Do not rely on canned mappings or hardcoded categories; reason from the actual goal. " +
        "Do not suggest infrastructure, large equipment, venue equipment, or things normally provided by a gym, studio, school, kitchen, workshop, office, or other likely location unless the goal explicitly says the user wants to buy, own, replace, or build that setup. " +
        "For goals that are usually done at a venue, suggest only small personal goods, consumables, or recovery/support items that materially help; otherwise return an empty suggestions array. " +
        "When the goal is to learn, practice, play, make, repair, or use a physical object that is normally personally owned, the primary object is more important than accessories or learning materials. Unless the input clearly says the user already owns or has access to that primary object, include it as the first suggestion. " +
        "For fitness or strength goals, prioritize personal consumables, recovery, safety, or tracking goods over shared equipment. " +
        "For learning goals, prefer substantial physical books, workbooks, kits, or tools when clearly useful; do not suggest cheat sheets, shortcut sheets, posters, laminated cards, PDFs, downloads, apps, courses, services, coaching, memberships, subscriptions, or vague categories. " +
        "Do not suggest software, apps, platforms, websites, online tools, digital downloads, programming environments, file formats, or named digital products unless itemName is a physical book, hardware device, kit, or other shipped retail good. " +
        "Do not suggest redundant gadgets whose main function is already covered by a normal phone, clock, calendar, notes app, or common household item unless the specialized physical product is clearly more useful for the goal. " +
        "Prefer generic item names over brands unless the user named a brand/model or a specific titled retail item is the best Amazon query. " +
        "The itemName must be the clean Amazon search query for the product itself, not a sentence or goal-specific label. Do not include the user's goal, activity, skill, or purpose in itemName unless that word changes the actual product type. Avoid phrases like for practice, for beginners, for the gym, for Python, for fitness, or for the goal. If a contextual phrase would make the Amazon search worse, use the simpler base product name. " +
        "Keep itemName short and wishlist-ready. Keep reason short and practical. Deduplicate overlapping items. " +
        "Return JSON with shape {\"suggestions\":[{\"itemName\":\"item\",\"reason\":\"why it helps\",\"confidence\":0.0,\"physicalRetailGood\":true,\"amazonSearchLikelyUseful\":true}]} and at most 3 suggestions.",
    },
    {
      role: "user",
      content: JSON.stringify({
        goalTitle: input.goalTitle,
        goalDetails: input.goalDetails,
        timeframe: input.timeframe,
        taskKind: input.taskKind,
        userTimezone: input.userTimezone,
        locale: input.locale,
      }),
    },
  ];
}
