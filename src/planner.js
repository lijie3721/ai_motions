import { randomUUID } from "node:crypto";
import { createCreativePlan, createFallbackPlan } from "./creativePlanner.js";
import { routeConversationMessage, routeConversationMessageAsync } from "./conversationRouter.js";
import { enrichStoryboardMedia } from "./mediaAssets.js";
import { enrichStoryboardFallbackShots } from "./stockMedia.js";

export function createProjectFromPrompt(prompt, options = {}) {
  return createProjectFromPlan(prompt, createFallbackPlan(prompt), options);
}

export async function createProjectFromPromptAsync(prompt, options = {}) {
  return createProjectFromPlan(prompt, await createCreativePlan(prompt, options), options);
}

function createProjectFromPlan(prompt, plan, options = {}) {
  const now = new Date().toISOString();
  const { brief, creativeScript } = plan;
  const confirmation = createConfirmation(prompt, brief);

  return {
    id: options.id ?? randomUUID(),
    type: "chat-video-project",
    title: brief.title,
    status: "needs_script_confirmation",
    createdAt: now,
    updatedAt: now,
    brief,
    creativeScript,
    confirmation,
    messages: [
      {
        id: randomUUID(),
        role: "user",
        content: prompt,
        createdAt: now,
      },
      {
        id: randomUUID(),
        role: "assistant",
        content: `我先给你一版短视频脚本方向：${creativeScript.hook} 默认做 ${confirmation.aspectRatio}，${confirmation.duration} 秒，${confirmation.style}。确认脚本后，我再生成可编辑分镜和素材。`,
        createdAt: now,
      },
    ],
    storyboard: null,
    render: null,
    versions: [],
    assets: [],
  };
}

export function applyUserRevision(project, message) {
  if ((project.status === "needs_confirmation" || project.status === "needs_script_confirmation") && isConfirmationMessage(message)) {
    return confirmProjectPlan(project, message);
  }

  if (shouldRebuildCreativeScript(project, message)) {
    const next = createProjectFromPrompt(cleanTopicSwitchMessage(message), {
      id: project.id,
    });
    next.createdAt = project.createdAt;
    next.assets = (project.assets || []).filter((asset) => asset.type !== "stock-media");
    next.messages = [
      ...(project.messages || []),
      {
        id: randomUUID(),
        role: "user",
        content: message,
        createdAt: next.updatedAt,
      },
      {
        id: randomUUID(),
        role: "assistant",
        content: `已按新主题重写短视频脚本：${next.creativeScript.hook} 请先确认脚本，再生成新的分镜和素材。`,
        createdAt: next.updatedAt,
      },
    ];
    next.storyboard = null;
    next.render = null;
    return next;
  }

  const now = new Date().toISOString();
  const next = structuredClone(project);
  next.updatedAt = now;
  next.messages.push({
    id: randomUUID(),
    role: "user",
    content: message,
    createdAt: now,
  });

  if (!next.storyboard) {
    next.confirmation = {
      ...(next.confirmation || createConfirmation("", next.brief)),
      ...parseConfirmationOverrides(message),
    };
    next.brief.style = detectStyle(message, next.brief.style);
    next.messages.push({
      id: randomUUID(),
      role: "assistant",
      content: `已更新生成偏好：${next.confirmation.aspectRatio}，${next.confirmation.duration} 秒，${next.confirmation.style || next.brief.style}。确认后我会生成可编辑分镜。`,
      createdAt: now,
    });
    return next;
  }

  const conversationIntent = routeConversationMessage(next, message);
  next.lastConversationIntent = conversationIntent;
  if (conversationIntent.intent === "material_refresh_request" || isMaterialRefreshRequest(message)) {
    const refresh = createMaterialRefreshPlan(next, message, conversationIntent);
    next.status = "needs_material_confirmation";
    next.pendingMaterialRefresh = refresh;
    next.messages.push({
      id: randomUUID(),
      role: "assistant",
      content: `我可以重新帮你去生成一些更贴合「${refresh.summary}」的分镜素材，这会花一点时间。确认后我再开始找素材，并只替换未锁定的系统配图。`,
      createdAt: now,
    });
    return next;
  }

  const sceneIndex = detectSceneIndex(message, next.storyboard.scenes.length);
  if (sceneIndex !== null) {
    const scene = next.storyboard.scenes[sceneIndex];
    scene.title = reviseSceneTitle(scene.title, message);
    scene.narration = reviseNarration(scene.narration, message);
    scene.highlights = reviseHighlights(scene.highlights, message);
    scene.visualPrompt = `${scene.visualPrompt} ${message}`.trim();
  } else {
    next.brief.style = detectStyle(message, next.brief.style);
    next.storyboard.scenes = next.storyboard.scenes.map((scene) => ({
      ...scene,
      visualPrompt: `${scene.visualPrompt} ${next.brief.style}`.trim(),
    }));
  }

  if (/30\s*秒|三十秒|缩短/.test(message)) {
    next.storyboard.scenes = next.storyboard.scenes.map((scene) => ({ ...scene, duration: 5 }));
  }

  next.storyboard = withFallbackShots(enrichStoryboardMedia(normalizeStoryboardTiming(next.storyboard), next.brief));
  next.messages.push({
    id: randomUUID(),
    role: "assistant",
    content: sceneIndex === null
      ? "已更新整体视频方向，并重新整理了分镜。"
      : `已更新${formatSceneLabel(sceneIndex)}，你可以继续指定某一段或整体风格。`,
    createdAt: now,
  });
  return next;
}

