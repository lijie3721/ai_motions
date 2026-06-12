import test from "node:test";
import assert from "node:assert/strict";
import {
  applyScenePatch,
  applyShotPatch,
  applyShotReorder,
  applyUserRevisionAsync,
  applyUserRevision,
  attachDocumentContext,
  attachUserMediaAsset,
  confirmMaterialRefresh,
  confirmProjectPlan,
  createProjectFromPrompt,
} from "../src/planner.js";

test("createProjectFromPrompt creates a confirmation-first video project", () => {
  const project = createProjectFromPrompt("帮我做一个宣传我们家火锅店的视频");

  assert.equal(project.type, "chat-video-project");
  assert.equal(project.status, "needs_script_confirmation");
  assert.equal(project.storyboard, null);
  assert.equal(project.confirmation.aspectRatio, "9:16");
  assert.ok(project.creativeScript);
  assert.ok(project.creativeScript.sceneBeats.length >= 4);
  assert.match(project.brief.goal, /火锅店/);
  assert.match(project.messages.at(-1).content, /脚本/);
});

test("confirmProjectPlan turns a confirmed idea into an editable storyboard draft", () => {
  const project = createProjectFromPrompt("帮我做一个宣传我们家火锅店的视频");
  const confirmed = confirmProjectPlan(project, "确认，做抖音竖屏，热闹一点");

  assert.equal(confirmed.status, "draft_ready");
  assert.equal(confirmed.storyboard.aspectRatio, "9:16");
  assert.ok(confirmed.storyboard.scenes.length >= 4);
  assert.ok(confirmed.storyboard.scenes.every((scene) => scene.media?.href?.includes("/public/assets/hotpot/")));
  assert.ok(confirmed.storyboard.scenes.flatMap((scene) => scene.shots || []).length >= 12);
  assert.match(confirmed.messages[0].content, /火锅店/);
  assert.equal(confirmed.storyboard.scenes[0].media.assetId, "hotpot-restaurant");
  assert.match(confirmed.messages.at(-1).content, /分镜/);
});

test("confirmProjectPlan expands creative script beats into storyboard scenes", () => {
  const project = createProjectFromPrompt("我在日本做旅游，引导中国人去旅游的宣传视频");
  const confirmed = confirmProjectPlan(project, { aspectRatio: "16:9", duration: 30 });

  assert.equal(confirmed.status, "draft_ready");
  assert.equal(confirmed.storyboard.scenes.length, project.creativeScript.sceneBeats.length);
  assert.equal(confirmed.storyboard.scenes[0].title, project.creativeScript.sceneBeats[0].title);
  assert.match(confirmed.storyboard.scenes[0].visualPrompt, /日本|东京|京都|富士山|旅行/);
});

test("confirmProjectPlan accepts structured confirmation options", () => {
  const project = createProjectFromPrompt("帮我做一个宣传咖啡店的视频");
  const confirmed = confirmProjectPlan(project, {
    aspectRatio: "16:9",
    duration: 30,
    style: "简洁现代",
    voiceover: false,
  });

  assert.equal(confirmed.confirmation.aspectRatio, "16:9");
  assert.equal(confirmed.confirmation.duration, 30);
  assert.equal(confirmed.confirmation.style, "简洁现代");
  assert.equal(confirmed.confirmation.voiceover, false);
  assert.equal(confirmed.storyboard.aspectRatio, "16:9");
  assert.equal(confirmed.storyboard.duration, 30);
  assert.equal(confirmed.storyboard.style, "简洁现代");
});

test("confirmProjectPlan stores selected video language before storyboard generation", () => {
  const project = createProjectFromPrompt("帮我做一个宣传咖啡店的视频");
  const confirmed = confirmProjectPlan(project, {
    aspectRatio: "9:16",
    duration: 25,
    language: "en",
    voicePreset: "female_natural_en",
  });

  assert.equal(confirmed.confirmation.language, "en");
  assert.equal(confirmed.confirmation.voicePreset, "female_natural_en");
  assert.equal(confirmed.storyboard.language, "en");
  assert.equal(confirmed.storyboard.confirmation.language, "en");
  assert.doesNotMatch(confirmed.storyboard.scenes.map((scene) => scene.narration).join(" "), /[\u4e00-\u9fff]/);
  assert.doesNotMatch(confirmed.storyboard.scenes.map((scene) => [scene.title, ...(scene.highlights || [])].join(" ")).join(" "), /[\u4e00-\u9fff]/);
});

