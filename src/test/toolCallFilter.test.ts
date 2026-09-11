import test from "node:test";
import assert from "node:assert/strict";
import { filterClientToolCallsForUserIntent } from "../ai/toolCallFilter";

test("calendar event requests drop unrelated todo calls", () => {
  const calls = filterClientToolCallsForUserIntent([
    { name: "todo_query", arguments: { q: "friend" } },
    { name: "calendar_search", arguments: { query: "friend" } },
  ], "any friend events today");

  assert.deepEqual(calls.map((call) => call.name), ["calendar_search"]);
});

test("event-like subject words do not imply calendar intent", () => {
  const calls = filterClientToolCallsForUserIntent([
    { name: "todo_query", arguments: { q: "lunch" } },
    { name: "calendar_search", arguments: { query: "lunch" } },
  ], "lunch today");

  assert.deepEqual(calls.map((call) => call.name), ["todo_query", "calendar_search"]);
});

test("todo-only calls survive event-like subject words", () => {
  const calls = filterClientToolCallsForUserIntent([
    { name: "todo_create_many", arguments: { items: [{ text: "call mom" }] } },
  ], "add call mom tomorrow");

  assert.deepEqual(calls.map((call) => call.name), ["todo_create_many"]);
});

test("explicit todo requests drop unrelated calendar calls", () => {
  const calls = filterClientToolCallsForUserIntent([
    { name: "todo_query", arguments: { q: "friend" } },
    { name: "calendar_search", arguments: { query: "friend" } },
  ], "show friend tasks today");

  assert.deepEqual(calls.map((call) => call.name), ["todo_query"]);
});

test("keyworded calendar event requests keep the most relevant calendar read call", () => {
  const calls = filterClientToolCallsForUserIntent([
    { name: "calendar_search", arguments: { query: "T1" } },
    { name: "calendar_fetch_range", arguments: { from: "2026-05-09", to: "2026-05-10" } },
    { name: "calendar_search", arguments: { query: "friend" } },
  ], "any friend events today");

  assert.deepEqual(calls, [
    { name: "calendar_search", arguments: { query: "friend" } },
  ]);
});

test("broad calendar event requests prefer range fetch over generic search", () => {
  const calls = filterClientToolCallsForUserIntent([
    { name: "calendar_search", arguments: { query: "events" } },
    { name: "calendar_fetch_range", arguments: { from: "2026-05-09", to: "2026-05-10" } },
  ], "events today");

  assert.deepEqual(calls, [
    { name: "calendar_fetch_range", arguments: { from: "2026-05-09", to: "2026-05-10" } },
  ]);
});

test("mixed todo and calendar requests keep both domains", () => {
  const calls = filterClientToolCallsForUserIntent([
    { name: "todo_query", arguments: { q: "friend" } },
    { name: "calendar_search", arguments: { query: "friend" } },
  ], "show friend tasks and events today");

  assert.deepEqual(calls.map((call) => call.name), ["todo_query", "calendar_search"]);
});
