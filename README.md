# TikTok Manager — Render

Telegram bot + Playwright Chromium. Chromium runs in a virtual display on Render (Xvfb).

## First login
1. Deploy the Docker service.
2. Set `BOT_TOKEN`, `ADMIN_ID`, and a long random `SESSION_TOKEN`.
3. In Telegram press **🔐 Войти в TikTok**.
4. Open the private browser link sent by the bot.
5. Complete TikTok login, 2FA and CAPTCHA yourself.
6. Return to Telegram and use profile controls.

The bot does not ask for or store your TikTok password in Telegram and does not bypass TikTok security.

## Render
Runtime: Docker. No Build/Start command is required; Dockerfile handles it.

Recommended: attach a persistent disk mounted at `/app/data`, otherwise the Playwright profile may disappear after a restart/redeploy.