export async function applyUserRevisionAsync(project, message, options = {}) {
  if ((project.status === "needs_confirmation" || project.status === "needs_script_confirmation") && isConfirmationMessage(message)) {
    return confirmProjectPlan(project, message);
  }

  if (!project.storyboard) {
    return applyUserRevision(project, message);
  }

  const now = new Date().toISOString();
  const next = structuredClone(project);
  next.updatedAt = now;
  next.messages.push({
    id: randomUUID(),
    role: "user",
    content: message,
    createdAt: now,
  });

  const route = await routeConversationMessageAsync(next, message, options);
  next.lastConversationRoute = route;
  next.actionHistory = [
    ...(next.actionHistory || []),
    {
      id: randomUUID(),
      createdAt: now,
      route,
    },
  ].slice(-20);

  const primaryAction = firstExecutableAction(route);
  if (!primaryAction) {
    next.messages.push({
      id: randomUUID(),
      role: "assistant",
      content: route.assistantReply || "我理解你的反馈了。你可以继续指定某一段、某张图，或确认是否需要重新找素材。",
      createdAt: now,
    });
    return next;
  }

  return executeConversationAction(next, primaryAction, route, message, now, options);
}

export function confirmMaterialRefresh(project, accepted = true) {
  const now = new Date().toISOString();
  const next = structuredClone(project);
  next.updatedAt = now;
  if (!accepted) {
    next.status = "draft_ready";
    next.pendingMaterialRefresh = null;
    next.pendingAction = null;
    next.messages.push({
      id: randomUUID(),
      role: "assistant",
      content: "好的，先保留当前素材。你也可以继续指定某一张图或上传本地素材替换。",
      createdAt: now,
    });
    return next;
  }

  const refresh = next.pendingMaterialRefresh || createMaterialRefreshPlan(next, "");
  next.status = "draft_ready";
  next.pendingMaterialRefresh = null;
  next.pendingAction = null;
  next.brief.stockQueries = refresh.stockQueries;
  next.storyboard.stockQueries = refresh.stockQueries;
  next.storyboard.requestedVisuals = refresh.requestedVisuals || [];
  next.storyboard.forbiddenVisuals = refresh.forbiddenVisuals || [];
  next.storyboard.mediaPlan = {
    perSceneMinAssets: refresh.perSceneMinAssets || 3,
    perSceneMaxAssets: refresh.perSceneMaxAssets || 5,
    preserveUserMedia: refresh.preserveUserMedia !== false,
  };
  next.storyboard.scenes = next.storyboard.scenes.map((scene) => ({
    ...scene,
    visualPrompt: [scene.visualPrompt, refresh.summary].filter(Boolean).join(" "),
    shots: (scene.shots || []).map((shot) => shot.mediaLocked ? shot : { ...shot, media: null }),
  }));
  next.render = null;
  next.messages.push({
    id: randomUUID(),
    role: "assistant",
    content: `已确认，我开始重新准备镜头配图：${refresh.stockQueries.slice(0, 3).join(" / ")}。`,
    createdAt: now,
  });
  return next;
}

export function confirmProjectPlan(project, message = "确认") {
  const now = new Date().toISOString();
  const next = structuredClone(project);
  const overrides = typeof message === "object" && message !== null
    ? parseStructuredConfirmation(message)
    : parseConfirmationOverrides(message);
  next.updatedAt = now;
  next.status = "draft_ready";
  next.confirmation = {
    ...(next.confirmation || createConfirmation("", next.brief)),
    ...overrides,
    confirmedAt: now,
  };
  next.confirmation.language = normalizeVideoLanguage(next.confirmation.language);
  next.confirmation.voicePreset = next.confirmation.voiceover === false
    ? next.confirmation.voicePreset
    : normalizeVoicePresetForLanguage(next.confirmation.language, next.confirmation.voicePreset);
  next.brief.style = next.confirmation.style || next.brief.style;
  next.brief.platform = next.confirmation.platform || next.brief.platform;
  next.storyboard = withFallbackShots(enrichStoryboardMedia(createStoryboardFromBrief(next.brief, next.confirmation, next.creativeScript), next.brief));
  next.render = null;
  next.messages.push({
    id: randomUUID(),
    role: "assistant",
    content: buildConfirmedSummary(next),
    createdAt: now,
  });
  return next;
}

function buildConfirmedSummary(project) {
  const scenes = project.storyboard?.scenes || [];
  const shotCount = scenes.flatMap((scene) => scene.shots || []).length;
  const confirmation = project.confirmation || {};
  const scriptLines = scenes.slice(0, 4).map((scene, index) => {
    const title = scene.title || `Scene ${index + 1}`;
    const narration = scene.narration ? `：${scene.narration}` : "";
    return `${String(index + 1).padStart(2, "0")}. ${title}${narration}`;
  });

  return [
    `已确认方案，并生成 ${scenes.length} 段分镜和 ${shotCount} 个镜头。`,
    `视频语言：${languageLabel(confirmation.language || project.storyboard?.language)}`,
    `配音：${voicePresetLabel(confirmation.voiceover === false ? "off" : confirmation.voicePreset)}`,
    `比例：${confirmation.aspectRatio || project.storyboard?.aspectRatio || "9:16"} · 时长：${formatDuration(confirmation.duration || project.storyboard?.duration || 0)} · 风格：${confirmation.style || project.storyboard?.style || project.brief?.style || "默认"}`,
    "脚本摘要：",
    ...scriptLines,
    "你可以继续修改分镜、替换素材，确认后生成视频。",
  ].join("\n");
}

function languageLabel(value) {
  return {
    "zh-CN": "中文",
    en: "English",
    ja: "日本語",
    ko: "한국어",
  }[value] || "中文";
}

function voicePresetLabel(value) {
  return {
    female_bright_cn: "中文女声",
    male_warm_cn: "中文男声",
    female_calm_cn: "中文温和女声",
    female_natural_en: "English female · Jennifer",
    male_commercial_en: "English male · Ryan",
    english_travel: "English travel · Cherry",
    female_japanese: "日本語 female",
    female_korean: "한국어 female",
    off: "无口播",
  }[value] || "中文女声";
}

function formatDuration(value) {
  const number = Number.parseFloat(value || 0);
  if (!Number.isFinite(number) || number <= 0) return "0s";
  return `${Math.round(number * 10) / 10}s`;
}

