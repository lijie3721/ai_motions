# AI Motions

AI Motions is a local-first AI short-video studio. It turns a user prompt, PPT, or PDF into an editable short-video draft with a chat workflow, script confirmation, storyboard editing, stock media, voiceover, and MP4 rendering.

The current app is a prototype for the full product flow:

1. Describe the video you want, or upload a PPT/PDF as source material.
2. Confirm the creative direction, script, language, voice, aspect ratio, and duration.
3. Review the generated storyboard and the media prepared for each scene.
4. Replace text, images, videos, timing, and local user media.
5. Save drafts and render a preview/video when ready.

## Features

- Multi-turn chat for video briefs and revisions.
- Script and plan confirmation before expensive media generation.
- Editable storyboard with scene duration and shot-level media.
- Stock media search/download with Pexels and Pixabay when API keys are configured.
- User media uploads for images and videos.
- Draft storage in local SQLite.
- Voiceover presets for Chinese, English, Japanese, and Korean.
- HTML composition preview plus MP4 rendering through Playwright/browser capture and FFmpeg.
- Legacy PPT/PDF upload pipeline for turning slides into a first video draft.

## Requirements

- Node.js 20 or newer.
- npm.
- Playwright browsers. Run `npx playwright install` if your machine does not already have them.
- FFmpeg for MP4 output. Without FFmpeg, the app can still generate and preview the HTML composition.
- `unzip` for PPTX text extraction.
- API keys are optional, but required for cloud LLM/TTS and stock media quality.

## Quick Start

```bash
npm install
cp .env.example .env
npm run dev
```

Open `http://localhost:4173`.

Edit `.env` to enable cloud services. Do not commit `.env`.

## Configuration

| Variable | Required | Description |
| --- | --- | --- |
| `PORT` | No | Local server port. Defaults to `4173`. |
| `MAX_UPLOAD_BYTES` | No | Maximum request body size. Defaults to `52428800` bytes. |
| `DASHSCOPE_API_KEY` | No | Aliyun DashScope API key for Qwen planning/TTS flows. |
| `ALIYUN_TTS_MODEL` | No | Aliyun TTS model. Defaults to `qwen3-tts-instruct-flash` when DashScope is enabled. |
| `ALIYUN_TTS_VOICE` | No | Advanced voice override. Usually leave empty so UI selections work. |
| `ALIYUN_TTS_VOICE_FORCE` | No | Set to `1` only when you intentionally want env config to override UI voice choices. |
| `ALIYUN_TTS_INSTRUCTION` | No | Advanced TTS instruction override. |
| `ALIYUN_TTS_INSTRUCTION_FORCE` | No | Set to `1` only when you intentionally want env config to override UI tone/style choices. |
| `PEXELS_API_KEY` | No | Enables Pexels stock media search. |
| `PIXABAY_API_KEY` | No | Enables Pixabay stock media search. |
| `OPENAI_API_KEY` | No | Reserved for OpenAI TTS integration. |
| `OPENAI_TTS_MODEL` | No | Reserved for OpenAI TTS integration. |

## Scripts

```bash
npm run dev      # Start the local server
npm run start    # Start the local server
npm test         # Run the Node test suite
```

There is no separate build step in this prototype.

## Project Structure

```text
public/              Browser UI
src/server.js        HTTP server, API routes, static file serving
src/planner.js       Project creation and multi-turn revision flow
src/creativePlanner.js
                     LLM-backed creative brief and storyboard planning
src/stockMedia.js    Stock media search/download and storyboard media assignment
src/tts.js           Voiceover provider selection and rendering
src/render.js        Composition writing and MP4 rendering
src/projectStore.js  Local SQLite draft storage
test/                Node test suite
uploads/             Local uploaded files, ignored by git
jobs/                Generated compositions/media/videos, ignored by git
data/                Local SQLite database, ignored by git
```

## Security And Privacy

This repository is designed for local development and experimentation. Before exposing it to other users or the public internet, review the following points.

- Do not commit `.env`, real API keys, uploaded files, generated jobs, or the SQLite database.
- `.gitignore` excludes `uploads/`, `jobs/`, `data/`, `.env*`, logs, and local temporary screenshots.
- Local uploads are stored under `uploads/`.
- Generated media, compositions, audio, and MP4 files are stored under `jobs/`.
- Drafts are stored in `data/ai-motions.sqlite`.
- The server now confines static file reads to their configured roots and rejects path traversal.
- The server has a configurable request body limit through `MAX_UPLOAD_BYTES`.
- Server errors are logged locally, while production clients receive a generic `Internal server error` for unexpected failures.
- This prototype does not include authentication, authorization, per-user isolation, rate limiting, billing controls, malware scanning, or provider-cost quotas.
- If you deploy it beyond localhost, put it behind authentication, HTTPS, request rate limits, upload scanning, storage lifecycle cleanup, and a reverse proxy with body-size limits.
- Stock assets come from third-party providers. Check Pexels/Pixabay license terms before commercial use.
- Uploaded PPT/PDF/image/video files may contain confidential data. Treat `uploads/`, `jobs/`, and `data/` as private local data.

## Open-Source Checklist

Before publishing the repository:

1. Add a `LICENSE` file. Without a license, other people do not have clear permission to use, modify, or redistribute the code.
2. Confirm no real secrets are present:

   ```bash
   git status --short
   git grep -n "DASHSCOPE_API_KEY\\|PEXELS_API_KEY\\|PIXABAY_API_KEY\\|OPENAI_API_KEY"
   ```

3. Remove or keep untracked local runtime folders out of git:

   ```bash
   git status --ignored --short
   ```

4. Run the test suite:

   ```bash
   npm test
   ```

5. Start the app and verify the core flow:

   ```bash
   npm run dev
   ```

## Current Limitations

- This is still a local prototype, not a hosted multi-tenant SaaS backend.
- The LLM and media provider behavior depends on configured keys and provider availability.
- OpenAI TTS variables are present for future wiring, but the current local MVP does not render OpenAI TTS audio yet.
- PPT/PDF conversion extracts text where possible; perfect slide visual fidelity is not guaranteed.
- Generated videos may require additional editing for production-grade ads.

