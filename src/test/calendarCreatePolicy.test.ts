import test from "node:test";
import assert from "node:assert/strict";
import {
  enforceCalendarCreatePolicy,
  getCalendarCreateRecoveryAction,
  getCalendarTimeContext,
  type CalendarTimeContext,
} from "../ai/calendarCreatePolicy";

const KOLKATA_CONTEXT: CalendarTimeContext = {
  nowLocalIso: "2026-06-12T04:40:00+05:30",
  userTimezone: "Asia/Kolkata",
};

const NEW_YORK_WINTER_CONTEXT: CalendarTimeContext = {
  nowLocalIso: "2026-01-10T09:00:00-05:00",
  userTimezone: "America/New_York",
};

const createCall = (argumentsValue: Record<string, unknown>) => ({
  name: "calendar_create",
  arguments: argumentsValue,
  raw: {
    function: {
      name: "calendar_create",
      arguments: argumentsValue,
    },
  },
});

test("calendar create policy accepts a complete model decision", () => {
  const result = enforceCalendarCreatePolicy([
    createCall({
      title: "Meeting",
      start: "2026-06-13T09:00:00+05:30",
      end: "2026-06-13T10:00:00+05:30",
      resolution: { date: "exact", start: "user", end: "user" },
    }),
  ], KOLKATA_CONTEXT);

  assert.equal(result.calls.length, 1);
  assert.equal(result.clarification, undefined);
  assert.equal(result.retryInstruction, undefined);
  assert.equal((result.calls[0].arguments as any).resolution, undefined);
});

test("calendar create policy derives a duration-based end", () => {
  const result = enforceCalendarCreatePolicy([
    createCall({
      title: "Meeting",
      start: "2026-06-13T07:00:00+05:30",
      resolution: {
        date: "exact",
        start: "user",
        end: "duration",
        durationMinutes: 60,
      },
    }),
  ], KOLKATA_CONTEXT);

  assert.equal(result.calls.length, 1);
  assert.equal((result.calls[0].arguments as any).end, "2026-06-13T02:30:00.000Z");
});

test("calendar create policy trusts the model's missing-field decision", () => {
  const missingDate = enforceCalendarCreatePolicy([
    createCall({
      title: "Meeting",
      resolution: { date: "missing", start: "user", end: "user" },
    }),
  ], KOLKATA_CONTEXT);
  const missingStart = enforceCalendarCreatePolicy([
    createCall({
      title: "Meeting",
      resolution: { date: "exact", start: "missing", end: "user" },
    }),
  ], KOLKATA_CONTEXT);
  const missingEnd = enforceCalendarCreatePolicy([
    createCall({
      title: "Meeting",
      start: "2026-06-13T07:00:00+05:30",
      resolution: { date: "exact", start: "user", end: "missing" },
    }),
  ], KOLKATA_CONTEXT);

  assert.equal(missingDate.clarification, "Which day should I use?");
  assert.equal(missingStart.clarification, "What time should it start?");
  assert.equal(missingEnd.clarification, "What time should it end?");
});

test("calendar create policy requires an exact day for model-marked ranges", () => {
  const result = enforceCalendarCreatePolicy([
    createCall({
      title: "Meeting",
      start: "2026-06-16T09:00:00+05:30",
      end: "2026-06-16T10:00:00+05:30",
      resolution: { date: "range", start: "user", end: "user" },
    }),
  ], KOLKATA_CONTEXT);

  assert.deepEqual(result.calls, []);
  assert.equal(result.clarification, "Which day should I use?");
});

test("calendar create policy retries malformed executable contracts", () => {
  const missingResolution = enforceCalendarCreatePolicy([
    createCall({
      title: "Meeting",
      start: "2026-06-13T09:00:00+05:30",
      end: "2026-06-13T10:00:00+05:30",
    }),
  ], KOLKATA_CONTEXT);
  const malformedStart = enforceCalendarCreatePolicy([
    createCall({
      title: "Meeting",
      start: "tomorrow morning",
      end: "2026-06-13T10:00:00+05:30",
      resolution: { date: "exact", start: "user", end: "user" },
    }),
  ], KOLKATA_CONTEXT);
  const missingDuration = enforceCalendarCreatePolicy([
    createCall({
      title: "Meeting",
      start: "2026-06-13T09:00:00+05:30",
      resolution: { date: "exact", start: "user", end: "duration" },
    }),
  ], KOLKATA_CONTEXT);
  const fractionalDuration = enforceCalendarCreatePolicy([
    createCall({
      title: "Meeting",
      start: "2026-06-13T09:00:00+05:30",
      resolution: {
        date: "exact",
        start: "user",
        end: "duration",
        durationMinutes: 1.5,
      },
    }),
  ], KOLKATA_CONTEXT);

  assert.match(missingResolution.retryInstruction || "", /requires resolution/);
  assert.match(malformedStart.retryInstruction || "", /full ISO 8601/);
  assert.match(missingDuration.retryInstruction || "", /durationMinutes/);
  assert.match(fractionalDuration.retryInstruction || "", /must be an integer/);
  assert.deepEqual(fractionalDuration.calls, []);
});