export function applyScenePatch(project, sceneId, patch) {
  const now = new Date().toISOString();
  const next = structuredClone(project);
  const index = next.storyboard.scenes.findIndex((scene) => scene.id === sceneId);
  if (index === -1) return null;

  const scene = next.storyboard.scenes[index];
  const highlights = Array.isArray(patch.highlights)
    ? patch.highlights
    : String(patch.highlights || "")
      .split(/[,，\n]/)
      .map((item) => item.trim())
      .filter(Boolean);

  next.storyboard.scenes[index] = {
    ...scene,
    title: cleanPatchText(patch.title, scene.title, 80),
    narration: cleanPatchText(patch.narration, scene.narration, 220),
    visualPrompt: cleanPatchText(patch.visualPrompt, scene.visualPrompt, 220),
    highlights: highlights.length ? highlights.slice(0, 4) : scene.highlights,
    duration: Math.max(3, Math.min(20, Number(patch.duration) || scene.duration)),
  };

  next.storyboard = normalizeStoryboardTiming(next.storyboard);
  next.storyboard.scenes[index].shots = normalizeShotTiming(next.storyboard.scenes[index].shots || [], next.storyboard.scenes[index].duration);
  next.updatedAt = now;
  next.render = null;
  next.messages.push({
    id: randomUUID(),
    role: "assistant",
    content: `已保存${formatSceneLabel(index)}的剪辑修改。需要我重新生成右侧视频时，点击 Generate video draft。`,
    createdAt: now,
  });
  return next;
}

export function attachDocumentContext(project, documentAsset) {
  const now = new Date().toISOString();
  const next = structuredClone(project);
  const text = documentAsset.slides
    .map((slide) => [slide.title, slide.body].filter(Boolean).join("："))
    .filter(Boolean)
    .slice(0, 6)
    .join(" / ");

  next.assets.push({
    id: documentAsset.id,
    type: "document",
    name: documentAsset.originalName,
    pageCount: documentAsset.pageCount,
    warnings: documentAsset.warnings,
    summary: text || "附件暂无可读文本",
  });
  if (!next.storyboard) {
    next.updatedAt = now;
    next.render = null;
    next.messages.push({
      id: randomUUID(),
      role: "assistant",
      content: `已读取附件「${documentAsset.originalName}」，确认方案后会把其中 ${documentAsset.pageCount} 页内容作为视频参考。`,
      createdAt: now,
    });
    return next;
  }
  next.storyboard.scenes = next.storyboard.scenes.map((scene, index) => {
    const slide = documentAsset.slides[index % documentAsset.slides.length];
    return {
      ...scene,
      visualPrompt: [scene.visualPrompt, slide?.title, slide?.body].filter(Boolean).join(" "),
    };
  });
  next.storyboard = withFallbackShots(enrichStoryboardMedia(next.storyboard, next.brief));
  next.updatedAt = now;
  next.render = null;
  next.messages.push({
    id: randomUUID(),
    role: "assistant",
    content: `已读取附件「${documentAsset.originalName}」，会把其中 ${documentAsset.pageCount} 页内容作为这个视频的参考。`,
    createdAt: now,
  });
  return next;
}

export function attachUserMediaAsset(project, mediaAsset) {
  const now = new Date().toISOString();
  const next = structuredClone(project);
  next.assets.push({
    id: mediaAsset.id,
    type: "user-media",
    name: mediaAsset.originalName,
    mimeType: mediaAsset.mimeType,
    href: mediaAsset.href,
    filePath: mediaAsset.filePath,
    locked: false,
    summary: mediaAsset.mimeType.startsWith("video/") ? "用户上传视频素材" : "用户上传图片素材",
    pageCount: 1,
    warnings: [],
  });
  next.updatedAt = now;
  next.render = null;
  next.messages.push({
    id: randomUUID(),
    role: "assistant",
    content: `已加入素材「${mediaAsset.originalName}」，可以在右侧镜头里选择它替换系统配图。`,
    createdAt: now,
  });
  return next;
}

export function applyShotPatch(project, sceneId, shotId, patch) {
  const now = new Date().toISOString();
  const next = structuredClone(project);
  const scene = next.storyboard?.scenes.find((item) => item.id === sceneId);
  if (!scene) return null;
  const shotIndex = scene.shots?.findIndex((shot) => shot.id === shotId) ?? -1;
  if (shotIndex === -1) return null;

  const shot = scene.shots[shotIndex];
  const media = patch.mediaId ? findMediaById(next, patch.mediaId) : null;
  scene.shots[shotIndex] = {
    ...shot,
    caption: cleanPatchText(patch.caption, shot.caption, 40),
    duration: Math.max(0.35, Math.min(8, Number(patch.duration) || shot.duration)),
    motion: cleanPatchText(patch.motion, shot.motion, 40),
    transition: cleanPatchText(patch.transition, shot.transition, 40),
    media: media || shot.media,
    mediaLocked: media ? true : shot.mediaLocked,
  };

  scene.shots = normalizeShotTiming(scene.shots, scene.duration);
  next.updatedAt = now;
  next.render = null;
  next.messages.push({
    id: randomUUID(),
    role: "assistant",
    content: "已保存镜头修改，右侧视频需要重新生成。",
    createdAt: now,
  });
  return next;
}

export function applyShotReorder(project, sceneId, shotIds) {
  const now = new Date().toISOString();
  const next = structuredClone(project);
  const scene = next.storyboard?.scenes.find((item) => item.id === sceneId);
  if (!scene?.shots?.length) return null;
  if (!isValidShotOrder(scene.shots, shotIds)) return null;

  const byId = new Map(scene.shots.map((shot) => [shot.id, shot]));
  scene.shots = normalizeShotTiming(shotIds.map((id) => byId.get(id)), scene.duration);
  next.updatedAt = now;
  next.render = null;
  next.messages.push({
    id: randomUUID(),
    role: "assistant",
    content: "已调整镜头顺序。",
    createdAt: now,
  });
  return next;
}

function formatSceneLabel(index) {
  return ["第一段", "第二段", "第三段", "第四段", "第五段"][index] || `第 ${index + 1} 段`;
}

