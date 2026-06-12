import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProjectStore } from "../src/projectStore.js";
import { createProjectFromPrompt, confirmProjectPlan, applyScenePatch } from "../src/planner.js";

test("ProjectStore persists and lists project drafts", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ai-motions-store-"));
  const store = new ProjectStore(path.join(dir, "projects.sqlite"));

  const first = createProjectFromPrompt("帮我做一个去泰国潜水的旅行团宣传", { id: "project-1" });
  const second = confirmProjectPlan(createProjectFromPrompt("我在日本做旅游，引导中国人去旅游的宣传视频", { id: "project-2" }));
  store.saveProject(first);
  store.saveProject(second);

  const loaded = store.getProject("project-1");
  assert.equal(loaded.id, "project-1");
  assert.match(loaded.brief.subject, /泰国|潜水/);

  const list = store.listProjects();
  assert.equal(list.length, 2);
  assert.ok(list.some((item) => item.id === "project-1" && item.status === "needs_script_confirmation"));
  assert.ok(list.some((item) => item.id === "project-2" && item.sceneCount >= 4));

  store.close();
});

test("ProjectStore keeps edited storyboard after reopening database", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ai-motions-store-"));
  const dbPath = path.join(dir, "projects.sqlite");
  const store = new ProjectStore(dbPath);
  const project = confirmProjectPlan(createProjectFromPrompt("帮我做一个宣传咖啡店的视频", { id: "project-1" }));
  const edited = applyScenePatch(project, "scene-1", {
    title: "咖啡香气开场",
    narration: "先闻到咖啡香，再看到门店。",
    highlights: "咖啡香气，门店",
  });
  store.saveProject(edited);
  store.close();

  const reopened = new ProjectStore(dbPath);
  const loaded = reopened.getProject("project-1");
  assert.equal(loaded.storyboard.scenes[0].title, "咖啡香气开场");
  reopened.close();
});