test("confirmProjectPlan defaults voice preset to selected language", () => {
  const project = createProjectFromPrompt("帮我做一个宣传咖啡店的视频");
  const english = confirmProjectPlan(project, { language: "en" });
  assert.equal(english.confirmation.voicePreset, "female_natural_en");

  const japanese = confirmProjectPlan(project, { language: "ja" });
  assert.equal(japanese.confirmation.voicePreset, "female_japanese");

  const korean = confirmProjectPlan(project, { language: "ko" });
  assert.equal(korean.confirmation.voicePreset, "female_korean");
});

test("confirmProjectPlan summarizes confirmed script language and voice in chat", () => {
  const project = createProjectFromPrompt("我是一个留学机构，做澳洲、欧洲、美国宣传视频");
  const confirmed = confirmProjectPlan(project, {
    aspectRatio: "9:16",
    duration: 25,
    language: "en",
    voicePreset: "female_natural_en",
    style: "高级商业宣传",
  });
  const message = confirmed.messages.at(-1).content;

  assert.match(message, /已确认方案/);
  assert.match(message, /视频语言：English/);
  assert.match(message, /配音：English female/);
  assert.match(message, /比例：9:16/);
  assert.match(message, /时长：25s/);
  assert.match(message, /脚本摘要/);
  assert.match(message, /01\./);
});

test("applyUserRevision can update a target scene from conversational feedback", () => {
  const project = confirmProjectPlan(createProjectFromPrompt("帮我做一个宣传我们家火锅店的视频"));
  const updated = applyUserRevision(project, "第二段更热闹一点，突出火锅沸腾和朋友聚餐");

  assert.equal(updated.storyboard.scenes.length, project.storyboard.scenes.length);
  assert.match(updated.storyboard.scenes[1].title, /热闹|沸腾|朋友|聚餐/);
  assert.match(updated.storyboard.scenes[1].media.assetId, /hotpot/);
  assert.match(updated.messages.at(-1).content, /第二段/);
});

test("applyScenePatch edits a timeline scene and clears stale render output", () => {
  const project = confirmProjectPlan(createProjectFromPrompt("帮我做一个宣传我们家火锅店的视频"));
  project.render = { status: "complete" };
  const updated = applyScenePatch(project, "scene-2", {
    title: "锅底沸腾的近景",
    narration: "镜头贴近红油锅底和翻滚热气。",
    highlights: "红油锅底，热气，食材",
    duration: 9,
  });

  assert.equal(updated.render, null);
  assert.equal(updated.storyboard.scenes[1].title, "锅底沸腾的近景");
  assert.deepEqual(updated.storyboard.scenes[1].highlights, ["红油锅底", "热气", "食材"]);
  assert.equal(updated.storyboard.scenes[1].media.assetId, "hotpot-table");
  assert.equal(updated.storyboard.duration, 27);
});

test("applyScenePatch preserves prepared stock media for non-hotpot storyboards", () => {
  const project = confirmProjectPlan(createProjectFromPrompt("我在云南卖蘑菇，帮我做一个宣传视频"));
  const media = {
    id: "stock-mushroom-1",
    type: "image",
    title: "云南菌菇素材",
    href: "/jobs/project-1/assets/stock/mushroom.jpg",
    posterHref: "/jobs/project-1/assets/stock/mushroom.jpg",
    provider: "pexels",
  };
  project.storyboard.scenes = project.storyboard.scenes.map((scene) => ({
    ...scene,
    shots: (scene.shots || []).map((shot) => ({ ...shot, media })),
  }));

  const updated = applyScenePatch(project, "scene-1", {
    title: "云南菌菇开场",
    narration: "如果你还没吃过云南菌菇，那是因为还没吃过我家的。",
    highlights: "云南菌菇，新鲜采摘",
    duration: 8,
    visualPrompt: "云南菌菇市场和新鲜采摘",
  });

  const shots = updated.storyboard.scenes.flatMap((scene) => scene.shots || []);
  assert.equal(shots.length, 17);
  assert.ok(shots.every((shot) => shot.media?.href === media.href));
  assert.ok(shots.every((shot) => shot.media?.posterHref === media.posterHref));
});

test("non-hotpot projects keep generated visuals instead of unrelated stock photos", () => {
  const project = confirmProjectPlan(createProjectFromPrompt("帮我做一个宣传咖啡店的视频"));

  assert.ok(project.storyboard.scenes.every((scene) => !scene.media));
});

