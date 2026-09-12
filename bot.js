const TelegramBot = require("node-telegram-bot-api");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");
const https = require("https");

const TikTokUploader = require("./tiktok_uploader");
const { buildHashtags, refreshTrending, BRAND_TAG } = require("./tiktok_uploader");
const { TikTokWarmer } = require("./warmer");
const { generateFingerprint } = require("./fingerprint");
const proxyMgr = require("./proxy_manager");
const factory = require("./account_factory");
const store = require("./accounts_store");

/* ============================================================
 *  КОНФИГ
 * ============================================================ */

const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) { console.error("BOT_TOKEN is not set"); process.exit(1); }

const DEFAULT_INSERT = Number(process.env.INSERT_AT_SECONDS || 5);
const DEFAULT_DURATION = Number(process.env.BANNER_DURATION || 4);
const MAX_MB = Number(process.env.MAX_VIDEO_MB || 49);
const HEADLESS = String(process.env.HEADLESS || "true") !== "false";

const ROOT = __dirname;
const BANNER = path.join(ROOT, "banner.mp4");
const TMP = path.join(os.tmpdir(), "zenodrop-tiktok");
fs.mkdirSync(TMP, { recursive: true });

if (!fs.existsSync(BANNER)) {
  console.error("banner.mp4 not found");
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: true });
const sessions = new Map();
const accounts = new Map();
const factoryJobs = new Map();

/* ============================================================
 *  УТИЛИТЫ (без изменений)
 * ============================================================ */

function cleanup(...files) {
  for (const f of files) { try { if (f) fs.unlinkSync(f); } catch {} }
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args);
    let stderr = "", stdout = "";
    p.stdout?.on("data", d => stdout += d.toString());
    p.stderr?.on("data", d => stderr += d.toString());
    p.on("error", reject);
    p.on("close", code => {
      if (code === 0) return resolve({ stdout, stderr });
      const text = (stderr || stdout || `exit ${code}`).slice(-9000);
      reject(new Error(`FFmpeg exit ${code}\n${text}`));
    });
  });
}

async function probe(file) {
  return new Promise((resolve, reject) => {
    const p = spawn("ffprobe", [
      "-v", "error",
      "-show_entries",
      "format=duration:stream=index,codec_type,width,height,r_frame_rate,sample_rate,channel_layout,channels",
      "-of", "json", file
    ]);
    let out = "", err = "";
    p.stdout.on("data", d => out += d.toString());
    p.stderr.on("data", d => err += d.toString());
    p.on("error", reject);
    p.on("close", code => {
      if (code !== 0) return reject(new Error(err || `ffprobe exit ${code}`));
      try {
        const j = JSON.parse(out);
        const streams = j.streams || [];
        const video = streams.find(x => x.codec_type === "video");
        const audio = streams.find(x => x.codec_type === "audio");
        resolve({
          duration: Number(j.format?.duration || 0),
          width: video?.width || 1280,
          height: video?.height || 720,
          hasAudio: !!audio,
          sampleRate: Number(audio?.sample_rate || 48000),
          channelLayout: audio?.channel_layout || (Number(audio?.channels) === 1 ? "mono" : "stereo")
        });
      } catch (e) { reject(e); }
    });
  });
}

async function download(fileId, dest) {
  const f = await bot.getFile(fileId);
  const url = `https://api.telegram.org/file/bot${TOKEN}/${f.file_path}`;
  await new Promise((resolve, reject) => {
    const stream = fs.createWriteStream(dest);
    const req = https.get(url, res => {
      if (res.statusCode !== 200) { stream.close(); cleanup(dest); return reject(new Error(`Telegram HTTP ${res.statusCode}`)); }
      res.pipe(stream);
      stream.on("finish", () => stream.close(resolve));
    });
    req.on("error", e => { stream.close(); cleanup(dest); reject(e); });
  });
}

function isTikTokUrl(text) {
  try {
    const u = new URL(text.trim());
    return /(^|\.)tiktok\.com$/i.test(u.hostname) || /(^|\.)vm\.tiktok\.com$/i.test(u.hostname);
  } catch { return false; }
}
function isUrl(text) {
  try { const u = new URL(text.trim()); return u.protocol === "http:" || u.protocol === "https:"; } catch { return false; }
}

