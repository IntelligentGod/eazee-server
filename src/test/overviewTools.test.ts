import test from "node:test";
import assert from "node:assert/strict";
import { getOpenAIToolDefsByNames, validateToolCall } from "../tools/registry";

function getPlanMyDayItemProperties() {
  const tool = getOpenAIToolDefsByNames(["plan_my_day"]).find((item: any) => item?.function?.name === "plan_my_day");
  return tool?.function?.parameters?.properties?.items?.items?.properties as any;
}

function getPlanMyDayDescription() {
  const tool = getOpenAIToolDefsByNames(["plan_my_day"]).find((item: any) => item?.function?.name === "plan_my_day");
  return String(tool?.function?.description || "");
}

test("plan_my_day validates timeline planning fields", () => {
  const validation = validateToolCall("plan_my_day", {
    date: "2026-05-13",
    items: [{
      text: "Write proposal",
      type: "task",
      dueDate: "2026-05-13T10:00:00+05:30",
      hasDueTime: true,
      order: 1,
      durationMinutes: 45,
      timeSource: "ai",
      daypart: "night",
    }],
  });

  assert.equal(validation.ok, true);
  if (validation.ok) {
    assert.equal(validation.data.items[0].order, 1);
    assert.equal(validation.data.items[0].durationMinutes, 45);
    assert.equal(validation.data.items[0].timeSource, "ai");
    assert.equal(validation.data.items[0].daypart, "night");
  }

  const props = getPlanMyDayItemProperties();
  assert.equal(props.order.type, "number");
  assert.equal(props.durationMinutes.type, "number");
  assert.deepEqual(props.timeSource.enum, ["user", "ai", "none"]);
  assert.deepEqual(props.daypart.enum, ["morning", "afternoon", "evening", "night"]);
  assert.deepEqual(props.type.enum, ["task", "event", "buffer"]);
});

test("plan_my_day accepts hidden scheduling buffers", () => {
  const validation = validateToolCall("plan_my_day", {
    date: "2026-05-13",
    items: [{
      text: "Transition time",
      type: "buffer",
      durationMinutes: 30,
      order: 2,
      timeSource: "none",
    }],
  });

  assert.equal(validation.ok, true);
});

test("plan_my_day rejects invalid timeline planning fields", () => {
  assert.equal(validateToolCall("plan_my_day", {
    items: [{ text: "Write proposal", timeSource: "maybe" }],
  }).ok, false);

  assert.equal(validateToolCall("plan_my_day", {
    items: [{ text: "Write proposal", durationMinutes: 10 }],
  }).ok, false);
});

test("plan_my_day tells the model not to ask for blockers or missing times", () => {
  const description = getPlanMyDayDescription();

  assert.match(description, /call this tool instead of asking for fixed-time events, blockers, or times for untimed items/);
  assert.match(description, /client checks existing calendar events and timed todos as blockers/);
});

test("plan_my_day tells the model to use hidden buffers for scheduling-only costs", () => {
  const description = getPlanMyDayDescription();

  assert.match(description, /scheduling-only time costs such as travel, transition, setup, cleanup, recovery, or breaks as type buffer/);
  assert.match(description, /Buffers affect placement but are hidden and not saved as todos\/calendar events/);
});

test("plan_my_day tells the model to preserve vague dayparts structurally", () => {
  const description = getPlanMyDayDescription();

  assert.match(description, /set daypart so the client can enforce that window even when the title is cleaned/);
  assert.match(description, /Never schedule a night\/tonight item in the afternoon/);
});
