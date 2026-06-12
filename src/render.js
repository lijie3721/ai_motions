import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

const execFileAsync = promisify(execFile);

export async function writeComposition({ jobDir, storyboard }) {
  const compositionPath = path.join(jobDir, "composition.html");
  await writeFile(compositionPath, renderCompositionHtml(storyboard, jobDir), "utf8");
  return compositionPath;
}

export async function renderMp4({ jobDir, storyboard, compositionPath, audioPath = null }) {
  try {
    const outputPath = await renderCompositionMp4({ jobDir, storyboard, compositionPath, audioPath });
    return {
      outputPath,
      renderer: {
        type: "browser-capture",
        fidelity: "motion-preview",
        note: "Video rendered from the HTML motion composition.",
      },
    };
  } catch (error) {
    const outputPath = await renderPlaceholderMp4({ jobDir, storyboard });
    return {
      outputPath,
      renderer: {
        type: "ffmpeg-placeholder",
        fidelity: "low",
        note: `Browser renderer failed, fallback video was generated: ${error.message}`,
      },
    };
  }
}

async function renderCompositionMp4({ jobDir, storyboard, compositionPath, audioPath }) {
  const frameDir = path.join(jobDir, "frames");
  await mkdir(frameDir, { recursive: true });

  const fps = Math.min(12, storyboard.fps || 12);
  const totalFrames = Math.max(1, Math.ceil(storyboard.duration * fps));
  const browser = await chromium.launch({ headless: true });

  try {
    const page = await browser.newPage({
      viewport: { width: storyboard.width, height: storyboard.height },
      deviceScaleFactor: 1,
    });

    await page.goto(`${pathToFileURL(compositionPath).href}?capture=1`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => typeof window.__aiMotionsSeek === "function", null, { timeout: 5000 });

    for (let frame = 0; frame < totalFrames; frame += 1) {
      const time = Math.min(storyboard.duration - 0.001, frame / fps);
      await page.evaluate((seconds) => window.__aiMotionsSeek(seconds), time);
      await page.screenshot({
        path: path.join(frameDir, `frame-${String(frame + 1).padStart(5, "0")}.png`),
        type: "png",
      });
    }
  } finally {
    await browser.close();
  }

  const silentOutputPath = path.join(jobDir, audioPath ? "output-silent.mp4" : "output.mp4");
  await execFileAsync("ffmpeg", [
    "-y",
    "-framerate",
    String(fps),
    "-i",
    path.join(frameDir, "frame-%05d.png"),
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-r",
    "30",
    "-movflags",
    "+faststart",
    silentOutputPath,
  ]);

  if (!audioPath) return silentOutputPath;

  const outputPath = path.join(jobDir, "output.mp4");
  await execFileAsync("ffmpeg", [
    "-y",
    "-i",
    silentOutputPath,
    "-i",
    audioPath,
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-movflags",
    "+faststart",
    outputPath,
  ]);

  return outputPath;
}

async function renderPlaceholderMp4({ jobDir, storyboard }) {
  const outDir = path.join(jobDir, "render");
  await mkdir(outDir, { recursive: true });

  const segmentPaths = [];
  for (const scene of storyboard.scenes) {
    const segmentPath = path.join(outDir, `${scene.id}.mp4`);
    await renderSceneSegment({ scene, segmentPath, width: storyboard.width, height: storyboard.height });
    segmentPaths.push(segmentPath);
  }

  const concatFile = path.join(outDir, "concat.txt");
  await writeFile(concatFile, segmentPaths.map((item) => `file '${item.replaceAll("'", "'\\''")}'`).join("\n"), "utf8");

  const outputPath = path.join(jobDir, "output.mp4");
  await execFileAsync("ffmpeg", [
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    concatFile,
    "-c",
    "copy",
    outputPath,
  ]);

  return outputPath;
}