function runCommand(cmd, args, label = cmd) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args);
    let stderr = "", stdout = "";
    p.stdout?.on("data", d => stdout += d.toString());
    p.stderr?.on("data", d => stderr += d.toString());
    p.on("error", err => reject(new Error(`${label}: ${err.message}`)));
    p.on("close", code => {
      if (code === 0) return resolve({ stdout, stderr });
      const text = (stderr || stdout || `exit ${code}`).slice(-7000);
      reject(new Error(`${label} exit ${code}\n${text}`));
    });
  });
}

async function downloadTikTok(url, dest) {
  await runCommand("yt-dlp", [
    "--no-playlist", "--no-warnings", "--restrict-filenames",
    "-f", "bv*+ba/b", "--merge-output-format", "mp4", "-o", dest, url
  ], "yt-dlp");
  if (!fs.existsSync(dest)) throw new Error("yt-dlp не создал видеофайл.");
  const size = fs.statSync(dest).size;
  if (size > MAX_MB * 1024 * 1024) {
    cleanup(dest);
    throw new Error(`Слишком большое: ${(size / 1024 / 1024).toFixed(1)} МБ. Максимум ${MAX_MB} МБ.`);
  }
}

/* ============================================================
 *  БАННЕР-РЕНДЕР (тот же)
 * ============================================================ */

async function renderVideo(input, output, insertAt, bannerDuration, count) {
  const info = await probe(input);
  const bannerInfo = await probe(BANNER);
  if (info.duration < 0.2) throw new Error("Видео слишком короткое.");

  const t = Math.max(0, Math.min(Number(insertAt), info.duration));
  const dur = Math.max(0.5, Math.min(60, Number(bannerDuration)));
  const n = Math.max(1, Math.min(3, Number(count)));

  if (t <= 0.01) throw new Error("Секунда вставки должна быть > 0.");
  if (t >= info.duration - 0.03) throw new Error(`Секунда должна быть < ${(info.duration - 0.03).toFixed(2)}`);

  const filterParts = [];
  filterParts.push(`[0:v]trim=start=0:end=${t},setpts=PTS-STARTPTS[pre]`);
  filterParts.push(
    `[0:v]trim=start=${t}:end=${Math.min(t + 0.04, info.duration)},setpts=PTS-STARTPTS,` +
    `tpad=stop_mode=clone:stop_duration=${dur},trim=duration=${dur},setpts=PTS-STARTPTS[freeze]`
  );

  const scale = n === 1 ? 0.62 : n === 2 ? 0.47 : 0.36;
  for (let i = 0; i < n; i++) {
    filterParts.push(
      `[${i + 1}:v]scale=w=iw*${scale}:h=-2:force_original_aspect_ratio=decrease,` +
      `format=rgba,setpts=PTS-STARTPTS[b${i}]`
    );
  }

  const ys = n === 1
    ? ["(H-h)/2"]
    : n === 2
      ? ["H*0.22-h/2", "H*0.78-h/2"]
      : ["H*0.17-h/2", "(H-h)/2", "H*0.83-h/2"];

  let current = "freeze";
  for (let i = 0; i < n; i++) {
    const next = `ov${i}`;
    filterParts.push(`[${current}][b${i}]overlay=x=(W-w)/2:y=${ys[i]}:shortest=1[${next}]`);
    current = next;
  }

  filterParts.push(
    `[0:v]trim=start=${t},setpts=PTS-STARTPTS[post]`,
    `[pre][${current}][post]concat=n=3:v=1:a=0[vout]`
  );

  const args = ["-y", "-i", input];
  for (let i = 0; i < n; i++) args.push("-stream_loop", "-1", "-i", BANNER);

  if (info.hasAudio) {
    const sr = Number.isFinite(info.sampleRate) ? info.sampleRate : 48000;
    const layout = info.channelLayout || "stereo";
    filterParts.push(
      `[0:a]atrim=start=0:end=${t},asetpts=PTS-STARTPTS[apre]`,
      `[0:a]atrim=start=${t},asetpts=PTS-STARTPTS[apost]`
    );
    if (bannerInfo.hasAudio) {
      filterParts.push(
        `[1:a]atrim=start=0:duration=${dur},asetpts=PTS-STARTPTS,` +
        `aformat=sample_rates=${sr}:channel_layouts=${layout}[abanner]`
      );
    } else {
      filterParts.push(`anullsrc=r=${sr}:cl=${layout},atrim=duration=${dur},asetpts=PTS-STARTPTS[abanner]`);
    }
    filterParts.push(`[apre][abanner][apost]concat=n=3:v=0:a=1[aout]`);
    args.push(
      "-filter_complex", filterParts.join(";"),
      "-map", "[vout]", "-map", "[aout]",
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "27",
      "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k",
      "-movflags", "+faststart", "-threads", "0", output
    );
  } else {
    args.push(
      "-filter_complex", filterParts.join(";"),
      "-map", "[vout]", "-an",
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "27",
      "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-threads", "0", output
    );
  }

  await run("ffmpeg", args);
}

