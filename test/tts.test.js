import test from "node:test";
import assert from "node:assert/strict";
import {
  expandStoryboardForAudio,
  prepareVoiceoverStoryboard,
  requestAliyunTtsForTest,
  selectTtsProvider,
} from "../src/tts.js";

test("selectTtsProvider prefers Aliyun, then OpenAI, then macOS say", () => {
  assert.equal(selectTtsProvider({ DASHSCOPE_API_KEY: "key" }).type, "aliyun");
  assert.equal(selectTtsProvider({ OPENAI_API_KEY: "key", OPENAI_TTS_MODEL: "model" }).type, "openai");
  assert.equal(selectTtsProvider({ OPENAI_API_KEY: "key" }).type, "say");
  assert.equal(selectTtsProvider({}).type, "say");
});

test("selectTtsProvider maps voice presets into provider options", () => {
  const bright = selectTtsProvider({ DASHSCOPE_API_KEY: "key" }, { voicePreset: "female_bright_cn" });
  assert.equal(bright.type, "aliyun");
  assert.equal(bright.voice, "Cherry");
  assert.equal(bright.preset, "female_bright_cn");
  assert.match(bright.instruction, /年轻|活力|宣传/);

  const male = selectTtsProvider({ DASHSCOPE_API_KEY: "key" }, { voicePreset: "male_warm_cn" });
  assert.equal(male.type, "aliyun");
  assert.equal(male.preset, "male_warm_cn");
  assert.match(male.instruction, /男声|稳重|可信/);

  const english = selectTtsProvider({ DASHSCOPE_API_KEY: "key" }, { voicePreset: "english_travel" });
  assert.equal(english.languageType, "English");
  assert.match(english.instruction, /English|travel/i);
});

test("selectTtsProvider supports distinct English male and female presets", () => {
  const male = selectTtsProvider({ DASHSCOPE_API_KEY: "key" }, { voicePreset: "male_commercial_en" });
  assert.equal(male.type, "aliyun");
  assert.equal(male.preset, "male_commercial_en");
  assert.equal(male.languageType, "English");
  assert.equal(male.voice, "Ryan");
  assert.match(male.instruction, /English|male|commercial/i);

  const female = selectTtsProvider({ DASHSCOPE_API_KEY: "key" }, { voicePreset: "female_natural_en" });
  assert.equal(female.preset, "female_natural_en");
  assert.equal(female.languageType, "English");
  assert.equal(female.voice, "Jennifer");
  assert.match(female.instruction, /English|natural/i);
});

test("selectTtsProvider gives selected language priority over mismatched voice preset", () => {
  const english = selectTtsProvider({ DASHSCOPE_API_KEY: "key" }, {
    language: "en",
    voicePreset: "female_bright_cn",
  });
  assert.equal(english.preset, "female_natural_en");
  assert.equal(english.languageType, "English");
  assert.equal(english.voice, "Jennifer");

  const japanese = selectTtsProvider({ DASHSCOPE_API_KEY: "key" }, {
    language: "ja",
    voicePreset: "female_bright_cn",
  });
  assert.equal(japanese.preset, "female_japanese");
  assert.equal(japanese.languageType, "Japanese");

  const korean = selectTtsProvider({ DASHSCOPE_API_KEY: "key" }, {
    language: "ko",
    voicePreset: "female_bright_cn",
  });
  assert.equal(korean.preset, "female_korean");
  assert.equal(korean.languageType, "Korean");
});

test("selectTtsProvider does not let global instruction override UI preset unless forced", () => {
  const provider = selectTtsProvider({
    DASHSCOPE_API_KEY: "key",
    ALIYUN_TTS_INSTRUCTION: "标准普通话，年轻有活力的中文女声",
  }, { voicePreset: "male_warm_cn" });

  assert.equal(provider.voice, "Ethan");
  assert.doesNotMatch(provider.instruction, /中文女声|年轻有活力/);
  assert.match(provider.instruction, /男声|稳重/);

  const forced = selectTtsProvider({
    DASHSCOPE_API_KEY: "key",
    ALIYUN_TTS_INSTRUCTION: "强制全局指令",
    ALIYUN_TTS_INSTRUCTION_FORCE: "1",
  }, { voicePreset: "male_warm_cn" });

  assert.equal(forced.instruction, "强制全局指令");
  assert.equal(forced.instructionForced, true);
});

test("selectTtsProvider keeps UI preset voice unless force override is enabled", () => {
  const selected = selectTtsProvider({
    DASHSCOPE_API_KEY: "key",
    ALIYUN_TTS_VOICE: "Cherry",
  }, { voicePreset: "male_warm_cn" });

  assert.equal(selected.preset, "male_warm_cn");
  assert.notEqual(selected.voice, "Cherry");

  const forced = selectTtsProvider({
    DASHSCOPE_API_KEY: "key",
    ALIYUN_TTS_VOICE: "Cherry",
    ALIYUN_TTS_VOICE_FORCE: "1",
  }, { voicePreset: "male_warm_cn" });

  assert.equal(forced.voice, "Cherry");
});

