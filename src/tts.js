import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const VOICE_PRESETS = {
  female_bright_cn: {
    voice: "Cherry",
    sayVoice: "Ting-Ting",
    languageType: "Chinese",
    speed: 1.08,
    pitch: 1.04,
    emotion: "bright",
    instruction: "标准普通话，年轻有活力的商业宣传口播，语速略快，情绪热情但不过度夸张",
  },
  male_warm_cn: {
    voice: "Ethan",
    sayVoice: "Sin-ji",
    languageType: "Chinese",
    speed: 0.96,
    pitch: 0.92,
    emotion: "warm",
    instruction: "标准普通话，男声，稳重可信，有旅行顾问的亲和力，语速适中",
  },
  female_calm_cn: {
    voice: "Cherry",
    sayVoice: "Ting-Ting",
    languageType: "Chinese",
    speed: 0.92,
    pitch: 0.98,
    emotion: "calm",
    instruction: "标准普通话，温和自然的女声旁白，语速适中，情绪克制高级",
  },
  english_travel: {
    voice: "Cherry",
    sayVoice: "Samantha",
    languageType: "English",
    speed: 1,
    pitch: 1.02,
    emotion: "upbeat",
    instruction: "English travel promo voiceover, warm, upbeat, clear, cinematic but not exaggerated",
  },
  female_natural_en: {
    voice: "Jennifer",
    sayVoice: "Samantha",
    languageType: "English",
    speed: 1,
    pitch: 1.02,
    emotion: "natural",
    instruction: "English female natural voiceover, warm, clear, conversational, polished commercial delivery.",
  },
  male_commercial_en: {
    voice: "Ryan",
    sayVoice: "Daniel",
    languageType: "English",
    speed: 0.98,
    pitch: 0.94,
    emotion: "confident",
    instruction: "English male commercial voiceover, confident, clear, trustworthy, steady pacing.",
  },
  female_japanese: {
    voice: "Cherry",
    sayVoice: "Kyoko",
    languageType: "Japanese",
    speed: 1,
    pitch: 1.02,
    emotion: "warm",
    instruction: "Japanese female commercial voiceover, warm, clear, natural and concise.",
  },
  female_korean: {
    voice: "Cherry",
    sayVoice: "Yuna",
    languageType: "Korean",
    speed: 1,
    pitch: 1.02,
    emotion: "warm",
    instruction: "Korean female commercial voiceover, warm, clear, natural and concise.",
  },
};

function normalizeVideoLanguage(value) {
  const text = String(value || "").trim();
  if (["en", "en-US", "English", "english"].includes(text)) return "en";
  if (["ja", "ja-JP", "Japanese", "japanese", "日本語"].includes(text)) return "ja";
  if (["ko", "ko-KR", "Korean", "korean", "한국어"].includes(text)) return "ko";
  return "zh-CN";
}

function defaultVoicePresetForLanguage(language) {
  return {
    "zh-CN": "female_bright_cn",
    en: "female_natural_en",
    ja: "female_japanese",
    ko: "female_korean",
  }[language] || "female_bright_cn";
}

function languageForVoicePreset(voicePreset) {
  const preset = String(voicePreset || "").trim();
  if (["female_natural_en", "male_commercial_en", "english_travel"].includes(preset)) return "en";
  if (preset === "female_japanese") return "ja";
  if (preset === "female_korean") return "ko";
  return "zh-CN";
}

function normalizeVoicePresetForLanguage(language, voicePreset) {
  const preset = String(voicePreset || "").trim();
  const allowed = {
    "zh-CN": new Set(["female_bright_cn", "male_warm_cn", "female_calm_cn"]),
    en: new Set(["female_natural_en", "male_commercial_en", "english_travel"]),
    ja: new Set(["female_japanese"]),
    ko: new Set(["female_korean"]),
  };
  if (allowed[language]?.has(preset)) return preset;
  return defaultVoicePresetForLanguage(language);
}

function languageCodeForProvider(provider) {
  return {
    English: "en",
    Japanese: "ja",
    Korean: "ko",
    Chinese: "zh-CN",
  }[provider?.languageType] || "zh-CN";
}