async function renderSceneSegment({ scene, segmentPath, width, height }) {
  const bg = scene.slideIndex % 2 === 0 ? "0xF0E8DA" : "0xE9F0EE";
  const accent = scene.slideIndex % 2 === 0 ? "0x35615B" : "0xD87B4A";

  await execFileAsync("ffmpeg", [
    "-y",
    "-f",
    "lavfi",
    "-i",
    `color=c=${bg}:s=${width}x${height}:d=${scene.duration}:r=30`,
    "-vf",
    [
      "drawbox=x=80:y=72:w=1760:h=936:color=0x17211F@1:t=4",
      `drawbox=x=140:y=140:w=420:h=18:color=${accent}@1:t=fill`,
      "drawbox=x=140:y=230:w=1180:h=86:color=0x17211F@1:t=fill",
      "drawbox=x=140:y=360:w=940:h=34:color=0x2E3A37@0.76:t=fill",
      "drawbox=x=140:y=430:w=720:h=34:color=0x2E3A37@0.58:t=fill",
      `drawbox=x=140:y=560:w=560:h=92:color=${accent}@1:t=fill`,
      "drawbox=x=1460:y=132:w=88:h=88:color=0x17211F@1:t=fill",
      "format=yuv420p",
    ].join(","),
    "-t",
    String(scene.duration),
    "-c:v",
    "libx264",
    "-movflags",
    "+faststart",
    segmentPath,
  ]);
}