export function createStoryboardFromBrief(brief, confirmation = {}, creativeScript = brief.creativeScript) {
  const targetDuration = Math.max(5, Number(confirmation.duration) || 25);
  const baseScenes = Array.isArray(creativeScript?.sceneBeats) && creativeScript.sceneBeats.length
    ? creativeScript.sceneBeats.map((beat, index) => ({
      id: `scene-${index + 1}`,
      slideIndex: index + 1,
      title: beat.title,
      narration: beat.narration,
      highlights: beat.highlights || [beat.caption, beat.purpose].filter(Boolean).slice(0, 3),
      motion: index === 0 ? "slow_push" : index === creativeScript.sceneBeats.length - 1 ? "cta_hold" : "kinetic_cards",
      transition: index === 0 ? "fade_in" : index === creativeScript.sceneBeats.length - 1 ? "final_fade" : "soft_wipe",
      visualPrompt: beat.visualPrompt,
      duration: index === 0 ? 6 : index === creativeScript.sceneBeats.length - 1 ? 5 : 7,
    }))
    : [
    {
      id: "scene-1",
      slideIndex: 1,
      title: `${brief.subject}，第一眼就想进店`,
      narration: `先用一个强开场把观众带进${brief.subject}的氛围。`,
      highlights: [brief.subject, "招牌氛围", "立即种草"],
      motion: "slow_push",
      transition: "fade_in",
      visualPrompt: `开场，${brief.subject}，高级商业宣传片，热气，招牌，门店氛围`,
      duration: 6,
    },
    {
      id: "scene-2",
      slideIndex: 2,
      title: `把${brief.coreValue}拍出来`,
      narration: `第二段集中展示核心卖点，让观众知道为什么值得选择。`,
      highlights: [brief.coreValue, "真实细节", "强记忆点"],
      motion: "pan_and_hold",
      transition: "soft_wipe",
      visualPrompt: `产品细节，${brief.coreValue}，近景，质感，高级灯光`,
      duration: 7,
    },
    {
      id: "scene-3",
      slideIndex: 3,
      title: "让人想象自己就在现场",
      narration: `第三段进入使用场景，用情绪和人群感建立信任。`,
      highlights: ["朋友聚会", "热闹现场", "真实体验"],
      motion: "kinetic_cards",
      transition: "soft_wipe",
      visualPrompt: `场景体验，人群，聚会，情绪，热闹但高级`,
      duration: 7,
    },
    {
      id: "scene-4",
      slideIndex: 4,
      title: "现在就来体验",
      narration: `最后给出清晰行动号召，强化记忆点并收束视频。`,
      highlights: ["到店体验", "立即预约", brief.platform],
      motion: "cta_hold",
      transition: "final_fade",
      visualPrompt: `结尾 CTA，品牌口号，清晰行动号召，高级收束`,
      duration: 5,
    },
    ];
  const baseDuration = baseScenes.reduce((sum, scene) => sum + scene.duration, 0);
  let elapsed = 0;
  const language = confirmation.language || "zh-CN";
  const scenes = baseScenes.map((scene, index) => {
    const duration = index === baseScenes.length - 1
      ? Number(Math.max(3, targetDuration - elapsed).toFixed(2))
      : Number(Math.max(3, scene.duration * (targetDuration / baseDuration)).toFixed(2));
    elapsed += duration;
    return localizeScene(scene, creativeScript?.sceneBeats?.[index], language, duration);
  });

  return normalizeStoryboardTiming({
    version: 2,
    title: brief.title,
    creativeScript,
    stockQueries: creativeScript?.stockQueries || brief.stockQueries,
    avoidKeywords: creativeScript?.avoidKeywords || brief.avoidKeywords,
    aspectRatio: confirmation.aspectRatio || "16:9",
    width: confirmation.aspectRatio === "9:16" ? 1080 : 1920,
    height: confirmation.aspectRatio === "9:16" ? 1920 : 1080,
    fps: 30,
    language,
    style: brief.style,
    confirmation,
    scenes,
  });
}

function localizeScene(scene, beat, language, duration) {
  if (language === "zh-CN") return { ...scene, duration };
  return {
    ...scene,
    ...sceneTextForLanguage(scene, beat, language),
    duration,
    narration: narrationForLanguage(scene, beat, language),
  };
}

function narrationForLanguage(scene, beat, language) {
  if (language === "en") return beat?.voiceoverEn || toEnglishNarration(scene);
  if (language === "ja") return beat?.voiceoverJa || beat?.voiceoverJp || toJapaneseNarration(scene);
  if (language === "ko") return beat?.voiceoverKo || toKoreanNarration(scene);
  return scene.narration;
}

function sceneTextForLanguage(scene, beat, language) {
  if (language === "en") return toEnglishSceneText(scene, beat);
  if (language === "ja") return toJapaneseSceneText(scene, beat);
  if (language === "ko") return toKoreanSceneText(scene, beat);
  return {};
}

function sceneTopic(scene) {
  const source = [scene.title, scene.visualPrompt, ...(scene.highlights || [])].join(" ");
  if (/潜水|diving|scuba/i.test(source)) return "diving";
  if (/travel|旅游|旅行|Thailand|Japan|泰国|日本/i.test(source)) return "travel";
  if (/mushroom|蘑菇|菌菇|野生菌/i.test(source)) return "mushroom";
  return "brand";
}

function scenePhase(scene) {
  const id = String(scene.id || "");
  if (/scene-1/.test(id)) return 0;
  if (/scene-2/.test(id)) return 1;
  if (/scene-3/.test(id)) return 2;
  return 3;
}

