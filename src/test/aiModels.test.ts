import test from "node:test";
import assert from "node:assert/strict";
import { AI_MODELS, getRouteModel } from "../ai/models";

test("AI model routing is fixed by feature", () => {
  assert.deepEqual(AI_MODELS, {
    main: "gpt-5.6-terra",
    compact: "gpt-5.6-terra",
    goalGuidance: "gpt-5.6-terra",
    lightweight: "gpt-5.4-mini",
    webSearch: "gpt-5.2",
  });
  assert.equal(getRouteModel(), AI_MODELS.main);
  assert.equal(getRouteModel("chat"), AI_MODELS.main);
  assert.equal(getRouteModel("compact"), AI_MODELS.compact);
});
