import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadLocalEnv, parseEnv, readPublicSettings, saveLocalSettings } from "../src/config.js";

test("parseEnv reads key values, comments, blank lines, and quoted values", () => {
  const values = parseEnv(`
    # Local API keys
    DASHSCOPE_API_KEY=abc123

    ALIYUN_TTS_VOICE="Cherry"
    ALIYUN_TTS_INSTRUCTION='标准普通话'
  `);

  assert.deepEqual(values, {
    DASHSCOPE_API_KEY: "abc123",
    ALIYUN_TTS_VOICE: "Cherry",
    ALIYUN_TTS_INSTRUCTION: "标准普通话",
  });
});

test("loadLocalEnv loads .env values without overriding existing environment", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ai-motions-env-"));
  const filePath = path.join(dir, ".env");
  await writeFile(filePath, "DASHSCOPE_API_KEY=from-file\nPEXELS_API_KEY=pexels\n", "utf8");

  const env = { DASHSCOPE_API_KEY: "from-shell" };
  const result = await loadLocalEnv({ filePath, env });

  assert.equal(result.loaded, true);
  assert.equal(env.DASHSCOPE_API_KEY, "from-shell");
  assert.equal(env.PEXELS_API_KEY, "pexels");
});

test("parseEnv skips template placeholder values", () => {
  const values = parseEnv(`
    DASHSCOPE_API_KEY=your_dashscope_api_key
    PEXELS_API_KEY=你的PexelsKey
    PIXABAY_API_KEY=real-key
  `);

  assert.deepEqual(values, {
    PIXABAY_API_KEY: "real-key",
  });
});

test("loadLocalEnv ignores missing .env files", async () => {
  const env = {};
  const result = await loadLocalEnv({ filePath: path.join(os.tmpdir(), "missing-ai-motions.env"), env });

  assert.deepEqual(result, { loaded: false, values: {} });
  assert.deepEqual(env, {});
});

test("saveLocalSettings creates .env and returns only masked values", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ai-motions-settings-"));
  const filePath = path.join(dir, ".env");
  const env = {};

  const settings = await saveLocalSettings({
    filePath,
    env,
    updates: {
      DASHSCOPE_API_KEY: "dashscope-secret-1234",
      PEXELS_API_KEY: "pexels-secret-5678",
      PIXABAY_API_KEY: "pixabay-secret-9999",
      ALIYUN_TTS_MODEL: "qwen3-tts-instruct-flash",
    },
  });

  const content = await readFile(filePath, "utf8");
  assert.match(content, /DASHSCOPE_API_KEY=dashscope-secret-1234/);
  assert.equal(env.DASHSCOPE_API_KEY, "dashscope-secret-1234");
  assert.equal(settings.providers.dashscope.configured, true);
  assert.equal(settings.providers.dashscope.masked, "****1234");
  assert.equal(JSON.stringify(settings).includes("dashscope-secret-1234"), false);
});

test("saveLocalSettings preserves existing fields and ignores blank updates", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ai-motions-settings-"));
  const filePath = path.join(dir, ".env");
  await writeFile(filePath, "PORT=4173\nDASHSCOPE_API_KEY=old-secret\nPEXELS_API_KEY=old-pexels\n", "utf8");
  const env = {};

  await saveLocalSettings({
    filePath,
    env,
    updates: {
      DASHSCOPE_API_KEY: "",
      PIXABAY_API_KEY: "new-pixabay",
    },
  });

  const content = await readFile(filePath, "utf8");
  assert.match(content, /PORT=4173/);
  assert.match(content, /DASHSCOPE_API_KEY=old-secret/);
  assert.match(content, /PEXELS_API_KEY=old-pexels/);
  assert.match(content, /PIXABAY_API_KEY=new-pixabay/);
});

test("saveLocalSettings clears selected managed keys only", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ai-motions-settings-"));
  const filePath = path.join(dir, ".env");
  await writeFile(filePath, "PORT=4173\nDASHSCOPE_API_KEY=old-secret\nPEXELS_API_KEY=old-pexels\n", "utf8");
  const env = { DASHSCOPE_API_KEY: "old-secret", PEXELS_API_KEY: "old-pexels" };

  const settings = await saveLocalSettings({
    filePath,
    env,
    clear: ["PEXELS_API_KEY"],
  });

  const content = await readFile(filePath, "utf8");
  assert.match(content, /PORT=4173/);
  assert.match(content, /DASHSCOPE_API_KEY=old-secret/);
  assert.doesNotMatch(content, /PEXELS_API_KEY=/);
  assert.equal(env.PEXELS_API_KEY, undefined);
  assert.equal(settings.providers.pexels.configured, false);
});

test("readPublicSettings reports configured providers without exposing secrets", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ai-motions-settings-"));
  const filePath = path.join(dir, ".env");
  await writeFile(filePath, "DASHSCOPE_API_KEY=secret-value-0001\n", "utf8");

  const settings = await readPublicSettings({ filePath, env: {} });

  assert.equal(settings.providers.dashscope.configured, true);
  assert.equal(settings.providers.dashscope.masked, "****0001");
  assert.equal(settings.providers.pexels.configured, false);
  assert.equal(settings.envPath, ".env");
  assert.equal(JSON.stringify(settings).includes("secret-value-0001"), false);
});
