# TikTok Manager Bot — Render / Docker

Telegram bot using Node.js, Telegraf and Playwright Chromium.

## Deploy on Render

This repository intentionally uses Docker because Playwright Chromium needs browser dependencies.

Render settings:
- Runtime: Docker
- Dockerfile: `Dockerfile`
- No Build Command required
- No Start Command required; Dockerfile supplies it

Environment variables:
- `BOT_TOKEN` — Telegram bot token
- `ADMIN_ID` — your numeric Telegram user ID
- `HEADLESS=true`

The container listens on `PORT` and exposes `/health`.

## Important persistence note

A normal Render filesystem is ephemeral. The Playwright browser profile in `/app/data/tiktok-profile` can disappear after redeploy/restart.

For a persistent TikTok browser session, attach a Render persistent disk to `/app/data` (on a plan that supports it), or use a VPS with persistent storage.

## Login

The bot opens TikTok through Playwright. You complete login yourself. The bot does not request or store your TikTok password and does not bypass CAPTCHA/2FA/anti-bot checks.

## Local

```bash
npm install
npx playwright install chromium
npm start
```