function narrationLanguageLabel(provider) {
  return provider?.languageType || "Chinese";
}

export function selectTtsProvider(env = process.env, options = {}) {
  const requestedPreset = options.voicePreset || env.AI_MOTIONS_VOICE_PRESET || "";
  const language = options.language ? normalizeVideoLanguage(options.language) : languageForVoicePreset(requestedPreset);
  const presetId = normalizeVoicePresetForLanguage(language, requestedPreset || defaultVoicePresetForLanguage(language));
  const preset = VOICE_PRESETS[presetId] || VOICE_PRESETS.female_bright_cn;
  if (env.DASHSCOPE_API_KEY) {
    return {
      type: "aliyun",
      model: env.ALIYUN_TTS_MODEL || "qwen3-tts-instruct-flash",
      voice: env.ALIYUN_TTS_VOICE_FORCE === "1" && env.ALIYUN_TTS_VOICE ? env.ALIYUN_TTS_VOICE : preset.voice,
      preset: presetId,
      languageType: preset.languageType,
      instruction: env.ALIYUN_TTS_INSTRUCTION_FORCE === "1" && env.ALIYUN_TTS_INSTRUCTION
        ? env.ALIYUN_TTS_INSTRUCTION
        : `${preset.instruction} Speed ${preset.speed}; pitch ${preset.pitch}; emotion ${preset.emotion}.`,
      instructionForced: env.ALIYUN_TTS_INSTRUCTION_FORCE === "1" && Boolean(env.ALIYUN_TTS_INSTRUCTION),
      speed: preset.speed,
      pitch: preset.pitch,
      emotion: preset.emotion,
    };
  }
  if (env.OPENAI_API_KEY && env.OPENAI_TTS_MODEL) {
    return { type: "openai", model: env.OPENAI_TTS_MODEL, preset: presetId, languageType: preset.languageType };
  }
  return { type: "say", voice: env.AI_MOTIONS_SAY_VOICE || preset.sayVoice, preset: presetId, languageType: preset.languageType };
}

export async function renderVoiceover({ jobDir, storyboard, env = process.env }) {
  if (storyboard.confirmation?.voiceover === false) {
    return {
      audioPath: null,
      provider: { type: "none", preset: storyboard.confirmation?.voicePreset || "off" },
      warning: null,
      duration: 0,
    };
  }
  const provider = selectTtsProvider(env, { language: storyboard.confirmation?.language || storyboard.language, voicePreset: storyboard.confirmation?.voicePreset });
  const voiceoverStoryboard = prepareVoiceoverStoryboard(storyboard, provider);
  const overrideWarnings = [
    env.ALIYUN_TTS_VOICE_FORCE === "1" ? "环境变量 ALIYUN_TTS_VOICE_FORCE=1 覆盖了界面的配音音色选择。" : null,
    provider.instructionForced ? "环境变量 ALIYUN_TTS_INSTRUCTION_FORCE=1 覆盖了界面的配音风格指令。" : null,
  ].filter(Boolean);
  const voiceWarning = overrideWarnings.length ? overrideWarnings.join(" ") : null;
  const audioDir = path.join(jobDir, "audio");
  await mkdir(audioDir, { recursive: true });

  if (provider.type === "openai") {
    return {
      audioPath: null,
      provider,
      warning: "OpenAI TTS is configured but not wired in this local MVP yet; falling back to silent video.",
      duration: 0,
    };
  }

  if (provider.type === "aliyun") {
    try {
      const result = await renderAliyunVoiceover({ jobDir, storyboard: voiceoverStoryboard, provider, env });
      return { ...result, warning: [voiceWarning, result.warning].filter(Boolean).join(" ") || null };
    } catch (error) {
      const fallback = await renderSayVoiceover({
        jobDir,
        storyboard: voiceoverStoryboard,
        provider: selectTtsProvider({}, { voicePreset: provider.preset }),
      });
      return {
        ...fallback,
        warning: [voiceWarning, `Aliyun TTS failed, used macOS say fallback: ${error.message}`].filter(Boolean).join(" "),
      };
    }
  }

  const result = await renderSayVoiceover({ jobDir, storyboard: voiceoverStoryboard, provider });
  return { ...result, warning: [voiceWarning, result.warning].filter(Boolean).join(" ") || null };
}

