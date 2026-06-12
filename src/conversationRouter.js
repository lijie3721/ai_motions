const ROUTER_TIMEOUT_MS = 6000;

const ALLOWED_INTENTS = new Set([
  "material_refresh_request",
  "asset_distribution_feedback",
  "scene_edit",
  "shot_edit",
  "topic_rewrite",
  "confirmation_update",
  "render_request",
  "general_question",
  "general_revision",
]);

const ALLOWED_ACTIONS = new Set([
  "request_material_refresh",
  "refresh_scene_materials",
  "refresh_shot_material",
  "redistribute_materials",
  "edit_scene",
  "edit_shot",
  "update_video_settings",
  "update_voice",
  "update_language",
  "regenerate_voiceover",
  "sync_duration_to_voiceover",
  "rewrite_topic",
  "revise_script",
  "render_video",
  "save_draft",
  "new_project",
  "answer_question",
]);

const VISUAL_MAPPINGS = [
  { label: "大米", priority: 10, patterns: [/大米|五常大米|米饭|米袋/], queries: ["rice close up", "rice bags", "cooked rice bowl"] },
  { label: "稻田", priority: 20, patterns: [/稻田|水稻田|田里/], queries: ["rice field", "rice paddy"] },
  { label: "餐桌", priority: 30, patterns: [/餐桌|桌上|饭桌/], queries: ["rice bowl on table", "family dinner rice table"] },
  { label: "东北冬天", priority: 40, patterns: [/东北.*冬天|冬天.*东北|东北.*雪|雪.*东北/], queries: ["Northeast China winter", "snowy village Northeast China"] },
  { label: "超市", priority: 50, patterns: [/超市|货架|商超/], queries: ["rice bags supermarket", "supermarket rice shelf"] },
  { label: "卤煮", priority: 10, patterns: [/卤煮|卤味|卤肉/], queries: ["Chinese braised food", "Chinese braised food restaurant"] },
  { label: "济南", priority: 20, patterns: [/济南|泉城/], queries: ["Jinan street food", "Jinan local restaurant"] },
  { label: "蘑菇", priority: 10, patterns: [/蘑菇|菌菇|野生菌/], queries: ["wild mushrooms", "fresh mushrooms"] },
  { label: "云南", priority: 20, patterns: [/云南/], queries: ["Yunnan market", "Yunnan mountains"] },
];

export async function routeConversationMessageAsync(project, message, { env = process.env, fetchImpl = fetch } = {}) {
  const llmRoute = await routeWithLlm(project, message, { env, fetchImpl });
  const fallbackRoute = routeConversationMessageFallback(project, message);
  if (!llmRoute) return fallbackRoute;
  if (!llmRoute.actions.length && fallbackRoute.actions.length) return fallbackRoute;
  return llmRoute;
}

export function routeConversationMessage(project, message) {
  return routeConversationMessageFallback(project, message);
}

export function routeConversationMessageFallback(project, message) {
  const text = String(message || "");
  const requestedVisuals = extractRequestedVisuals(text);
  const forbiddenVisuals = extractForbiddenVisuals(text);
  const stockQueries = buildVisualQueries(requestedVisuals, project);
  const distributionComplaint = /共用|同一组|同几张|素材太少|图片太少|每个分镜.*(图|素材)|每段.*(图|素材)/.test(text);
  const materialIntent = isMaterialRefreshText(text) || distributionComplaint || requestedVisuals.length >= 2 || (requestedVisuals.length && forbiddenVisuals.length);

  if (materialIntent) {
    return normalizeConversationRoute({
      intent: distributionComplaint ? "asset_distribution_feedback" : "material_refresh_request",
      confidence: 0.58,
      actions: [{
        type: "request_material_refresh",
        requiresConfirmation: true,
        scope: "project",
        params: {
          summary: requestedVisuals.length ? requestedVisuals.join("、") : "",
          requestedVisuals,
          forbiddenVisuals,
          stockQueries,
          perSceneMinAssets: 3,
          perSceneMaxAssets: 5,
        },
      }],
      requestedVisuals,
      forbiddenVisuals,
      stockQueries,
      constraints: {
        preserveUserMedia: true,
        replaceOnlyUnlockedSystemMedia: true,
      },
      assistantReply: "",
    }, project, message);
  }

  return normalizeConversationRoute({
    intent: "general_revision",
    confidence: 0.4,
    actions: [],
    constraints: {},
    assistantReply: "",
  }, project, message);
}

export function normalizeConversationRoute(value, project = null, message = "") {
  const source = value && typeof value === "object" ? value : {};
  const intent = ALLOWED_INTENTS.has(source.intent) ? source.intent : "general_revision";
  const sceneCount = project?.storyboard?.scenes?.length || 0;
  const actions = Array.isArray(source.actions)
    ? source.actions.map((action) => normalizeAction(action, sceneCount)).filter(Boolean)
    : [];
  const constraints = source.constraints && typeof source.constraints === "object" ? {
    preserveUserMedia: source.constraints.preserveUserMedia !== false,
    replaceOnlyUnlockedSystemMedia: source.constraints.replaceOnlyUnlockedSystemMedia !== false,
    doNotRender: Boolean(source.constraints.doNotRender),
  } : {
    preserveUserMedia: true,
    replaceOnlyUnlockedSystemMedia: true,
    doNotRender: false,
  };

  return {
    intent,
    confidence: clampNumber(source.confidence, 0, 1, 0),
    actions,
    constraints,
    requestedVisuals: cleanList(source.requestedVisuals),
    forbiddenVisuals: cleanList(source.forbiddenVisuals),
    stockQueries: cleanList(source.stockQueries),
    assistantReply: cleanText(source.assistantReply, 420),
    originalMessage: String(message || ""),
  };
}

