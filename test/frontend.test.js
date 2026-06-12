import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("chat composer supports Enter send and Shift Enter newline without IME misfire", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");

  assert.match(html, /promptEl\.addEventListener\("keydown"/);
  assert.match(html, /event\.key === "Enter"/);
  assert.match(html, /!event\.shiftKey/);
  assert.match(html, /!event\.isComposing/);
  assert.match(html, /!state\.isSending/);
  assert.match(html, /composer\.requestSubmit\(\)/);
});

test("confirmation form lets users choose video language before generation", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");

  assert.match(html, /视频语言/);
  assert.match(html, /name="language"/);
  assert.match(html, /option\("en"/);
  assert.match(html, /option\("ja"/);
  assert.match(html, /option\("ko"/);
  assert.match(html, /syncVoicePresetForLanguage/);
});

test("confirmation reads selected settings before entering sending state", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const confirmPlan = html.match(/async function confirmPlan\(\) \{(?<body>[\s\S]*?)\n    async function confirmMaterialRefresh/);

  assert.ok(confirmPlan?.groups?.body);
  assert.ok(
    confirmPlan.groups.body.indexOf("const confirmation = readConfirmationForm();") <
      confirmPlan.groups.body.indexOf("setSending(\"正在准备分镜和素材\")"),
  );
});

test("rendered video uses a responsive player shell so controls are not clipped", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");

  assert.match(html, /rendered-video-shell/);
  assert.match(html, /class="rendered-video"/);
  assert.match(html, /width:\s*min\(100%, 860px, 72vh\)/);
  assert.doesNotMatch(html, /<video controls playsinline preload="metadata" src="\$\{render\.links\.mp4\}[^`]+style="/);
});

test("settings center gives beginners clear provider setup guidance", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");

  assert.match(html, /配置中心/);
  assert.match(html, /阿里 DashScope/);
  assert.match(html, /用于理解你的需求、生成脚本和配音/);
  assert.match(html, /Pexels 素材库/);
  assert.match(html, /主要用于搜索真实图片，也会补充视频素材/);
  assert.match(html, /Pixabay 视频素材库/);
  assert.match(html, /当 Pexels 素材不够时使用/);
  assert.match(html, /去配置/);
});

test("settings center persists keys through API instead of localStorage", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");

  assert.match(html, /\/api\/settings/);
  assert.match(html, /saveSettings/);
  assert.doesNotMatch(html, /localStorage\.setItem\([^)]*(DASHSCOPE|PEXELS|PIXABAY|OPENAI|ApiKey|apiKey)/);
});

test("settings center hides key inputs and explains stale server errors", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");

  assert.match(html, /name="dashscopeApiKey"[^>]+type="password"/);
  assert.match(html, /name="pexelsApiKey"[^>]+type="password"/);
  assert.match(html, /name="pixabayApiKey"[^>]+type="password"/);
  assert.match(html, /配置接口不可用。请重启本地服务后再保存配置。/);
});