export function prepareVoiceoverStoryboard(storyboard, provider) {
  const language = normalizeVideoLanguage(storyboard.confirmation?.language || storyboard.language || languageCodeForProvider(provider));
  if (language === "zh-CN") return storyboard;
  const beats = storyboard.creativeScript?.sceneBeats || [];
  return {
    ...storyboard,
    language,
    scenes: storyboard.scenes.map((scene, index) => ({
      ...scene,
      narration: narrationForLanguage(scene, beats[index], language),
    })),
  };
}

function narrationForLanguage(scene, beat, language) {
  if (language === "en") return beat?.voiceoverEn || toEnglishNarration(scene);
  if (language === "ja") return beat?.voiceoverJa || beat?.voiceoverJp || toJapaneseNarration(scene);
  if (language === "ko") return beat?.voiceoverKo || toKoreanNarration(scene);
  return scene.narration;
}

function toEnglishNarration(scene) {
  const source = [scene.title, scene.visualPrompt, ...(scene.highlights || [])].join(" ");
  const place = /Thailand|泰国/i.test(source) ? "Thailand" : "this destination";
  if (/潜水|diving|scuba/i.test(source)) {
    return `Start your ${place} diving trip with a clear plan, trusted guidance, and a view worth going underwater for.`;
  }
  return `Discover ${place} with a clear route, trusted guidance, and moments that feel ready to book.`;
}

function toJapaneseNarration(scene) {
  const source = [scene.title, scene.visualPrompt, ...(scene.highlights || [])].join(" ");
  if (/mushroom|蘑菇|菌菇|野生菌/i.test(source)) {
    return "雲南きのこの新鮮さと産地の空気感を、印象的な映像で伝えます。";
  }
  if (/travel|旅游|旅行|Thailand|Japan|泰国|日本/i.test(source)) {
    return "安心できる旅の流れと、今すぐ出発したくなる体験を紹介します。";
  }
  return "ブランドの魅力と信頼できる体験を、わかりやすく印象的に伝えます。";
}

function toKoreanNarration(scene) {
  const source = [scene.title, scene.visualPrompt, ...(scene.highlights || [])].join(" ");
  if (/mushroom|蘑菇|菌菇|野生菌/i.test(source)) {
    return "운남 버섯의 신선함과 산지의 분위기를 생생한 장면으로 전합니다.";
  }
  if (/travel|旅游|旅行|Thailand|Japan|泰国|日本/i.test(source)) {
    return "믿을 수 있는 여행 일정과 바로 떠나고 싶은 경험을 소개합니다.";
  }
  return "브랜드의 매력과 신뢰할 수 있는 경험을 쉽고 인상적으로 전합니다.";
}

async function renderSayVoiceover({ jobDir, storyboard, provider }) {
  const audioDir = path.join(jobDir, "audio");
  await mkdir(audioDir, { recursive: true });
  const segmentPaths = [];
  for (const scene of storyboard.scenes) {
    const aiffPath = path.join(audioDir, `${scene.id}.aiff`);
    const wavPath = path.join(audioDir, `${scene.id}.wav`);
    await execFileAsync("say", ["-v", provider.voice, "-o", aiffPath, scene.narration]);
    await execFileAsync("ffmpeg", ["-y", "-i", aiffPath, "-ar", "48000", "-ac", "2", wavPath]);
    segmentPaths.push(wavPath);
  }

  const concatPath = path.join(audioDir, "concat.txt");
  await import("node:fs/promises").then(({ writeFile }) =>
    writeFile(concatPath, segmentPaths.map((item) => `file '${item.replaceAll("'", "'\\''")}'`).join("\n"), "utf8")
  );

  const audioPath = path.join(jobDir, "voiceover.m4a");
  await execFileAsync("ffmpeg", [
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    concatPath,
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    audioPath,
  ]);

  return {
    audioPath,
      provider: {
      ...provider,
      voicePreset: provider.preset,
      narrationLanguage: narrationLanguageLabel(provider),
    },
    warning: null,
    duration: await probeAudioDuration(audioPath),
  };
}

