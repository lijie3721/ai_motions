import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadLocalEnv, parseEnv } from "../src/config.js";

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
