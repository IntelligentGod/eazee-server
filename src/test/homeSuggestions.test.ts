import test from "node:test";
import assert from "node:assert/strict";
import {
  HomeSuggestionsRequestSchema,
  buildFallbackHomeSuggestions,
  buildHomeSuggestionsMessages,
  normalizeHomeSuggestionsResponse,
} from "../ai/homeSuggestions";

const request = HomeSuggestionsRequestSchema.parse({
  candidates: [
    {
      id: "goal:1",
      kind: "goal",
      openTodoId: "goal-1",
      title: "Continue Learn guitar",
      activeTodoIds: ["action-1"],
    },
    {
      id: "overdue:1",
      kind: "overdue",
      openTodoId: "todo-1",
      title: "File taxes",
    },
  ],
  freeWindow: {
    start: "2026-06-14T12:00:00.000Z",
    end: "2026-06-14T16:00:00.000Z",
  },
  today: { tasks: [], calendar: [] },
  userTimezone: "Asia/Kolkata",
  locale: "en-US",
});

test("home suggestions request accepts bounded local context", () => {
  assert.equal(request.candidates.length, 2);
});

test("home suggestions prompt requires balanced valid candidate selection", () => {
  const system = String(buildHomeSuggestionsMessages(request)[0]?.content || "");
  assert.match(system, /Choose only candidate IDs supplied/i);
  assert.match(system, /Always choose at least one supplied candidate/i);
  assert.match(system, /balanced mix/i);
  assert.match(system, /Today-plan overlap is allowed/i);
  assert.match(system, /preserve the supplied title exactly/i);
  assert.match(system, /never expose or substitute an active-action title/i);
});

test("home suggestions normalize valid ids and preserve root-goal title", () => {
  assert.deepEqual(normalizeHomeSuggestionsResponse({
    suggestions: [
      { candidateId: "goal:1", title: "Do hidden action", reason: " Build momentum ", confidence: 0.8 },
      { candidateId: "invented", title: "Invented", reason: "Bad", confidence: 1 },
      { candidateId: "goal:1", title: "Duplicate", reason: "Duplicate", confidence: 0.7 },
      { candidateId: "overdue:1", title: "Finish filing taxes", reason: "It is overdue", confidence: 2 },
    ],
  }, request.candidates), {
    suggestions: [
      {
        candidateId: "goal:1",
        title: "Continue Learn guitar",
        reason: "Build momentum",
        confidence: 0.8,
      },
      {
        candidateId: "overdue:1",
        title: "Finish filing taxes",
        reason: "It is overdue",
        confidence: 1,
      },
    ],
  });
});

test("home suggestions fallback selects only supplied candidates", () => {
  assert.deepEqual(buildFallbackHomeSuggestions(request.candidates), {
    suggestions: [
      {
        candidateId: "goal:1",
        title: "Continue Learn guitar",
        reason: "Use the available time to make progress on this.",
        confidence: 0.5,
      },
      {
        candidateId: "overdue:1",
        title: "Finish File taxes",
        reason: "Use the available time to clear this overdue task.",
        confidence: 0.5,
      },
    ],
  });
});
