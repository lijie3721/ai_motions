import test from "node:test";
import assert from "node:assert/strict";
import { contentType, resolveSafeFilePath, toPublicJob, toPublicProject } from "../src/server.js";

function baseJob(outputPath = null, renderer = null) {
  return {
    id: "job-1",
    status: outputPath ? "complete" : "preview-ready",
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
    error: null,
    outputPath,
    renderer,
    documentAsset: {
      warnings: [],
      pageCount: 1,
    },
    storyboard: {
      title: "Demo",
      duration: 4,
      scenes: [],
    },
  };
}

test("toPublicJob prefers mp4 primary preview when output exists", () => {
  const job = toPublicJob(baseJob("/tmp/output.mp4", { type: "browser-capture", fidelity: "motion-preview" }));

  assert.equal(job.primaryPreview.type, "mp4");
  assert.equal(job.primaryPreview.href, "/jobs/job-1/output.mp4");
  assert.equal(job.links.mp4, "/jobs/job-1/output.mp4");
  assert.equal(job.renderer.type, "browser-capture");
  assert.equal(job.renderer.fidelity, "motion-preview");
});

test("toPublicJob falls back to composition preview without mp4", () => {
  const job = toPublicJob(baseJob());

  assert.equal(job.primaryPreview.type, "composition");
  assert.equal(job.primaryPreview.href, "/jobs/job-1/composition.html");
  assert.equal(job.links.mp4, null);
  assert.equal(job.renderer.type, "html-composition");
});

test("toPublicProject hides local paths and waits for completion before exposing links", () => {
  const project = {
    id: "project-1",
    title: "Demo",
    render: {
      status: "rendering",
      stage: "capturing-frames",
      outputPath: "/private/project-1/output.mp4",
      compositionPath: "/private/project-1/composition.html",
      updatedAt: "2026-06-06T00:00:00.000Z",
    },
  };

  const payload = toPublicProject(project);

  assert.equal(payload.render.status, "rendering");
  assert.equal(payload.render.stage, "capturing-frames");
  assert.equal(payload.render.outputPath, undefined);
  assert.equal(payload.render.compositionPath, undefined);
  assert.equal(payload.render.links, null);

  project.render.status = "complete";
  const completed = toPublicProject(project);
  assert.equal(completed.render.outputPath, undefined);
  assert.equal(completed.render.compositionPath, undefined);
  assert.equal(completed.render.links.mp4, "/jobs/project-1/output.mp4");
  assert.equal(completed.render.links.composition, "/jobs/project-1/composition.html");
});

test("toPublicProject exposes user media assets without local file paths", () => {
  const project = {
    id: "project-1",
    title: "Demo",
    render: null,
    assets: [
      {
        id: "media-1",
        type: "user-media",
        name: "store.jpg",
        href: "/uploads/store.jpg",
        filePath: "/private/store.jpg",
      },
    ],
  };

  const payload = toPublicProject(project);

  assert.equal(payload.assets[0].href, "/uploads/store.jpg");
  assert.equal(payload.assets[0].filePath, undefined);
});

test("toPublicProject hides storyboard media file paths", () => {
  const project = {
    id: "project-1",
    title: "Demo",
    render: null,
    assets: [],
    storyboard: {
      scenes: [{
        id: "scene-1",
        media: { href: "/jobs/project-1/assets/stock/a.jpg", filePath: "/private/a.jpg" },
        shots: [{
          id: "shot-1",
          media: { href: "/jobs/project-1/assets/stock/b.jpg", filePath: "/private/b.jpg" },
        }],
      }],
    },
  };

  const payload = toPublicProject(project);

  assert.equal(payload.storyboard.scenes[0].media.filePath, undefined);
  assert.equal(payload.storyboard.scenes[0].shots[0].media.filePath, undefined);
});

test("resolveSafeFilePath rejects paths outside the root", () => {
  const root = "/tmp/ai-motions-public";

  assert.equal(resolveSafeFilePath(root, "../.env"), null);
  assert.equal(resolveSafeFilePath(root, "/etc/passwd"), null);
});

test("resolveSafeFilePath allows normal nested paths inside the root", () => {
  const root = "/tmp/ai-motions-public";

  assert.equal(
    resolveSafeFilePath(root, "assets/cover.png"),
    "/tmp/ai-motions-public/assets/cover.png",
  );
});

test("contentType returns browser-safe image mime types", () => {
  assert.equal(contentType("cover.jpg"), "image/jpeg");
  assert.equal(contentType("cover.jpeg"), "image/jpeg");
  assert.equal(contentType("cover.png"), "image/png");
  assert.equal(contentType("cover.webp"), "image/webp");
});