/* ============================================================
 *  КЛАВИАТУРЫ
 * ============================================================ */

function settingsKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "⏱ Секунда", callback_data: "time" }, { text: "⏳ Длительность", callback_data: "duration" }],
      [{ text: "🖼 1", callback_data: "count1" }, { text: "🖼 2", callback_data: "count2" }, { text: "🖼 3", callback_data: "count3" }],
      [{ text: "🚀 ОБРАБОТАТЬ БАННЕР", callback_data: "render" }]
    ]
  };
}

function mainMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "➕ Добавить аккаунт вручную", callback_data: "add_account" }],
      [{ text: "🏭 Массовое создание", callback_data: "factory" }],
      [{ text: "📋 Список аккаунтов", callback_data: "list_accounts" }],
      [{ text: "🔥 Прогреть все", callback_data: "warm_all" }],
      [{ text: "🌐 Прокси", callback_data: "proxies" }],
      [{ text: "🏷 Сменить ник", callback_data: "change_nick" }],
      [{ text: "📊 Статус", callback_data: "status" }]
    ]
  };
}

function accountsKeyboard(prefix) {
  const rows = [];
  for (const [id, acc] of accounts) {
    rows.push([
      { text: `${prefix} ${acc.name} (${acc.status})`, callback_data: `${prefix === "📤" ? "post_" : "warm_"}${id}` },
      { text: "🏷", callback_data: `preview_tags_${id}` }
    ]);
  }
  return { inline_keyboard: rows };
}

function showSettings(chatId) {
  const s = sessions.get(chatId);
  return bot.sendMessage(
    chatId,
    `⚙️ Настройки баннера\n\n⏱ Вставка: ${s.insertAt} сек.\n⏳ Баннер: ${s.duration} сек.\n🖼 Баннеров: ${s.count}`,
    { reply_markup: settingsKeyboard() }
  );
}

/* ============================================================
 *  ИНИЦИАЛИЗАЦИЯ
 * ============================================================ */

(async () => {
  store.initDB();
  await store.migrate();

  // Загружаем аккаунты в память
  try {
    const list = await store.loadAllAccounts();
    for (const a of list) {
      a.uploader = new TikTokUploader({
        proxy: a.proxy,
        fingerprint: a.fingerprint,
        cookies: a.cookies,
        accountId: a.id,
        headless: HEADLESS,
        onCookies: async (cks) => { await store.saveCookies(a.id, cks); }
      });
      accounts.set(a.id, a);
    }
    console.log(`[init] loaded ${accounts.size} accounts`);
  } catch (e) {
    console.error('[init] load accounts error:', e.message);
  }

  refreshTrending().catch(() => {});
  setInterval(() => refreshTrending().catch(() => {}), 24 * 60 * 60 * 1000);
})();

/* ============================================================
 *  КОМАНДЫ
 * ============================================================ */

bot.onText(/^\/start$/, msg => {
  bot.sendMessage(msg.chat.id,
    "🤖 *Zenodrop TikTok Farm v5*\n\n" +
    "• /menu — меню\n" +
    "• Отправь видео или ссылку TikTok — обработка\n" +
    "• Отправь `login:password:name:tag1,tag2` — добавить аккаунт вручную",
    { parse_mode: "Markdown", reply_markup: mainMenuKeyboard() });
});

bot.onText(/^\/menu$/, msg => {
  bot.sendMessage(msg.chat.id, "📋 Меню:", { reply_markup: mainMenuKeyboard() });
});