test("prepareVoiceoverStoryboard rewrites narration for English preset", () => {
  const storyboard = {
    title: "泰国潜水宣传视频",
    duration: 25,
    creativeScript: {
      sceneBeats: [
        { title: "泰国潜水开场", voiceoverEn: "Start your Thailand diving trip with one deep breath." },
        { title: "中文领队", voiceoverEn: "A trusted guide helps every first-time diver feel ready." },
      ],
    },
    scenes: [
      {
        id: "scene-1",
        title: "泰国潜水开场",
        narration: "第一次潜水，就从泰国开始。",
        visualPrompt: "Thailand scuba diving ocean",
        highlights: ["泰国", "潜水"],
      },
      {
        id: "scene-2",
        title: "中文领队",
        narration: "中文领队带你完成准备。",
        visualPrompt: "Thailand dive guide",
        highlights: ["中文领队"],
      },
    ],
  };

  const prepared = prepareVoiceoverStoryboard(storyboard, { preset: "english_travel", languageType: "English" });

  assert.equal(prepared.scenes[0].narration, "Start your Thailand diving trip with one deep breath.");
  assert.equal(prepared.scenes[1].narration, "A trusted guide helps every first-time diver feel ready.");
  assert.doesNotMatch(prepared.scenes.map((scene) => scene.narration).join(" "), /[\u4e00-\u9fff]/);
});

test("prepareVoiceoverStoryboard uses target language from storyboard confirmation", () => {
  const storyboard = {
    confirmation: { language: "ja" },
    creativeScript: {
      sceneBeats: [
        { voiceoverJa: "雲南きのこの魅力を、産地の空気感から伝えます。" },
      ],
    },
    scenes: [
      {
        id: "scene-1",
        title: "云南菌菇开场",
        narration: "先用一个强开场把观众带进云南菌菇的氛围。",
        visualPrompt: "Yunnan mushroom market",
        highlights: ["云南", "菌菇"],
      },
    ],
  };

  const prepared = prepareVoiceoverStoryboard(storyboard, { preset: "female_japanese", languageType: "Japanese" });

  assert.equal(prepared.language, "ja");
  assert.equal(prepared.scenes[0].narration, "雲南きのこの魅力を、産地の空気感から伝えます。");
  assert.notEqual(prepared.scenes[0].narration, storyboard.scenes[0].narration);
});

test("requestAliyunTts sends English language type and English text for English preset", async () => {
  const provider = selectTtsProvider({ DASHSCOPE_API_KEY: "key" }, { voicePreset: "male_commercial_en" });
  let requestBody = null;
  const audioUrl = await requestAliyunTtsForTest({
    text: "Teach English with a clear course promise.",
    provider,
    env: { DASHSCOPE_API_KEY: "key" },
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return new Response(JSON.stringify({ output: { audio: { url: "https://audio.test/en.wav" } } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  assert.equal(audioUrl, "https://audio.test/en.wav");
  assert.equal(requestBody.input.language_type, "English");
  assert.equal(requestBody.input.voice, "Ryan");
  assert.doesNotMatch(requestBody.input.text, /[\u4e00-\u9fff]/);
  assert.match(requestBody.input.instruction, /English/i);
});

test("requestAliyunTts sends Japanese and Korean language types", async () => {
  const requests = [];
  const fetchImpl = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ output: { audio: { url: "https://audio.test/voice.wav" } } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  await requestAliyunTtsForTest({
    text: "雲南きのこの魅力を伝えます。",
    provider: selectTtsProvider({ DASHSCOPE_API_KEY: "key" }, { language: "ja" }),
    env: { DASHSCOPE_API_KEY: "key" },
    fetchImpl,
  });
  await requestAliyunTtsForTest({
    text: "운남 버섯의 매력을 전합니다.",
    provider: selectTtsProvider({ DASHSCOPE_API_KEY: "key" }, { language: "ko" }),
    env: { DASHSCOPE_API_KEY: "key" },
    fetchImpl,
  });

  assert.equal(requests[0].input.language_type, "Japanese");
  assert.equal(requests[1].input.language_type, "Korean");
});

test("expandStoryboardForAudio extends scene and shot timing to fit voiceover", () => {
  const storyboard = {
    duration: 25,
    scenes: [
      {
        id: "scene-1",
        duration: 10,
        start: 0,
        shots: [
          { id: "shot-1", start: 0, duration: 4 },
          { id: "shot-2", start: 4, duration: 6 },
        ],
      },
      {
        id: "scene-2",
        duration: 15,
        start: 10,
        shots: [
          { id: "shot-3", start: 0, duration: 15 },
        ],
      },
    ],
  };

  const expanded = expandStoryboardForAudio(storyboard, 31);

  assert.equal(expanded.duration, 31.4);
  assert.ok(expanded.scenes[0].duration > 10);
  assert.equal(expanded.scenes[1].start, expanded.scenes[0].duration);
  assert.equal(
    Number((expanded.scenes[0].shots[0].duration + expanded.scenes[0].shots[1].duration).toFixed(2)),
    expanded.scenes[0].duration,
  );
});

test("expandStoryboardForAudio keeps requested duration when voiceover is shorter or disabled", () => {
  const storyboard = { duration: 25, scenes: [{ id: "scene-1", duration: 25, start: 0, shots: [] }] };

  assert.equal(expandStoryboardForAudio(storyboard, 20), storyboard);
  assert.equal(expandStoryboardForAudio(storyboard, 0), storyboard);
});