function renderCompositionHtml(storyboard, jobDir) {
  const sceneMarkup = storyboard.scenes
    .map((scene, index) => {
      const start = storyboard.scenes.slice(0, index).reduce((sum, item) => sum + item.duration, 0);
      const template = sceneTemplate(index, storyboard.scenes.length);
      const mediaMarkup = scene.shots?.length
        ? renderShotMarkup(scene, start, jobDir, template)
        : renderSingleSceneMedia(scene, jobDir);
      return `<section id="${scene.id}" class="scene ${template}" data-start="${start}" data-duration="${scene.duration}" data-track-index="1">
        <div class="kinetic-layer">
          <span></span><span></span><span></span>
        </div>
        <div class="slide-frame ${scene.motion || ""}">
          ${mediaMarkup}
        </div>
        <div class="overlay">
          <div class="scene-eyebrow">0${scene.slideIndex} / ${escapeHtml(templateLabel(template))}</div>
          <h2>${escapeHtml(scene.title)}</h2>
          <p>${escapeHtml(scene.narration)}</p>
          <div class="highlight">${escapeHtml(scene.highlights[0] || "Key message")}</div>
        </div>
      </section>`;
    })
    .join("\n");

  const timelineTweens = storyboard.scenes
    .map((scene, index) => {
      const start = storyboard.scenes.slice(0, index).reduce((sum, item) => sum + item.duration, 0);
      const enter = start + 0.2;
      const transition = Math.max(start, start + scene.duration - 0.65);
      return `
tl.from("#${scene.id} .slide-frame", { scale: 1.18, opacity: 0, rotate: ${index % 2 ? -1.2 : 1.2}, duration: 0.42, ease: "expo.out" }, ${enter});
tl.from("#${scene.id} .kinetic-layer span", { x: ${index % 2 ? 260 : -260}, opacity: 0, duration: 0.44, ease: "power4.out", stagger: 0.055 }, ${enter + 0.02});
tl.fromTo("#${scene.id} .shot-media", { scale: 1.22, xPercent: ${index % 2 ? 3 : -3} }, { scale: 1.04, xPercent: 0, duration: ${Math.max(1, scene.duration - 0.15)}, ease: "none", stagger: 0.08 }, ${enter});
tl.from("#${scene.id} .shot-caption", { y: 52, x: -22, opacity: 0, duration: 0.22, ease: "power4.out", stagger: 0.04 }, ${enter + 0.08});
tl.from("#${scene.id} .scene-eyebrow", { x: -48, opacity: 0, duration: 0.34, ease: "power3.out" }, ${enter + 0.1});
tl.from("#${scene.id} .overlay h2", { y: 64, opacity: 0, skewY: 2, duration: 0.48, ease: "expo.out" }, ${enter + 0.16});
tl.from("#${scene.id} .overlay p", { y: 34, opacity: 0, duration: 0.42, ease: "power2.out" }, ${enter + 0.28});
tl.from("#${scene.id} .highlight", { scale: 0.78, x: -34, opacity: 0, duration: 0.36, ease: "back.out(1.8)" }, ${enter + 0.38});
${index === storyboard.scenes.length - 1 ? `tl.to("#${scene.id}", { opacity: 0, duration: 0.45, ease: "power2.in" }, ${transition});` : ""}`;
    })
    .join("\n");

  return `<!doctype html>
<html data-composition-variables='[]' data-capture-mode="auto">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(storyboard.title)}</title>
  <style>
    html, body {
      margin: 0;
      width: 100%;
      height: 100%;
      background: #17211f;
      color: #f7f4ed;
      font-family: Avenir Next, Helvetica, Arial, sans-serif;
    }
    [data-composition-id="ppt-video"] {
      position: relative;
      width: 1920px;
      height: 1080px;
      overflow: hidden;
      background:
        linear-gradient(135deg, #101816 0%, #192420 48%, #0d100f 100%);
    }
    .scene {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      box-sizing: border-box;
      opacity: 0;
      pointer-events: none;
      overflow: hidden;
    }
    .scene.is-active {
      opacity: 1;
      pointer-events: auto;
    }
    .slide-frame {
      position: absolute;
      inset: 0;
      background: #111817;
      overflow: hidden;
    }
    .template-proof .slide-frame {
      left: 84px;
      right: 730px;
      top: 128px;
      bottom: 128px;
      border: 2px solid rgba(255, 247, 234, 0.14);
      box-shadow: 0 42px 120px rgba(0, 0, 0, 0.42);
    }
    .template-scene .slide-frame {
      right: 0;
      width: 68%;
      clip-path: polygon(13% 0, 100% 0, 100% 100%, 0 100%);
    }
    .template-cta .slide-frame {
      inset: 0;
      opacity: 0.62;
    }
    .photo-visual {
      position: relative;
      width: 100%;
      height: 100%;
      overflow: hidden;
      background: #17211f;
    }
    .photo-visual img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
      filter: saturate(1.1) contrast(1.04);
      transform: scale(1.03);
    }
    .photo-scrim {
      position: absolute;
      inset: 0;
      background:
        linear-gradient(90deg, rgba(23, 33, 31, 0.18), rgba(23, 33, 31, 0.02) 45%, rgba(23, 33, 31, 0.26)),
        linear-gradient(0deg, rgba(23, 33, 31, 0.38), transparent 44%);
    }
    .photo-visual span {
      position: absolute;
      left: 48px;
      bottom: 42px;
      max-width: calc(100% - 96px);
      color: #fff7ea;
      background: #e4572e;
      padding: 14px 18px;
      font-size: 30px;
      font-weight: 900;
      line-height: 1.18;
      overflow-wrap: anywhere;
    }
    .shot-stage {
      position: relative;
      width: 100%;
      height: 100%;
      overflow: hidden;
      background: #17211f;
    }
    .shot {
      position: absolute;
      inset: 0;
      opacity: 0;
      overflow: hidden;
    }
    .shot.is-active {
      opacity: 1;
    }
    .shot-media {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
      filter: saturate(1.22) contrast(1.08) brightness(0.86);
      transform: scale(1.04);
    }
    .shot.whip_pan .shot-media {
      transform: scale(1.12) translateX(-2%);
    }
    .shot.snap_zoom .shot-media {
      transform: scale(1.18);
    }
    .shot.handheld_crop .shot-media {
      transform: scale(1.1) rotate(-0.35deg);
    }
    .shot-scrim {
      position: absolute;
      inset: 0;
      background:
        linear-gradient(90deg, rgba(13, 16, 15, 0.68), rgba(13, 16, 15, 0.08) 42%, rgba(13, 16, 15, 0.42)),
        radial-gradient(circle at 78% 18%, rgba(216, 123, 74, 0.26), transparent 24%),
        linear-gradient(0deg, rgba(13, 16, 15, 0.72), rgba(13, 16, 15, 0.08) 55%);
    }
    .shot.flash_cut::before {
      content: "";
      position: absolute;
      inset: 0;
      z-index: 3;
      background: rgba(255, 247, 234, 0.56);
      opacity: 0;
      animation: flash 0.18s ease-out both;
    }
    .shot.whip_wipe::after {
      content: "";
      position: absolute;
      inset: 0;
      z-index: 3;
      background: linear-gradient(90deg, transparent, rgba(255, 247, 234, 0.42), transparent);
      transform: translateX(-100%);
      animation: wipe 0.28s ease-out both;
    }
    .shot-caption {
      position: absolute;
      left: 54px;
      bottom: 48px;
      z-index: 4;
      color: #17211f;
      background: #d87b4a;
      padding: 16px 20px;
      font-weight: 900;
      font-size: 34px;
      line-height: 1.1;
      max-width: calc(100% - 108px);
      overflow-wrap: anywhere;
      box-shadow: 10px 10px 0 rgba(0, 0, 0, 0.28);
    }
    @keyframes flash {
      0% { opacity: 0.78; }
      100% { opacity: 0; }
    }
    @keyframes wipe {
      0% { transform: translateX(-100%); }
      100% { transform: translateX(100%); }
    }
    .generated-visual {
      width: 100%;
      height: 100%;
      padding: 74px;
      display: flex;
      flex-direction: column;
      justify-content: flex-end;
      gap: 28px;
      box-sizing: border-box;
      color: #17211f;
      background:
        radial-gradient(circle at 78% 20%, rgba(228, 87, 46, 0.38), transparent 18%),
        linear-gradient(135deg, #fff7ea 0%, #e8eee8 100%);
    }
    .generated-visual span {
      width: max-content;
      max-width: 100%;
      color: #fff7ea;
      background: #e4572e;
      padding: 14px 18px;
      font-size: 34px;
      font-weight: 900;
    }
    .generated-visual strong {
      max-width: 900px;
      font: 800 82px Georgia, serif;
      line-height: 0.95;
    }
    .generated-visual em {
      max-width: 860px;
      color: #526b4f;
      font-style: normal;
      font-size: 28px;
      line-height: 1.35;
    }
    .kinetic-layer {
      position: absolute;
      inset: 0;
      z-index: 6;
      pointer-events: none;
      mix-blend-mode: screen;
    }
    .kinetic-layer span {
      position: absolute;
      height: 5px;
      width: 620px;
      background: linear-gradient(90deg, transparent, rgba(255, 247, 234, 0.9), transparent);
      transform: rotate(-12deg);
      opacity: 0.42;
    }
    .kinetic-layer span:nth-child(1) { top: 160px; left: 80px; }
    .kinetic-layer span:nth-child(2) { top: 520px; right: 120px; width: 780px; }
    .kinetic-layer span:nth-child(3) { bottom: 168px; left: 420px; width: 520px; }
    .overlay {
      position: absolute;
      z-index: 8;
      display: flex;
      flex-direction: column;
      justify-content: center;
      gap: 24px;
      min-width: 0;
    }
    .template-opener .overlay {
      left: 82px;
      right: 92px;
      bottom: 86px;
      justify-content: flex-end;
    }
    .template-proof .overlay {
      top: 154px;
      right: 86px;
      width: 610px;
    }
    .template-scene .overlay {
      left: 88px;
      top: 138px;
      width: 680px;
    }
    .template-cta .overlay {
      inset: 92px 120px;
      align-items: center;
      text-align: center;
    }
    .scene-eyebrow {
      width: max-content;
      color: #d87b4a;
      font: 900 30px Avenir Next, Helvetica, Arial, sans-serif;
      letter-spacing: 0;
      text-transform: uppercase;
      border-bottom: 4px solid #d87b4a;
      padding-bottom: 8px;
    }
    h2 {
      margin: 0;
      font: 800 90px Georgia, serif;
      line-height: 0.92;
      color: #f7f4ed;
      overflow-wrap: anywhere;
      text-shadow: 0 18px 42px rgba(0, 0, 0, 0.42);
    }
    .template-opener h2 {
      max-width: 1220px;
      font-size: 126px;
    }
    .template-cta h2 {
      max-width: 1420px;
      font-size: 132px;
    }
    p {
      margin: 0;
      color: #d9ded7;
      max-width: 820px;
      font-size: 34px;
      line-height: 1.42;
      font-weight: 700;
    }
    .highlight {
      width: fit-content;
      max-width: 100%;
      color: #17211f;
      background: #d87b4a;
      padding: 20px 28px;
      font-weight: 900;
      font-size: 34px;
      line-height: 1.2;
      overflow-wrap: anywhere;
      box-shadow: 12px 12px 0 rgba(0, 0, 0, 0.28);
    }
    .template-cta .highlight {
      font-size: 42px;
    }
  </style>
</head>
<body>
  <main data-composition-id="ppt-video" data-start="0" data-duration="${storyboard.duration}" data-width="1920" data-height="1080">
    ${sceneMarkup}
  </main>
  <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
  <script>
    window.__timelines = window.__timelines || {};
    const tl = gsap.timeline({ paused: true });
    ${timelineTweens}
    window.__timelines["ppt-video"] = tl;
    const scenes = Array.from(document.querySelectorAll(".scene"));
    const shots = Array.from(document.querySelectorAll(".shot"));
    function syncScenes(time) {
      for (const scene of scenes) {
        const start = Number(scene.dataset.start || 0);
        const duration = Number(scene.dataset.duration || 0);
        scene.classList.toggle("is-active", time >= start && time < start + duration);
      }
      for (const shot of shots) {
        const start = Number(shot.dataset.start || 0);
        const duration = Number(shot.dataset.duration || 0);
        const active = time >= start && time < start + duration;
        shot.classList.toggle("is-active", active);
        const video = shot.querySelector("video");
        if (video && active && Math.abs(video.currentTime - Math.max(0, time - start)) > 0.2) {
          video.currentTime = Math.max(0, time - start);
        }
      }
    }
    syncScenes(0);
    window.__aiMotionsSeek = function(seconds) {
      const time = Math.max(0, Math.min(${storyboard.duration}, Number(seconds) || 0));
      syncScenes(time);
      tl.seek(time, false);
    };
    const isCapture = new URLSearchParams(window.location.search).get("capture") === "1";
    document.documentElement.dataset.captureMode = isCapture ? "capture" : "preview";
    if (!window.__hyperframes && !isCapture) {
      const duration = ${storyboard.duration};
      const startedAt = performance.now();
      function tick(now) {
        const time = ((now - startedAt) / 1000) % duration;
        window.__aiMotionsSeek(time);
        requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
    }
  </script>
</body>
</html>`;
}