async function renderAliyunVoiceover({ jobDir, storyboard, provider, env, fetchImpl = fetch }) {
  const audioDir = path.join(jobDir, "audio");
  await mkdir(audioDir, { recursive: true });

  const segmentPaths = [];
  for (const scene of storyboard.scenes) {
    const text = scene.narration;
    const audioUrl = await requestAliyunTts({
        text,
        provider,
      env,
      fetchImpl,
    });
    const segmentPath = path.join(audioDir, `${scene.id}-aliyun.wav`);
    await downloadToFile(fetchImpl, audioUrl, segmentPath);
    segmentPaths.push(segmentPath);
  }

  const concatPath = path.join(audioDir, "concat-aliyun.txt");
  await import("node:fs/promises").then(({ writeFile }) =>
    writeFile(concatPath, segmentPaths.map((item) => `file '${item.replaceAll("'", "'\\''")}'`).join("\n"), "utf8")
  );

  const audioPath = path.join(jobDir, "voiceover.m4a");
  await execFileAsync("ffmpeg", [
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    concatPath,
    "-af",
    "loudnorm=I=-16:TP=-1.5:LRA=11",
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    audioPath,
  ]);

  return {
    audioPath,
      provider: {
      ...provider,
      voicePreset: provider.preset,
      narrationLanguage: narrationLanguageLabel(provider),
    },
    warning: null,
    duration: await probeAudioDuration(audioPath),
  };
}

async function requestAliyunTts({ text, provider, env, fetchImpl }) {
  const response = await fetchImpl("https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.DASHSCOPE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: provider.model,
      input: {
        text,
        voice: provider.voice,
        language_type: provider.languageType || "Chinese",
        instruction: provider.instruction,
        speed: provider.speed,
        pitch: provider.pitch,
        emotion: provider.emotion,
      },
    }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.message || payload.code || "Aliyun TTS request failed");
  const audioUrl = payload.output?.audio?.url || payload.output?.url || payload.output?.audio_url;
  if (!audioUrl) throw new Error("Aliyun TTS response did not include an audio URL");
  return audioUrl;
}

export const requestAliyunTtsForTest = requestAliyunTts;

export async function probeAudioDuration(audioPath) {
  if (!audioPath) return 0;
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      audioPath,
    ]);
    const duration = Number.parseFloat(stdout);
    return Number.isFinite(duration) ? duration : 0;
  } catch {
    return 0;
  }
}

export function expandStoryboardForAudio(storyboard, audioDuration) {
  const currentDuration = Number(storyboard.duration || 0);
  const target = Number(audioDuration || 0);
  if (!Number.isFinite(target) || target <= 0 || target <= currentDuration) return storyboard;

  const nextDuration = Number((target + 0.4).toFixed(2));
  const ratio = nextDuration / currentDuration;
  let elapsed = 0;
  return {
    ...storyboard,
    duration: nextDuration,
    scenes: storyboard.scenes.map((scene, sceneIndex) => {
      const duration = sceneIndex === storyboard.scenes.length - 1
        ? Number((nextDuration - elapsed).toFixed(2))
        : Number((Number(scene.duration || 0) * ratio).toFixed(2));
      const start = Number(elapsed.toFixed(2));
      elapsed += duration;
      return {
        ...scene,
        start,
        duration,
        shots: scaleShots(scene.shots || [], duration),
      };
    }),
  };
}

function scaleShots(shots, sceneDuration) {
  if (!shots.length) return shots;
  const total = shots.reduce((sum, shot) => sum + Number(shot.duration || 0), 0) || sceneDuration;
  let elapsed = 0;
  return shots.map((shot, index) => {
    const duration = index === shots.length - 1
      ? Number((sceneDuration - elapsed).toFixed(2))
      : Number((Number(shot.duration || 0) * (sceneDuration / total)).toFixed(2));
    const start = Number(elapsed.toFixed(2));
    elapsed += duration;
    return { ...shot, start, duration };
  });
}

async function downloadToFile(fetchImpl, url, filePath) {
  const response = await fetchImpl(url);
  if (!response.ok || !response.body) throw new Error(`Failed to download TTS audio: ${url}`);
  await pipeline(response.body, createWriteStream(filePath));
}
