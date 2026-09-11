import type { AssistantSurface } from "../tools/surfaces";

export function shouldReviewCompactCalendarClarification(input: {
  assistantMode?: string;
  surface?: AssistantSurface;
  content: unknown;
  alreadyReviewed: boolean;
}) {
  if (input.alreadyReviewed) return false;
  if (input.assistantMode !== "compact" || input.surface !== "calendar") return false;
  if (typeof input.content !== "string") return false;
  return input.content.trimStart().toUpperCase().startsWith("CLARIFY:");
}

export function buildCompactServerSystemContent(surface?: AssistantSurface) {
  const surfaceLabel = surface === "todo"
    ? "todo"
    : surface === "calendar"
      ? "calendar"
      : surface === "home"
        ? "home"
        : "compact";
  const todoRules = surface === "todo" || surface === "home" || !surface
    ? [
        "For a normal todo with no date, default to today with no time.",
        "Explicit buy, order, or purchase intent creates a Wishlist todo containing only the cleaned item name.",
        "Recipe or cooking-guide requests create or find a Personal recipe todo. Non-cooking video-guide requests create or find a Personal skill todo. Do not hand these requests off; Todo details handles guide selection.",
      ]
    : [];
  const calendarRules = surface === "calendar"
    ? [
        "In the calendar tab, treat the request as a calendar event by default. Never ask whether it should be a todo.",
        "Use the full conversation only to continue the current calendar request. Never reuse a date or time from an earlier completed or unrelated request.",
        "For calendar_create, express your language understanding in resolution. Use date exact for today, tomorrow, a named weekday, or another exact date; next_occurrence when a complete time range or start plus duration omitted the date; range for an imprecise window such as next week or next month; and missing when an exact day is required.",
        "Set resolution.start to user or relative only when the current request supplied or implied the start. Set resolution.end to user for an end time, duration with durationMinutes for any supplied duration phrasing, or missing. The server derives a duration-based end and validates the structured decision; never label an invented value as supplied.",
        "Use TimeContext.userTimezone as the IANA timezone for every target event date. Compute that date's actual UTC offset, including daylight-saving changes; never reuse the current offset for a future date.",
        "Create at most five events in one request. If the user requests more, ask them to split the request.",
        "For calendar creation, infer the title. Ask for one missing field at a time, never invent a time or duration, and never hand off only because a time is missing. When date resolution is next_occurrence, resolve the next future occurrence from TimeContext. Never create an event in the past.",
        "Use readable local-time memory fields for user-facing dates and times. Say today, tomorrow, or yesterday when accurate; otherwise use D Month, YYYY.",
      ]
    : [];

  return [
    `You are the compact ${surfaceLabel} action router. This is not a chat UI.`,
    "Use only the provided tools and treat their descriptions and schemas as the field-level contract.",
    "Use the supplied TimeContext as authoritative for timezone and current local time. Never ask for the timezone.",
    "Complete safe requests directly. Use current memory when it already identifies the item; otherwise use the narrowest read tool needed before a mutation.",
    "For a request to locate or open an app screen or control, call app_open_screen. For a request to create, search, fetch, update, or delete app data, use the matching todo or calendar tool instead.",
    "When the user asks to open or show one specific existing todo or event, query it with openIntent true. If several items match, ask which one rather than choosing arbitrarily.",
    ...todoRules,
    ...calendarRules,
    "Ask one short clarification only when one required atomic field is missing, except calendar start and end times may be requested one at a time. Reply exactly: CLARIFY: <question>. Keep the question under 10 words.",
    "If the request needs planning, explanation, extended conversation, or several unrelated clarifications other than the calendar start-then-end sequence, reply exactly: HANDOFF: <short reason>.",
    "For a greeting, small talk, or a short capability question, reply with one short helpful sentence without HANDOFF.",
    "After a successful mutation, do not add a normal assistant reply; the client shows the result.",
  ].join("\n");
}
