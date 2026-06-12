import { loadLocalEnv } from "./config.js";
import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { processDocument } from "./document.js";
import { generateStoryboard } from "./storyboard.js";
import { writeComposition, renderMp4 } from "./render.js";
import { createRenderJob } from "./models.js";
import {
  applyScenePatch,
  applyShotPatch,
  applyShotReorder,
  applyUserRevisionAsync,
  applyUserRevision,
  attachDocumentContext,
  attachUserMediaAsset,
  confirmMaterialRefresh,
  confirmProjectPlan,
  createProjectFromPromptAsync,
} from "./planner.js";
import { expandStoryboardForAudio, renderVoiceover } from "./tts.js";
import { prepareStoryboardShots } from "./stockMedia.js";
import { ProjectStore } from "./projectStore.js";

await loadLocalEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const publicDir = path.join(rootDir, "public");
const uploadDir = path.join(rootDir, "uploads");
const jobsDir = path.join(rootDir, "jobs");
const dataDir = path.join(rootDir, "data");
const jobs = new Map();
const projects = new Map();
const projectStore = new ProjectStore(path.join(dataDir, "ai-motions.sqlite"));

const port = Number(process.env.PORT || 4173);
const maxUploadBytes = Number(process.env.MAX_UPLOAD_BYTES || 50 * 1024 * 1024);

await mkdir(uploadDir, { recursive: true });
await mkdir(jobsDir, { recursive: true });
await mkdir(dataDir, { recursive: true });

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);

    if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/") {
      return serveFile(request, response, path.join(publicDir, "index.html"), "text/html; charset=utf-8");
    }

    if ((request.method === "GET" || request.method === "HEAD") && url.pathname.startsWith("/public/")) {
      const filePath = resolveSafeFilePath(publicDir, url.pathname.slice("/public/".length));
      if (!filePath) return sendJson(response, 403, { error: "Invalid path" });
      return serveFile(request, response, filePath, contentType(url.pathname));
    }

    if ((request.method === "GET" || request.method === "HEAD") && url.pathname.startsWith("/uploads/")) {
      const requested = url.pathname.slice("/uploads/".length);
      const filePath = resolveSafeFilePath(uploadDir, requested);
      if (!filePath) return sendJson(response, 403, { error: "Invalid path" });
      return serveFile(request, response, filePath, contentType(requested));
    }

    if (request.method === "POST" && url.pathname === "/api/jobs") {
      return createJob(request, response);
    }

    if (request.method === "POST" && url.pathname === "/api/projects") {
      return createProject(request, response);
    }

    if (request.method === "GET" && url.pathname === "/api/projects") {
      return sendJson(response, 200, { projects: projectStore.listProjects() });
    }

    if (request.method === "GET" && /^\/api\/projects\/[^/]+$/.test(url.pathname)) {
      const { id } = parseProjectRoute(url.pathname);
      const project = getProject(id);
      if (!project) return sendJson(response, 404, { error: "Project not found" });
      return sendJson(response, 200, toPublicProject(project));
    }

    if (request.method === "POST" && /\/api\/projects\/[^/]+\/save$/.test(url.pathname)) {
      const { id } = parseProjectRoute(url.pathname);
      const project = getProject(id);
      if (!project) return sendJson(response, 404, { error: "Project not found" });
      saveProject(project);
      return sendJson(response, 200, toPublicProject(project));
    }

    if (request.method === "POST" && /\/api\/projects\/[^/]+\/messages$/.test(url.pathname)) {
      const { id } = parseProjectRoute(url.pathname);
      return appendProjectMessage(id, request, response);
    }

    if (request.method === "POST" && /\/api\/projects\/[^/]+\/assets$/.test(url.pathname)) {
      const { id } = parseProjectRoute(url.pathname);
      return attachProjectAsset(id, request, response);
    }

    if (request.method === "PATCH" && /\/api\/projects\/[^/]+\/scenes\/[^/]+$/.test(url.pathname)) {
      const { id, sceneId } = parseProjectRoute(url.pathname);
      return updateProjectScene(id, sceneId, request, response);
    }

    if (request.method === "PATCH" && /\/api\/projects\/[^/]+\/scenes\/[^/]+\/shots\/[^/]+$/.test(url.pathname)) {
      const { id, sceneId, shotId } = parseProjectRoute(url.pathname);
      return updateProjectShot(id, sceneId, shotId, request, response);
    }

    if (request.method === "POST" && /\/api\/projects\/[^/]+\/scenes\/[^/]+\/shots\/reorder$/.test(url.pathname)) {
      const { id, sceneId } = parseProjectRoute(url.pathname);
      return reorderProjectShots(id, sceneId, request, response);
    }

    if (request.method === "POST" && /\/api\/projects\/[^/]+\/render$/.test(url.pathname)) {
      const { id } = parseProjectRoute(url.pathname);
      return renderProject(id, response);
    }

    if (request.method === "GET" && url.pathname.startsWith("/api/jobs/")) {
      const id = url.pathname.split("/").pop();
      const job = jobs.get(id);
      if (!job) return sendJson(response, 404, { error: "Job not found" });
      return sendJson(response, 200, toPublicJob(job));
    }

    if ((request.method === "GET" || request.method === "HEAD") && url.pathname.startsWith("/jobs/")) {
      const requested = url.pathname.slice("/jobs/".length);
      const filePath = resolveSafeFilePath(jobsDir, requested);
      if (!filePath) return sendJson(response, 403, { error: "Invalid path" });
      return serveFile(request, response, filePath, contentType(requested));
    }

    return sendJson(response, 404, { error: "Not found" });
  } catch (error) {
    console.error(error);
    const status = error.statusCode || 500;
    const message = status < 500 || process.env.NODE_ENV === "development"
      ? error.message
      : "Internal server error";
    return sendJson(response, status, { error: message });
  }
});

