export type RouteToolCallLike = {
  name: string;
  arguments: unknown;
};

const CALENDAR_READ_TOOL_NAMES = new Set(["calendar_fetch_range", "calendar_search"]);

const GENERIC_CALENDAR_TOKENS = new Set([
  "a",
  "an",
  "any",
  "are",
  "calendar",
  "do",
  "events",
  "event",
  "for",
  "have",
  "i",
  "list",
  "me",
  "my",
  "on",
  "please",
  "show",
  "the",
  "there",
  "today",
  "tomorrow",
  "tonight",
  "upcoming",
  "what",
]);

function tokenize(text: string) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .map((token) => token.trim())
    .filter(Boolean);
}

function hasExplicitCalendarDomain(text: string) {
  return /\b(calendar|events?)\b/i.test(text);
}

function hasExplicitTodoDomain(text: string) {
  return /\b(tasks?|todos?|to-dos?|to dos?|wishlist|goal|goals)\b/i.test(text);
}

function getSearchQuery(call: RouteToolCallLike) {
  const args = call.arguments as Record<string, unknown> | null;
  return typeof args?.query === "string" ? args.query : "";
}

function scoreCalendarReadCall(call: RouteToolCallLike, userTokens: string[]) {
  if (call.name === "calendar_fetch_range") {
    return userTokens.length > 0 ? 12 : 40;
  }

  if (call.name !== "calendar_search") {
    return 0;
  }

  const queryTokens = tokenize(getSearchQuery(call));
  const meaningfulQueryTokens = queryTokens.filter((token) => !GENERIC_CALENDAR_TOKENS.has(token));
  const overlap = meaningfulQueryTokens.filter((token) => userTokens.includes(token)).length;
  const genericPenalty = meaningfulQueryTokens.length === 0 ? 8 : 0;

  return 15 + overlap * 25 + Math.min(meaningfulQueryTokens.length, 3) * 2 - genericPenalty;
}

function chooseCalendarReadCall(calls: RouteToolCallLike[], latestUserText: string) {
  const userTokens = tokenize(latestUserText).filter((token) => !GENERIC_CALENDAR_TOKENS.has(token));
  let bestIndex = 0;
  let bestScore = Number.NEGATIVE_INFINITY;

  calls.forEach((call, index) => {
    const score = scoreCalendarReadCall(call, userTokens);
    if (score >= bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  });

  return calls[bestIndex];
}

export function filterClientToolCallsForUserIntent<T extends RouteToolCallLike>(calls: T[], latestUserText: string): T[] {
  const text = latestUserText || "";
  const calendarIntent = hasExplicitCalendarDomain(text);
  const todoIntent = hasExplicitTodoDomain(text);
  const hasCalendarCall = calls.some((call) => String(call.name || "").startsWith("calendar_"));
  const hasTodoCall = calls.some((call) => String(call.name || "").startsWith("todo_"));
  let filtered = calls;

  if (hasCalendarCall && hasTodoCall && calendarIntent && !todoIntent) {
    filtered = filtered.filter((call) => !String(call.name || "").startsWith("todo_"));
  }

  if (hasCalendarCall && hasTodoCall && todoIntent && !calendarIntent) {
    filtered = filtered.filter((call) => !String(call.name || "").startsWith("calendar_"));
  }

  const calendarReadCalls = filtered.filter((call) => CALENDAR_READ_TOOL_NAMES.has(call.name));
  if (calendarReadCalls.length <= 1) {
    return filtered;
  }

  const selectedCalendarReadCall = chooseCalendarReadCall(calendarReadCalls, text);
  let inserted = false;
  return filtered.filter((call) => {
    if (!CALENDAR_READ_TOOL_NAMES.has(call.name)) return true;
    if (!inserted && call === selectedCalendarReadCall) {
      inserted = true;
      return true;
    }
    return false;
  });
}
