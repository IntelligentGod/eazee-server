import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCompactServerSystemContent,
  shouldReviewCompactCalendarClarification,
} from "../ai/compactPrompt";
import { CalendarFetchRangeSchema, CalendarSearchSchema } from "../tools/calendar";
import { getToolByName } from "../tools/registry";

test("compact prompt owns shared behavior and scopes calendar requests", () => {
  const prompt = buildCompactServerSystemContent("calendar");

  assert.match(prompt, /compact calendar action router/);
  assert.match(prompt, /treat the request as a calendar event by default/);
  assert.match(prompt, /current calendar request/);
  assert.match(prompt, /Never reuse a date or time/);
  assert.match(prompt, /express your language understanding in resolution/);
  assert.match(prompt, /date exact/);
  assert.match(prompt, /next_occurrence/);
  assert.match(prompt, /durationMinutes/);
  assert.match(prompt, /never label an invented value as supplied/);
  assert.match(prompt, /calendar start and end times may be requested one at a time/);
  assert.match(prompt, /clarifications other than the calendar start-then-end sequence/);
  assert.match(prompt, /CLARIFY: <question>/);
  assert.doesNotMatch(prompt, /Explicit buy, order, or purchase intent/);
});

test("compact prompt keeps todo and home actions surface-aware", () => {
  const todoPrompt = buildCompactServerSystemContent("todo");
  const homePrompt = buildCompactServerSystemContent("home");

  assert.match(todoPrompt, /normal todo with no date, default to today/);
  assert.match(todoPrompt, /Wishlist todo/);
  assert.match(homePrompt, /Recipe or cooking-guide requests/);
  assert.doesNotMatch(homePrompt, /date exact/);
  assert.doesNotMatch(homePrompt, /Never reuse a date or time/);
});

test("compact tool contracts preserve open and recurring intent", () => {
  assert.equal(getToolByName("todo_query")?.schema.safeParse({ recurringOnly: true, openIntent: true }).success, true);
  assert.equal(CalendarFetchRangeSchema.safeParse({ openIntent: true }).success, true);
  assert.equal(CalendarSearchSchema.safeParse({ query: "dentist", openIntent: true }).success, true);
});

test("compact calendar clarifications receive one model self-review", () => {
  assert.equal(shouldReviewCompactCalendarClarification({
    assistantMode: "compact",
    surface: "calendar",
    content: "CLARIFY: Which day should I use?",
    alreadyReviewed: false,
  }), true);
  assert.equal(shouldReviewCompactCalendarClarification({
    assistantMode: "compact",
    surface: "calendar",
    content: "CLARIFY: What time should it end?",
    alreadyReviewed: true,
  }), false);
  assert.equal(shouldReviewCompactCalendarClarification({
    assistantMode: "chat",
    surface: "calendar",
    content: "CLARIFY: Which day should I use?",
    alreadyReviewed: false,
  }), false);
});