if (process.env.NODE_ENV !== "test") {
  server.listen(port, () => {
    console.log(`AI Motions running at http://localhost:${port}`);
  });
}

async function createJob(request, response) {
  const contentTypeHeader = request.headers["content-type"] || "";
  if (!contentTypeHeader.includes("multipart/form-data")) {
    return sendJson(response, 400, { error: "Expected multipart/form-data upload" });
  }

  const boundary = contentTypeHeader.match(/boundary=(.+)$/)?.[1];
  if (!boundary) return sendJson(response, 400, { error: "Missing multipart boundary" });

  const body = await readRequestBody(request);
  const upload = parseMultipartFile(body, boundary);
  if (!upload) return sendJson(response, 400, { error: "No file field found" });

  const id = randomUUID();
  const jobDir = path.join(jobsDir, id);
  await mkdir(jobDir, { recursive: true });
  const safeName = upload.filename.replace(/[^\w.\- ]+/g, "_") || "upload.pptx";
  const filePath = path.join(uploadDir, `${id}-${safeName}`);
  await writeFile(filePath, upload.content);

  const documentAsset = await processDocument({
    id,
    originalName: safeName,
    mimeType: upload.contentType,
    filePath,
    jobDir,
  });

  const storyboard = generateStoryboard(documentAsset);
  const storyboardPath = path.join(jobDir, "storyboard.json");
  await writeFile(storyboardPath, JSON.stringify(storyboard, null, 2), "utf8");
  const compositionPath = await writeComposition({ jobDir, storyboard });
  const job = createRenderJob({ id, documentAsset, storyboard, compositionPath });
  jobs.set(id, job);

  try {
    job.status = "rendering";
    job.updatedAt = new Date().toISOString();
    const voiceover = await renderVoiceover({ jobDir, storyboard });
    const renderResult = await renderMp4({ jobDir, storyboard, compositionPath, audioPath: voiceover.audioPath });
    job.outputPath = renderResult.outputPath;
    job.renderer = { ...renderResult.renderer, audio: voiceover.provider.type };
    if (voiceover.warning) job.documentAsset.warnings.push(voiceover.warning);
    job.status = "complete";
  } catch (error) {
    job.status = "preview-ready";
    job.error = `MP4 render skipped or failed: ${error.message}`;
  } finally {
    job.updatedAt = new Date().toISOString();
  }

  return sendJson(response, 201, toPublicJob(job));
}

