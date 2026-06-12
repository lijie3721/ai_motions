import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { createDocumentAsset } from "./models.js";

const execFileAsync = promisify(execFile);

export async function processDocument({ id, originalName, mimeType, filePath, jobDir }) {
  const extension = path.extname(originalName).toLowerCase();
  const warnings = [];
  let slides = [];

  if (extension === ".pptx") {
    slides = await extractPptxSlides(filePath, warnings);
  } else if (extension === ".pdf") {
    slides = await extractPdfFallback(originalName, warnings);
  } else {
    warnings.push("Unsupported file type. Generated a placeholder scene.");
    slides = [createFallbackSlide(1, originalName, "Upload a PPTX or PDF to generate a video plan.")];
  }

  if (slides.length === 0) {
    warnings.push("No readable slide text was found. Generated a placeholder scene.");
    slides = [createFallbackSlide(1, originalName, "No readable text found in this document.")];
  }

  const slideDir = path.join(jobDir, "slides");
  await mkdir(slideDir, { recursive: true });
  const slidesWithImages = [];

  for (const slide of slides) {
    const svgPath = path.join(slideDir, `slide-${slide.index}.svg`);
    await writeFile(svgPath, renderSlideSvg(slide), "utf8");
    slidesWithImages.push({ ...slide, imagePath: svgPath });
  }

  return createDocumentAsset({
    id,
    originalName,
    mimeType,
    filePath,
    slides: slidesWithImages,
    warnings,
  });
}

async function extractPptxSlides(filePath, warnings) {
  try {
    const { stdout } = await execFileAsync("unzip", ["-Z1", filePath], { maxBuffer: 1024 * 1024 * 4 });
    const slideFiles = stdout
      .split("\n")
      .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
      .sort(compareSlideNames);

    const slides = [];
    for (const slideFile of slideFiles) {
      const index = Number(slideFile.match(/slide(\d+)\.xml$/)?.[1] ?? slides.length + 1);
      const { stdout: xml } = await execFileAsync("unzip", ["-p", filePath, slideFile], {
        maxBuffer: 1024 * 1024 * 8,
      });
      const texts = extractTextRuns(xml);
      slides.push(createSlide(index, texts));
    }

    return slides;
  } catch (error) {
    warnings.push(`PPTX text extraction failed: ${error.message}`);
    return [];
  }
}

async function extractPdfFallback(originalName, warnings) {
  warnings.push("PDF parsing is a planned adapter. This MVP creates one scene from the uploaded PDF name.");
  return [createFallbackSlide(1, originalName, "PDF support is wired as an adapter and ready for a real parser.")];
}

function createSlide(index, texts) {
  const cleaned = texts.map((text) => text.trim()).filter(Boolean);
  const title = cleaned[0] || `Slide ${index}`;
  const body = cleaned.slice(1).join(" ");

  return {
    index,
    title,
    body,
    text: cleaned.join("\n"),
  };
}

function createFallbackSlide(index, title, body) {
  return {
    index,
    title: title || `Slide ${index}`,
    body,
    text: `${title}\n${body}`,
  };
}

function extractTextRuns(xml) {
  const runs = [];
  const matches = xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g);
  for (const match of matches) {
    runs.push(decodeXml(match[1]));
  }
  return runs;
}

function decodeXml(value) {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'");
}

function compareSlideNames(a, b) {
  const aIndex = Number(a.match(/slide(\d+)\.xml$/)?.[1] ?? 0);
  const bIndex = Number(b.match(/slide(\d+)\.xml$/)?.[1] ?? 0);
  return aIndex - bIndex;
}

function renderSlideSvg(slide) {
  const title = escapeXml(slide.title).slice(0, 120);
  const bodyLines = wrapText(slide.body || slide.text || "", 70).slice(0, 8);
  const lines = bodyLines
    .map((line, index) => `<text x="112" y="${330 + index * 48}" class="body">${escapeXml(line)}</text>`)
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900" viewBox="0 0 1600 900">
  <defs>
    <linearGradient id="paper" x1="0" x2="1" y1="0" y2="1">
      <stop offset="0" stop-color="#f7f4ed"/>
      <stop offset="1" stop-color="#e8eef0"/>
    </linearGradient>
    <style>
      .kicker { font: 600 28px Georgia, serif; fill: #35615b; letter-spacing: 2px; }
      .title { font: 700 76px Georgia, serif; fill: #17211f; }
      .body { font: 400 34px Helvetica, Arial, sans-serif; fill: #2e3a37; }
      .folio { font: 700 24px Helvetica, Arial, sans-serif; fill: #6b5f4b; }
    </style>
  </defs>
  <rect width="1600" height="900" fill="url(#paper)"/>
  <rect x="64" y="64" width="1472" height="772" rx="20" fill="none" stroke="#17211f" stroke-width="3"/>
  <text x="112" y="148" class="kicker">SLIDE ${slide.index}</text>
  <text x="112" y="248" class="title">${title}</text>
  ${lines}
  <circle cx="1452" cy="148" r="44" fill="#d87b4a"/>
  <text x="1437" y="157" class="folio">${slide.index}</text>
</svg>`;
}

function wrapText(text, maxLength) {
  const words = String(text).replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const lines = [];
  let current = "";

  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > maxLength && current) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }

  if (current) lines.push(current);
  return lines.length ? lines : ["No body text detected on this slide."];
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

