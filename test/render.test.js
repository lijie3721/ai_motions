import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { writeComposition } from "../src/render.js";

test("writeComposition exposes a deterministic seek function for browser capture", async () => {
  const jobDir = await mkdtemp(path.join(tmpdir(), "ai-motions-render-"));
  const storyboard = {
    title: "Demo",
    width: 1920,
    height: 1080,
    duration: 4,
    scenes: [
      {
        id: "scene-1",
        slideIndex: 1,
        duration: 4,
        title: "Opening",
        narration: "Narration",
        motion: "slow_zoom_in",
        transition: "fade_in",
        highlights: ["Opening"],
        media: {
          title: "火锅桌面与锅底",
          filePath: path.join(jobDir, "hotpot.jpg"),
        },
        shots: [
          {
            id: "scene-1-shot-1",
            start: 0,
            duration: 2,
            caption: "热气锅底",
            motion: "snap_zoom",
            transition: "flash_cut",
            media: {
              type: "image",
              title: "火锅桌面与锅底",
              filePath: path.join(jobDir, "hotpot.jpg"),
            },
          },
          {
            id: "scene-1-shot-2",
            start: 2,
            duration: 2,
            caption: "朋友聚餐",
            motion: "whip_pan",
            transition: "whip_wipe",
            media: {
              type: "image",
              title: "多人围坐用餐",
              filePath: path.join(jobDir, "dining.jpg"),
            },
          },
        ],
      },
    ],
  };

  const compositionPath = await writeComposition({ jobDir, storyboard });
  const html = await readFile(compositionPath, "utf8");

  assert.match(html, /window\.__aiMotionsSeek = function/);
  assert.match(html, /data-capture-mode/);
  assert.match(html, /shot-stage/);
  assert.match(html, /template-opener/);
  assert.match(html, /kinetic-layer/);
  assert.match(html, /scene-eyebrow/);
  assert.match(html, /class="shot /);
  assert.match(html, /热气锅底/);
  assert.match(html, /hotpot\.jpg/);
});
