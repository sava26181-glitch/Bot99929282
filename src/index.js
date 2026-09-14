require("dotenv").config();

const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const { Telegraf, Markup } = require("telegraf");
const { chromium } = require("playwright");

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = String(process.env.ADMIN_ID || "");
const HEADLESS = String(process.env.HEADLESS || "true").toLowerCase() === "true";
const PORT = Number(process.env.PORT || 10000);

if (!BOT_TOKEN) throw new Error("BOT_TOKEN is missing");
if (!ADMIN_ID) throw new Error("ADMIN_ID is missing");

const DATA_DIR = path.join(process.cwd(), "data");
const PROFILE_DIR = path.join(DATA_DIR, "tiktok-profile");
const TMP_DIR = path.join(DATA_DIR, "tmp");
fs.mkdirSync(TMP_DIR, { recursive: true });

let context = null;
let page = null;
const state = new Map();

function allowed(ctx) {
  return String(ctx.from?.id) === ADMIN_ID;
}

function startHealthServer() {
  const server = http.createServer((req, res) => {
    if (req.url === "/health" || req.url === "/") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        service: "tiktok-manager-bot"
      }));
      return;
    }
    res.writeHead(404);
    res.end("Not found");
  });

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`HTTP health server listening on ${PORT}`);
  });
}

async function getBrowser() {
  if (context) return context;

  context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: HEADLESS,
    viewport: { width: 1280, height: 900 },
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled"
    ]
  });

  context.on("close", () => {
    context = null;
    page = null;
  });

  page = context.pages()[0] || await context.newPage();
  return context;
}

async function getPage() {
  const ctx = await getBrowser();
  const pages = ctx.pages();
  page = pages[0] || await ctx.newPage();
  return page;
}

async function openTikTok(pathname) {
  const p = await getPage();
  await p.goto(`https://www.tiktok.com${pathname}`, {
    waitUntil: "domcontentloaded",
    timeout: 60000
  }).catch(() => {});
  await p.waitForTimeout(2500);
  return p;
}

async function mainMenu(ctx) {
  return ctx.reply(
    "🎵 TikTok Manager\n\nВыбери действие:",
    Markup.inlineKeyboard([
      [Markup.button.callback("🔐 Войти в TikTok", "login")],
      [Markup.button.callback("👤 Профиль", "profile")],
      [Markup.button.callback("📝 Изменить био", "bio")],
      [Markup.button.callback("👤 Изменить имя", "name")],
      [Markup.button.callback("🖼 Сменить аватар", "avatar")],
      [Markup.button.callback("🚪 Выйти", "logout")]
    ])
  );
}

const bot = new Telegraf(BOT_TOKEN);

bot.use(async (ctx, next) => {
  if (!allowed(ctx)) {
    if (ctx.message) await ctx.reply("⛔ Доступ запрещён.");
    return;
  }
  return next();
});

bot.start(mainMenu);

bot.command("login", async ctx => {
  await ctx.reply("⏳ Открываю TikTok...");
  try {
    await openTikTok("/login");
    await ctx.reply(
      HEADLESS
        ? "TikTok запущен в headless-режиме. Для первого входа на Render нужен отдельный способ ручной авторизации/сессии."
        : "TikTok открыт. Заверши вход/2FA/CAPTCHA вручную."
    );
  } catch (e) {
    await ctx.reply("❌ " + e.message);
  }
});

bot.command("profile", async ctx => {
  try {
    await openTikTok("/profile");
    await ctx.reply("👤 Профиль открыт.");
  } catch (e) {
    await ctx.reply("❌ " + e.message);
  }
});

bot.command("bio", async ctx => {
  state.set(ctx.from.id, { type: "bio" });
  await ctx.reply("📝 Отправь новое био.");
});

bot.command("name", async ctx => {
  state.set(ctx.from.id, { type: "name" });
  await ctx.reply("👤 Отправь новое отображаемое имя.");
});

bot.command("avatar", async ctx => {
  state.set(ctx.from.id, { type: "avatar" });
  await ctx.reply("🖼 Отправь новую аватарку как фото.");
});

bot.command("logout", async ctx => {
  try {
    if (context) await context.close();
    context = null;
    page = null;
    fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
    await ctx.reply("🚪 Локальная браузерная сессия удалена.");
  } catch (e) {
    await ctx.reply("❌ " + e.message);
  }
});

for (const [action, handler] of [
  ["login", async ctx => {
    await ctx.answerCbQuery();
    await ctx.reply("⏳ Открываю TikTok...");
    try {
      await openTikTok("/login");
      await ctx.reply(
        HEADLESS
          ? "TikTok запущен без GUI. Для Render используй заранее сохранённую сессию или подключи удалённый браузер."
          : "TikTok открыт. Войди вручную."
      );
    } catch (e) {
      await ctx.reply("❌ " + e.message);
    }
  }],
  ["profile", async ctx => {
    await ctx.answerCbQuery();
    try {
      await openTikTok("/profile");
      await ctx.reply("👤 Профиль открыт.");
    } catch (e) {
      await ctx.reply("❌ " + e.message);
    }
  }],
  ["bio", async ctx => {
    await ctx.answerCbQuery();
    state.set(ctx.from.id, { type: "bio" });
    await ctx.reply("📝 Отправь новое био.");
  }],
  ["name", async ctx => {
    await ctx.answerCbQuery();
    state.set(ctx.from.id, { type: "name" });
    await ctx.reply("👤 Отправь новое отображаемое имя.");
  }],
  ["avatar", async ctx => {
    await ctx.answerCbQuery();
    state.set(ctx.from.id, { type: "avatar" });
    await ctx.reply("🖼 Отправь новую аватарку как фото.");
  }],
  ["logout", async ctx => {
    await ctx.answerCbQuery();
    try {
      if (context) await context.close();
      context = null;
      page = null;
      fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
      await ctx.reply("🚪 Локальная браузерная сессия удалена.");
    } catch (e) {
      await ctx.reply("❌ " + e.message);
    }
  }]
]) {
  bot.action(action, handler);
}

