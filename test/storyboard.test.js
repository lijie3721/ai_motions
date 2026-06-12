import test from "node:test";
import assert from "node:assert/strict";
import { generateStoryboard } from "../src/storyboard.js";

test("generateStoryboard creates one scene per slide with stable timing", () => {
  const storyboard = generateStoryboard({
    originalName: "Quarterly Review.pptx",
    slides: [
      { index: 1, title: "Revenue", body: "Revenue grew by 18 percent.", text: "Revenue\nRevenue grew by 18 percent.", imagePath: "slide-1.svg" },
      { index: 2, title: "Pipeline", body: "The pipeline is weighted toward enterprise accounts.", text: "Pipeline\nThe pipeline is weighted toward enterprise accounts.", imagePath: "slide-2.svg" },
    ],
  });

  assert.equal(storyboard.title, "Quarterly Review");
  assert.equal(storyboard.aspectRatio, "16:9");
  assert.equal(storyboard.scenes.length, 2);
  assert.equal(storyboard.scenes[0].start, 0);
  assert.equal(storyboard.scenes[1].start, storyboard.scenes[0].duration);
  assert.ok(storyboard.duration >= 8);
  assert.match(storyboard.scenes[0].narration, /Revenue/);
});
