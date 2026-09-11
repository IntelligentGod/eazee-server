import test from "node:test";
import assert from "node:assert/strict";

import { excludeVideosById } from "../ai/videoSelection";

test("excludeVideosById removes excluded ids and preserves order", () => {
  const videos = [
    { videoId: "first", title: "First" },
    { videoId: "second", title: "Second" },
    { videoId: "third", title: "Third" },
    { videoId: "fourth", title: "Fourth" },
  ];

  assert.deepEqual(
    excludeVideosById(videos, ["second", "fourth", "missing"]).map((video) => video.videoId),
    ["first", "third"]
  );
});

test("excludeVideosById returns original array when nothing is excluded", () => {
  const videos = [
    { videoId: "first", title: "First" },
    { videoId: "second", title: "Second" },
  ];

  assert.equal(excludeVideosById(videos, []), videos);
});
