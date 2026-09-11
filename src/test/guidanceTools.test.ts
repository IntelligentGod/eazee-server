import test from "node:test";
import assert from "node:assert/strict";
import { AppOpenScreenSchema, ChatRenameSchema } from "../tools/appNavigation";
import { GoalCreateSchema, GoalCreateWithGuidanceSchema, GuidanceCurrentStepSchema } from "../tools/guidance";
import { getOpenAIToolDefs, getOpenAIToolDefsByNames, validateToolCall } from "../tools/registry";
import { TodoCreateManySchema, TodoCreateWithStepsSchema, TodoEditManySchema } from "../tools/todo";

test("goal_create requires an explicit timeframe", () => {
  assert.equal(GoalCreateSchema.safeParse({ title: "Learn guitar" }).success, false);
  assert.equal(GoalCreateSchema.safeParse({ title: "Learn guitar", timeframe: "thisMonth" }).success, true);
  assert.equal(validateToolCall("goal_create", { title: "Learn guitar" }).ok, false);
  assert.equal(validateToolCall("goal_create", { title: "Learn guitar", timeframe: "longTerm" }).ok, true);
});

test("goal_create_with_guidance requires explicit timeframe and guidance path", () => {
  assert.equal(GoalCreateWithGuidanceSchema.safeParse({ title: "Learn saxophone", timeframe: "thisMonth" }).success, false);
  assert.equal(GoalCreateWithGuidanceSchema.safeParse({ title: "Learn saxophone", guidancePath: "actions" }).success, false);
  assert.equal(GoalCreateWithGuidanceSchema.safeParse({
    title: "Learn saxophone",
    timeframe: "thisMonth",
    guidancePath: "actions",
    sourceSteps: [{ title: "Practice embouchure", details: "Five minutes." }],
  }).success, true);
  assert.equal(validateToolCall("goal_create_with_guidance", {
    title: "Learn saxophone",
    timeframe: "thisWeek",
    guidancePath: "video",
  }).ok, true);
  assert.equal(validateToolCall("goal_create_with_guidance", {
    title: "Learn saxophone",
    timeframe: "thisWeek",
    guidancePath: "calendar",
  }).ok, false);
});

test("guidance_current_step accepts current, next, and all scopes", () => {
  assert.equal(GuidanceCurrentStepSchema.safeParse({ textContains: "guitar", scope: "current" }).success, true);
  assert.equal(GuidanceCurrentStepSchema.safeParse({ textContains: "guitar", scope: "next" }).success, true);
  assert.equal(GuidanceCurrentStepSchema.safeParse({ todoId: "123", scope: "all" }).success, true);
  assert.equal(validateToolCall("guidance_current_step", { textContains: "guitar", scope: "next" }).ok, true);
  assert.equal(validateToolCall("guidance_current_step", { textContains: "guitar", scope: "later" }).ok, false);
});

test("todo_create_with_steps requires one main title and checkable steps", () => {
  assert.equal(TodoCreateWithStepsSchema.safeParse({
    title: "Build portfolio site",
    steps: [
      { title: "Pick projects", details: "Choose three strong examples." },
      { title: "Write case studies" },
    ],
  }).success, true);
  assert.equal(TodoCreateWithStepsSchema.safeParse({
    title: "Build portfolio site",
    steps: [],
  }).success, false);
  assert.equal(validateToolCall("todo_create_with_steps", {
    title: "Build portfolio site",
    steps: [{ title: "Pick projects" }],
  }).ok, true);
});

test("todo tools accept recurrence for create and edit", () => {
  assert.equal(TodoCreateManySchema.safeParse({
    items: [{
      text: "Stretch",
      dueDate: "2026-05-18T20:00:00+05:30",
      hasDueTime: true,
      recurrence: { interval: 1, unit: "day" },
    }],
  }).success, true);
  assert.equal(validateToolCall("todo_create_many", {
    items: [{
      text: "Stretch",
      recurrence: { interval: 1, unit: "year" },
    }],
  }).ok, false);
  assert.equal(TodoEditManySchema.safeParse({
    items: [{
      id: "todo-1",
      recurrence: null,
    }],
  }).success, true);

  const createTool = getOpenAIToolDefsByNames(["todo_create_many"])[0] as any;
  const recurrence = createTool?.function?.parameters?.properties?.items?.items?.properties?.recurrence;
  assert.deepEqual(recurrence?.properties?.unit?.enum, ["day", "week", "month"]);
});

test("full chat registry exposes goal and guidance tools", () => {
  const tools = getOpenAIToolDefs();
  const names = tools
    .map((tool: any) => tool?.function?.name)
    .filter(Boolean);
  const guidanceCurrent = tools.find((tool: any) => tool?.function?.name === "guidance_current_step");
  const guidanceAnswer = tools.find((tool: any) => tool?.function?.name === "guidance_answer");
  const goalCreateWithGuidance = tools.find((tool: any) => tool?.function?.name === "goal_create_with_guidance");

  assert.ok(names.includes("app_open_screen"));
  assert.ok(names.includes("todo_create_with_steps"));
  assert.ok(names.includes("goal_create"));
  assert.ok(names.includes("goal_create_with_guidance"));
  assert.ok(names.includes("goal_query"));
  assert.ok(names.includes("guidance_current_step"));
  assert.ok(names.includes("guidance_answer"));
  assert.match(guidanceCurrent?.function?.description || "", /progress/);
  assert.match(guidanceAnswer?.function?.description || "", /resource\/link requests/);
  assert.match(goalCreateWithGuidance?.function?.description || "", /Quota goals do not support video guidance/);
});

test("compact-style explicit tool lists omit goal and guidance tools", () => {
  const names = getOpenAIToolDefsByNames(["todo_create_many", "todo_query"])
    .map((tool: any) => tool?.function?.name)
    .filter(Boolean);

  assert.deepEqual(names, ["todo_create_many", "todo_query"]);
});

test("app_open_screen accepts only supported destinations", () => {
  for (const destination of [
    "chat",
    "chat_history",
    "chat_new",
    "home_google_connection",
    "home_country",
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
    "todo",
    "todo_search",
    "todo_create",
    "todo_wishlist",
    "calendar_search",
  ]) {
    assert.equal(AppOpenScreenSchema.safeParse({ destination }).success, true, destination);
  }
  assert.equal(validateToolCall("app_open_screen", { destination: "calendar" }).ok, true);
  assert.equal(validateToolCall("app_open_screen", { destination: "email_search" }).ok, false);
  assert.equal(validateToolCall("app_open_screen", { destination: "notes" }).ok, false);
  assert.equal(AppOpenScreenSchema.safeParse({ destination: "wishlist" }).success, false);
});

test("chat_rename rejects blank titles and trims valid titles", () => {
  assert.equal(ChatRenameSchema.safeParse({ title: "   " }).success, false);
  const validation = validateToolCall("chat_rename", { title: "  Project Alpha  " });
  assert.equal(validation.ok, true);
  if (validation.ok) {
    assert.deepEqual(validation.data, { title: "Project Alpha" });
  }
});