test("mushroom seller prompts create mushroom-specific storyboard copy", () => {
  const project = confirmProjectPlan(createProjectFromPrompt("我是 在云南卖蘑菇的，帮我做个宣传视频"));
  const text = [
    project.brief.subject,
    project.brief.coreValue,
    ...project.storyboard.scenes.flatMap((scene) => [scene.title, scene.visualPrompt, ...(scene.highlights || [])]),
  ].join(" ");

  assert.match(text, /蘑菇|菌菇|野生菌/);
  assert.match(text, /云南|产地|新鲜/);
});

test("applyUserRevision rebuilds script when the user switches to a new topic", () => {
  const project = confirmProjectPlan(createProjectFromPrompt("帮我做一个猪肉批发宣传视频"));
  const updated = applyUserRevision(project, "改成我在日本做旅游，引导中国人去旅游的宣传视频");

  assert.equal(updated.status, "needs_script_confirmation");
  assert.equal(updated.storyboard, null);
  assert.equal(updated.render, null);
  assert.equal(updated.brief.subject, "日本旅游");
  assert.match(updated.creativeScript.targetAudience, /中国游客/);
  assert.ok(updated.creativeScript.stockQueries.every((query) => !/pork|meat|restaurant/i.test(query)));
});

test("applyUserRevision asks for confirmation before refreshing unsatisfactory material", () => {
  const project = confirmProjectPlan(createProjectFromPrompt("我在济南，开了卤煮店，想宣传视频"));
  project.render = { status: "complete", outputPath: "/jobs/project/output.mp4" };
  project.storyboard.scenes[0].shots[0].media = {
    id: "stock-old",
    type: "image",
    title: "Black Friday promo",
    href: "/jobs/project/assets/stock/black-friday.jpg",
    provider: "pexels",
  };

  const updated = applyUserRevision(project, "你生成的素材里，没有卤煮的画面，也没有济南的照片");

  assert.equal(updated.status, "needs_material_confirmation");
  assert.equal(updated.render.status, "complete");
  assert.equal(updated.storyboard.scenes[0].shots[0].media.id, "stock-old");
  assert.match(updated.pendingMaterialRefresh.summary, /济南|卤煮/);
  assert.ok(updated.pendingMaterialRefresh.stockQueries.some((query) => /Jinan|braised/i.test(query)));
  assert.match(updated.messages.at(-1).content, /确认|重新.*素材|找素材/);
});

test("applyUserRevision routes natural material complaints into a visual refresh confirmation", () => {
  const project = confirmProjectPlan(createProjectFromPrompt("我在卖东北卖大米，卖东北五常大米，你帮我生成一个宣传视频"));

  const updated = applyUserRevision(project, "这个视频里面的跟大米没什么关系的素材，我说了要出现东北冬天的样子，还有大米在稻田里的样子，还有在餐桌上的样子，还有在超市里的样子，你都没什么反应啊。");

  assert.equal(updated.status, "needs_material_confirmation");
  assert.deepEqual(updated.pendingMaterialRefresh.requestedVisuals, ["大米", "稻田", "餐桌", "东北冬天", "超市"]);
  assert.ok(updated.pendingMaterialRefresh.forbiddenVisuals.some((item) => /不相关|没关系/.test(item)));
  assert.ok(updated.pendingMaterialRefresh.stockQueries.some((query) => /rice field/i.test(query)));
  assert.ok(updated.pendingMaterialRefresh.stockQueries.some((query) => /rice bowl on table/i.test(query)));
  assert.ok(updated.pendingMaterialRefresh.stockQueries.some((query) => /Northeast China winter/i.test(query)));
  assert.doesNotMatch(updated.messages.at(-1).content, /已更新整体视频方向/);
});

