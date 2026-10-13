import assert from "node:assert/strict";
import test from "node:test";

import { getToolByName } from "../tools/registry";

test("calendar_create_many takes a whole roster, with weekly repeats", () => {
  const tool = getToolByName("calendar_create_many");
  assert.ok(tool, "tool is registered");
  assert.equal(tool!.mode, "client");
  const roster = {
    events: [
      { title: "Work shift", start: "2026-10-19T16:00:00+13:00", end: "2026-10-19T20:00:00+13:00", repeatWeekly: true },
      { title: "Work shift", start: "2026-10-21T16:00:00+13:00", end: "2026-10-21T20:00:00+13:00", repeatWeekly: true },
      { title: "Work shift", start: "2026-10-23T16:00:00+13:00", end: "2026-10-23T20:00:00+13:00", repeatWeekly: true },
      { title: "Work shift", start: "2026-10-24T10:00:00+13:00", end: "2026-10-24T16:00:00+13:00", repeatWeekly: true },
    ],
  };
  assert.equal(tool!.schema.safeParse(roster).success, true);
  assert.equal(tool!.schema.safeParse({ events: [] }).success, false);
  assert.match(tool!.description, /never add just the first one/);
});

test("only apps that can run it are offered calendar_create_many", async () => {
  const { filterToolsForClientCapabilities } = await import("../tools/surfaces");
  const tools = [{ function: { name: "calendar_create" } }, { function: { name: "calendar_create_many" } }];
  assert.deepEqual(filterToolsForClientCapabilities(tools, undefined).map((t) => t.function.name), ["calendar_create"]);
  assert.deepEqual(
    filterToolsForClientCapabilities(tools, ["calendar_create_many"]).map((t) => t.function.name),
    ["calendar_create", "calendar_create_many"]
  );
});
