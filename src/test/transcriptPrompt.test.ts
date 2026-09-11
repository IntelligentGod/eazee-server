import test from "node:test";
import assert from "node:assert/strict";
import { buildTranscriptPromptChunks } from "../ai/transcriptPrompt";

test("buildTranscriptPromptChunks keeps later transcript ranges instead of truncating at the front", () => {
  const segments = Array.from({ length: 18 }, (_, index) => ({
    start: index * 600,
    text: `Step ${index + 1} ` + "x".repeat(1700),
  }));

  const chunks = buildTranscriptPromptChunks(segments, 5000);

  assert.ok(chunks.length > 1);
  assert.equal(chunks[0]?.startSeconds, 0);
  assert.equal(chunks[chunks.length - 1]?.endSeconds, 10200);
  assert.match(chunks[chunks.length - 1]?.transcript || "", /\[10200s\]/);
  for (const chunk of chunks) {
    assert.ok(chunk.transcript.length <= 5000);
  }
});

test("buildTranscriptPromptChunks clamps oversized single lines to chunk limit", () => {
  const chunks = buildTranscriptPromptChunks([
    { start: 0, text: "x".repeat(6000) },
    { start: 60, text: "next step" },
  ], 1000);

  assert.equal(chunks.length, 1);
  assert.ok(chunks[0]);
  assert.ok(chunks[0]!.transcript.length <= 1000);
  assert.match(chunks[0]!.transcript, /\[0s\]/);
  assert.match(chunks[0]!.transcript, /\[60s\]/);
});
