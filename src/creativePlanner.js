export async function createCreativePlan(prompt, options = {}) {
  const llmPlan = await createLlmPlan(prompt, options);
  if (llmPlan) return llmPlan;
  return createFallbackPlan(prompt);
}

export function createFallbackPlan(prompt) {
  const brief = createBrief(prompt);
  const creativeScript = createCreativeScript(brief, prompt);
  brief.creativeScript = creativeScript;
  brief.stockQueries = creativeScript.stockQueries;
  brief.avoidKeywords = creativeScript.avoidKeywords;
  return { brief, creativeScript };
}

async function createLlmPlan(prompt, { env = process.env, fetchImpl = fetch } = {}) {
  if (!env.DASHSCOPE_API_KEY) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(env.AI_MOTIONS_PLANNER_TIMEOUT_MS || 8000));
  try {
    const response = await fetchImpl("https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${env.DASHSCOPE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: env.AI_MOTIONS_PLANNER_MODEL || "qwen-plus",
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: "你是短视频导演。只输出严格 JSON，不要 Markdown。必须根据用户原始需求抽取主题、地点、行业、受众和卖点，不得复用历史主题，不得把旅游默认成日本。",
          },
          {
            role: "user",
            content: JSON.stringify({
              prompt,
              schema: {
                brief: "title, goal, subject, industry, audience, style, coreValue",
                creativeScript: "hook, targetAudience, emotionalArc, visualStyle, pacing, cta, sceneBeats[title,purpose,narration,visualPrompt,caption,highlights], stockQueries, avoidKeywords",
              },
            }),
          },
        ],
      }),
    });
    const payload = await response.json();
    if (!response.ok) return null;
    const text = payload.choices?.[0]?.message?.content || payload.output?.text || payload.output?.choices?.[0]?.message?.content;
    const parsed = JSON.parse(text);
    return normalizePlan(parsed, prompt);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizePlan(value, prompt) {
  const fallback = createFallbackPlan(prompt);
  const brief = {
    ...fallback.brief,
    ...(value.brief || {}),
  };
  const creativeScript = {
    ...fallback.creativeScript,
    ...(value.creativeScript || {}),
  };
  creativeScript.sceneBeats = Array.isArray(creativeScript.sceneBeats) && creativeScript.sceneBeats.length >= 3
    ? creativeScript.sceneBeats
    : fallback.creativeScript.sceneBeats;
  creativeScript.stockQueries = Array.isArray(creativeScript.stockQueries) && creativeScript.stockQueries.length
    ? creativeScript.stockQueries.map((item) => String(item).trim()).filter(Boolean)
    : fallback.creativeScript.stockQueries;
  creativeScript.avoidKeywords = Array.isArray(creativeScript.avoidKeywords)
    ? creativeScript.avoidKeywords.map((item) => String(item).trim()).filter(Boolean)
    : fallback.creativeScript.avoidKeywords;
  brief.creativeScript = creativeScript;
  brief.stockQueries = creativeScript.stockQueries;
  brief.avoidKeywords = creativeScript.avoidKeywords;
  return { brief, creativeScript };
}

function createBrief(prompt) {
  const subject = detectSubject(prompt);
  const platform = /抖音|小红书|视频号|快手/.test(prompt) ? "短视频平台" : "线上宣传";
  const style = detectStyle(prompt, "高级商业宣传");
  const industry = detectIndustry(prompt, subject);
  const audience = detectAudience(prompt, subject);
  const coreValue = detectCoreValue(subject, prompt);

  return {
    title: `${subject}宣传视频`,
    goal: `为${subject}生成一条可继续对话修改的宣传视频`,
    subject,
    industry,
    platform,
    audience,
    style,
    coreValue,
  };
}