/* ============================================================
 *  ОБРАБОТКА ВИДЕО
 * ============================================================ */

bot.on("video", async msg => {
  const chatId = msg.chat.id;
  const size = Number(msg.video.file_size || 0);
  if (size && size > MAX_MB * 1024 * 1024) return bot.sendMessage(chatId, `❌ Максимум ${MAX_MB} МБ.`);

  const input = path.join(TMP, `${crypto.randomUUID()}_input.mp4`);
  try {
    await bot.sendMessage(chatId, "⬇️ Получаю видео...");
    await download(msg.video.file_id, input);
    const info = await probe(input);

    const old = sessions.get(chatId);
    if (old) cleanup(old.input, old.rendered);

    sessions.set(chatId, {
      input,
      insertAt: Math.min(DEFAULT_INSERT, Math.max(0.1, info.duration - 0.1)),
      duration: DEFAULT_DURATION,
      count: 1,
      waiting: null,
      videoDuration: info.duration,
      caption: msg.caption || "",
      rendered: null
    });
    await showSettings(chatId);
  } catch (e) {
    console.error(e);
    cleanup(input);
    bot.sendMessage(chatId, "❌ Не удалось получить видео.");
  }
});

/* ============================================================
 *  ТЕКСТ
 * ============================================================ */

bot.on("message", async msg => {
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();
  if (!text || text.startsWith("/")) return;

  // Состояния диалога
  const job = factoryJobs.get(chatId);
  if (job && job.waiting) {
    if (job.waiting === "count") {
      const n = Number(text);
      if (!Number.isFinite(n) || n < 1 || n > 100) return bot.sendMessage(chatId, "❌ Введи число 1..100");
      job.count = n;
      job.waiting = "niche";
      return bot.sendMessage(chatId, "📝 Введи нишу через запятую (или `-` чтобы пропустить):");
    }
    if (job.waiting === "niche") {
      job.niche = text === "-" ? null : text.split(',').map(s => s.trim().toLowerCase());
      job.waiting = null;
      return startFactory(chatId, job);
    }
  }

  if (isTikTokUrl(text)) {
    const input = path.join(TMP, `${crypto.randomUUID()}_tiktok.mp4`);
    try {
      const old = sessions.get(chatId);
      if (old) cleanup(old.input, old.rendered);
      await bot.sendMessage(chatId, "⬇️ Скачиваю TikTok...");
      await downloadTikTok(text, input);
      const info = await probe(input);
      sessions.set(chatId, {
        input,
        insertAt: Math.min(DEFAULT_INSERT, Math.max(0.1, info.duration - 0.1)),
        duration: DEFAULT_DURATION, count: 1, waiting: null,
        videoDuration: info.duration, caption: "", rendered: null
      });
      await showSettings(chatId);
    } catch (e) {
      cleanup(input);
      await bot.sendMessage(chatId, `❌ ${String(e.message).slice(0, 800)}`);
    }
    return;
  }

  if (isUrl(text)) return bot.sendMessage(chatId, "❌ Только TikTok ссылки.");

  // Добавление аккаунта вручную
  const accMatch = text.match(/^([^:]+):([^:]+):([^:]+)(?::(.+))?$/);
  if (accMatch && !sessions.get(chatId)) {
    const [, login, password, name, nicheStr] = accMatch;
    const id = crypto.randomUUID().slice(0, 12);
    const fingerprint = generateFingerprint(id);
    const proxy = await proxyMgr.acquireProxyForAccount(id, null);
    const acc = {
      id, name: name.trim(), login: login.trim(), password: password.trim(),
      niche: nicheStr ? nicheStr.split(',').map(s => s.trim().toLowerCase()) : null,
      proxy, fingerprint, cookies: null, status: "new", postsCount: 0
    };
    acc.uploader = new TikTokUploader({
      proxy, fingerprint, accountId: id, headless: HEADLESS,
      onCookies: async (cks) => { await store.saveCookies(id, cks); }
    });
    accounts.set(id, acc);
    await store.saveAccount(acc);
    return bot.sendMessage(chatId,
      `✅ Аккаунт "${acc.name}" добавлен.\nID: \`${id}\`\nПрокси: ${proxy ? proxy.server : 'нет (free)'}`,
      { parse_mode: "Markdown" });
  }

  // Остальные состояния
  const s = sessions.get(chatId);
  if (!s) return;

  if (s.waiting === "time") {
    const v = Number(text.replace(",", "."));
    if (!Number.isFinite(v) || v < 0 || v >= s.videoDuration - 0.03)
      return bot.sendMessage(chatId, `❌ 0..${(s.videoDuration - 0.03).toFixed(2)}`);
    s.insertAt = v; s.waiting = null;
    return showSettings(chatId);
  }
  if (s.waiting === "duration") {
    const v = Number(text.replace(",", "."));
    if (!Number.isFinite(v) || v < 0.5 || v > 60) return bot.sendMessage(chatId, "❌ 0.5..60");
    s.duration = v; s.waiting = null;
    return showSettings(chatId);
  }
});