function toEnglishSceneText(scene, beat) {
  const fallback = {
    diving: [
      ["Thailand diving without guesswork", ["Thailand", "Scuba diving", "Easy route"]],
      ["Turn every best moment into one route", ["Island route", "Ocean view", "Photo stops"]],
      ["Guided planning before you depart", ["Chinese support", "Safety details", "Trip plan"]],
      ["Ask for your diving plan today", ["Departure city", "Group size", "Route quote"]],
    ],
    travel: [
      ["A trip that feels easy from the first second", ["Destination", "Experience", "Easy plan"]],
      ["Show the best moments in one route", ["Landmarks", "Local scene", "Travel rhythm"]],
      ["Planned details build trust", ["Support", "Schedule", "Safety"]],
      ["Start with one quick consultation", ["Depart", "Budget", "Custom plan"]],
    ],
    mushroom: [
      ["Fresh Yunnan mushrooms at first glance", ["Yunnan origin", "Fresh harvest", "Market trust"]],
      ["Show the texture and origin clearly", ["Mushroom detail", "Origin story", "Real supply"]],
      ["Make the table scene feel close", ["Home cooking", "Fresh aroma", "Trusted choice"]],
      ["Order fresh mushrooms today", ["Contact now", "Fresh delivery", "Limited supply"]],
    ],
    brand: [
      ["A clear reason to pay attention", ["Brand promise", "Real scene", "Strong hook"]],
      ["Show the core value fast", ["Key benefit", "Real detail", "Memory point"]],
      ["Make the experience feel real", ["User scene", "Trust detail", "Emotional proof"]],
      ["Turn interest into action", ["Contact now", "Visit today", "Simple next step"]],
    ],
  };
  const phase = scenePhase(scene);
  const [title, highlights] = fallback[sceneTopic(scene)][phase] || fallback.brand[phase];
  return {
    title: beat?.titleEn || title,
    highlights,
  };
}

function toJapaneseSceneText(scene, beat) {
  const phase = scenePhase(scene);
  const defaults = [
    ["最初の一秒で旅の魅力を伝える", ["目的地", "体験", "安心感"]],
    ["期待できる場面をテンポよく見せる", ["名所", "体験シーン", "旅の流れ"]],
    ["細かな準備で信頼をつくる", ["サポート", "計画", "安全"]],
    ["相談したくなる導線で締める", ["出発", "人数", "相談"]],
  ];
  const [title, highlights] = defaults[phase] || defaults[3];
  return { title: beat?.titleJa || beat?.titleJp || title, highlights };
}

function toKoreanSceneText(scene, beat) {
  const phase = scenePhase(scene);
  const defaults = [
    ["첫 순간에 여행의 매력을 보여주기", ["목적지", "체험", "안심"]],
    ["기대되는 장면을 빠르게 연결하기", ["명소", "체험 장면", "여행 흐름"]],
    ["세심한 준비로 신뢰 만들기", ["지원", "일정", "안전"]],
    ["상담으로 이어지는 마무리", ["출발", "인원", "상담"]],
  ];
  const [title, highlights] = defaults[phase] || defaults[3];
  return { title: beat?.titleKo || title, highlights };
}

function toEnglishNarration(scene) {
  const source = [scene.title, scene.visualPrompt, ...(scene.highlights || [])].join(" ");
  if (/潜水|diving|scuba/i.test(source)) return "Start with a clear travel promise, trusted guidance, and a scene that makes people want to go now.";
  if (/mushroom|蘑菇|菌菇|野生菌/i.test(source)) return "Show the freshness of Yunnan mushrooms with real origin details and a market scene people can trust.";
  return "Show the brand promise with real scenes, clear benefits, and a reason to take action today.";
}

function toJapaneseNarration(scene) {
  const source = [scene.title, scene.visualPrompt, ...(scene.highlights || [])].join(" ");
  if (/mushroom|蘑菇|菌菇|野生菌/i.test(source)) return "雲南きのこの新鮮さと産地の空気感を、信頼できる市場の場面で伝えます。";
  if (/travel|旅游|旅行|Thailand|Japan|泰国|日本/i.test(source)) return "安心できる旅の流れと、今すぐ出発したくなる体験を紹介します。";
  return "ブランドの魅力と信頼できる体験を、わかりやすく印象的に伝えます。";
}

function toKoreanNarration(scene) {
  const source = [scene.title, scene.visualPrompt, ...(scene.highlights || [])].join(" ");
  if (/mushroom|蘑菇|菌菇|野生菌/i.test(source)) return "운남 버섯의 신선함과 산지의 분위기를 신뢰감 있는 시장 장면으로 전합니다.";
  if (/travel|旅游|旅行|Thailand|Japan|泰国|日本/i.test(source)) return "믿을 수 있는 여행 일정과 바로 떠나고 싶은 경험을 소개합니다.";
  return "브랜드의 매력과 신뢰할 수 있는 경험을 쉽고 인상적으로 전합니다.";
}

function normalizeVideoLanguage(value) {
  const text = String(value || "").trim();
  if (["en", "en-US", "English", "english"].includes(text)) return "en";
  if (["ja", "ja-JP", "Japanese", "japanese", "日本語"].includes(text)) return "ja";
  if (["ko", "ko-KR", "Korean", "korean", "한국어"].includes(text)) return "ko";
  return "zh-CN";
}

function normalizeVoicePresetForLanguage(language, voicePreset) {
  const preset = String(voicePreset || "").trim();
  const languagePresets = {
    "zh-CN": new Set(["female_bright_cn", "male_warm_cn", "female_calm_cn", "off"]),
    en: new Set(["female_natural_en", "male_commercial_en", "english_travel", "off"]),
    ja: new Set(["female_japanese", "off"]),
    ko: new Set(["female_korean", "off"]),
  };
  const defaults = {
    "zh-CN": "female_bright_cn",
    en: "female_natural_en",
    ja: "female_japanese",
    ko: "female_korean",
  };
  if (languagePresets[language]?.has(preset)) return preset;
  return defaults[language] || "female_bright_cn";
}

function createConfirmation(prompt, brief) {
  return {
    aspectRatio: /大屏|横屏|16:9/.test(prompt) ? "16:9" : "9:16",
    duration: /30\s*秒|三十秒/.test(prompt) ? 30 : 25,
    platform: /抖音|小红书|视频号|快手/.test(prompt) ? "短视频平台" : brief.platform,
    style: detectStyle(prompt, brief.style),
    language: "zh-CN",
    voiceover: true,
    voicePreset: "female_bright_cn",
    questions: ["平台和比例", "整体风格", "视频时长", "视频语言", "是否需要口播"],
  };
}

