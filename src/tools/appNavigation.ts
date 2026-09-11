import { z } from "zod";
import type { ToolDef } from "./todo";

export const APP_SCREEN_DESTINATIONS = [
  "chat",
  "chat_history",
  "chat_new",
  "home",
  "home_settings",
  "home_guided_access_mode",
  "home_left_handed_mode",
  "home_ai_personalization",
  "home_ai_base_personalization",
  "home_ai_emoji",
  "home_ai_response_length",
  "home_personalization",
  "home_personalization_reorder",
  "home_personalization_next_step",
  "home_personalization_suggestions",
  "home_personalization_today_plan",
  "home_replay_tutorial",
  "home_legal_support",
  "home_privacy_policy",
  "home_terms",
  "home_support",
  "home_profile",
  "home_country",
  "home_google_connection",
  "todo",
  "todo_search",
  "todo_create",
  "todo_goals",
  "todo_personal",
  "todo_wishlist",
  "calendar",
  "calendar_search",
] as const;

export const AppScreenDestinationSchema = z.enum(APP_SCREEN_DESTINATIONS);

export const AppOpenScreenSchema = z.object({
  destination: AppScreenDestinationSchema,
});

export const ChatRenameSchema = z.object({
  title: z.string().transform((value) => value.trim()).pipe(z.string().min(1).max(80)),
});

export const AppOpenScreenParameters = {
  type: "object",
  properties: {
    destination: {
      type: "string",
      enum: APP_SCREEN_DESTINATIONS,
      description: "Exact app destination or screen control for a tappable shortcut. Prefer the most specific matching destination. Do not use for requests that create, search, fetch, refresh, summarize, draft, compose, or send actual content/data.",
    },
  },
  required: ["destination"],
  additionalProperties: false,
};

export const ChatRenameParameters = {
  type: "object",
  properties: {
    title: {
      type: "string",
      minLength: 1,
      maxLength: 80,
      description: "The exact new title requested by the user for the current chat. Do not include command words like rename, title, or chat.",
    },
  },
  required: ["title"],
  additionalProperties: false,
};

export const appNavigationTools: ToolDef[] = [
  {
    name: "chat_rename",
    description:
      "Rename the current chat session. Use this whenever the user asks to rename, retitle, name, title, call, update, fix, or correct this chat/conversation title, including follow-ups like 'rename it to X' or typoed wording like 'rename this caht to X'.",
    mode: "client",
    schema: ChatRenameSchema,
    parameters: ChatRenameParameters,
  },
  {
    name: "app_open_screen",
    description:
      "Show a tappable shortcut for a specific app screen or control. Use this for requests to locate or open Chat, Home settings and controls, Todo workspaces and controls, Calendar, or event search. Prefer the most specific destination. Do not use this for requests that create, search, fetch, refresh, summarize, draft, compose, or send actual content/data.",
    mode: "client",
    schema: AppOpenScreenSchema,
    parameters: AppOpenScreenParameters,
  },
];