/* ============================================================
 *  CALLBACK
 * ============================================================ */

bot.on("callback_query", async q => {
  const chatId = q.message.chat.id;
  const s = sessions.get(chatId);
  const data = q.data;

  /* --- МЕНЮ --- */
  if (data === "add_account") {
    await bot.answerCallbackQuery(q.id);
    return bot.sendMessage(chatId,
      "➕ `login:password:name:tag1,tag2`\n\nПример:\n`user@mail.com:pass123:myacc:dropshipping,ecommerce`",
      { parse_mode: "Markdown" });
  }

  if (data === "list_accounts") {
    await bot.answerCallbackQuery(q.id);
    if (accounts.size === 0) return bot.sendMessage(chatId, "📋 Пусто.");
    let txt = `📋 *Аккаунты (${accounts.size}):*\n\n`;
    let i = 1;
    for (const [id, acc] of accounts) {
      txt += `${i++}. *${acc.name}* (\`${id}\`)\n`;
      txt += `   ${acc.login} | ${acc.status}\n`;
      if (acc.proxy) txt += `   🌐 ${acc.proxy.server}\n`;
      if (acc.niche) txt += `   🏷 ${acc.niche.join(', ')}\n`;
      txt += `\n`;
      if (i > 30) { txt += `... и ещё ${accounts.size - 30}\n`; break; }
    }
    return bot.sendMessage(chatId, txt, { parse_mode: "Markdown" });
  }

  if (data === "status") {
    await bot.answerCallbackQuery(q.id);
    const proxies = await store.loadAllProxies();
    const free = proxies.filter(p => p.status === 'free').length;
    const busy = proxies.filter(p => p.status === 'busy').length;
    let txt = `📊 *Статус*\n\nАккаунтов: ${accounts.size}\nСессий: ${sessions.size}\n\n`;
    txt += `Прокси: всего ${proxies.length}\n🟢 free: ${free}\n🔴 busy: ${busy}\n\n`;
    const stats = {};
    for (const acc of accounts.values()) stats[acc.status] = (stats[acc.status] || 0) + 1;
    for (const [st, cnt] of Object.entries(stats)) txt += `${st}: ${cnt}\n`;
    return bot.sendMessage(chatId, txt, { parse_mode: "Markdown" });
  }

  /* --- ФАБРИКА --- */
  if (data === "factory") {
    await bot.answerCallbackQuery(q.id);
    factoryJobs.set(chatId, { waiting: "count" });
    return bot.sendMessage(chatId,
      "🏭 *Массовое создание аккаунтов*\n\nСколько аккаунтов создать? (1..100)\n\n" +
      "⚠️ Требуется свободный пул прокси и почтовый провайдер.",
      { parse_mode: "Markdown" });
  }

  /* --- ПРОКСИ --- */
  if (data === "proxies") {
    await bot.answerCallbackQuery(q.id);
    const list = await store.loadAllProxies();
    const free = list.filter(p => p.status === 'free').length;
    const busy = list.filter(p => p.status === 'busy').length;
    return bot.sendMessage(chatId,
      `🌐 *Прокси*\n\nВсего: ${list.length}\n🟢 free: ${free}\n🔴 busy: ${busy}\n\n` +
      `Отправь список прокси одним сообщением, каждый с новой строки:\n\n` +
      "`scheme://user:pass@host:port`\n`host:port:user:pass`\n`host:port`",
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "📥 Проверить все", callback_data: "proxy_check" }],
            [{ text: "🗑 Очистить", callback_data: "proxy_clear" }]
          ]
        }
      });
  }

  if (data === "proxy_check") {
    await bot.answerCallbackQuery(q.id);
    const list = await store.loadAllProxies();
    await bot.sendMessage(chatId, `🔍 Проверяю ${list.length} прокси...`);
    let ok = 0, fail = 0;
    for (const p of list) {
      const r = await proxyMgr.checkProxy(p);
      if (r.ok) ok++;
      else {
        fail++;
        await store.saveProxy({ ...p, status: 'dead' });
      }
    }
    return bot.sendMessage(chatId, `✅ Живых: ${ok}\n❌ Мёртвых: ${fail}`);
  }

  if (data === "proxy_clear") {
    await bot.answerCallbackQuery(q.id);
    return bot.sendMessage(chatId, "⚠️ Очистка не реализована — удаляй строки напрямую в БД.");
  }

  /* --- СМЕНА НИКА --- */
  if (data === "change_nick") {
    await bot.answerCallbackQuery(q.id);
    if (accounts.size === 0) return bot.sendMessage(chatId, "❌ Нет аккаунтов.");
    const rows = [];
    for (const [id, acc] of accounts) {
      rows.push([{ text: `🏷 ${acc.name}`, callback_data: `nick_${id}` }]);
    }
    return bot.sendMessage(chatId, "🏷 Выбери аккаунт:", { reply_markup: { inline_keyboard: rows } });
  }

  if (data.startsWith("nick_")) {
    const id = data.slice(5);
    await bot.answerCallbackQuery(q.id);
    accounts.forEach(a => a.__waitNick = false);
    const acc = accounts.get(id);
    if (acc) acc.__waitNick = true;
    return bot.sendMessage(chatId,
      `🏷 Введи новый ник для *${acc?.name}*:\n\n` +
      `Рекомендую формат: \`zenodrop_XXXX\`\n\nОтправь ник одним сообщением.`,
      { parse_mode: "Markdown" });
  }

  /* --- ПРОГРЕВ ВСЕХ --- */
  if (data === "warm_all") {
    await bot.answerCallbackQuery(q.id);
    return startWarmAll(chatId);
  }

  /* --- ПРОГРЕВ ОДНОГО --- */
  if (data.startsWith("warm_")) {
    const id = data.slice(5);
    await bot.answerCallbackQuery(q.id);
    return startWarm(chatId, id);
  }

  /* --- ПРЕВЬЮ ХЕШТЕГОВ --- */
  if (data.startsWith("preview_tags_")) {
    const id = data.slice("preview_tags_".length);
    await bot.answerCallbackQuery(q.id);
    const acc = accounts.get(id);
    if (!acc) return bot.sendMessage(chatId, "❌ Нет.");
    const tags = buildHashtags({ niche: acc.niche || undefined });
    return bot.sendMessage(chatId, `🏷 *${acc.name}*\n\n${tags.join(' ')}\n\nВсего: ${tags.length}`, { parse_mode: "Markdown" });
  }

  /* --- БАННЕР --- */
  if (!s) return bot.answerCallbackQuery(q.id, { text: "Сначала видео." });

  if (data === "time") {
    s.waiting = "time";
    await bot.answerCallbackQuery(q.id);
    return bot.sendMessage(chatId, "⏱ На какой секунде вставить баннер?");
  }
  if (data === "duration") {
    s.waiting = "duration";
    await bot.answerCallbackQuery(q.id);
    return bot.sendMessage(chatId, "⏳ Длительность баннера в секундах?");
  }
  if (/^count[123]$/.test(data)) {
    s.count = Number(data.slice(-1));
    await bot.answerCallbackQuery(q.id, { text: `Баннеров: ${s.count}` });
    return showSettings(chatId);
  }

  if (data === "render") {
    await bot.answerCallbackQuery(q.id);
    const output = path.join(TMP, `${crypto.randomUUID()}_rendered.mp4`);
    try {
      await bot.sendMessage(chatId, "🎬 Вставляю баннер...");
      await renderVideo(s.input, output, s.insertAt, s.duration, s.count);
      s.rendered = output;
      await bot.sendVideo(chatId, output, { caption: "✅ Готово", supports_streaming: true });
      if (accounts.size === 0) return bot.sendMessage(chatId, "❌ Нет аккаунтов.");
      await bot.sendMessage(chatId, "📤 Куда заливаем?", { reply_markup: accountsKeyboard("📤") });
    } catch (e) {
      console.error(e);
      await bot.sendMessage(chatId, `❌ ${String(e.message).slice(0, 1000)}`);
    }
    return;
  }

  if (data.startsWith("post_")) {
    const id = data.slice(5);
    await bot.answerCallbackQuery(q.id);
    if (!s?.rendered) return bot.sendMessage(chatId, "❌ Сначала баннер.");
    return startPost(chatId, id, s);
  }
});