async function createProject(request, response) {
  const payload = await readJsonBody(request);
  const prompt = String(payload.prompt || "").trim();
  if (!prompt) return sendJson(response, 400, { error: "Prompt is required" });

  const project = await createProjectFromPromptAsync(prompt);
  saveProject(project);
  return sendJson(response, 201, toPublicProject(project));
}

async function appendProjectMessage(id, request, response) {
  const project = getProject(id);
  if (!project) return sendJson(response, 404, { error: "Project not found" });

  const payload = await readJsonBody(request);
  const message = String(payload.message || "").trim();
  if (!message && typeof payload.materialRefresh !== "boolean") return sendJson(response, 400, { error: "Message is required" });

  let shouldPrepareMedia = false;
  let updated = project.status === "needs_material_confirmation" && typeof payload.materialRefresh === "boolean"
    ? confirmMaterialRefresh(project, payload.materialRefresh)
    : (project.status === "needs_confirmation" || project.status === "needs_script_confirmation") && payload.confirmation
    ? confirmProjectPlan(project, payload.confirmation)
    : await applyUserRevisionAsync(project, message);
  shouldPrepareMedia = Boolean(updated.storyboard)
    && updated.status !== "needs_material_confirmation"
    && (payload.confirmation || payload.materialRefresh === true || project.status === "needs_confirmation" || project.status === "needs_script_confirmation");
  if (shouldPrepareMedia) {
    const jobDir = path.join(jobsDir, updated.id);
    await mkdir(jobDir, { recursive: true });
    const prepared = await prepareStoryboardShots({ storyboard: updated.storyboard, brief: updated.brief, jobDir });
    updated.storyboard = prepared.storyboard;
    updated.assets = [
      ...updated.assets.filter((asset) => asset.type !== "stock-media"),
      {
        id: "stock-media",
        type: "stock-media",
        name: "Shot media",
        pageCount: prepared.manifest.items.length,
        warnings: prepared.manifest.summary.warnings || [],
        summary: `${prepared.manifest.summary.provider}: ${prepared.manifest.summary.externalCount} external, ${prepared.manifest.summary.localCount} local`,
      },
    ];
  }
  if (updated.status !== "needs_material_confirmation" && payload.materialRefresh !== false) updated.render = null;
  saveProject(updated);
  return sendJson(response, 200, toPublicProject(updated));
}

async function attachProjectAsset(id, request, response) {
  const project = getProject(id);
  if (!project) return sendJson(response, 404, { error: "Project not found" });

  const contentTypeHeader = request.headers["content-type"] || "";
  if (!contentTypeHeader.includes("multipart/form-data")) {
    return sendJson(response, 400, { error: "Expected multipart/form-data upload" });
  }

  const boundary = contentTypeHeader.match(/boundary=(.+)$/)?.[1];
  if (!boundary) return sendJson(response, 400, { error: "Missing multipart boundary" });

  const body = await readRequestBody(request);
  const upload = parseMultipartFile(body, boundary);
  if (!upload) return sendJson(response, 400, { error: "No file field found" });

  const assetId = randomUUID();
  const jobDir = path.join(jobsDir, project.id);
  await mkdir(jobDir, { recursive: true });
  const safeName = upload.filename.replace(/[^\w.\- ]+/g, "_") || "upload.pptx";
  const filePath = path.join(uploadDir, `${assetId}-${safeName}`);
  await writeFile(filePath, upload.content);

  const updated = isUserMedia(upload.contentType, safeName)
    ? attachUserMediaAsset(project, {
      id: assetId,
      originalName: safeName,
      mimeType: upload.contentType,
      filePath,
      href: `/uploads/${assetId}-${safeName}`,
    })
    : attachDocumentContext(project, await processDocument({
      id: assetId,
      originalName: safeName,
      mimeType: upload.contentType,
      filePath,
      jobDir,
    }));
  saveProject(updated);
  return sendJson(response, 200, toPublicProject(updated));
}

async function updateProjectScene(id, sceneId, request, response) {
  const project = getProject(id);
  if (!project) return sendJson(response, 404, { error: "Project not found" });

  const patch = await readJsonBody(request);
  const updated = applyScenePatch(project, sceneId, patch);
  if (!updated) return sendJson(response, 404, { error: "Scene not found" });

  saveProject(updated);
  return sendJson(response, 200, toPublicProject(updated));
}

