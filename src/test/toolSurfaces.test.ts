import test from "node:test";
import assert from "node:assert/strict";
import { getToolDefsForSurface, SURFACE_TOOL_NAMES, type AssistantSurface } from "../tools/surfaces";

const chatOnlyToolNames = [
  "chat_rename",
  "todo_create_with_steps",
  "goal_create",
  "goal_create_with_guidance",
  "goal_query",
  "guidance_current_step",
  "guidance_answer",
];

test("chat surface includes chat-only tools", () => {
  const names = new Set(getToolDefsForSurface("chat").map((tool: any) => tool?.function?.name).filter(Boolean));

  chatOnlyToolNames.forEach((name) => assert.equal(names.has(name), true, `${name} missing from chat surface`));
});

test("compact surfaces exclude chat-only tools", () => {
  (["todo", "calendar", "home"] as AssistantSurface[]).forEach((surface) => {
    const explicitNames = new Set(SURFACE_TOOL_NAMES[surface] || []);
    assert.equal(explicitNames.has("app_open_screen"), true, `app_open_screen missing from ${surface}`);
    chatOnlyToolNames.forEach((name) => assert.equal(explicitNames.has(name), false, `${name} unexpectedly allowed on ${surface}`));

    const resolvedNames = new Set(getToolDefsForSurface(surface).map((tool: any) => tool?.function?.name).filter(Boolean));
    assert.equal(resolvedNames.has("app_open_screen"), true, `app_open_screen missing from resolved ${surface}`);
    chatOnlyToolNames.forEach((name) => assert.equal(resolvedNames.has(name), false, `${name} unexpectedly resolved on ${surface}`));
  });
});

test("compact surfaces do not expose email tools", () => {
  const emailToolNames = ["email_fetch_latest", "email_search", "email_generate_reply_single", "email_update_draft", "email_refine_draft"];

  (["todo", "calendar", "home"] as AssistantSurface[]).forEach((surface) => {
    const explicitNames = new Set(SURFACE_TOOL_NAMES[surface] || []);
    const resolvedNames = new Set(getToolDefsForSurface(surface).map((tool: any) => tool?.function?.name).filter(Boolean));

    emailToolNames.forEach((name) => {
      assert.equal(explicitNames.has(name), false, `${name} unexpectedly allowed on ${surface}`);
      assert.equal(resolvedNames.has(name), false, `${name} unexpectedly resolved on ${surface}`);
    });
  });
});
