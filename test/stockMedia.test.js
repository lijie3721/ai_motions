import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { confirmProjectPlan, createProjectFromPrompt } from "../src/planner.js";
import { buildStockQueries, prepareStoryboardShots } from "../src/stockMedia.js";

test("prepareStoryboardShots creates high-frequency fallback shots without API keys", async () => {
  const project = confirmProjectPlan(createProjectFromPrompt("帮我做一个宣传我们家火锅店的视频"));
  const jobDir = await mkdtemp(path.join(tmpdir(), "ai-motions-stock-"));

  const { storyboard, manifest } = await prepareStoryboardShots({
    storyboard: project.storyboard,
    jobDir,
    env: {},
  });

  const shots = storyboard.scenes.flatMap((scene) => scene.shots || []);
  assert.ok(shots.length >= 12);
  assert.ok(shots.every((shot) => shot.duration >= 0.35));
  assert.ok(shots.some((shot) => shot.transition === "flash_cut"));
  assert.equal(manifest.summary.provider, "fallback-local-media");

  const manifestFile = await readFile(path.join(jobDir, "assets", "stock", "stock-manifest.json"), "utf8");
  assert.match(manifestFile, /fallback-local-media/);
});

test("prepareStoryboardShots builds dumpling stock queries without hotpot fallback media", async () => {
  const project = confirmProjectPlan(createProjectFromPrompt("帮我做一个饺子馆宣传视频"));
  const jobDir = await mkdtemp(path.join(tmpdir(), "ai-motions-stock-dumpling-"));

  const { storyboard, manifest } = await prepareStoryboardShots({
    storyboard: project.storyboard,
    brief: project.brief,
    jobDir,
    env: {},
  });

  assert.ok(manifest.queries.some((query) => query.includes("dumpling")));
  assert.ok(manifest.queries.every((query) => !query.includes("hot pot")));
  assert.equal(manifest.summary.localCount, 0);
  assert.ok(storyboard.scenes.flatMap((scene) => scene.shots || []).every((shot) => !shot.media?.href?.includes("/public/assets/hotpot/")));
});

test("buildStockQueries uses mushroom and Yunnan queries for mushroom sellers", () => {
  const project = confirmProjectPlan(createProjectFromPrompt("我是 在云南卖蘑菇的，帮我做个宣传视频"));
  const queries = buildStockQueries({ storyboard: project.storyboard, brief: project.brief });

  assert.ok(queries.some((query) => /mushroom|fungi/i.test(query)));
  assert.ok(queries.some((query) => /yunnan/i.test(query)));
  assert.notEqual(queries[0], "restaurant promo");
});

test("buildStockQueries prefers creative script queries for tourism projects", () => {
  const project = confirmProjectPlan(createProjectFromPrompt("我在日本做旅游，引导中国人去旅游的宣传视频"));
  const queries = buildStockQueries({ storyboard: project.storyboard, brief: project.brief });

  assert.ok(queries.some((query) => /Japan|Tokyo|Kyoto|Fuji/i.test(query)));
  assert.ok(queries.every((query) => !/restaurant|pork|meat/i.test(query)));
});

test("buildStockQueries prefers refreshed storyboard queries over old creative script queries", () => {
  const project = confirmProjectPlan(createProjectFromPrompt("我在济南，开了卤煮店，想宣传视频"));
  project.storyboard.stockQueries = ["Jinan Chinese braised food", "Jinan street food"];

  const queries = buildStockQueries({ storyboard: project.storyboard, brief: project.brief });

  assert.deepEqual(queries.slice(0, 2), ["Jinan Chinese braised food", "Jinan street food"]);
});

test("prepareStoryboardShots degrades when stock fetch fails", async () => {
  const project = confirmProjectPlan(createProjectFromPrompt("帮我做一个饺子馆宣传视频"));
  const jobDir = await mkdtemp(path.join(tmpdir(), "ai-motions-stock-fail-"));

  const { storyboard, manifest } = await prepareStoryboardShots({
    storyboard: project.storyboard,
    brief: project.brief,
    jobDir,
    env: { PEXELS_API_KEY: "test-key" },
    fetchImpl: async () => {
      throw new Error("network unavailable");
    },
  });

  assert.equal(manifest.summary.provider, "generated-visuals");
  assert.equal(storyboard.scenes.flatMap((scene) => scene.shots || []).length, 17);
});

