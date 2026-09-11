import test from "node:test";
import assert from "node:assert/strict";
import { getOpenAIToolDefs, validateToolCall } from "../tools/registry";

const emailToolNames = [
  "email_fetch_latest",
  "email_search",
  "email_generate_reply_single",
  "email_update_draft",
  "email_refine_draft",
  "email_generate_reply_many",
  "email_generate_new_draft",
  "email_send_new",
  "email_send_reply",
];

test("email tools are not registered for routing", () => {
  const registeredNames = new Set(getOpenAIToolDefs().map((tool: any) => tool?.function?.name).filter(Boolean));

  emailToolNames.forEach((name) => {
    assert.equal(registeredNames.has(name), false, `${name} should not be registered`);
    assert.equal(validateToolCall(name, {}).ok, false, `${name} should not validate`);
  });
});
