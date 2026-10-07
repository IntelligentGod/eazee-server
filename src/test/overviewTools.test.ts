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

test("plan_my_week takes a main goal and a timeline of up to 5 items per day", () => {
  const item = (text: string) => ({ text, type: "task", start: "2026-10-05T09:00:00+08:00", durationMinutes: 45 });
  const day = (date: string, count: number) => ({
    date,
    mainGoal: "Record pronunciation baseline",
    items: Array.from({ length: count }, (_, index) => item(`Item ${index + 1}`)),
  });
  const validation = validateToolCall("plan_my_week", { days: [day("2026-10-05", 5), day("2026-10-06", 2)] });
  assert.equal(validation.ok, true);
  if (validation.ok) assert.equal(validation.data.days[0].items?.length, 5);

  const trimmed = validateToolCall("plan_my_week", { days: [day("2026-10-05", 6)] });
  assert.equal(trimmed.ok && trimmed.data.days[0].items?.length, 5, "a sixth item is dropped, not the week");
  assert.equal(validateToolCall("plan_my_week", { days: [{ mainGoal: "No date" }] }).ok, false);
  assert.equal(validateToolCall("plan_my_week", { days: [] }).ok, false);

  const tool = getOpenAIToolDefsByNames(["plan_my_week"])[0] as any;
  assert.equal(tool?.function?.parameters?.properties?.days?.items?.properties?.items?.maxItems, 5);
});

test("plan_my_week tidies the model's small slips instead of refusing the week", () => {
  const validation = validateToolCall("plan_my_week", {
    weekGoal: null,
    days: [
      {
        date: "2026-10-05",
        mainGoal: "",
        items: [
          { text: "Stretch", type: "event", durationMinutes: 10, timeSource: "model", daypart: null, start: "2026-10-05T08:00:00+08:00" },
          { text: "", durationMinutes: 30 },
          { text: "Deep work", durationMinutes: 600, priority: "urgent" },
        ],
      },
      { date: "2026-10-06", mainGoal: "Rest", items: [] },
    ],
  });
  assert.equal(validation.ok, true);
  if (!validation.ok) return;
  const [monday, tuesday] = validation.data.days;
  assert.equal(validation.data.weekGoal, undefined);
  assert.equal(monday.mainGoal, "Stretch", "a missing focus falls back to the first block");
  assert.deepEqual(monday.items?.map((item: { text: string; durationMinutes?: number; timeSource?: string; priority?: string }) => [item.text, item.durationMinutes, item.timeSource, item.priority]), [
    ["Stretch", 15, undefined, undefined],
    ["Deep work", 480, undefined, undefined],
  ]);
  assert.equal(tuesday.items, undefined, "an empty day is kept, without items");
});

test("plan_my_week accepts the week's goal", () => {
  const validation = validateToolCall("plan_my_week", {
    weekGoal: "Study four languages",
    days: [{ date: "2026-10-05", mainGoal: "Spanish basics" }],
  });
  assert.equal(validation.ok, true);
  if (validation.ok) assert.equal(validation.data.weekGoal, "Study four languages");
});
