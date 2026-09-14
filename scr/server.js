require("dotenv").config();

const express = require("express");
const fs = require("fs");
const path = require("path");
const https = require("https");
const { Telegraf, Markup } = require("telegraf");
const tiktok = require("./tiktok");

const app = express();
app.use(express.json());

const PORT = Number(process.env.PORT || 10000);
const BOT_TOKEN = (process.env.BOT_TOKEN || "").trim();
const ADMIN_ID = String(process.env.ADMIN_ID || "").trim();
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/+$/, "");

if (!BOT_TOKEN) throw new Error("BOT_TOKEN is missing");
if (!ADMIN_ID) throw new Error("ADMIN_ID is missing");

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data");
const TMP_DIR = path.join(DATA_DIR, "tmp");
fs.mkdirSync(TMP_DIR, { recursive: true });

const bot = new Telegraf(BOT_TOKEN);
const state = new Map();

function allowed(ctx) {
  return String(ctx.from?.id) === ADMIN_ID;
}

function menu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🔐 Войти в TikTok", "login")],
    [Markup.button.callback("👤 Профиль", "profile")],
    [Markup.button.callback("📝 Изменить био", "bio")],
    [Markup.button.callback("👤 Изменить имя", "name")],
    [Markup.button.callback("🖼 Сменить аватар", "avatar")],
    [Markup.button.callback("🚪 Выйти", "logout")]
  ]);
}

async function sendMenu(ctx) {
  return ctx.reply("🎵 TikTok Manager\\n\\nВыбери действие:", menu());
}

bot.use(async (ctx, next) => {
  if (!allowed(ctx)) {
    if (ctx.message) await ctx.reply("⛔ Доступ запрещён.");
    return;
  }
  return next();
});

bot.start(sendMenu);

bot.command("login", async (ctx) => {
  await ctx.reply("⏳ Запускаю браузер TikTok...");
  try {
    await tiktok.openLogin();
    const url = PUBLIC_URL ? `${PUBLIC_URL}/login` : null;
    await ctx.reply(
      url
        ? `🌐 Открой страницу входа:\\n${url}\\n\\nАвторизацию, код и CAPTCHA проходи самостоятельно.`
        : "🌐 TikTok запущен. PUBLIC_URL пока не задан."
    );
  } catch (e) {
    await ctx.reply("❌ " + e.message);
  }
});

bot.command("profile", async (ctx) => {
  try {
    await tiktok.openProfile();
    await ctx.reply("👤 Профиль TikTok открыт.");
  } catch (e) {
    await ctx.reply("❌ " + e.message);
  }
});

bot.command("bio", async (ctx) => {
  state.set(ctx.from.id, { type: "bio" });
  await ctx.reply("📝 Отправь новое био.");
});

bot.command("name", async (ctx) => {
  state.set(ctx.from.id, { type: "name" });
  await ctx.reply("👤 Отправь новое отображаемое имя.");
});

bot.command("avatar", async (ctx) => {
  state.set(ctx.from.id, { type: "avatar" });
  await ctx.reply("🖼 Отправь новую фотографию.");
});

bot.command("logout", async (ctx) => {
  try {
    await tiktok.clearSession();
    await ctx.reply("🚪 Локальная TikTok-сессия удалена.");
  } catch (e) {
    await ctx.reply("❌ " + e.message);
  }
});

bot.action("login", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply("⏳ Запускаю TikTok...");
  try {
    await tiktok.openLogin();
    const url = PUBLIC_URL ? `${PUBLIC_URL}/login` : null;
    await ctx.reply(url ? `🌐 Страница управления браузером:\\n${url}` : "TikTok запущен.");
  } catch (e) {
    await ctx.reply("❌ " + e.message);
  }
});

bot.action("profile", async (ctx) => {
  await ctx.answerCbQuery();
  try {
    await tiktok.openProfile();
    await ctx.reply("👤 Профиль открыт.");
  } catch (e) {
    await ctx.reply("❌ " + e.message);
  }
});

bot.action("bio", async (ctx) => {
  await ctx.answerCbQuery();
  state.set(ctx.from.id, { type: "bio" });
  await ctx.reply("📝 Отправь новое био.");
});

bot.action("name", async (ctx) => {
  await ctx.answerCbQuery();
  state.set(ctx.from.id, { type: "name" });
  await ctx.reply("👤 Отправь новое имя.");
});

bot.action("avatar", async (ctx) => {
  await ctx.answerCbQuery();
  state.set(ctx.from.id, { type: "avatar" });
  await ctx.reply("🖼 Отправь новую аватарку как фото.");
});

