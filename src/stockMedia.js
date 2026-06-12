import { createWriteStream } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { HOTPOT_ASSETS } from "./mediaAssets.js";

const DEFAULT_HOTPOT_QUERIES = [
  "hot pot restaurant",
  "hot pot cooking",
  "restaurant food table",
  "friends eating restaurant",
  "restaurant storefront",
];

const SHOT_DURATIONS = [0.7, 0.55, 0.9, 1.1, 0.65, 1.25, 0.8, 1.4, 0.6, 1.0, 1.35, 0.75, 1.5, 0.85, 1.15, 1.3];
const MOTIONS = ["snap_zoom", "push_in", "whip_pan", "parallax_push", "handheld_crop"];
const TRANSITIONS = ["flash_cut", "cut", "whip_wipe", "match_cut"];
const DEFAULT_TARGET_MEDIA_PER_SHOT = 2;
const DEFAULT_MAX_EXTERNAL_MEDIA = 40;
const STOCK_TIMEOUT_MS = 8000;

export async function prepareStoryboardShots({
  storyboard,
  brief = null,
  jobDir,
  env = process.env,
  fetchImpl = fetch,
  targetMediaPerShot = DEFAULT_TARGET_MEDIA_PER_SHOT,
  maxExternalMedia = DEFAULT_MAX_EXTERNAL_MEDIA,
}) {
  const manifest = await resolveStockMedia({ storyboard, brief, jobDir, env, fetchImpl, targetMediaPerShot, maxExternalMedia });
  const scenes = storyboard.scenes.map((scene, sceneIndex) => {
    const shots = buildSceneShots({ scene, sceneIndex, manifest });
    return { ...scene, shots: mergeLockedShots(scene.shots || [], shots) };
  });
  return {
    storyboard: { ...storyboard, scenes, mediaManifest: manifest.summary },
    manifest,
  };
}

function mergeLockedShots(existingShots, generatedShots) {
  if (!existingShots.length) return generatedShots;
  const lockedById = new Map(existingShots.filter((shot) => shot.mediaLocked).map((shot) => [shot.id, shot]));
  return generatedShots.map((shot) => lockedById.get(shot.id) || shot);
}

export function enrichStoryboardFallbackShots(storyboard) {
  if (!isHotpotStoryboard(storyboard)) {
    return {
      ...storyboard,
      mediaManifest: {
        provider: "generated-visuals",
        externalCount: 0,
        localCount: 0,
      },
      scenes: storyboard.scenes.map((scene, sceneIndex) => ({
        ...scene,
        shots: buildSceneShots({
          scene,
          sceneIndex,
          manifest: {
            summary: { provider: "generated-visuals", externalCount: 0, localCount: 0 },
            queries: buildStockQueries({ storyboard }),
            items: [],
          },
        }),
      })),
    };
  }
  const manifest = {
    summary: {
      provider: "fallback-local-media",
      externalCount: 0,
      localCount: HOTPOT_ASSETS.length,
    },
    queries: DEFAULT_HOTPOT_QUERIES,
    items: HOTPOT_ASSETS.map((asset) => ({
      id: asset.id,
      type: "image",
      title: asset.title,
      href: asset.href,
      filePath: asset.filePath,
      source: asset.source,
      provider: "local",
      posterHref: asset.href,
      tags: asset.keywords,
    })),
  };
  return {
    ...storyboard,
    mediaManifest: manifest.summary,
    scenes: storyboard.scenes.map((scene, sceneIndex) => ({
      ...scene,
      shots: buildSceneShots({ scene, sceneIndex, manifest }),
    })),
  };
}

