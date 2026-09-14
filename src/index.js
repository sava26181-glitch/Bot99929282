require("dotenv").config();

const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const { Telegraf, Markup } = require("telegraf");
const { chromium } = require("playwright");
const { WebSocketServer, WebSocket } = require("ws");

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = String(process.env.ADMIN_ID || "");
const PORT = Number(process.env.PORT || 10000);

if (!BOT_TOKEN) throw new Error("BOT_TOKEN is missing");
if (!ADMIN_ID) throw new Error("ADMIN_ID is missing");
if (!process.env.SESSION_TOKEN) throw new Error("SESSION_TOKEN is missing");

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
    const u = new URL(req.url, `http://${req.headers.host}`);
    if (u.pathname === "/health" || u.pathname === "/") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: true, service: "tiktok-manager-bot" }));
    }
    if (u.pathname === "/browser") {
      if (u.searchParams.get("token") !== process.env.SESSION_TOKEN) { res.writeHead(401); return res.end("Unauthorized"); }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>TikTok Login</title><style>html,body{margin:0;height:100%;background:#111}iframe{border:0;width:100%;height:100%}</style></head><body><iframe src="/novnc/vnc.html?autoconnect=1&resize=scale&path=novnc/websockify&token=${encodeURIComponent(process.env.SESSION_TOKEN)}"></iframe></body></html>`);
    }
    if (u.pathname.startsWith("/novnc/")) {
      if (u.searchParams.get("token") !== process.env.SESSION_TOKEN) { res.writeHead(401); return res.end("Unauthorized"); }
      const proxy = http.request({ hostname:"127.0.0.1", port:6080, path:u.pathname.replace(/^\/novnc/,"")+u.search, method:req.method, headers:{...req.headers,host:"127.0.0.1:6080"} }, r => { res.writeHead(r.statusCode||200,r.headers); r.pipe(res); });
      proxy.on("error", e => { if(!res.headersSent) res.writeHead(502); res.end(String(e)); });
      req.pipe(proxy);
      return;
    }
    res.writeHead(404); res.end("Not found");
  });
  const wss = new WebSocketServer({ noServer:true });
  wss.on("connection", (client, req) => {
    const u = new URL(req.url, `http://${req.headers.host}`);
    if (u.searchParams.get("token") !== process.env.SESSION_TOKEN) return client.close();
    const upstream = new WebSocket("ws://127.0.0.1:6080/websockify");
    client.on("message", m => { if(upstream.readyState === WebSocket.OPEN) upstream.send(m); });
    upstream.on("message", m => { if(client.readyState === WebSocket.OPEN) client.send(m); });
    const close=()=>{try{client.close()}catch{} try{upstream.close()}catch{}};
    client.on("close",close); upstream.on("close",close); upstream.on("error",close);
  });
  server.on("upgrade", (req,socket,head) => {
    try {
      const u=new URL(req.url,`http://${req.headers.host}`);
      if(u.pathname !== "/novnc/websockify" || u.searchParams.get("token") !== process.env.SESSION_TOKEN) return socket.destroy();
      wss.handleUpgrade(req,socket,head,ws=>wss.emit("connection",ws,req));
    } catch { socket.destroy(); }
  });
  server.listen(PORT,"0.0.0.0",()=>console.log(`HTTP server listening on ${PORT}`));
}

function startVirtualDisplay() {
  const { spawn } = require("child_process");
  spawn("Xvfb",[":99","-screen","0","1280x900x24","-ac"],{stdio:"ignore"});
  spawn("fluxbox",[],{env:{...process.env,DISPLAY:":99"},stdio:"ignore"});
  spawn("x11vnc",["-display",":99","-forever","-shared","-nopw","-rfbport","5900"],{stdio:"ignore"});
  spawn("websockify",["--web=/usr/share/novnc/","6080","localhost:5900"],{stdio:"ignore"});
}

async function getBrowser() {
  if (context) return context;

  context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
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

async function login(ctx) {
  await ctx.reply("⏳ Запускаю браузер TikTok...");
  try {
    await openTikTok("/login");
    const host = process.env.RENDER_EXTERNAL_HOSTNAME;
    if (!host) throw new Error("Render не передал RENDER_EXTERNAL_HOSTNAME");
    const link = `https://${host}/browser?token=${encodeURIComponent(process.env.SESSION_TOKEN)}`;
    await ctx.reply("🔐 Открой браузер по кнопке и выполни вход в TikTok вручную:", Markup.inlineKeyboard([[Markup.button.url("🌐 Открыть браузер", link)]]));
    await ctx.reply("После входа вернись сюда. Пароль в Telegram отправлять не нужно.");
  } catch (e) {
    await ctx.reply("❌ " + e.message);
  }
}

bot.command("login", login);

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
        "Открой ссылку на браузер, которую бот пришлёт следующим сообщением."
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

startVirtualDisplay();
startHealthServer();

bot.launch().then(() => {
  console.log("TikTok Manager bot started");
  console.log("PORT:", PORT);
}).catch(err => {
  console.error("Bot failed to start:", err);
  process.exit(1);
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