function createCreativeScript(brief, prompt) {
  if (brief.industry === "旅游服务") return createTravelScript(brief, prompt);

  const stockQueries = stockQueriesForBrief(brief);
  return {
    hook: `${brief.subject}最打动人的，不只是产品，而是第一眼就能相信的现场感。`,
    targetAudience: brief.audience,
    emotionalArc: "被开场吸引 -> 看见核心卖点 -> 代入真实场景 -> 产生咨询或到店动作",
    visualStyle: `${brief.style}，用快切、近景细节和现场人物情绪制造短视频节奏`,
    pacing: "开头 3 秒密集信息，中段用 4-5 个镜头连续证明，结尾明确 CTA",
    cta: "现在咨询或到店体验",
    sceneBeats: [
      {
        title: `${brief.subject}，第一眼就想了解`,
        purpose: "用强开场建立主题和情绪",
        narration: `先用一个强开场把观众带进${brief.subject}的氛围。`,
        visualPrompt: `开场，${brief.subject}，高级商业宣传片，真实场景，强记忆点`,
        caption: brief.subject,
        highlights: [brief.subject, "强开场", "立即种草"],
      },
      {
        title: `把${brief.coreValue}拍出来`,
        purpose: "集中展示核心卖点",
        narration: "第二段集中展示核心卖点，让观众知道为什么值得选择。",
        visualPrompt: `产品细节，${brief.coreValue}，近景，质感，高级灯光`,
        caption: brief.coreValue,
        highlights: [brief.coreValue, "真实细节", "强记忆点"],
      },
      {
        title: "让人想象自己就在现场",
        purpose: "用真实体验建立信任",
        narration: "第三段进入使用场景，用情绪和人群感建立信任。",
        visualPrompt: `场景体验，${brief.subject}，人群，真实体验，情绪，高级短视频`,
        caption: "真实体验",
        highlights: ["真实体验", "现场氛围", "用户代入"],
      },
      {
        title: "现在就来体验",
        purpose: "清晰行动号召",
        narration: "最后给出清晰行动号召，强化记忆点并收束视频。",
        visualPrompt: `结尾 CTA，${brief.subject}，品牌口号，清晰行动号召，高级收束`,
        caption: "立即咨询",
        highlights: ["立即咨询", "到店体验", brief.platform],
      },
    ],
    stockQueries,
    avoidKeywords: avoidKeywordsForBrief(brief),
  };
}

function createTravelScript(brief, prompt) {
  const destination = detectDestination(prompt) || brief.subject.replace(/旅游|旅行团|旅行|潜水/g, "") || "目的地";
  const activity = detectActivity(prompt) || "旅行";
  const englishDestination = destinationEnglish(destination);
  const englishActivity = /潜水/.test(activity) ? "scuba diving" : "travel";
  return {
    hook: `不用自己做攻略，也能把${destination}${activity}拍成一条让人立刻想出发的路线。`,
    targetAudience: brief.audience,
    emotionalArc: "被目的地吸引 -> 看到体验细节 -> 感到省心可信 -> 立即咨询报名",
    visualStyle: "高频切换的旅行 vlog，目的地场景、体验动作、路线卡和人物情绪快速穿插",
    pacing: "前 3 秒强钩子，中段 0.6-1.2 秒快切，结尾用清晰 CTA 收束",
    cta: `私信领取${destination}${activity}路线和报价`,
    sceneBeats: [
      {
        title: `${destination}${activity}，不再靠刷攻略碰运气`,
        purpose: "强钩子，直接戳中游客做攻略累、怕踩坑的痛点",
        narration: `想去${destination}${activity}，但不想把时间都花在查攻略和试错上？这条路线帮你直接进入旅行状态。`,
        visualPrompt: `${destination}${activity}开场, ${englishDestination} ${englishActivity} travel opening, tourists, cinematic vlog, fast cuts`,
        caption: `${destination}${activity}`,
        highlights: [destination, activity, "省心路线"],
      },
      {
        title: `把${destination}最值得期待的体验串起来`,
        purpose: "展示目的地吸引力，让用户看到具体可期待的画面",
        narration: `把${destination}的经典体验、拍照点和节奏都串起来，让第一次去的人也知道怎么玩。`,
        visualPrompt: `${destination}${activity}体验, ${englishDestination} ${englishActivity}, destination highlights, ocean travel, local experience`,
        caption: "经典体验一次串好",
        highlights: [destination, activity, "经典路线"],
      },
      {
        title: "中文沟通、行程规划、安全细节都提前安排",
        purpose: "建立服务可信度，强调不只是景点拼接",
        narration: "中文沟通、交通衔接、体验准备和自由活动时间都提前规划，适合第一次出发的人。",
        visualPrompt: `${destination}中文行程服务, ${englishDestination} travel guide service, Chinese tourists, itinerary planning, safe experience`,
        caption: "第一次去也不慌",
        highlights: ["中文沟通", "行程规划", "安全细节"],
      },
      {
        title: "从想去，到真正出发，只差一次咨询",
        purpose: "行动号召，降低咨询门槛",
        narration: `想看适合你的${destination}${activity}路线，私信告诉我出发城市和人数，先给你一版参考方案。`,
        visualPrompt: `${destination}旅行 CTA, ${englishDestination} travel CTA, suitcase, departure, happy tourists, clean commercial ending`,
        caption: "私信领取路线",
        highlights: ["出发城市", "人数预算", "路线报价"],
      },
    ],
    stockQueries: [
      `${englishDestination} ${englishActivity}`,
      `${englishDestination} travel`,
      /潜水/.test(activity) ? `${englishDestination} coral reef diving` : `${englishDestination} tourists`,
      /泰国/.test(destination) ? "Phuket ocean travel" : `${englishDestination} city travel`,
      `${englishDestination} travel group`,
    ],
    avoidKeywords: ["pork", "meat", "restaurant", "hotpot", "mushroom", destination === "日本" ? "" : "Japan", "Tokyo", "Kyoto", "Fuji"].filter(Boolean),
  };
}