bot.action("logout", async (ctx) => {
  await ctx.answerCbQuery();
  try {
    await tiktok.clearSession();
    await ctx.reply("🚪 Локальная TikTok-сессия удалена.");
  } catch (e) {
    await ctx.reply("❌ " + e.message);
  }
});

async function downloadTelegramFile(ctx, fileId, target) {
  const link = await ctx.telegram.getFileLink(fileId);
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(target);
    https.get(link.href, (res) => {
      res.pipe(out);
      out.on("finish", () => out.close(resolve));
    }).on("error", (err) => {
      out.close();
      reject(err);
    });
  });
}

bot.on("photo", async (ctx) => {
  const s = state.get(ctx.from.id);
  if (!s || s.type !== "avatar") return;

  state.delete(ctx.from.id);
  const file = path.join(TMP_DIR, `avatar-${Date.now()}.jpg`);

  try {
    await ctx.reply("⏳ Загружаю аватар...");
    const photo = ctx.message.photo.at(-1);
    await downloadTelegramFile(ctx, photo.file_id, file);
    await tiktok.setAvatar(file);
    await ctx.reply("✅ Аватар изменён.");
  } catch (e) {
    await ctx.reply("❌ " + e.message);
  } finally {
    fs.rmSync(file, { force: true });
  }
});

bot.on("text", async (ctx) => {
  const s = state.get(ctx.from.id);
  if (!s) return;

  state.delete(ctx.from.id);

  try {
    if (s.type === "bio") {
      await ctx.reply("⏳ Изменяю био...");
      await tiktok.setBio(ctx.message.text);
      await ctx.reply("✅ Био изменено.");
    }

    if (s.type === "name") {
      await ctx.reply("⏳ Изменяю имя...");
      await tiktok.setName(ctx.message.text);
      await ctx.reply("✅ Имя изменено.");
    }
  } catch (e) {
    await ctx.reply("❌ " + e.message);
  }
});

bot.catch((err) => console.error("Telegram error:", err));

app.get("/", (req, res) => {
  res.type("html").send(`
    <html>
      <head>
        <meta name="viewport" content="width=device-width,initial-scale=1">
        <title>TikTok Manager</title>
        <style>
          body{font-family:Arial,sans-serif;background:#0d0f17;color:#fff;margin:0;padding:30px}
          .box{max-width:700px;margin:auto;background:#161924;border-radius:16px;padding:24px}
          button{background:#f59e0b;border:0;border-radius:10px;padding:12px 16px;font-weight:700}
          p{color:#b7bbc8}
        </style>
      </head>
      <body>
        <div class="box">
          <h2>🎵 TikTok Manager</h2>
          <p>Render service is online.</p>
          <p>Use Telegram to control the connected TikTok browser session.</p>
        </div>
      </body>
    </html>
  `);
});

app.get("/login", async (req, res) => {
  try {
    await tiktok.openLogin();
    res.type("html").send(`
      <html>
      <head>
        <meta name="viewport" content="width=device-width,initial-scale=1">
        <title>TikTok Login</title>
        <style>
          body{font-family:Arial;background:#0d0f17;color:#fff;padding:24px}
          .box{max-width:650px;margin:auto;background:#161924;padding:24px;border-radius:16px}
          .warn{background:#211b0d;padding:14px;border-radius:10px;color:#ffd66b}
        </style>
      </head>
      <body>
        <div class="box">
          <h2>🔐 TikTok Login</h2>
          <p>Playwright is running on Render in headless mode.</p>
          <div class="warn">
            A headless browser cannot provide a normal interactive TikTok login window here.
          </div>
          <p>For initial authorization, use a trusted local browser. This service does not collect your TikTok password, OTP codes, or CAPTCHA answers.</p>
        </div>
      </body>
      </html>
    `);
  } catch (e) {
    res.status(500).send("TikTok error: " + e.message);
  }
});

app.get("/health", (req, res) => res.json({ ok: true }));

app.listen(PORT, async () => {
  console.log(`TikTok Manager listening on ${PORT}`);
  console.log(`PUBLIC_URL: ${PUBLIC_URL || "(not set)"}`);
  await bot.launch();
  console.log("Telegram bot started");
});

process.once("SIGINT", async () => {
  await bot.stop("SIGINT");
  await tiktok.close();
  process.exit(0);
});

process.once("SIGTERM", async () => {
  await bot.stop("SIGTERM");
  await tiktok.close();
  process.exit(0);
});