export async function resolveStockMedia({
  storyboard,
  brief = null,
  jobDir,
  env = process.env,
  fetchImpl = fetch,
  targetMediaPerShot = DEFAULT_TARGET_MEDIA_PER_SHOT,
  maxExternalMedia = DEFAULT_MAX_EXTERNAL_MEDIA,
}) {
  const stockDir = path.join(jobDir, "assets", "stock");
  await rm(stockDir, { recursive: true, force: true });
  await mkdir(stockDir, { recursive: true });
  const publicBaseHref = `/jobs/${encodeURIComponent(path.basename(jobDir))}/assets/stock`;

  const queries = buildStockQueries({ storyboard, brief });
  const sceneMediaTargets = calculateSceneMediaTargets(storyboard);
  const targetExternalCount = calculateTargetExternalCount(storyboard, targetMediaPerShot, maxExternalMedia);
  const localItems = isHotpotStoryboard(storyboard, brief)
    ? HOTPOT_ASSETS.map((asset) => ({
      id: asset.id,
      type: "image",
      title: asset.title,
      href: asset.href,
      filePath: asset.filePath,
      source: asset.source,
      provider: "local",
      posterHref: asset.href,
      tags: asset.keywords,
    }))
    : [];

  const downloaded = [];
  if (env.PEXELS_API_KEY) {
    downloaded.push(...await tryFetchStock(() => fetchPexelsPhotos({ stockDir, publicBaseHref, apiKey: env.PEXELS_API_KEY, fetchImpl, queries, targetCount: targetExternalCount })));
  }

  if (downloaded.length < targetExternalCount && env.PEXELS_API_KEY) {
    downloaded.push(...await tryFetchStock(() => fetchPexelsVideos({ stockDir, publicBaseHref, apiKey: env.PEXELS_API_KEY, fetchImpl, queries, targetCount: targetExternalCount - downloaded.length })));
  }

  if (downloaded.length < targetExternalCount && env.PIXABAY_API_KEY) {
    downloaded.push(...await tryFetchStock(() => fetchPixabayVideos({ stockDir, publicBaseHref, apiKey: env.PIXABAY_API_KEY, fetchImpl, queries, targetCount: targetExternalCount - downloaded.length })));
  }

  const limitedDownloaded = downloaded.slice(0, targetExternalCount);
  const fallbackItems = buildFallbackVisualItems({
    storyboard,
    brief,
    count: Math.max(0, targetExternalCount - limitedDownloaded.length - localItems.length),
  });
  const items = [...limitedDownloaded, ...localItems, ...fallbackItems];
  const sceneBuckets = allocateSceneMediaBuckets({ items, sceneMediaTargets });
  const summary = {
    provider: limitedDownloaded.length ? "stock-api" : localItems.length ? "fallback-local-media" : "generated-visuals",
    externalCount: limitedDownloaded.length,
    localCount: localItems.length,
    fallbackVisualCount: fallbackItems.length,
    targetExternalCount,
    sceneMediaTargets: sceneMediaTargets.map((target, index) => ({
      sceneId: storyboard.scenes[index]?.id || `scene-${index + 1}`,
      targetCount: target,
      actualCount: sceneBuckets[index]?.items?.length || 0,
    })),
    requestedQueries: queries,
    insufficientMedia: Boolean(env.PEXELS_API_KEY || env.PIXABAY_API_KEY) && limitedDownloaded.length < targetExternalCount,
    warnings: fallbackItems.length ? [`外部素材不足，已用 ${fallbackItems.length} 个主题占位视觉补齐。`] : [],
  };
  const manifest = { summary, queries, items, sceneBuckets };
  await writeFile(path.join(stockDir, "stock-manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  return manifest;
}

async function tryFetchStock(load) {
  try {
    return await load();
  } catch {
    return [];
  }
}

function buildSceneShots({ scene, sceneIndex, manifest }) {
  const count = sceneIndex === 0 ? 4 : sceneIndex === 3 ? 3 : 5;
  const sceneItems = manifest.sceneBuckets?.[sceneIndex]?.items?.length ? manifest.sceneBuckets[sceneIndex].items : manifest.items;
  const preferred = selectMediaForScene(scene, sceneItems);
  const shots = [];

  for (let index = 0; index < count; index += 1) {
    const media = preferred[index % preferred.length];
    const globalIndex = sceneIndex * 5 + index;
    shots.push({
      id: `${scene.id}-shot-${index + 1}`,
      duration: SHOT_DURATIONS[globalIndex % SHOT_DURATIONS.length],
      media,
      motion: MOTIONS[globalIndex % MOTIONS.length],
      transition: TRANSITIONS[globalIndex % TRANSITIONS.length],
      caption: buildCaption(scene, index),
    });
  }

  return normalizeShotDurations(shots, scene.duration);
}

function selectMediaForScene(scene, items) {
  if (!items.length) return [];
  const haystack = [scene.title, scene.narration, scene.visualPrompt, ...(scene.highlights || [])].join(" ");
  const scored = items
    .map((item) => ({
      item,
      score: (item.tags || []).reduce((sum, tag) => sum + (haystack.toLowerCase().includes(String(tag).toLowerCase()) || haystack.includes(tag) ? 1 : 0), 0),
    }))
    .sort((a, b) => b.score - a.score);

  const selected = scored.filter((entry) => entry.score > 0).map((entry) => entry.item);
  return selected.length ? selected : items.slice(0, 4);
}

function calculateTargetExternalCount(storyboard, targetMediaPerShot, maxExternalMedia) {
  const sceneTargetCount = calculateSceneMediaTargets(storyboard).reduce((sum, count) => sum + count, 0);
  return Math.min(Math.max(0, Number(maxExternalMedia) || DEFAULT_MAX_EXTERNAL_MEDIA), sceneTargetCount);
}

function calculateSceneMediaTargets(storyboard) {
  const min = Math.max(1, Number(storyboard?.mediaPlan?.perSceneMinAssets) || 3);
  const max = Math.max(min, Number(storyboard?.mediaPlan?.perSceneMaxAssets) || 5);
  return (storyboard?.scenes || []).map((scene) => Math.max(min, Math.min(max, Math.ceil(Number(scene.duration || 0) / 2) || min)));
}

function allocateSceneMediaBuckets({ items, sceneMediaTargets }) {
  let cursor = 0;
  return sceneMediaTargets.map((targetCount, index) => {
    const selected = [];
    for (let offset = 0; offset < targetCount; offset += 1) {
      if (!items.length) break;
      const item = items[cursor] || items[(cursor + offset) % items.length];
      if (item && !selected.some((existing) => existing.id === item.id)) selected.push(item);
      cursor += 1;
    }
    if (selected.length < targetCount && items.length) {
      for (const item of items) {
        if (selected.length >= targetCount) break;
        if (!selected.some((existing) => existing.id === item.id)) selected.push(item);
      }
    }
    return {
      sceneIndex: index,
      targetCount,
      items: selected,
    };
  });
}

function buildFallbackVisualItems({ storyboard, brief, count }) {
  if (count <= 0) return [];
  const labels = fallbackVisualLabels(storyboard, brief);
  return Array.from({ length: count }, (_, index) => {
    const title = labels[index % labels.length] || "主题素材";
    const href = createFallbackSvgDataUrl(title, index);
    return {
      id: `generated-visual-${index + 1}`,
      provider: "generated-visuals",
      type: "image",
      title,
      source: "generated-fallback",
      tags: [title],
      href,
      posterHref: href,
    };
  });
}

function fallbackVisualLabels(storyboard, brief) {
  const requested = Array.isArray(storyboard?.requestedVisuals) ? storyboard.requestedVisuals : [];
  if (requested.length) return requested;
  const queries = firstQueryList(storyboard?.stockQueries, brief?.stockQueries);
  if (queries.length) return queries.map((query) => query.replace(/\b(close up|restaurant|business|promo)\b/gi, "").trim()).filter(Boolean);
  return (storyboard?.scenes || []).flatMap((scene) => [scene.title, ...(scene.highlights || [])]).filter(Boolean).slice(0, 6);
}

function createFallbackSvgDataUrl(title, index) {
  const palettes = [
    ["#16241f", "#d9b45f", "#fff7df"],
    ["#2b2118", "#d86f45", "#fff3e2"],
    ["#17233a", "#9db7d9", "#f6f1e7"],
    ["#26301d", "#9bb86d", "#fff9e8"],
  ];
  const [bg, accent, fg] = palettes[index % palettes.length];
  const safeTitle = escapeSvgText(String(title || "主题素材").slice(0, 18));
  const visualNo = String(index + 1).padStart(2, "0");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720"><rect width="1280" height="720" fill="${bg}"/><rect x="84" y="74" width="1112" height="572" fill="none" stroke="${accent}" stroke-width="10"/><circle cx="${980 + (index % 5) * 24}" cy="${138 + (index % 4) * 18}" r="${68 + (index % 3) * 12}" fill="${accent}" opacity=".22"/><path d="M150 ${500 + (index % 4) * 18} C350 410 520 610 760 ${450 + (index % 5) * 18} S1040 360 1160 ${460 + (index % 3) * 24}" fill="none" stroke="${accent}" stroke-width="${14 + (index % 4) * 2}" opacity=".75"/><text x="120" y="198" fill="${accent}" font-family="Arial, sans-serif" font-size="34" font-weight="800" letter-spacing="4">AI MOTIONS VISUAL ${visualNo}</text><text x="120" y="378" fill="${fg}" font-family="Arial, sans-serif" font-size="92" font-weight="900">${safeTitle}</text><text x="124" y="452" fill="${fg}" opacity=".72" font-family="Arial, sans-serif" font-size="32">主题占位视觉，可替换为真实素材</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function escapeSvgText(value) {
  return String(value).replace(/[&<>"]/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
  }[char]));
}

export function buildStockQueries({ storyboard, brief = null }) {
  const scriptedQueries = firstQueryList(
    storyboard?.stockQueries,
    brief?.stockQueries,
    storyboard?.creativeScript?.stockQueries,
    brief?.creativeScript?.stockQueries,
  );
  if (scriptedQueries.length) {
    return filterAvoidKeywords(scriptedQueries, firstQueryList(brief?.avoidKeywords, brief?.creativeScript?.avoidKeywords, storyboard?.avoidKeywords, storyboard?.creativeScript?.avoidKeywords));
  }

  const text = storyboardText(storyboard, brief);
  if (/火锅|锅底|红油|涮/.test(text)) return DEFAULT_HOTPOT_QUERIES;
  if (/饺子|水饺|煎饺|dumpling/i.test(text)) {
    return [
      "dumpling restaurant",
      "chinese dumplings",
      "dumpling kitchen",
      "restaurant dining",
      "asian food restaurant",
    ];
  }
  if (/云南.*(蘑菇|菌菇|野生菌)|(蘑菇|菌菇|野生菌).*云南|mushroom|fungi/i.test(text)) {
    return [
      "Yunnan mushrooms",
      "wild mushrooms",
      "fresh mushrooms",
      "mushroom market",
      "mushroom farm",
    ];
  }
  if (/蘑菇|菌菇|野生菌/.test(text)) {
    return [
      "wild mushrooms",
      "fresh mushrooms",
      "mushroom market",
      "mushroom farm",
      "organic mushrooms",
    ];
  }

  const subject = String(brief?.subject || storyboard?.title || "business").replace(/宣传视频|视频/g, "").trim();
  const englishSubject = /[a-z]/i.test(subject) ? subject : "business";
  return [
    `${englishSubject} promo`,
    "city lifestyle",
    "customer experience",
    "service business",
    "people shopping",
  ];
}

function firstQueryList(...values) {
  for (const value of values) {
    if (!Array.isArray(value)) continue;
    const cleaned = value
      .map((item) => String(item || "").trim())
      .filter(Boolean)
      .slice(0, 5);
    if (cleaned.length) return cleaned;
  }
  return [];
}

function filterAvoidKeywords(queries, avoidKeywords) {
  if (!avoidKeywords.length) return queries;
  const blocked = new RegExp(avoidKeywords.map(escapeRegExp).join("|"), "i");
  return queries.filter((query) => !blocked.test(query)).slice(0, 5);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isHotpotStoryboard(storyboard, brief = null) {
  return /火锅|锅底|红油|涮/.test(storyboardText(storyboard, brief));
}

function storyboardText(storyboard, brief = null) {
  return [
    brief?.subject,
    brief?.title,
    brief?.coreValue,
    storyboard?.title,
    ...(storyboard?.scenes || []).flatMap((scene) => [scene.title, scene.narration, scene.visualPrompt, ...(scene.highlights || [])]),
  ].join(" ");
}

function normalizeShotDurations(shots, sceneDuration) {
  const total = shots.reduce((sum, shot) => sum + shot.duration, 0);
  const ratio = sceneDuration / total;
  let elapsed = 0;
  return shots.map((shot, index) => {
    const duration = index === shots.length - 1
      ? Math.max(0.35, Number((sceneDuration - elapsed).toFixed(2)))
      : Number(Math.max(0.35, shot.duration * ratio).toFixed(2));
    const start = Number(elapsed.toFixed(2));
    elapsed += duration;
    return { ...shot, start, duration };
  });
}

function buildCaption(scene, index) {
  const options = [scene.highlights?.[index % (scene.highlights?.length || 1)], scene.title];
  return String(options.find(Boolean) || "").slice(0, 14);
}

async function fetchPexelsVideos({ stockDir, publicBaseHref, apiKey, fetchImpl, queries, targetCount }) {
  const items = [];
  for (const query of queries) {
    const remaining = targetCount - items.length;
    if (remaining <= 0) return items;
    const url = new URL("https://api.pexels.com/videos/search");
    url.searchParams.set("query", query);
    url.searchParams.set("orientation", "landscape");
    url.searchParams.set("per_page", String(Math.min(15, Math.max(3, remaining))));
    const response = await fetchWithTimeout(fetchImpl, url, { headers: { Authorization: apiKey } });
    if (!response.ok) continue;
    const payload = await response.json();
    for (const video of payload.videos || []) {
      const file = choosePexelsVideoFile(video.video_files || []);
      if (!file?.link) continue;
      if (items.length >= targetCount) return items;
      items.push(await downloadMediaFile({
        stockDir,
        fetchImpl,
        url: file.link,
        id: `pexels-${video.id}`,
        publicBaseHref,
        provider: "pexels",
        type: "video",
        title: query,
        source: video.url,
        tags: query.split(" "),
        posterHref: video.image,
      }));
    }
  }
  return items;
}

async function fetchPexelsPhotos({ stockDir, publicBaseHref, apiKey, fetchImpl, queries, targetCount }) {
  const items = [];
  for (const query of queries) {
    const remaining = targetCount - items.length;
    if (remaining <= 0) return items;
    const url = new URL("https://api.pexels.com/v1/search");
    url.searchParams.set("query", query);
    url.searchParams.set("orientation", "landscape");
    url.searchParams.set("per_page", String(Math.min(20, Math.max(4, remaining))));
    const response = await fetchWithTimeout(fetchImpl, url, { headers: { Authorization: apiKey } });
    if (!response.ok) continue;
    const payload = await response.json();
    for (const photo of payload.photos || []) {
      const imageUrl = photo.src?.large || photo.src?.medium || photo.src?.original;
      if (!imageUrl) continue;
      if (items.length >= targetCount) return items;
      items.push(await downloadMediaFile({
        stockDir,
        fetchImpl,
        url: imageUrl,
        id: `pexels-photo-${photo.id}`,
        publicBaseHref,
        provider: "pexels",
        type: "image",
        title: photo.alt || query,
        source: photo.url,
        tags: query.split(" "),
      }));
    }
  }
  return items;
}

async function fetchPixabayVideos({ stockDir, publicBaseHref, apiKey, fetchImpl, queries, targetCount }) {
  const items = [];
  for (const query of queries) {
    const remaining = targetCount - items.length;
    if (remaining <= 0) return items;
    const url = new URL("https://pixabay.com/api/videos/");
    url.searchParams.set("key", apiKey);
    url.searchParams.set("q", query);
    url.searchParams.set("orientation", "horizontal");
    url.searchParams.set("per_page", String(Math.min(20, Math.max(3, remaining))));
    const response = await fetchWithTimeout(fetchImpl, url);
    if (!response.ok) continue;
    const payload = await response.json();
    for (const hit of payload.hits || []) {
      const videoUrl = hit.videos?.medium?.url || hit.videos?.small?.url;
      if (!videoUrl) continue;
      if (items.length >= targetCount) return items;
      items.push(await downloadMediaFile({
        stockDir,
        fetchImpl,
        url: videoUrl,
        id: `pixabay-${hit.id}`,
        publicBaseHref,
        provider: "pixabay",
        type: "video",
        title: query,
        source: hit.pageURL,
        tags: query.split(" "),
        posterHref: hit.videos?.medium?.thumbnail || (hit.picture_id ? `https://i.vimeocdn.com/video/${hit.picture_id}_640x360.jpg` : null),
      }));
    }
  }
  return items;
}

function choosePexelsVideoFile(files) {
  return files
    .filter((file) => file.width >= 1280 && file.height >= 720)
    .sort((a, b) => (a.width * a.height) - (b.width * b.height))[0] || files[0];
}

async function downloadMediaFile({ stockDir, fetchImpl, url, id, publicBaseHref, provider, type, title, source, tags, posterHref = null }) {
  const extension = path.extname(new URL(url).pathname) || ".mp4";
  const filename = `${id}${extension}`;
  const localPath = path.join(stockDir, filename);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STOCK_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok || !response.body) throw new Error(`Failed to download ${url}`);
    await pipeline(response.body, createWriteStream(localPath));
  } finally {
    clearTimeout(timer);
  }
  return {
    id,
    provider,
    type,
    title,
    source,
    tags,
    filePath: localPath,
    href: publicBaseHref ? `${publicBaseHref}/${encodeURIComponent(filename)}` : localPath,
    posterHref: posterHref || (type === "image" ? (publicBaseHref ? `${publicBaseHref}/${encodeURIComponent(filename)}` : localPath) : null),
  };
}

async function fetchWithTimeout(fetchImpl, url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STOCK_TIMEOUT_MS);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
