import { z } from "zod";
import type { ChatMessage } from "../providers/openai";

export const WishlistPurchaseIntentSurfaceSchema = z.enum(["goal", "task", "recipe", "skill"]);

export const WishlistPurchaseIntentRequestSchema = z.object({
  message: z.string().min(1).max(1000),
  surface: WishlistPurchaseIntentSurfaceSchema,
  contextTitle: z.string().max(300).optional().default(""),
  contextDetails: z.string().max(2000).optional().default(""),
  recentMessages: z.array(z.object({
    role: z.enum(["user", "assistant"]),
    content: z.string().max(2000),
  })).max(8).optional().default([]),
  userTimezone: z.string().max(100).optional().default("UTC"),
  locale: z.string().max(100).optional().default("en-US"),
});

export const WishlistPurchaseIntentResponseSchema = z.object({
  hasPurchaseIntent: z.boolean(),
  itemName: z.preprocess(
    (value) => typeof value === "string" && value.trim() ? value.trim().replace(/\s+/g, " ") : undefined,
    z.string().min(1).max(200).optional()
  ),
  confidence: z.number().min(0).max(1),
});

export type WishlistPurchaseIntentRequest = z.infer<typeof WishlistPurchaseIntentRequestSchema>;
export type WishlistPurchaseIntentResponse = z.infer<typeof WishlistPurchaseIntentResponseSchema>;

export function normalizeWishlistItemName(value: string): string {
  return value
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\bknif\b/gi, "knife")
    .replace(/\broller smates\b/gi, "roller skates");
}

export function normalizeWishlistPurchaseIntentResponse(value: unknown): WishlistPurchaseIntentResponse {
  const parsed = WishlistPurchaseIntentResponseSchema.parse(value);
  const itemName = parsed.itemName ? normalizeWishlistItemName(parsed.itemName) : undefined;
  const hasPurchaseIntent = parsed.hasPurchaseIntent && !!itemName;
  return {
    hasPurchaseIntent,
    ...(hasPurchaseIntent && itemName ? { itemName } : {}),
    confidence: parsed.confidence,
  };
}

export function buildWishlistPurchaseIntentMessages(input: WishlistPurchaseIntentRequest): ChatMessage[] {
  return [
    {
      role: "system",
      content:
        "Classify whether a Todo guidance-chat message is an explicit request to buy, order, purchase, or add an item to Wishlist. Return only strict JSON. " +
        "The latest message is the only source of intent. Recent messages are context only; never infer purchase intent from recentMessages if the latest message is asking for recommendations, alternatives, explanations, or help. " +
        "Only mark hasPurchaseIntent true when the latest message explicitly asks to buy, order, purchase, or add/save a concrete item to Wishlist. " +
        "Return false for research, advice, availability, price, comparison, how-to, or informational questions such as where can I buy, should I buy, what should I buy, or is this worth buying. " +
        "Return false when the latest message asks you to find, recommend, choose, pick, or suggest an item and add it, unless a specific concrete product/book title is already named in the latest message or clearly referenced from recentMessages. " +
        "Do not add generic categories such as beginner workbook, python book, running shoes, or headphones as itemName when the user is asking for discovery or recommendations. " +
        "Resolve references like the first one, second one, that book, it, or this from the most recent assistant message in recentMessages only when the latest message itself contains explicit buy/order/purchase/add-to-wishlist intent. " +
        "If recentMessages contains multiple assistant recommendation lists, ignore older lists and use only the newest assistant recommendation list. " +
        "If the user says can I buy the first one after the newest assistant message listed books/products, return true and set itemName to that first listed item from that newest list. " +
        "If a reference cannot be resolved to a concrete item, return false. " +
        "When true, itemName must contain only the cleaned item name. Remove intent wording, leading verbs, and simple articles like a, an, the. " +
        "Correct obvious spelling mistakes in generic item names when the intended product is clear, for example knif -> knife and roller smates -> roller skates. " +
        "Do not autocorrect brand names, product names, model names, numbers, versions, or unusual proper nouns unless the correction is unambiguous from context. " +
        "Preserve brand names, product names, quantities, sizes, model numbers, versions, colors, and meaningful descriptors.",
    },
    {
      role: "user",
      content:
        "Return JSON with shape {\"hasPurchaseIntent\":true,\"itemName\":\"clean item\",\"confidence\":0.0}. " +
        "If false, return {\"hasPurchaseIntent\":false,\"confidence\":0.0}.\n\n" +
        JSON.stringify({
          message: input.message,
          surface: input.surface,
          contextTitle: input.contextTitle,
          contextDetails: input.contextDetails,
          recentMessages: input.recentMessages,
          userTimezone: input.userTimezone,
          locale: input.locale,
        }),
    },
  ];
}
