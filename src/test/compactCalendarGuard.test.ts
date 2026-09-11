import test from "node:test";
import assert from "node:assert/strict";
import { enforceCalendarCreatePolicy } from "../ai/calendarCreatePolicy";

test("legacy compact calendar guard is replaced by structured policy", () => {
  assert.equal(typeof enforceCalendarCreatePolicy, "function");
});