test("applyUserRevisionAsync uses LLM action routing for material distribution feedback without clearing media", async () => {
  const project = confirmProjectPlan(createProjectFromPrompt("我在云南卖蘑菇，帮我做一个宣传视频"));
  const existingMedia = {
    id: "stock-old-mushroom",
    type: "image",
    title: "旧菌菇市场素材",
    href: "/jobs/project/assets/stock/mushroom.jpg",
    provider: "pexels",
  };
  project.storyboard.scenes = project.storyboard.scenes.map((scene) => ({
    ...scene,
    shots: (scene.shots || []).map((shot) => ({ ...shot, media: existingMedia })),
  }));
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({
      choices: [{
        message: {
          content: JSON.stringify({
            intent: "asset_distribution_feedback",
            confidence: 0.96,
            actions: [{
              type: "request_material_refresh",
              requiresConfirmation: true,
              scope: "project",
              params: {
                summary: "云南野生菌市场、摊位、顾客挑选和真实售卖现场",
                requestedVisuals: ["云南市场", "野生菌摊位", "顾客挑选"],
                forbiddenVisuals: ["无关餐厅"],
                stockQueries: ["Yunnan mushroom market", "wild mushroom stall", "customers buying mushrooms"],
                perSceneMinAssets: 3,
                perSceneMaxAssets: 5,
              },
            }],
            constraints: {
              preserveUserMedia: true,
              replaceOnlyUnlockedSystemMedia: true,
            },
            assistantReply: "我可以按每个分镜重新准备独立素材，确认后开始。",
          }),
        },
      }],
    }),
  });

  const updated = await applyUserRevisionAsync(project, "每个分镜都共用同一组图，重新按云南卖蘑菇配素材", {
    env: { DASHSCOPE_API_KEY: "test-key" },
    fetchImpl,
  });

  assert.equal(updated.status, "needs_material_confirmation");
  assert.equal(updated.pendingAction.type, "request_material_refresh");
  assert.equal(updated.pendingMaterialRefresh.perSceneMinAssets, 3);
  assert.ok(updated.pendingMaterialRefresh.stockQueries.some((query) => /Yunnan mushroom/i.test(query)));
  assert.ok(updated.storyboard.scenes.flatMap((scene) => scene.shots || []).every((shot) => shot.media?.id === "stock-old-mushroom"));
  assert.match(updated.messages.at(-1).content, /每个分镜|确认/);
});

test("applyUserRevisionAsync edits a target scene without regenerating or clearing media", async () => {
  const project = confirmProjectPlan(createProjectFromPrompt("帮我做一个宣传我们家火锅店的视频"));
  const originalMediaIds = project.storyboard.scenes.flatMap((scene) => scene.shots || []).map((shot) => shot.media?.id || shot.media?.assetId || shot.media?.href);
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({
      choices: [{
        message: {
          content: JSON.stringify({
            intent: "scene_edit",
            confidence: 0.91,
            actions: [{
              type: "edit_scene",
              requiresConfirmation: false,
              scope: "scene",
              sceneIndex: 0,
              params: {
                title: "开场更短更抓人",
                narration: "一进门就看到热气和人气。",
              },
            }],
            constraints: { doNotRender: true },
            assistantReply: "已更新第一段，不重新找素材。",
          }),
        },
      }],
    }),
  });

  const updated = await applyUserRevisionAsync(project, "第一段标题短一点，不要重新找素材", {
    env: { DASHSCOPE_API_KEY: "test-key" },
    fetchImpl,
  });

  const nextMediaIds = updated.storyboard.scenes.flatMap((scene) => scene.shots || []).map((shot) => shot.media?.id || shot.media?.assetId || shot.media?.href);
  assert.equal(updated.status, "draft_ready");
  assert.equal(updated.storyboard.scenes[0].title, "开场更短更抓人");
  assert.deepEqual(nextMediaIds, originalMediaIds);
  assert.equal(updated.pendingMaterialRefresh, undefined);
  assert.match(updated.messages.at(-1).content, /第一段|素材/);
});

test("applyUserRevisionAsync falls back to material confirmation when LLM returns no executable action", async () => {
  const project = confirmProjectPlan(createProjectFromPrompt("我在云南卖蘑菇，帮我做一个宣传视频"));
  const existingMedia = {
    id: "stock-existing",
    type: "image",
    title: "现有蘑菇素材",
    href: "/jobs/project/assets/stock/existing.jpg",
    provider: "pexels",
  };
  project.storyboard.scenes = project.storyboard.scenes.map((scene) => ({
    ...scene,
    shots: (scene.shots || []).map((shot) => ({ ...shot, media: existingMedia })),
  }));
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({
      choices: [{
        message: {
          content: JSON.stringify({
            intent: "general_revision",
            confidence: 0.8,
            actions: [],
            assistantReply: "我理解你的反馈了。",
          }),
        },
      }],
    }),
  });

  const updated = await applyUserRevisionAsync(project, "这些素材太少了，每个分镜不要共用同一组图，请重新配三到五张云南蘑菇市场素材", {
    env: { DASHSCOPE_API_KEY: "test-key" },
    fetchImpl,
  });

  assert.equal(updated.status, "needs_material_confirmation");
  assert.equal(updated.pendingAction.type, "request_material_refresh");
  assert.ok(updated.pendingMaterialRefresh.stockQueries.length);
  assert.ok(updated.storyboard.scenes.flatMap((scene) => scene.shots || []).every((shot) => shot.media?.id === "stock-existing"));
});