function renderShotMarkup(scene, sceneStart, jobDir, template) {
  return `<div class="shot-stage ${template}-stage">
    ${scene.shots.map((shot) => {
      const media = shot.media || scene.media;
      const mediaPath = media?.filePath;
      const source = mediaPath ? relativeAsset(mediaPath, jobDir) : "";
      const mediaElement = media?.type === "video"
        ? `<video class="shot-media" src="${source}" muted playsinline preload="auto"></video>`
        : mediaPath
          ? `<img class="shot-media" src="${source}" alt="${escapeHtml(media.title || shot.caption || scene.title)}" />`
          : `<div class="shot-media generated-visual"><strong>${escapeHtml(scene.title)}</strong></div>`;
      return `<div class="shot ${shot.motion || "push_in"} ${shot.transition || "cut"}" data-start="${sceneStart + shot.start}" data-duration="${shot.duration}">
        ${mediaElement}
        <div class="shot-scrim"></div>
        <div class="shot-caption">${escapeHtml(shot.caption || scene.highlights?.[0] || "")}</div>
      </div>`;
    }).join("\n")}
  </div>`;
}

function sceneTemplate(index, total) {
  if (index === 0) return "template-opener";
  if (index === total - 1) return "template-cta";
  return index % 2 ? "template-proof" : "template-scene";
}

function templateLabel(template) {
  return {
    "template-opener": "强开场",
    "template-proof": "卖点快切",
    "template-scene": "场景代入",
    "template-cta": "行动收束",
  }[template] || "动态分镜";
}

function renderSingleSceneMedia(scene, jobDir) {
  const imagePath = scene.slideImage || scene.media?.filePath;
  return imagePath
    ? `<div class="photo-visual">
        <img src="${relativeAsset(imagePath, jobDir)}" alt="${escapeHtml(scene.media?.title || scene.title)}" />
        <div class="photo-scrim"></div>
        <span>${escapeHtml(scene.media?.title || scene.highlights[0] || scene.title)}</span>
      </div>`
    : `<div class="generated-visual">
        <span>${escapeHtml(scene.highlights[0] || scene.title)}</span>
        <strong>${escapeHtml(scene.title)}</strong>
        <em>${escapeHtml(scene.visualPrompt || "")}</em>
      </div>`;
}

function relativeAsset(assetPath, jobDir) {
  return path.relative(jobDir, assetPath).replaceAll(path.sep, "/");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
