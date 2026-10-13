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

/**
 * Tools that run in the app and only exist in newer app builds. Older builds don't list
 * them in clientCapabilities, so they are never offered a tool they can't run.
 */
const CAPABILITY_GATED_TOOL_NAMES = new Set(["calendar_create_many"]);

export function filterToolsForClientCapabilities<T extends { function?: { name?: string } }>(
  tools: T[],
  clientCapabilities?: string[] | null
) {
  const capabilities = new Set(clientCapabilities || []);
  return tools.filter((tool) => {
    const name = tool?.function?.name || "";
    return !CAPABILITY_GATED_TOOL_NAMES.has(name) || capabilities.has(name);
  });
}

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