test("calendar create policy rejects past and non-positive events", () => {
  const exactPast = enforceCalendarCreatePolicy([
    createCall({
      title: "Meeting",
      start: "2026-06-12T01:00:00+05:30",
      end: "2026-06-12T02:00:00+05:30",
      resolution: { date: "exact", start: "user", end: "user" },
    }),
  ], KOLKATA_CONTEXT);
  const badNextOccurrence = enforceCalendarCreatePolicy([
    createCall({
      title: "Meeting",
      start: "2026-06-12T01:00:00+05:30",
      end: "2026-06-12T02:00:00+05:30",
      resolution: { date: "next_occurrence", start: "user", end: "user" },
    }),
  ], KOLKATA_CONTEXT);
  const reversed = enforceCalendarCreatePolicy([
    createCall({
      title: "Meeting",
      start: "2026-06-13T10:00:00+05:30",
      end: "2026-06-13T09:00:00+05:30",
      resolution: { date: "exact", start: "user", end: "user" },
    }),
  ], KOLKATA_CONTEXT);

  assert.equal(exactPast.clarification, "That time has passed. What time should it start?");
  assert.equal(exactPast.retryInstruction, undefined);
  assert.match(badNextOccurrence.retryInstruction || "", /next future occurrence/);
  assert.equal(reversed.clarification, "What time should it end?");
});

test("calendar create policy reads and validates complete TimeContext", () => {
  assert.deepEqual(
    getCalendarTimeContext([{
      role: "system",
      content: 'TimeContext: {"userTimezone":"Asia/Kolkata","nowLocal":"2026-06-12T04:40:00+05:30"}',
    }]),
    KOLKATA_CONTEXT
  );
  assert.equal(
    getCalendarTimeContext([{
      role: "system",
      content: 'TimeContext: {"nowLocal":"2026-06-12T04:40:00+05:30"}',
    }]),
    null
  );
  assert.equal(
    getCalendarTimeContext([{
      role: "system",
      content: 'TimeContext: {"userTimezone":"America/New_York","nowLocal":"2026-01-10T09:00:00-04:00"}',
    }]),
    null
  );
});

test("calendar create policy enforces the target date's DST offset", () => {
  const correctSummerOffset = enforceCalendarCreatePolicy([
    createCall({
      title: "Summer meeting",
      start: "2026-06-13T09:00:00-04:00",
      end: "2026-06-13T10:00:00-04:00",
      resolution: { date: "exact", start: "user", end: "user" },
    }),
  ], NEW_YORK_WINTER_CONTEXT);
  const staleWinterOffset = enforceCalendarCreatePolicy([
    createCall({
      title: "Summer meeting",
      start: "2026-06-13T09:00:00-05:00",
      end: "2026-06-13T10:00:00-05:00",
      resolution: { date: "exact", start: "user", end: "user" },
    }),
  ], NEW_YORK_WINTER_CONTEXT);

  assert.equal(correctSummerOffset.calls.length, 1);
  assert.match(staleWinterOffset.retryInstruction || "", /daylight-saving changes/);
  assert.deepEqual(staleWinterOffset.calls, []);
});

test("calendar create policy caps model-proposed batches", () => {
  const sixCalls = Array.from({ length: 6 }, (_, index) => createCall({
    title: `Event ${index + 1}`,
    start: `2026-06-${String(index + 13).padStart(2, "0")}T09:00:00+05:30`,
    end: `2026-06-${String(index + 13).padStart(2, "0")}T10:00:00+05:30`,
    resolution: { date: "exact", start: "user", end: "user" },
  }));

  const result = enforceCalendarCreatePolicy(sixCalls, KOLKATA_CONTEXT);

  assert.deepEqual(result.calls, []);
  assert.match(result.clarification || "", /up to 5 events/);
  assert.equal(result.retryInstruction, undefined);
});

test("calendar create policy leaves unrelated calls untouched", () => {
  const searchCall = { name: "calendar_search", arguments: { query: "dentist" } };
  const result = enforceCalendarCreatePolicy([searchCall], KOLKATA_CONTEXT);

  assert.deepEqual(result.calls, [searchCall]);
});

test("calendar recovery retries model contract errors only once", () => {
  const policy = {
    calls: [],
    retryInstruction: "Correct the structured call.",
    clarification: "Could you restate the event details?",
  };

  assert.equal(getCalendarCreateRecoveryAction(policy, false), "retry");
  assert.equal(getCalendarCreateRecoveryAction(policy, true), "clarify");
});
