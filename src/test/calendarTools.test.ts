import test from "node:test";
import assert from "node:assert/strict";
import { getOpenAIToolDefsByNames, validateToolCall } from "../tools/registry";
import { withCompactCalendarCreateContract } from "../tools/calendar";

function getTool(name: string) {
  return getOpenAIToolDefsByNames([name]).find((item: any) => item?.function?.name === name) as any;
}

function getToolParameters(name: string) {
  return getTool(name)?.function?.parameters as any;
}

test("calendar create exposes and validates details", () => {
  const tool = getTool("calendar_create");
  const validation = validateToolCall("calendar_create", {
    title: "Interview",
    start: "2026-05-09T10:00:00+05:30",
    end: "2026-05-09T10:30:00+05:30",
    details: "Bring portfolio link.",
  });

  assert.equal(validation.ok, true);
  if (validation.ok) assert.equal(validation.data.details, "Bring portfolio link.");
  assert.equal(getToolParameters("calendar_create")?.properties?.details?.type, "string");
  assert.deepEqual(getToolParameters("calendar_create")?.required, ["title", "start", "end"]);
  assert.equal(getToolParameters("calendar_create")?.properties?.resolution, undefined);
  assert.match(getToolParameters("calendar_create")?.properties?.title?.description, /Never ask only for a title/);
  assert.match(getToolParameters("calendar_create")?.properties?.title?.description, /Exclude create commands and scheduling expressions/);
  assert.match(getToolParameters("calendar_create")?.properties?.title?.description, /preserve date or time words that clearly belong to a named event/);
  assert.match(tool?.function?.description, /both start and end times/);
});

test("shared calendar create rejects compact-only incomplete proposals", () => {
  const validation = validateToolCall("calendar_create", {
    title: "Interview",
    start: "2026-05-09T10:00:00+05:30",
    resolution: {
      date: "exact",
      start: "user",
      end: "duration",
      durationMinutes: 45,
    },
  });

  assert.equal(validation.ok, false);
});

test("compact calendar tool definition exposes structured resolution only in its overlay", () => {
  const [compactTool] = withCompactCalendarCreateContract([getTool("calendar_create")]);
  const parameters = compactTool?.function?.parameters as any;

  assert.deepEqual(parameters?.required, ["title", "resolution"]);
  assert.deepEqual(
    parameters?.properties?.resolution?.properties?.date?.enum,
    ["exact", "next_occurrence", "range", "missing"]
  );
  assert.match(compactTool?.function?.description || "", /compact-calendar request/);
});

test("calendar update accepts details as the only changed field", () => {
  const validation = validateToolCall("calendar_update", {
    id: "evt_123",
    source: "local",
    details: "Use side entrance.",
  });

  assert.equal(validation.ok, true);
  if (validation.ok) assert.equal(validation.data.details, "Use side entrance.");
  assert.equal(getToolParameters("calendar_update")?.properties?.details?.type, "string");
});