function shouldRebuildCreativeScript(project, message) {
  if (!project.storyboard) return false;
  const text = String(message || "");
  return /(改成|换成|重新做|另做|做一个|做个)/.test(text)
    && !detectSceneIndex(text, project.storyboard.scenes.length);
}

function isMaterialRefreshRequest(message) {
  return /素材不满意|重新配图|重新找图|换素材|换图|图片不对|照片不对|配图不对|没有.*(图片|照片|画面|素材)|不要这些图/.test(String(message || ""));
}

function createMaterialRefreshPlan(project, message, intent = null) {
  const text = [
    project.brief?.subject,
    project.brief?.coreValue,
    project.storyboard?.title,
    message,
  ].filter(Boolean).join(" ");
  const city = detectCity(text);
  const food = detectFoodCategory(text);
  const industry = /店|餐饮|餐厅|美食|卤煮|火锅|饺子|咖啡/.test(text) ? "本地餐饮" : project.brief?.industry || "本地服务";
  const requestedVisuals = Array.isArray(intent?.requestedVisuals) ? intent.requestedVisuals : [];
  const forbiddenVisuals = Array.isArray(intent?.forbiddenVisuals) ? intent.forbiddenVisuals : [];
  const stockQueries = Array.isArray(intent?.stockQueries) && intent.stockQueries.length
    ? intent.stockQueries
    : buildMaterialStockQueries({ city: city.query, food: food.query, industry, subject: project.brief?.subject });
  const summary = requestedVisuals.length
    ? requestedVisuals.join("、")
    : [city.label, food.label || project.brief?.subject || industry].filter(Boolean).join(" ");
  return {
    reason: String(message || "").trim(),
    summary: summary || project.brief?.subject || "当前主题",
    requestedVisuals,
    forbiddenVisuals,
    stockQueries,
    perSceneMinAssets: Number(intent?.perSceneMinAssets || intent?.params?.perSceneMinAssets) || 3,
    perSceneMaxAssets: Number(intent?.perSceneMaxAssets || intent?.params?.perSceneMaxAssets) || 5,
    preserveUserMedia: intent?.preserveUserMedia !== false,
    replaceScope: "unlocked-system-media",
  };
}

function firstExecutableAction(route) {
  const actions = Array.isArray(route?.actions) ? route.actions : [];
  return actions.find((action) => action?.type);
}

function executeConversationAction(project, action, route, message, now, options) {
  if (["request_material_refresh", "refresh_scene_materials", "refresh_shot_material", "redistribute_materials"].includes(action.type)) {
    return requestMaterialRefresh(project, action, route, message, now);
  }
  if (action.type === "edit_scene") {
    return executeSceneEdit(project, action, route, message, now);
  }
  if (action.type === "rewrite_topic") {
    return executeTopicRewrite(project, action, route, message, now, options);
  }
  if (action.type === "update_video_settings" || action.type === "update_voice" || action.type === "update_language") {
    return executeSettingsUpdate(project, action, route, now);
  }
  if (action.type === "answer_question") {
    project.messages.push({
      id: randomUUID(),
      role: "assistant",
      content: route.assistantReply || "我可以继续根据你的反馈修改脚本、分镜、素材或配音。",
      createdAt: now,
    });
    return project;
  }

  project.messages.push({
    id: randomUUID(),
    role: "assistant",
    content: route.assistantReply || "我理解了，但这个动作还需要在界面里确认后执行。",
    createdAt: now,
  });
  return project;
}

function requestMaterialRefresh(project, action, route, message, now) {
  const params = action.params || {};
  const intent = {
    requestedVisuals: cleanStringList(params.requestedVisuals).length ? cleanStringList(params.requestedVisuals) : route.requestedVisuals,
    forbiddenVisuals: cleanStringList(params.forbiddenVisuals).length ? cleanStringList(params.forbiddenVisuals) : route.forbiddenVisuals,
    stockQueries: cleanStringList(params.stockQueries).length ? cleanStringList(params.stockQueries) : route.stockQueries,
    perSceneMinAssets: params.perSceneMinAssets,
    perSceneMaxAssets: params.perSceneMaxAssets,
    preserveUserMedia: route.constraints?.preserveUserMedia,
    params,
  };
  const refresh = createMaterialRefreshPlan(project, message, intent);
  if (params.summary) refresh.summary = String(params.summary).slice(0, 140);
  project.status = "needs_material_confirmation";
  project.pendingAction = {
    id: randomUUID(),
    type: action.type,
    createdAt: now,
    requiresConfirmation: true,
    summary: refresh.summary,
    params: {
      perSceneMinAssets: refresh.perSceneMinAssets,
      perSceneMaxAssets: refresh.perSceneMaxAssets,
      preserveUserMedia: refresh.preserveUserMedia,
      replaceOnlyUnlockedSystemMedia: route.constraints?.replaceOnlyUnlockedSystemMedia !== false,
    },
  };
  project.pendingMaterialRefresh = refresh;
  project.messages.push({
    id: randomUUID(),
    role: "assistant",
    content: route.assistantReply || `我可以重新帮你为每个分镜准备 ${refresh.perSceneMinAssets}-${refresh.perSceneMaxAssets} 张更贴合「${refresh.summary}」的素材。这会花一点时间，确认后我再开始，并只替换未锁定的系统素材。`,
    createdAt: now,
  });
  return project;
}