/* ============================================================
 *  СМЕНА НИКА — текстовый обработчик
 * ============================================================ */

bot.on("message", async msg => {
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();
  if (!text) return;
  for (const [id, acc] of accounts) {
    if (acc.__waitNick) {
      acc.__waitNick = false;
      await bot.sendMessage(chatId, `🏷 Меняю ник на "${text}"...`);
      try {
        await acc.uploader.init();
        const r = await acc.uploader.setNickname(text);
        if (r.success) {
          acc.name = text;
          await store.saveAccount(acc);
          await bot.sendMessage(chatId, `✅ Ник изменён на "${text}"`);
        } else {
          await bot.sendMessage(chatId, `❌ ${r.error || 'не удалось'}`);
        }
      } catch (e) {
        await bot.sendMessage(chatId, `❌ ${e.message}`);
      } finally {
        await acc.uploader.close();
      }
      return;
    }
  }
});

/* ============================================================
 *  ПРОКСИ — импорт из сообщения
 * ============================================================ */

bot.on("message", async msg => {
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();
  if (!text) return;

  // Эвристика: если много строк, и в них есть "://" или ":" с портом — это прокси
  const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (lines.length >= 2) {
    const looksLikeProxy = lines.every(l =>
      /^[a-z]+:\/\//i.test(l) ||
      /^\d{1,3}(\.\d{1,3}){3}:\d+/.test(l) ||
      /^[^\s:]+:\d+:[^\s:]+:[^\s:]+$/.test(l) ||
      /^[^\s@]+:[^\s@]+@[^\s:]+:\d+$/.test(l)
    );
    if (looksLikeProxy) {
      await bot.sendMessage(chatId, `🌐 Импортирую ${lines.length} строк...`);
      const r = await proxyMgr.importProxies(text, 'telegram');
      return bot.sendMessage(chatId, `✅ Добавлено: ${r.added}\n⏭ Пропущено: ${r.skipped}`);
    }
  }
});