async function updateProjectShot(id, sceneId, shotId, request, response) {
  const project = getProject(id);
  if (!project) return sendJson(response, 404, { error: "Project not found" });

  const patch = await readJsonBody(request);
  const updated = applyShotPatch(project, sceneId, shotId, patch);
  if (!updated) return sendJson(response, 404, { error: "Shot not found" });

  saveProject(updated);
  return sendJson(response, 200, toPublicProject(updated));
}

async function reorderProjectShots(id, sceneId, request, response) {
  const project = getProject(id);
  if (!project) return sendJson(response, 404, { error: "Project not found" });

  const payload = await readJsonBody(request);
  const updated = applyShotReorder(project, sceneId, payload.shotIds);
  if (!updated) return sendJson(response, 400, { error: "Invalid shot order" });

  saveProject(updated);
  return sendJson(response, 200, toPublicProject(updated));
}

async function renderProject(id, response) {
  const project = getProject(id);
  if (!project) return sendJson(response, 404, { error: "Project not found" });
  if (project.render?.status === "rendering") return sendJson(response, 202, toPublicProject(project));
  if (project.status === "needs_material_confirmation") {
    return sendJson(response, 409, { error: "Please confirm or cancel material refresh before rendering" });
  }
  if (project.status === "needs_confirmation" || project.status === "needs_script_confirmation") {
    saveProject(confirmProjectPlan(project));
  }

  const startedAt = new Date().toISOString();
  const current = getProject(id);
  current.status = "rendering";
  current.render = {
    id: randomUUID(),
    status: "rendering",
    stage: "queued",
    createdAt: startedAt,
    updatedAt: startedAt,
    outputPath: null,
    compositionPath: null,
    renderer: null,
    warning: null,
    error: null,
  };
  current.updatedAt = startedAt;
  saveProject(current);

  runProjectRender(id);
  return sendJson(response, 202, toPublicProject(current));
}

async function runProjectRender(id) {
  const project = getProject(id);
  if (!project) return;

    const jobDir = path.join(jobsDir, project.id);
  try {
    await mkdir(jobDir, { recursive: true });
    setRenderStage(project, "finding-media");
    if (!hasPreparedShotMedia(project.storyboard)) {
      const prepared = await prepareStoryboardShots({ storyboard: project.storyboard, brief: project.brief, jobDir });
      project.storyboard = prepared.storyboard;
      project.assets = [
        ...project.assets.filter((asset) => asset.type !== "stock-media"),
        {
          id: "stock-media",
          type: "stock-media",
          name: "Shot media",
          pageCount: prepared.manifest.items.length,
          warnings: prepared.manifest.summary.warnings || [],
          summary: `${prepared.manifest.summary.provider}: ${prepared.manifest.summary.externalCount} external, ${prepared.manifest.summary.localCount} local`,
        },
      ];
    }
    setRenderStage(project, "voiceover");
    const voiceover = await renderVoiceover({ jobDir, storyboard: project.storyboard });
    const beforeAudioDuration = project.storyboard.duration;
    project.storyboard = expandStoryboardForAudio(project.storyboard, voiceover.duration);
    const durationAdjusted = project.storyboard.duration !== beforeAudioDuration;
    if (durationAdjusted) {
      project.updatedAt = new Date().toISOString();
      saveProject(project);
    }
    setRenderStage(project, "writing-composition");
    const compositionPath = await writeComposition({ jobDir, storyboard: project.storyboard });
    setRenderStage(project, "capturing-frames");
    const renderResult = await renderMp4({
      jobDir,
      storyboard: project.storyboard,
      compositionPath,
      audioPath: voiceover.audioPath,
    });

    const completedAt = new Date().toISOString();
    const render = {
      ...project.render,
      status: "complete",
      stage: "complete",
      outputPath: renderResult.outputPath,
      compositionPath,
      renderer: {
        ...renderResult.renderer,
        audio: {
          ...voiceover.provider,
          duration: voiceover.duration || 0,
          durationAdjusted,
          finalStoryboardDuration: project.storyboard.duration,
        },
      },
      warning: [voiceover.warning, durationAdjusted ? `已根据配音自动延长到 ${project.storyboard.duration} 秒。` : null].filter(Boolean).join(" "),
      updatedAt: completedAt,
      completedAt,
    };
    project.render = render;
    project.versions.push(render);
    project.status = "rendered";
    project.updatedAt = completedAt;
  } catch (error) {
    const failedAt = new Date().toISOString();
    project.render = {
      ...project.render,
      status: "failed",
      stage: "failed",
      error: error.message,
      updatedAt: failedAt,
    };
    project.status = "draft";
    project.updatedAt = failedAt;
  } finally {
    saveProject(project);
  }
}

