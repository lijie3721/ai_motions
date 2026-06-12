# Security Policy

AI Motions is currently a local-first prototype. It is not hardened for public, multi-user hosting out of the box.

## Reporting A Vulnerability

If you publish this repository, replace this section with your preferred private reporting channel, such as a security email address or GitHub private vulnerability reporting.

Do not open public issues that include API keys, uploaded user files, generated videos, database files, or other sensitive data.

## Secrets

Never commit `.env` or real provider keys.

The following values are sensitive:

- `DASHSCOPE_API_KEY`
- `PEXELS_API_KEY`
- `PIXABAY_API_KEY`
- `OPENAI_API_KEY`

If a key is committed or shared accidentally, rotate it with the provider immediately.

## Local Data

The app stores local runtime data in ignored directories:

- `uploads/` for uploaded PPT/PDF/image/video files.
- `jobs/` for generated compositions, media, audio, and MP4 files.
- `data/` for local SQLite drafts.

Treat these folders as private user data. Do not attach them to public bug reports.

## Deployment Notes

Before running this project outside localhost, add:

- Authentication and authorization.
- HTTPS.
- Reverse-proxy request size limits.
- Rate limits and provider cost controls.
- Upload scanning and file lifecycle cleanup.
- Per-user storage isolation.
- Monitoring that does not log secrets or sensitive uploaded content.