async function clickEditProfile(p) {
  const candidates = [
    p.getByRole("button", { name: /Edit profile|Редактировать профиль/i }).first(),
    p.getByText(/Edit profile|Редактировать профиль/i).first()
  ];

  for (const loc of candidates) {
    try {
      if (await loc.isVisible({ timeout: 2500 })) {
        await loc.click();
        await p.waitForTimeout(1200);
        return true;
      }
    } catch {}
  }
  return false;
}

async function setBio(value) {
  const p = await openTikTok("/profile");
  if (!(await clickEditProfile(p))) throw new Error("Кнопка редактирования профиля не найдена.");

  let field = null;
  for (const selector of [
    'textarea[placeholder*="Bio" i]',
    'textarea[placeholder*="Био" i]',
    "textarea"
  ]) {
    try {
      const loc = p.locator(selector).first();
      if (await loc.isVisible({ timeout: 1500 })) {
        field = loc;
        break;
      }
    } catch {}
  }

  if (!field) throw new Error("Поле био не найдено.");
  await field.fill(value);

  const save = p.getByRole("button", { name: /Save|Сохранить/i }).first();
  if (!(await save.isVisible({ timeout: 2000 }).catch(() => false))) {
    throw new Error("Кнопка сохранения не найдена.");
  }
  await save.click();
  await p.waitForTimeout(1500);
}

async function setName(value) {
  const p = await openTikTok("/profile");
  if (!(await clickEditProfile(p))) throw new Error("Кнопка редактирования профиля не найдена.");

  let field = null;
  for (const selector of [
    'input[placeholder*="Name" i]',
    'input[placeholder*="Имя" i]',
    'input[name*="name" i]'
  ]) {
    try {
      const loc = p.locator(selector).first();
      if (await loc.isVisible({ timeout: 1500 })) {
        field = loc;
        break;
      }
    } catch {}
  }

  if (!field) throw new Error("Поле имени не найдено.");
  await field.fill(value);

  const save = p.getByRole("button", { name: /Save|Сохранить/i }).first();
  if (!(await save.isVisible({ timeout: 2000 }).catch(() => false))) {
    throw new Error("Кнопка сохранения не найдена.");
  }
  await save.click();
  await p.waitForTimeout(1500);
}

async function setAvatar(filePath) {
  const p = await openTikTok("/profile");
  if (!(await clickEditProfile(p))) throw new Error("Кнопка редактирования профиля не найдена.");

  const inputs = p.locator('input[type="file"]');
  if ((await inputs.count()) === 0) {
    throw new Error("Поле загрузки аватара не найдено.");
  }

  await inputs.first().setInputFiles(filePath);
  await p.waitForTimeout(1500);

  const save = p.getByRole("button", {
    name: /Save|Сохранить|Confirm|Подтвердить/i
  }).first();

  if (await save.isVisible({ timeout: 3000 }).catch(() => false)) {
    await save.click();
  }

  await p.waitForTimeout(2000);
}

function download(url, destination) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destination);
    https.get(url, response => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        file.close();
        fs.rmSync(destination, { force: true });
        return download(response.headers.location, destination).then(resolve).catch(reject);
      }
      response.pipe(file);
      file.on("finish", () => file.close(resolve));
    }).on("error", err => {
      file.close();
      fs.rmSync(destination, { force: true });
      reject(err);
    });
  });
}

bot.on("photo", async ctx => {
  const s = state.get(ctx.from.id);
  if (!s || s.type !== "avatar") return;
  state.delete(ctx.from.id);

  const target = path.join(TMP_DIR, `avatar-${ctx.from.id}-${Date.now()}.jpg`);

  try {
    const photo = ctx.message.photo.at(-1);
    const fileLink = await ctx.telegram.getFileLink(photo.file_id);
    await ctx.reply("⏳ Загружаю аватар...");
    await download(fileLink.href, target);
    await setAvatar(target);
    await ctx.reply("✅ Аватар изменён.");
  } catch (e) {
    await ctx.reply("❌ " + e.message);
  } finally {
    fs.rmSync(target, { force: true });
  }
});

bot.on("text", async ctx => {
  const s = state.get(ctx.from.id);
  if (!s) return;
  state.delete(ctx.from.id);

  try {
    if (s.type === "bio") {
      await ctx.reply("⏳ Изменяю био...");
      await setBio(ctx.message.text);
      await ctx.reply("✅ Био изменено.");
    } else if (s.type === "name") {
      await ctx.reply("⏳ Изменяю имя...");
      await setName(ctx.message.text);
      await ctx.reply("✅ Имя изменено.");
    }
  } catch (e) {
    await ctx.reply("❌ " + e.message);
  }
});

bot.catch((err, ctx) => {
  console.error("Bot error:", err);
  ctx.reply("❌ Произошла ошибка.").catch(() => {});
});

startHealthServer();

bot.launch().then(() => {
  console.log("TikTok Manager bot started");
  console.log("HEADLESS:", HEADLESS);
  console.log("PORT:", PORT);
}).catch(err => {
  console.error("Bot failed to start:", err);
  process.exit(1);
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