export function toPublicJob(job) {
  const base = `/jobs/${job.id}`;
  const links = {
    storyboard: `${base}/storyboard.json`,
    composition: `${base}/composition.html`,
    mp4: job.outputPath ? `${base}/output.mp4` : null,
  };

  return {
    id: job.id,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    error: job.error,
    warnings: job.documentAsset.warnings,
    pageCount: job.documentAsset.pageCount,
    storyboard: job.storyboard,
    renderer: {
      type: job.renderer?.type ?? (job.outputPath ? "ffmpeg-placeholder" : "html-composition"),
      fidelity: job.renderer?.fidelity ?? (job.outputPath ? "low" : "preview"),
      note: job.renderer?.note ?? (job.outputPath
        ? "Fallback video was generated. HTML Preview contains the richer motion composition."
        : "MP4 rendering did not complete. HTML Preview is available."),
    },
    primaryPreview: links.mp4
      ? { type: "mp4", href: links.mp4 }
      : { type: "composition", href: links.composition },
    links,
  };
}

export function toPublicProject(project) {
  const base = `/jobs/${project.id}`;
  const renderLinks = project.render?.status === "complete" && project.render.outputPath
    ? {
        mp4: `${base}/output.mp4`,
        composition: `${base}/composition.html`,
      }
    : null;
  return {
    ...project,
    assets: (project.assets || []).map((asset) => ({ ...asset, filePath: undefined })),
    storyboard: project.storyboard ? toPublicStoryboard(project.storyboard) : project.storyboard,
    render: project.render
      ? {
          ...project.render,
          outputPath: undefined,
          compositionPath: undefined,
          links: renderLinks,
        }
      : null,
  };
}

function toPublicStoryboard(storyboard) {
  return {
    ...storyboard,
    scenes: (storyboard.scenes || []).map((scene) => ({
      ...scene,
      media: scene.media ? { ...scene.media, filePath: undefined } : scene.media,
      shots: (scene.shots || []).map((shot) => ({
        ...shot,
        media: shot.media ? { ...shot.media, filePath: undefined } : shot.media,
      })),
    })),
  };
}

function parseProjectRoute(pathname) {
  const parts = pathname.split("/");
  return {
    id: parts[3],
    resource: parts[4],
    sceneId: parts[5],
    shotId: parts[7],
  };
}

function isUserMedia(mimeType, filename) {
  return /^image\/(jpeg|png|webp)$/.test(mimeType)
    || /^video\/(mp4|quicktime)$/.test(mimeType)
    || /\.(jpe?g|png|webp|mp4|mov)$/i.test(filename);
}

function hasPreparedShotMedia(storyboard) {
  const shots = (storyboard?.scenes || []).flatMap((scene) => scene.shots || []);
  return shots.length > 0 && shots.every((shot) => shot.media?.href || shot.media?.posterHref);
}

function setRenderStage(project, stage) {
  const now = new Date().toISOString();
  project.render = {
    ...project.render,
    status: "rendering",
    stage,
    updatedAt: now,
  };
  project.updatedAt = now;
  saveProject(project);
}

function getProject(id) {
  return projects.get(id) || projectStore.getProject(id);
}

function saveProject(project) {
  projects.set(project.id, project);
  projectStore.saveProject(project);
}