function executeSceneEdit(project, action, route, message, now) {
  const sceneIndex = action.sceneIndex ?? detectSceneIndex(message, project.storyboard.scenes.length) ?? 0;
  const scene = project.storyboard.scenes[sceneIndex];
  if (!scene) return project;
  const params = action.params || {};
  scene.title = cleanPatchText(params.title, reviseSceneTitle(scene.title, message), 80);
  scene.narration = cleanPatchText(params.narration, reviseNarration(scene.narration, message), 220);
  scene.visualPrompt = cleanPatchText(params.visualPrompt, scene.visualPrompt, 260);
  if (Array.isArray(params.highlights) && params.highlights.length) {
    scene.highlights = params.highlights.map((item) => String(item).trim()).filter(Boolean).slice(0, 4);
  }
  if (params.duration) {
    scene.duration = Math.max(3, Math.min(20, Number(params.duration) || scene.duration));
    scene.shots = normalizeShotTiming(scene.shots || [], scene.duration);
    project.storyboard = normalizeStoryboardTiming(project.storyboard);
  }
  project.render = null;
  project.messages.push({
    id: randomUUID(),
    role: "assistant",
    content: route.assistantReply || `已更新${formatSceneLabel(sceneIndex)}，当前素材保持不变。`,
    createdAt: now,
  });
  return project;
}

function executeTopicRewrite(project, action, route, message, now) {
  const prompt = String(action.params?.prompt || message || "").trim();
  const next = createProjectFromPrompt(cleanTopicSwitchMessage(prompt), {
    id: project.id,
  });
  next.createdAt = project.createdAt;
  next.assets = (project.assets || []).filter((asset) => asset.type !== "stock-media");
  next.messages = [
    ...(project.messages || []),
    {
      id: randomUUID(),
      role: "assistant",
      content: route.assistantReply || `已按新主题重写短视频脚本：${next.creativeScript.hook} 请先确认脚本，再生成新的分镜和素材。`,
      createdAt: now,
    },
  ];
  next.lastConversationRoute = route;
  return next;
}

function executeSettingsUpdate(project, action, route, now) {
  const params = action.params || {};
  project.confirmation = {
    ...(project.confirmation || createConfirmation("", project.brief)),
    ...parseStructuredConfirmation(params),
  };
  if (params.language) project.storyboard.language = String(params.language).slice(0, 20);
  project.render = null;
  project.messages.push({
    id: randomUUID(),
    role: "assistant",
    content: route.assistantReply || "已更新视频设置，重新生成视频时会使用新的配置。",
    createdAt: now,
  });
  return project;
}

function cleanStringList(value) {
  return Array.isArray(value) ? value.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 12) : [];
}

function buildMaterialStockQueries({ city, food, industry, subject }) {
  const queries = [];
  if (city && food) queries.push(`${city} ${food}`);
  if (city) queries.push(`${city} street food`, `${city} local restaurant`);
  if (food) queries.push(food, `${food} restaurant`, `${food} food close up`);
  if (industry === "本地餐饮") {
    queries.push("local Chinese restaurant kitchen", "customers eating Chinese food");
  }
  if (!queries.length && subject) queries.push(`${subject} business`, "local business storefront", "customer experience");
  return [...new Set(queries)].slice(0, 5);
}

function detectCity(text) {
  const cityMap = [
    [/济南|泉城/i, "Jinan"],
    [/北京/i, "Beijing"],
    [/上海/i, "Shanghai"],
    [/广州/i, "Guangzhou"],
    [/深圳/i, "Shenzhen"],
    [/成都/i, "Chengdu"],
    [/杭州/i, "Hangzhou"],
    [/西安/i, "Xi'an"],
    [/云南/i, "Yunnan"],
    [/日本/i, "Japan"],
    [/泰国/i, "Thailand"],
  ];
  const value = cityMap.find(([pattern]) => pattern.test(text))?.[1] || "";
  return { label: value ? value.replace("Jinan", "济南").replace("Yunnan", "云南").replace("Japan", "日本").replace("Thailand", "泰国") : "", query: value };
}

function detectFoodCategory(text) {
  const categoryMap = [
    [/卤煮|卤味|卤肉/i, "Chinese braised food"],
    [/火锅/i, "hot pot restaurant"],
    [/饺子|水饺|煎饺/i, "Chinese dumplings"],
    [/咖啡/i, "coffee shop"],
    [/蘑菇|菌菇|野生菌/i, "wild mushrooms"],
    [/烧烤/i, "Chinese barbecue restaurant"],
    [/面馆|拉面|面条/i, "Chinese noodle restaurant"],
  ];
  const value = categoryMap.find(([pattern]) => pattern.test(text))?.[1] || "";
  const labels = {
    "Chinese braised food": "卤煮",
    "hot pot restaurant": "火锅",
    "Chinese dumplings": "饺子",
    "coffee shop": "咖啡店",
    "wild mushrooms": "菌菇",
    "Chinese barbecue restaurant": "烧烤",
    "Chinese noodle restaurant": "面馆",
  };
  return { label: labels[value] || "", query: value };
}

function cleanTopicSwitchMessage(message) {
  return String(message || "").replace(/^(改成|换成|重新做|另做)\s*/, "").trim();
}

function parseConfirmationOverrides(message) {
  const text = String(message || "");
  const next = {};
  if (/16:9|横屏|大屏/.test(text)) next.aspectRatio = "16:9";
  if (/9:16|竖屏|抖音|小红书|视频号|快手/.test(text)) next.aspectRatio = "9:16";
  if (/30\s*秒|三十秒/.test(text)) next.duration = 30;
  if (/15\s*秒|十五秒/.test(text)) next.duration = 15;
  if (/抖音|小红书|视频号|快手/.test(text)) next.platform = "短视频平台";
  next.style = detectStyle(text, undefined);
  if (!next.style) delete next.style;
  return next;
}

function parseStructuredConfirmation(value) {
  const next = {};
  if (["9:16", "16:9", "1:1"].includes(value.aspectRatio)) next.aspectRatio = value.aspectRatio;
  const duration = Number(value.duration);
  if (Number.isFinite(duration)) next.duration = Math.max(5, Math.min(120, duration));
  if (typeof value.platform === "string" && value.platform.trim()) next.platform = value.platform.trim().slice(0, 30);
  if (typeof value.style === "string" && value.style.trim()) next.style = value.style.trim().slice(0, 40);
  if (typeof value.language === "string" && value.language.trim()) next.language = normalizeVideoLanguage(value.language);
  if (typeof value.voiceover === "boolean") next.voiceover = value.voiceover;
  if (typeof value.voicePreset === "string" && value.voicePreset.trim()) next.voicePreset = value.voicePreset.trim().slice(0, 40);
  if (next.language) next.voicePreset = normalizeVoicePresetForLanguage(next.language, next.voicePreset);
  return next;
}