test("confirmMaterialRefresh clears only unlocked system media and keeps locked user media", () => {
  const project = confirmProjectPlan(createProjectFromPrompt("我在济南，开了卤煮店，想宣传视频"));
  project.render = { status: "complete", outputPath: "/jobs/project/output.mp4" };
  project.storyboard.scenes[0].shots[0].media = {
    id: "stock-old",
    type: "image",
    title: "Black Friday promo",
    href: "/jobs/project/assets/stock/black-friday.jpg",
    provider: "pexels",
  };
  project.storyboard.scenes[0].shots[1].media = {
    id: "media-1",
    type: "image",
    title: "用户门店",
    href: "/uploads/store.jpg",
    provider: "user",
  };
  project.storyboard.scenes[0].shots[1].mediaLocked = true;

  const pending = applyUserRevision(project, "素材不满意，没有济南和卤煮，重新配图");
  const updated = confirmMaterialRefresh(pending);

  assert.equal(updated.status, "draft_ready");
  assert.equal(updated.render, null);
  assert.equal(updated.pendingMaterialRefresh, null);
  assert.equal(updated.storyboard.scenes[0].shots[0].media, null);
  assert.equal(updated.storyboard.scenes[0].shots[1].media.id, "media-1");
  assert.equal(updated.storyboard.scenes[0].shots[1].mediaLocked, true);
  assert.ok(updated.storyboard.stockQueries.some((query) => /Jinan|braised/i.test(query)));
  assert.match(updated.messages.at(-1).content, /开始重新准备素材|重新准备镜头配图/);
});

test("attachDocumentContext adds uploaded documents as project context", () => {
  const project = confirmProjectPlan(createProjectFromPrompt("帮我做一个招商视频"));
  const updated = attachDocumentContext(project, {
    id: "asset-1",
    originalName: "deck.pptx",
    pageCount: 2,
    warnings: [],
    slides: [
      { title: "市场规模", body: "年轻用户增长" },
      { title: "商业模式", body: "会员和到店转化" },
    ],
  });

  assert.equal(updated.assets.length, 1);
  assert.match(updated.assets[0].summary, /市场规模/);
  assert.match(updated.storyboard.scenes[0].visualPrompt, /市场规模/);
  assert.equal(updated.render, null);
});

test("attachUserMediaAsset adds uploaded images to the project media library", () => {
  const project = confirmProjectPlan(createProjectFromPrompt("帮我做一个宣传我们家火锅店的视频"));
  const updated = attachUserMediaAsset(project, {
    id: "media-1",
    originalName: "store.jpg",
    mimeType: "image/jpeg",
    href: "/uploads/store.jpg",
    filePath: "/private/store.jpg",
  });

  assert.equal(updated.assets.length, 1);
  assert.equal(updated.assets[0].type, "user-media");
  assert.equal(updated.assets[0].href, "/uploads/store.jpg");
  assert.equal(updated.render, null);
});

test("applyShotPatch edits one shot and locks user-selected media", () => {
  const project = attachUserMediaAsset(confirmProjectPlan(createProjectFromPrompt("帮我做一个宣传我们家火锅店的视频")), {
    id: "media-1",
    originalName: "store.jpg",
    mimeType: "image/jpeg",
    href: "/uploads/store.jpg",
    filePath: "/private/store.jpg",
  });

  const updated = applyShotPatch(project, "scene-2", "scene-2-shot-1", {
    caption: "门店实拍",
    duration: 2,
    motion: "whip_pan",
    transition: "flash_cut",
    mediaId: "media-1",
  });

  const shot = updated.storyboard.scenes[1].shots[0];
  assert.equal(shot.caption, "门店实拍");
  assert.equal(shot.motion, "whip_pan");
  assert.equal(shot.media.id, "media-1");
  assert.equal(shot.mediaLocked, true);
  assert.equal(updated.render, null);
  assert.equal(updated.storyboard.scenes[1].shots.at(-1).start + updated.storyboard.scenes[1].shots.at(-1).duration, updated.storyboard.scenes[1].duration);
});

test("applyShotReorder reorders shots and normalizes timing", () => {
  const project = confirmProjectPlan(createProjectFromPrompt("帮我做一个宣传我们家火锅店的视频"));
  const scene = project.storyboard.scenes[1];
  const ids = scene.shots.map((shot) => shot.id);
  const updated = applyShotReorder(project, "scene-2", [ids[1], ids[0], ...ids.slice(2)]);

  assert.equal(updated.storyboard.scenes[1].shots[0].id, ids[1]);
  assert.equal(updated.storyboard.scenes[1].shots[0].start, 0);
  assert.equal(updated.render, null);
});
