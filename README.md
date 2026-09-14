# TikTok Manager — Render

Telegram bot + Express + Playwright for managing your own TikTok account.

## Render deployment

Create a Render Web Service from this repository/ZIP after uploading it to GitHub.

Build Command:
npm install && npx playwright install --with-deps chromium

Start Command:
npm start

Add environment variables:

BOT_TOKEN=...
ADMIN_ID=...
PUBLIC_URL=https://YOUR-SERVICE.onrender.com
HEADLESS=true

A 1 GB Persistent Disk is required and should be mounted at:
`/opt/render/project/src/data`

The browser profile is stored in:
`/opt/render/project/src/data/tiktok-profile`

## Login

Because Render is headless, `/login` creates a browser session and provides a remote-control page.

Open the login URL from Telegram. The page shows the TikTok browser through screenshots and controls. This implementation intentionally does NOT attempt to bypass CAPTCHA, 2FA, anti-bot checks, or security challenges.

For a robust production deployment, the recommended approach is to complete TikTok authorization on a trusted local browser and import an authorized session only when permitted by TikTok's rules. Do not upload passwords or authentication codes to the bot.

## Important

TikTok can change its web interface at any time. The selectors for profile editing are therefore isolated in `src/tiktok.js` and may need updating.

This project is intended for your own account. It does not implement CAPTCHA bypass, anti-bot evasion, mass-account automation, or credential harvesting.