function detectSubject(prompt) {
  const value = String(prompt || "").trim();
  const destination = detectDestination(value);
  const activity = detectActivity(value);
  if (destination && /旅游|旅行|出境游|旅行团|潜水/.test(value)) return `${destination}${activity || "旅游"}`;
  if (/火锅/.test(value)) return "火锅店";
  if (/云南.*(蘑菇|菌菇|野生菌)|(蘑菇|菌菇|野生菌).*云南/.test(value)) return "云南菌菇";
  if (/蘑菇|菌菇|野生菌/.test(value)) return "菌菇";
  if (/饺子|水饺|煎饺/.test(value)) return "饺子馆";
  if (/咖啡/.test(value)) return "咖啡店";
  if (/课程|培训/.test(value)) return "课程";
  if (/产品/.test(value)) return "产品";
  return value.replace(/^帮我做一个?/, "").replace(/的视频$/, "").slice(0, 18) || "新项目";
}

function detectIndustry(prompt, subject) {
  const text = `${prompt} ${subject}`;
  if (/旅游|旅行|出境游|旅行团|潜水/.test(text)) return "旅游服务";
  if (/餐|店|火锅|饺子|咖啡/.test(text)) return "本地生活餐饮";
  if (/课程|培训/.test(text)) return "教育培训";
  return "商业服务";
}

function detectAudience(prompt, subject) {
  const text = `${prompt} ${subject}`;
  if (/中国人|中国游客|中文/.test(text) && /旅游|旅行|潜水|出境游/.test(text)) return "中国游客";
  if (/招商|加盟/.test(text)) return "潜在投资人和加盟商";
  return "潜在顾客";
}

function detectCoreValue(subject, prompt) {
  const text = `${subject} ${prompt}`;
  if (/旅游|旅行|潜水|出境游/.test(text)) {
    const destination = detectDestination(text) || "目的地";
    const activity = detectActivity(text) || "旅行";
    return `${destination}${activity}体验、行程规划和中文服务`;
  }
  if (subject.includes("火锅")) return "热气、锅底和聚餐氛围";
  if (/饺子|水饺|煎饺/.test(text)) return "现包饺子、热气出锅和家常口味";
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

function stockQueriesForBrief(brief) {
  if (/火锅/.test(brief.subject)) return ["hot pot restaurant", "hot pot cooking", "restaurant food table", "friends eating restaurant", "restaurant storefront"];
  if (/饺子/.test(brief.subject)) return ["dumpling restaurant", "chinese dumplings", "dumpling kitchen", "asian food restaurant", "dumpling meal"];
  if (/云南菌菇/.test(brief.subject)) return ["Yunnan mushrooms", "wild mushrooms", "fresh mushrooms", "mushroom market", "mushroom farm"];
  if (/蘑菇|菌菇/.test(brief.subject)) return ["wild mushrooms", "fresh mushrooms", "mushroom market", "mushroom farm", "organic mushrooms"];
  if (/咖啡/.test(brief.subject)) return ["coffee shop", "barista coffee", "cafe interior", "coffee customers", "coffee cup close up"];
  return ["business promo", "city lifestyle", "customer experience", "service business", "people shopping"];
}

function detectDestination(text) {
  const value = String(text || "");
  const destinations = ["泰国", "日本", "云南", "成都", "韩国", "新加坡", "马来西亚", "巴厘岛", "普吉", "清迈"];
  return destinations.find((item) => value.includes(item)) || null;
}

function detectActivity(text) {
  const value = String(text || "");
  if (/潜水|diving|scuba/i.test(value)) return "潜水";
  if (/旅行团|跟团/.test(value)) return "旅行团";
  if (/旅游|旅行|出境游/.test(value)) return "旅游";
  return null;
}

function destinationEnglish(destination) {
  const map = {
    泰国: "Thailand",
    日本: "Japan",
    云南: "Yunnan",
    成都: "Chengdu",
    韩国: "Korea",
    新加坡: "Singapore",
    马来西亚: "Malaysia",
    巴厘岛: "Bali",
    普吉: "Phuket",
    清迈: "Chiang Mai",
  };
  return map[destination] || destination;
}

function avoidKeywordsForBrief(brief) {
  if (/火锅|饺子|咖啡|蘑菇|菌菇/.test(brief.subject)) return [];
  return ["pork", "meat", "restaurant", "hotpot"];
}