function normalizeAction(action, sceneCount) {
  if (!action || typeof action !== "object" || !ALLOWED_ACTIONS.has(action.type)) return null;
  const sceneIndex = normalizeIndex(action.sceneIndex, sceneCount);
  return {
    type: action.type,
    requiresConfirmation: action.requiresConfirmation !== false && requiresConfirmationByDefault(action.type),
    scope: ["project", "scene", "shot"].includes(action.scope) ? action.scope : inferScope(action.type),
    sceneIndex,
    shotIndex: Number.isInteger(action.shotIndex) && action.shotIndex >= 0 ? action.shotIndex : null,
    params: action.params && typeof action.params === "object" ? action.params : {},
  };
}

function requiresConfirmationByDefault(type) {
  return [
    "request_material_refresh",
    "refresh_scene_materials",
    "refresh_shot_material",
    "redistribute_materials",
    "rewrite_topic",
    "render_video",
    "new_project",
  ].includes(type);
}

function inferScope(type) {
  if (type.includes("scene")) return "scene";
  if (type.includes("shot")) return "shot";
  return "project";
}

function normalizeIndex(value, count) {
  const index = Number(value);
  if (!Number.isInteger(index) || index < 0) return null;
  if (count && index >= count) return null;
  return index;
}

async function routeWithLlm(project, message, { env, fetchImpl }) {
  if (!env.DASHSCOPE_API_KEY) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(env.AI_MOTIONS_ROUTER_TIMEOUT_MS || ROUTER_TIMEOUT_MS));
  try {
    const response = await fetchImpl("https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${env.DASHSCOPE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: env.AI_MOTIONS_ROUTER_MODEL || env.AI_MOTIONS_PLANNER_MODEL || "qwen-plus",
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: [
              "你是短视频编辑产品的多轮对话路由器。",
              "只输出严格 JSON，不要 Markdown。",
              "你只负责理解用户意图并给出白名单 action，不要声称已经执行。",
              "素材下载、重写主题、渲染、新建项目等耗时或高风险动作必须 requiresConfirmation=true。",
              "如果用户只是改文案或某一段，不要触发重新找素材。",
            ].join(""),
          },
          {
            role: "user",
            content: JSON.stringify({
              message,
              project: projectContext(project),
              schema: {
                intent: [...ALLOWED_INTENTS].join(" | "),
                actions: [{ type: [...ALLOWED_ACTIONS].join(" | "), requiresConfirmation: "boolean", scope: "project|scene|shot", sceneIndex: "0-based|null", shotIndex: "0-based|null", params: "object" }],
                constraints: "preserveUserMedia, replaceOnlyUnlockedSystemMedia, doNotRender",
                assistantReply: "给用户看的简短回复，确认前不要说已经完成",
              },
            }),
          },
        ],
      }),
    });
    if (!response.ok) return null;
    const payload = await response.json();
    const text = payload.choices?.[0]?.message?.content || payload.output?.text || payload.output?.choices?.[0]?.message?.content;
    return normalizeConversationRoute(JSON.parse(text), project, message);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function projectContext(project) {
  return {
    status: project?.status,
    title: project?.title,
    brief: {
      subject: project?.brief?.subject,
      industry: project?.brief?.industry,
      audience: project?.brief?.audience,
      style: project?.brief?.style,
      coreValue: project?.brief?.coreValue,
    },
    confirmation: project?.confirmation,
    scenes: (project?.storyboard?.scenes || []).map((scene, index) => ({
      index,
      title: scene.title,
      narration: scene.narration,
      duration: scene.duration,
      visualPrompt: scene.visualPrompt,
      shotCount: scene.shots?.length || 0,
      mediaTitles: (scene.shots || []).map((shot) => shot.media?.title || shot.media?.id).filter(Boolean).slice(0, 6),
    })),
  };
}

export function extractRequestedVisuals(message) {
  const text = String(message || "");
  return VISUAL_MAPPINGS
    .map((item) => ({
      item,
      index: firstPatternIndex(text, item.patterns),
    }))
    .filter((entry) => entry.index >= 0)
    .sort((a, b) => (a.item.priority ?? 100) - (b.item.priority ?? 100) || a.index - b.index)
    .map((entry) => entry.item.label);
}

export function buildVisualQueries(visuals, project = null) {
  const queries = [];
  for (const visual of visuals) {
    const item = VISUAL_MAPPINGS.find((entry) => entry.label === visual);
    if (item) queries.push(...item.queries);
  }
  if (!queries.length && project?.brief?.subject) {
    queries.push(`${project.brief.subject} product close up`, `${project.brief.subject} customer scene`, `${project.brief.subject} store shelf`);
  }
  return [...new Set(queries)].slice(0, 8);
}

function isMaterialRefreshText(message) {
  return /素材不满意|重新配图|重新找图|换素材|换图|图片不对|照片不对|配图不对|没有.*(图片|照片|画面|素材)|不要这些图|没什么关系|不相关|不贴合|不匹配|没有体现|没看到|没有出现|要出现|你都没.*反应|没反应/.test(String(message || ""));
}

function extractForbiddenVisuals(message) {
  const text = String(message || "");
  const forbidden = [];
  if (/没什么关系|不相关|不贴合|不匹配/.test(text)) forbidden.push("不相关素材");
  if (/不要这些图/.test(text)) forbidden.push("当前系统配图");
  return forbidden;
}

function firstPatternIndex(text, patterns) {
  const indexes = patterns
    .map((pattern) => text.search(pattern))
    .filter((index) => index >= 0);
  return indexes.length ? Math.min(...indexes) : -1;
}

function cleanList(value) {
  return Array.isArray(value) ? value.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 12) : [];
}

function cleanText(value, maxLength) {
  return String(value || "").trim().slice(0, maxLength);
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}
