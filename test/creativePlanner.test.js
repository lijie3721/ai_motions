import test from "node:test";
import assert from "node:assert/strict";
import { createCreativePlan } from "../src/creativePlanner.js";

test("createCreativePlan builds a director script for Japan tourism", async () => {
  const plan = await createCreativePlan("我在日本做旅游，引导中国人去旅游的宣传视频", { env: {} });

  assert.equal(plan.brief.subject, "日本旅游");
  assert.equal(plan.brief.industry, "旅游服务");
  assert.match(plan.brief.audience, /中国游客/);
  assert.match(plan.brief.coreValue, /日本|行程|中文/);
  assert.match(plan.creativeScript.hook, /日本|旅游|旅行/);
  assert.ok(plan.creativeScript.sceneBeats.length >= 4);
  assert.ok(plan.creativeScript.stockQueries.some((query) => /Japan|Tokyo|Kyoto|Fuji/i.test(query)));
  assert.ok(plan.creativeScript.stockQueries.every((query) => !/restaurant|pork|meat/i.test(query)));
  assert.ok(plan.creativeScript.avoidKeywords.some((keyword) => /pork|meat|restaurant/i.test(keyword)));
});

test("createCreativePlan does not classify Thailand diving travel as Japan", async () => {
  const plan = await createCreativePlan("帮我做一个去泰国潜水的旅行团宣传", { env: {} });
  const text = [
    plan.brief.subject,
    plan.brief.coreValue,
    plan.creativeScript.hook,
    ...plan.creativeScript.sceneBeats.flatMap((beat) => [beat.title, beat.visualPrompt, ...(beat.highlights || [])]),
    ...plan.creativeScript.stockQueries,
  ].join(" ");

  assert.match(plan.brief.subject, /泰国|潜水/);
  assert.match(text, /泰国|潜水|Thailand|diving|scuba/i);
  assert.doesNotMatch(text, /日本|东京|京都|富士山|Japan|Tokyo|Kyoto|Fuji/i);
  assert.ok(plan.creativeScript.stockQueries.some((query) => /Thailand|diving|scuba|Phuket/i.test(query)));
});

test("createCreativePlan uses LLM JSON when available", async () => {
  const response = {
    output: {
      text: JSON.stringify({
        brief: {
          title: "泰国潜水旅行团宣传视频",
          goal: "为泰国潜水旅行团生成宣传视频",
          subject: "泰国潜水旅行团",
          industry: "旅游服务",
          audience: "想体验潜水的中国游客",
          style: "热闹短视频",
          coreValue: "泰国海岛潜水、中文领队和安全体验",
        },
        creativeScript: {
          hook: "第一次潜水，就去泰国看一片真正的蓝。",
          targetAudience: "想体验潜水的中国游客",
          emotionalArc: "向往 -> 安心 -> 心动 -> 咨询",
          visualStyle: "海岛潜水快切",
          pacing: "前3秒强开场",
          cta: "私信咨询团期",
          sceneBeats: [
            {
              title: "泰国潜水开场",
              purpose: "强钩子",
              narration: "第一次潜水，就从泰国开始。",
              visualPrompt: "Thailand scuba diving ocean",
              caption: "泰国潜水",
              highlights: ["泰国", "潜水"],
            },
            {
              title: "中文领队",
              purpose: "建立信任",
              narration: "中文领队带你完成准备。",
              visualPrompt: "Chinese tourists diving Thailand",
              caption: "中文领队",
              highlights: ["中文领队"],
            },
            {
              title: "海岛体验",
              purpose: "展示体验",
              narration: "蓝色海水和珊瑚都安排好。",
              visualPrompt: "Phuket coral reef diving",
              caption: "海岛体验",
              highlights: ["海岛", "珊瑚"],
            },
            {
              title: "咨询团期",
              purpose: "CTA",
              narration: "私信领取团期。",
              visualPrompt: "Thailand travel CTA",
              caption: "咨询团期",
              highlights: ["团期"],
            },
          ],
          stockQueries: ["Thailand scuba diving", "Phuket coral reef diving"],
          avoidKeywords: ["Japan", "Tokyo"],
        },
      }),
    },
  };
  const fetchImpl = async () => ({
    ok: true,
    json: async () => response,
  });

  const plan = await createCreativePlan("帮我做一个去泰国潜水的旅行团宣传", {
    env: { DASHSCOPE_API_KEY: "key" },
    fetchImpl,
  });

  assert.equal(plan.brief.subject, "泰国潜水旅行团");
  assert.equal(plan.creativeScript.hook, "第一次潜水，就去泰国看一片真正的蓝。");
  assert.deepEqual(plan.creativeScript.stockQueries, ["Thailand scuba diving", "Phuket coral reef diving"]);
});