test("prepareStoryboardShots exposes downloaded stock media with browser hrefs", async () => {
  const project = confirmProjectPlan(createProjectFromPrompt("帮我做一个饺子馆宣传视频"));
  const jobDir = path.join(tmpdir(), "jobs", "project-public-href");
  const videoBytes = Buffer.from("fake-video");
  const fetchImpl = async (url) => {
    const href = String(url);
    if (href.includes("api.pexels.com")) {
      return new Response(JSON.stringify({
        videos: [{
          id: 123,
          url: "https://pexels.test/video",
          image: "https://images.pexels.test/dumpling.jpg",
          video_files: [{ width: 1280, height: 720, link: "https://media.test/dumpling.mp4" }],
        }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(videoBytes, { status: 200 });
  };

  const { storyboard } = await prepareStoryboardShots({
    storyboard: project.storyboard,
    brief: project.brief,
    jobDir,
    env: { PEXELS_API_KEY: "test-key" },
    fetchImpl,
  });

  const media = storyboard.scenes.flatMap((scene) => scene.shots || []).find((shot) => shot.media)?.media;
  assert.ok(media.href.startsWith("/jobs/project-public-href/assets/stock/"));
  assert.equal(media.posterHref, "https://images.pexels.test/dumpling.jpg");
  assert.ok(media.filePath.endsWith(path.join("assets", "stock", "pexels-123.mp4")));
});

test("prepareStoryboardShots can use Pexels photos for visible storyboard thumbnails", async () => {
  const project = confirmProjectPlan(createProjectFromPrompt("我是 在云南卖蘑菇的，帮我做个宣传视频"));
  const jobDir = path.join(tmpdir(), "jobs", "project-photo-href");
  const imageBytes = Buffer.from("fake-image");
  const fetchImpl = async (url) => {
    const href = String(url);
    if (href.includes("api.pexels.com/v1/search")) {
      return new Response(JSON.stringify({
        photos: [{
          id: 456,
          url: "https://pexels.test/photo",
          alt: "Wild mushrooms",
          src: { large: "https://images.test/mushroom-large.jpg", medium: "https://images.test/mushroom-medium.jpg" },
        }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (href.includes("api.pexels.com/videos/search")) {
      return new Response(JSON.stringify({ videos: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(imageBytes, { status: 200 });
  };

  const { storyboard } = await prepareStoryboardShots({
    storyboard: project.storyboard,
    brief: project.brief,
    jobDir,
    env: { PEXELS_API_KEY: "test-key" },
    fetchImpl,
  });

  const media = storyboard.scenes.flatMap((scene) => scene.shots || []).find((shot) => shot.media)?.media;
  assert.equal(media.type, "image");
  assert.ok(media.href.startsWith("/jobs/project-photo-href/assets/stock/"));
  assert.equal(media.posterHref, media.href);
});

test("prepareStoryboardShots downloads per-scene media pools instead of per-shot duplicates", async () => {
  const project = confirmProjectPlan(createProjectFromPrompt("我在济南，开了卤煮店，想宣传视频"), { duration: 25 });
  project.storyboard.stockQueries = ["Jinan Chinese braised food", "Jinan street food", "local Chinese restaurant kitchen"];
  const jobDir = path.join(tmpdir(), "jobs", "project-rich-media");
  const imageBytes = Buffer.from("fake-image");
  const seenQueries = [];
  const fetchImpl = async (url) => {
    const href = String(url);
    if (href.includes("api.pexels.com/v1/search")) {
      const query = new URL(href).searchParams.get("query");
      const perPage = Number(new URL(href).searchParams.get("per_page"));
      seenQueries.push({ query, perPage });
      return new Response(JSON.stringify({
        photos: Array.from({ length: perPage }, (_, index) => ({
          id: `${query}-${index}`.replace(/\W+/g, "-"),
          url: `https://pexels.test/${query}/${index}`,
          alt: query,
          src: { large: `https://images.test/${encodeURIComponent(query)}-${index}.jpg` },
        })),
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (href.includes("api.pexels.com/videos/search")) {
      return new Response(JSON.stringify({ videos: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(imageBytes, { status: 200 });
  };

  const { manifest } = await prepareStoryboardShots({
    storyboard: project.storyboard,
    brief: project.brief,
    jobDir,
    env: { PEXELS_API_KEY: "test-key" },
    fetchImpl,
  });

  const sceneTargetCount = manifest.summary.sceneMediaTargets.reduce((sum, item) => sum + item.targetCount, 0);
  assert.equal(project.storyboard.scenes.flatMap((scene) => scene.shots || []).length, 17);
  assert.equal(sceneTargetCount, 14);
  assert.equal(manifest.summary.targetExternalCount, sceneTargetCount);
  assert.equal(manifest.summary.externalCount, sceneTargetCount);
  assert.equal(manifest.summary.insufficientMedia, false);
  assert.ok(seenQueries.some((item) => item.perPage > 2));
});

test("prepareStoryboardShots clears stale stock files before downloading current media", async () => {
  const project = confirmProjectPlan(createProjectFromPrompt("我在新疆卖哈密瓜，帮我做一个宣传视频"));
  project.storyboard.stockQueries = ["Xinjiang cantaloupe farm", "fresh cantaloupe market"];
  const jobDir = await mkdtemp(path.join(tmpdir(), "ai-motions-stock-clean-"));
  const stockDir = path.join(jobDir, "assets", "stock");
  await mkdir(stockDir, { recursive: true });
  await writeFile(path.join(stockDir, "old-unused.jpg"), "old");
  await writeFile(path.join(stockDir, "old-unused.mp4"), "old");
  const imageBytes = Buffer.from("fake-image");
  const fetchImpl = async (url) => {
    const href = String(url);
    if (href.includes("api.pexels.com/v1/search")) {
      const query = new URL(href).searchParams.get("query");
      const perPage = Number(new URL(href).searchParams.get("per_page"));
      return new Response(JSON.stringify({
        photos: Array.from({ length: perPage }, (_, index) => ({
          id: `${query}-${index}`.replace(/\W+/g, "-"),
          url: `https://pexels.test/${query}/${index}`,
          alt: query,
          src: { large: `https://images.test/${encodeURIComponent(query)}-${index}.jpg` },
        })),
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (href.includes("api.pexels.com/videos/search")) {
      return new Response(JSON.stringify({ videos: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(imageBytes, { status: 200 });
  };

  const { manifest } = await prepareStoryboardShots({
    storyboard: project.storyboard,
    brief: project.brief,
    jobDir,
    env: { PEXELS_API_KEY: "test-key" },
    fetchImpl,
  });
  const files = await readdir(stockDir);

  assert.equal(files.includes("old-unused.jpg"), false);
  assert.equal(files.includes("old-unused.mp4"), false);
  assert.equal(files.length, manifest.items.length + 1);
  assert.ok(files.includes("stock-manifest.json"));
});

test("prepareStoryboardShots assigns independent media groups per scene", async () => {
  const project = confirmProjectPlan(createProjectFromPrompt("我在云南卖蘑菇，帮我做一个宣传视频"), { duration: 30 });
  project.storyboard.stockQueries = ["Yunnan mushroom market", "wild mushroom stall", "fresh mushrooms", "customers buying mushrooms"];
  const jobDir = path.join(tmpdir(), "jobs", "project-scene-media-groups");
  const imageBytes = Buffer.from("fake-image");
  const fetchImpl = async (url) => {
    const href = String(url);
    if (href.includes("api.pexels.com/v1/search")) {
      const query = new URL(href).searchParams.get("query");
      return new Response(JSON.stringify({
        photos: Array.from({ length: 20 }, (_, index) => ({
          id: `${query}-${index}`.replace(/\W+/g, "-"),
          url: `https://pexels.test/${query}/${index}`,
          alt: `${query} ${index}`,
          src: { large: `https://images.test/${encodeURIComponent(query)}-${index}.jpg` },
        })),
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (href.includes("api.pexels.com/videos/search")) {
      return new Response(JSON.stringify({ videos: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(imageBytes, { status: 200 });
  };

  const { storyboard, manifest } = await prepareStoryboardShots({
    storyboard: project.storyboard,
    brief: project.brief,
    jobDir,
    env: { PEXELS_API_KEY: "test-key" },
    fetchImpl,
  });

  assert.equal(manifest.summary.sceneMediaTargets.length, storyboard.scenes.length);
  assert.ok(manifest.summary.sceneMediaTargets.every((item) => item.targetCount >= 3));
  const sceneMediaIds = storyboard.scenes.map((scene) => new Set((scene.shots || []).map((shot) => shot.media?.id).filter(Boolean)));
  assert.ok(sceneMediaIds.every((ids) => ids.size >= 3));
  for (let index = 1; index < sceneMediaIds.length; index += 1) {
    const overlap = [...sceneMediaIds[index]].filter((id) => sceneMediaIds[0].has(id));
    assert.equal(overlap.length, 0);
  }
});

test("prepareStoryboardShots fills visible fallback media when external stock has no results", async () => {
  const project = confirmProjectPlan(createProjectFromPrompt("我在卖东北五常大米，帮我做一个宣传视频"));
  project.storyboard.stockQueries = ["rice field", "rice bowl on table", "rice bags supermarket", "Northeast China winter"];
  project.storyboard.requestedVisuals = ["大米", "稻田", "餐桌", "东北冬天", "超市"];
  const jobDir = await mkdtemp(path.join(tmpdir(), "ai-motions-stock-fallback-"));

  const { storyboard, manifest } = await prepareStoryboardShots({
    storyboard: project.storyboard,
    brief: project.brief,
    jobDir,
    env: { PEXELS_API_KEY: "test-key" },
    fetchImpl: async (url) => {
      const href = String(url);
      if (href.includes("api.pexels.com/v1/search")) {
        return new Response(JSON.stringify({ photos: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (href.includes("api.pexels.com/videos/search")) {
        return new Response(JSON.stringify({ videos: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(Buffer.from(""));
    },
  });

  const shots = storyboard.scenes.flatMap((scene) => scene.shots || []);
  assert.ok(shots.length >= 12);
  assert.ok(shots.every((shot) => shot.media?.href));
  assert.ok(shots.every((shot) => shot.media?.posterHref));
  assert.ok(shots.some((shot) => /大米|稻田|餐桌|东北冬天|超市/.test(shot.media.title)));
  assert.equal(manifest.summary.insufficientMedia, true);
  assert.equal(manifest.summary.fallbackVisualCount, manifest.summary.targetExternalCount);
  assert.ok(manifest.summary.warnings.some((warning) => /外部素材不足/.test(warning)));
});

test("prepareStoryboardShots preserves locked user media shots", async () => {
  const project = createProjectFromPrompt("帮我做一个宣传我们家火锅店的视频");
  const confirmed = confirmProjectPlan(project);
  const jobDir = await mkdtemp(path.join(tmpdir(), "ai-motions-stock-locked-"));
  const scene = confirmed.storyboard.scenes[1];
  scene.shots[0] = {
    ...scene.shots[0],
    mediaLocked: true,
    media: {
      id: "media-1",
      type: "image",
      title: "用户上传门店",
      href: "/uploads/store.jpg",
      provider: "user",
    },
  };

  const { storyboard } = await prepareStoryboardShots({
    storyboard: confirmed.storyboard,
    jobDir,
    env: {},
  });

  assert.equal(storyboard.scenes[1].shots[0].media.id, "media-1");
  assert.equal(storyboard.scenes[1].shots[0].mediaLocked, true);
});