function isConfirmationMessage(message) {
  return /确认|可以|就这样|开始|生成分镜|没问题|ok/i.test(String(message || ""));
}

function createBrief(prompt) {
  const subject = detectSubject(prompt);
  const platform = /抖音|小红书|视频号|快手/.test(prompt) ? "短视频平台" : "线上宣传";
  const style = detectStyle(prompt, "高级商业宣传");
  const coreValue = detectCoreValue(subject, prompt);

  return {
    title: `${subject}宣传视频`,
    goal: `为${subject}生成一条可继续对话修改的宣传视频`,
    subject,
    platform,
    audience: "潜在顾客",
    style,
    coreValue,
  };
}

function detectSubject(prompt) {
  const value = String(prompt || "").trim();
  if (/火锅/.test(value)) return "火锅店";
  if (/云南.*(蘑菇|菌菇|野生菌)|(蘑菇|菌菇|野生菌).*云南/.test(value)) return "云南菌菇";
  if (/蘑菇|菌菇|野生菌/.test(value)) return "菌菇";
  if (/咖啡/.test(value)) return "咖啡店";
  if (/课程|培训/.test(value)) return "课程";
  if (/产品/.test(value)) return "产品";
  return value.replace(/^帮我做一个?/, "").replace(/的视频$/, "").slice(0, 18) || "新项目";
}

function detectCoreValue(subject, prompt) {
  const text = `${subject} ${prompt}`;
  if (subject.includes("火锅")) return "热气、锅底和聚餐氛围";
  if (/云南.*(蘑菇|菌菇|野生菌)|(蘑菇|菌菇|野生菌).*云南/.test(text)) return "云南野生菌、新鲜采摘和产地直发";
  if (/蘑菇|菌菇|野生菌/.test(text)) return "新鲜菌菇、产地品质和健康食材";
  return "核心卖点和真实体验";
}

function detectStyle(message, fallback) {
  if (/高级|质感|精致/.test(message)) return "高级商业宣传";
  if (/热闹|活力|激情|燃/.test(message)) return "热闹短视频";
  if (/简洁|干净/.test(message)) return "简洁现代";
  return fallback;
}

function detectSceneIndex(message, sceneCount) {
  const match = String(message).match(/第?\s*([一二三四五六七八九十\d]+)\s*(段|幕|个|页|scene)/i);
  if (!match) return null;
  const index = parseChineseNumber(match[1]) - 1;
  return index >= 0 && index < sceneCount ? index : null;
}

function parseChineseNumber(value) {
  const map = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  return Number(value) || map[value] || 1;
}

function reviseSceneTitle(title, message) {
  if (/热闹|沸腾|朋友|聚餐/.test(message)) return "热闹沸腾的朋友聚餐";
  if (/高级|质感/.test(message)) return "更有质感的高级呈现";
  if (/开头|第一/.test(message)) return "更抓人的开场";
  return title;
}

function reviseNarration(narration, message) {
  if (/热闹|沸腾|朋友|聚餐/.test(message)) {
    return "这一段把火锅沸腾、朋友围坐和热闹氛围推到前面，让观众马上产生想来一顿的冲动。";
  }
  return `${narration} ${message}`.slice(0, 180);
}

function reviseHighlights(highlights, message) {
  if (/热闹|沸腾|朋友|聚餐/.test(message)) return ["火锅沸腾", "朋友聚餐", "热闹氛围"];
  return [...new Set([...highlights, message.slice(0, 12)])].slice(0, 3);
}

function cleanPatchText(value, fallback, maxLength) {
  const text = String(value || "").trim();
  return text ? text.slice(0, maxLength) : fallback;
}

function withFallbackShots(storyboard) {
  return enrichStoryboardFallbackShots(storyboard);
}

function normalizeShotTiming(shots, sceneDuration) {
  const total = shots.reduce((sum, shot) => sum + Math.max(0.35, Number(shot.duration) || 0.35), 0);
  const ratio = sceneDuration / total;
  let elapsed = 0;
  return shots.map((shot, index) => {
    const duration = index === shots.length - 1
      ? Number(Math.max(0.35, sceneDuration - elapsed).toFixed(2))
      : Number(Math.max(0.35, (Number(shot.duration) || 0.35) * ratio).toFixed(2));
    const start = Number(elapsed.toFixed(2));
    elapsed += duration;
    return { ...shot, start, duration };
  });
}

function findMediaById(project, mediaId) {
  const userAsset = project.assets.find((asset) => asset.id === mediaId && asset.type === "user-media");
  if (userAsset) {
    return {
      id: userAsset.id,
      type: userAsset.mimeType.startsWith("video/") ? "video" : "image",
      title: userAsset.name,
      href: userAsset.href,
      filePath: userAsset.filePath,
      provider: "user",
      source: "user-upload",
      tags: ["user", "upload"],
    };
  }
  return project.storyboard?.scenes.flatMap((scene) => scene.shots || []).map((shot) => shot.media).find((media) => media?.id === mediaId) || null;
}

function isValidShotOrder(shots, shotIds) {
  if (!Array.isArray(shotIds) || shotIds.length !== shots.length) return false;
  const expected = new Set(shots.map((shot) => shot.id));
  return new Set(shotIds).size === shotIds.length && shotIds.every((id) => expected.has(id));
}

function normalizeStoryboardTiming(storyboard) {
  let start = 0;
  const scenes = storyboard.scenes.map((scene, index) => {
    const duration = Math.max(3, Number(scene.duration) || 5);
    const next = {
      ...scene,
      id: scene.id || `scene-${index + 1}`,
      slideIndex: index + 1,
      start,
      duration,
    };
    start += duration;
    return next;
  });

  return {
    ...storyboard,
    duration: start,
    scenes,
  };
}