/* ============================================================
 *  ФАБРИКА
 * ============================================================ */

async function startFactory(chatId, job) {
  const { count, niche } = job;
  factoryJobs.delete(chatId);

  await bot.sendMessage(chatId,
    `🏭 Запускаю создание ${count} аккаунтов...\nНиша: ${niche ? niche.join(', ') : 'общая'}`);

  const created = [];
  try {
    const r = await factory.createBatch({
      count,
      emailProvider: 'mail.tm',
      niche,
      startSeq: 1,
      concurrency: 2,
      log: (m) => console.log(m),
      onProgress: async ({ done, total, last }) => {
        if (done % 5 === 0 || done === total) {
          await bot.sendMessage(chatId, `⏳ ${done}/${total} (последний: ${last.success ? '✅' : '❌ ' + last.reason})`).catch(() => {});
        }
      }
    });

    // Загружаем созданные в память
    for (const acc of r.ok) {
      acc.uploader = new TikTokUploader({
        proxy: acc.proxy,
        fingerprint: acc.fingerprint,
        cookies: acc.cookies,
        accountId: acc.id,
        headless: HEADLESS,
        onCookies: async (cks) => { await store.saveCookies(acc.id, cks); }
      });
      accounts.set(acc.id, acc);
    }

    await bot.sendMessage(chatId,
      `✅ Создано: ${r.ok.length}\n❌ Ошибок: ${r.fail.length}\n\n` +
      (r.fail.length ? `Причины:\n${r.fail.slice(0, 10).map(f => `#${f.seq}: ${f.reason}`).join('\n')}` : ''));
  } catch (e) {
    console.error(e);
    await bot.sendMessage(chatId, `❌ Фабрика упала: ${e.message}`);
  }
}

/* ============================================================
 *  ПРОГРЕВ
 * ============================================================ */

async function startWarm(chatId, id) {
  const acc = accounts.get(id);
  if (!acc) return bot.sendMessage(chatId, "❌ Нет аккаунта.");

  acc.status = "warming";
  await store.updateStatus(id, "warming");
  await bot.sendMessage(chatId, `🔥 Прогрев ${acc.name}...`);

  try {
    await acc.uploader.init();
    if (!acc.cookies) {
      const r = await acc.uploader.login(acc.login, acc.password);
      if (r.captcha) {
        acc.status = "captcha";
        await store.updateStatus(id, "captcha");
        return bot.sendMessage(chatId, `⚠️ Капча у ${acc.name}`);
      }
    }
    const warmer = new TikTokWarmer(acc.uploader);
    await warmer.warmAccount(3, 20);

    acc.status = "warmed";
    await store.updateStatus(id, "warmed");
    await bot.sendMessage(chatId, `✅ ${acc.name} прогрет!`);
  } catch (e) {
    acc.status = "error";
    await store.updateStatus(id, "error");
    await bot.sendMessage(chatId, `❌ ${acc.name}: ${e.message}`);
  } finally {
    await acc.uploader.close();
  }
}

async function startWarmAll(chatId) {
  if (accounts.size === 0) return bot.sendMessage(chatId, "❌ Нет аккаунтов.");
  await bot.sendMessage(chatId, `🔥 Прогреваю ${accounts.size} аккаунтов последовательно...`);
  let done = 0;
  for (const [id, acc] of accounts) {
    if (acc.status === 'warming') continue;
    try {
      await startWarm(chatId, id);
    } catch {}
    done++;
    if (done % 5 === 0) {
      await bot.sendMessage(chatId, `⏳ ${done}/${accounts.size}`).catch(() => {});
    }
    // Пауза между аккаунтами, чтобы не спалить сеть
    await new Promise(r => setTimeout(r, 30_000));
  }
  await bot.sendMessage(chatId, `✅ Прогрев завершён: ${done}`);
}

/* ============================================================
 *  ПОСТИНГ
 * ============================================================ */

async function startPost(chatId, id, session) {
  const acc = accounts.get(id);
  if (!acc) return bot.sendMessage(chatId, "❌ Нет аккаунта.");

  acc.status = "posting";
  await store.updateStatus(id, "posting");
  await bot.sendMessage(chatId, `📤 Заливаю в ${acc.name}...`);

  try {
    await acc.uploader.init();
    if (!acc.cookies) {
      const r = await acc.uploader.login(acc.login, acc.password);
      if (r.captcha) {
        acc.status = "captcha";
        await store.updateStatus(id, "captcha");
        return bot.sendMessage(chatId, `⚠️ Капча.`);
      }
    }

    const warmer = new TikTokWarmer(acc.uploader);
    await warmer.randomScroll(60);

    const hashtags = buildHashtags({ niche: acc.niche || undefined });
    await bot.sendMessage(chatId, `🏷 ${hashtags.join(' ')}`);

    const caption = session.caption || "Check this out 🔥";
    const r = await acc.uploader.uploadVideo(session.rendered, caption, { hashtags });

    acc.status = "posted";
    acc.postsCount = (acc.postsCount || 0) + 1;
    await store.updateStatus(id, "posted");
    await store.markPosted(id);
    await bot.sendMessage(chatId, `✅ ${acc.name} → ${r.url || 'OK'}`);
  } catch (e) {
    acc.status = "error";
    await store.updateStatus(id, "error");
    await bot.sendMessage(chatId, `❌ ${acc.name}: ${String(e.message).slice(0, 500)}`);
  } finally {
    await acc.uploader.close();
    if (session.input) cleanup(session.input);
    if (session.rendered) cleanup(session.rendered);
    sessions.delete(chatId);
  }
}

/* ============================================================
 *  СТАРТ
 * ============================================================ */

bot.on("polling_error", err => console.error("POLLING:", err?.message || err));
console.log("Zenodrop TikTok Farm v5 started.");
