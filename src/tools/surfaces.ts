import { getOpenAIToolDefs, getOpenAIToolDefsByNames } from "./registry";

export type AssistantSurface = "chat" | "todo" | "calendar" | "home";

export const SURFACE_TOOL_NAMES: Record<AssistantSurface, string[] | null> = {
  chat: null,
  todo: [
    "app_open_screen",
    "todo_create_many",
    "todo_delete_many",
    "todo_delete_by_day_except",
    "todo_complete_many",
    "todo_edit_many",
    "todo_star_toggle_many",
    "todo_query",
  ],
  calendar: [
    "app_open_screen",
    "calendar_fetch_range",
    "calendar_get_details",
    "calendar_create",
    "calendar_update",
    "calendar_delete",
    "calendar_search",
  ],
  home: [
    "app_open_screen",
    "todo_create_many",
    "todo_delete_many",
    "todo_delete_by_day_except",
    "todo_complete_many",
    "todo_edit_many",
    "todo_star_toggle_many",
    "todo_query",
    "calendar_fetch_range",
    "calendar_get_details",
    "calendar_create",
    "calendar_update",
    "calendar_delete",
    "calendar_search",
  ],
};

export function getAllowedToolNamesForSurface(surface?: AssistantSurface) {
  if (!surface || surface === "chat") {
    return null;
  }
  const toolNames = SURFACE_TOOL_NAMES[surface];
  return Array.isArray(toolNames) ? new Set(toolNames) : null;
}

export function getToolDefsForSurface(surface?: AssistantSurface) {
  if (!surface || surface === "chat") {
    return getOpenAIToolDefs();
  }
  const toolNames = SURFACE_TOOL_NAMES[surface];
  if (!toolNames) {
    return getOpenAIToolDefs();
  }
  return getOpenAIToolDefsByNames(toolNames);
}