async function serveFile(request, response, filePath, type) {
  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) return sendJson(response, 404, { error: "File not found" });

    if (type === "video/mp4") {
      return serveVideo(request, response, filePath, fileStat.size, type);
    }

    const headers = {
      "content-type": type,
      "content-length": fileStat.size,
      "x-content-type-options": "nosniff",
    };

    response.writeHead(200, headers);
    if (request.method === "HEAD") return response.end();

    const content = await readFile(filePath);
    response.end(content);
  } catch {
    sendJson(response, 404, { error: "File not found" });
  }
}

function serveVideo(request, response, filePath, size, type) {
  const range = request.headers.range;
  const baseHeaders = {
    "content-type": type,
    "accept-ranges": "bytes",
    "x-content-type-options": "nosniff",
  };

  if (!range) {
    response.writeHead(200, { ...baseHeaders, "content-length": size });
    if (request.method === "HEAD") return response.end();
    return createReadStream(filePath).pipe(response);
  }

  const match = range.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) {
    response.writeHead(416, { "content-range": `bytes */${size}` });
    return response.end();
  }

  const start = match[1] ? Number(match[1]) : 0;
  const end = match[2] ? Number(match[2]) : size - 1;
  if (start >= size || end >= size || start > end) {
    response.writeHead(416, { "content-range": `bytes */${size}` });
    return response.end();
  }

  response.writeHead(206, {
    ...baseHeaders,
    "content-length": end - start + 1,
    "content-range": `bytes ${start}-${end}/${size}`,
  });
  if (request.method === "HEAD") return response.end();
  return createReadStream(filePath, { start, end }).pipe(response);
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(payload));
}

function readRequestBody(request, { maxBytes = maxUploadBytes } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    request.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        request.destroy(createHttpError(413, "Request body is too large"));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

async function readJsonBody(request) {
  const body = await readRequestBody(request);
  if (body.length === 0) return {};
  return JSON.parse(body.toString("utf8"));
}

function parseMultipartFile(body, boundary) {
  const marker = Buffer.from(`--${boundary}`);
  const parts = splitBuffer(body, marker);

  for (const part of parts) {
    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd === -1) continue;
    const header = part.slice(0, headerEnd).toString("utf8");
    if (!header.includes('name="file"')) continue;

    const filename = header.match(/filename="([^"]*)"/)?.[1] || "upload";
    const contentTypeHeader = header.match(/Content-Type:\s*([^\r\n]+)/i)?.[1] || "application/octet-stream";
    let content = part.slice(headerEnd + 4);
    if (content.subarray(content.length - 2).toString() === "\r\n") content = content.subarray(0, content.length - 2);
    return { filename, contentType: contentTypeHeader, content };
  }

  return null;
}

function splitBuffer(buffer, separator) {
  const parts = [];
  let start = 0;
  let index = buffer.indexOf(separator, start);

  while (index !== -1) {
    if (index > start) parts.push(buffer.slice(start, index));
    start = index + separator.length;
    index = buffer.indexOf(separator, start);
  }

  if (start < buffer.length) parts.push(buffer.slice(start));
  return parts.map((part) => {
    let value = part;
    if (value.subarray(0, 2).toString() === "\r\n") value = value.subarray(2);
    if (value.subarray(0, 2).toString() === "--") value = value.subarray(2);
    return value;
  });
}

export function contentType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".html") return "text/html; charset=utf-8";
  if (extension === ".css") return "text/css; charset=utf-8";
  if (extension === ".js") return "application/javascript; charset=utf-8";
  if (extension === ".json") return "application/json; charset=utf-8";
  if (extension === ".svg") return "image/svg+xml";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".png") return "image/png";
  if (extension === ".webp") return "image/webp";
  if (extension === ".mp4") return "video/mp4";
  return "application/octet-stream";
}

export function resolveSafeFilePath(root, requestedPath) {
  const resolvedRoot = path.resolve(root);
  if (path.isAbsolute(requestedPath) || /^[A-Za-z]:[\\/]/.test(requestedPath)) return null;
  const normalizedRequested = path.normalize(requestedPath).replace(/^[/\\]+/, "");
  if (normalizedRequested === "." || normalizedRequested.startsWith("..")) return null;

  const filePath = path.resolve(resolvedRoot, normalizedRequested);
  if (filePath !== resolvedRoot && !filePath.startsWith(`${resolvedRoot}${path.sep}`)) return null;
  return filePath;
}

function createHttpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
