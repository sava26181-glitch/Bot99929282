const TelegramBot = require("node-telegram-bot-api");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");
const https = require("https");
const http = require("http");

const TikTokMobile = require("./tiktok_uploader");
const { buildHashtags, refreshTrending, BRAND_TAG, DEFAULT_BIO } = require("./tiktok_uploader");
const { TikTokMobileWarmer } = require("./warmer");
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
const PORT = process.env.PORT || 3000;

const ROOT = __dirname;
const BANNER = path.join(ROOT, "banner.mp4");
const AVATAR_PATH = path.join(ROOT, "avatar.png");
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
const avatarWaiting = new Map();
const bioWaiting = new Map();

const stopFlags = {
  factory: false,
  warm: false,
  post: false
};

/* ============================================================
 *  HTTP-СЕРВЕР
 * ============================================================ */

const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      accounts: accounts.size,
      uptime: Math.floor(process.uptime()),
      ts: Date.now()
    }));
  } else {
    res.writeHead(404);
    res.end();
  }
});

server.listen(PORT, () => {
  console.log('[health] listening on port ' + PORT);
});

if (process.env.RENDER) {
  setInterval(() => {
    const hostname = process.env.RENDER_EXTERNAL_HOSTNAME;
    if (!hostname) return;
    https.get('https://' + hostname + '/health', () => {}).on('error', () => {});
  }, 12 * 60 * 1000);
  console.log('[self-ping] enabled for Render');
}

/* ============================================================
 *  УТИЛИТЫ
 * ============================================================ */

function cleanup(...files) {
  for (const f of files) { try { if (f) fs.unlinkSync(f); } catch {} }
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args);
    let stderr = "";
    let stdout = "";
    p.stdout.on("data", d => stdout += d.toString());
    p.stderr.on("data", d => stderr += d.toString());
    p.on("error", reject);
    p.on("close", code => {
      if (code === 0) return resolve({ stdout, stderr });
      const text = (stderr || stdout || 'exit ' + code).slice(-9000);
      reject(new Error('FFmpeg exit ' + code + '\n' + text));
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
    let out = "";
    let err = "";
    p.stdout.on("data", d => out += d.toString());
    p.stderr.on("data", d => err += d.toString());
    p.on("error", reject);
    p.on("close", code => {
      if (code !== 0) return reject(new Error(err || 'ffprobe exit ' + code));
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
  const url = 'https://api.telegram.org/file/bot' + TOKEN + '/' + f.file_path;
  await new Promise((resolve, reject) => {
    const stream = fs.createWriteStream(dest);
    const req = https.get(url, res => {
      if (res.statusCode !== 200) { stream.close(); cleanup(dest); return reject(new Error('Telegram HTTP ' + res.statusCode)); }
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

function runCommand(cmd, args, label) {
  label = label || cmd;
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args);
    let stderr = "";
    let stdout = "";
    p.stdout.on("data", d => stdout += d.toString());
    p.stderr.on("data", d => stderr += d.toString());
    p.on("error", err => reject(new Error(label + ': ' + err.message)));
    p.on("close", code => {
      if (code === 0) return resolve({ stdout, stderr });
      const text = (stderr || stdout || 'exit ' + code).slice(-7000);
      reject(new Error(label + ' exit ' + code + '\n' + text));
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
    throw new Error('Слишком большое: ' + (size / 1024 / 1024).toFixed(1) + ' МБ. Максимум ' + MAX_MB + ' МБ.');
  }
}

/* ============================================================
 *  БАННЕР-РЕНДЕР
 * ============================================================ */

async function renderVideo(input, output, insertAt, bannerDuration, count) {
  const info = await probe(input);
  const bannerInfo = await probe(BANNER);
  if (info.duration < 0.2) throw new Error("Видео слишком короткое.");

  const t = Math.max(0, Math.min(Number(insertAt), info.duration));
  const dur = Math.max(0.5, Math.min(60, Number(bannerDuration)));
  const n = Math.max(1, Math.min(3, Number(count)));

  if (t <= 0.01) throw new Error("Секунда вставки должна быть > 0.");
  if (t >= info.duration - 0.03) throw new Error('Секунда должна быть < ' + (info.duration - 0.03).toFixed(2));

  const filterParts = [];
  filterParts.push('[0:v]trim=start=0:end=' + t + ',setpts=PTS-STARTPTS[pre]');
  filterParts.push(
    '[0:v]trim=start=' + t + ':end=' + Math.min(t + 0.04, info.duration) + ',setpts=PTS-STARTPTS,' +
    'tpad=stop_mode=clone:stop_duration=' + dur + ',trim=duration=' + dur + ',setpts=PTS-STARTPTS[freeze]'
  );

  const scale = n === 1 ? 0.62 : n === 2 ? 0.47 : 0.36;
  for (let i = 0; i < n; i++) {
    filterParts.push(
      '[' + (i + 1) + ':v]scale=w=iw*' + scale + ':h=-2:force_original_aspect_ratio=decrease,' +
      'format=rgba,setpts=PTS-STARTPTS[b' + i + ']'
    );
  }

  const ys = n === 1
    ? ["(H-h)/2"]
    : n === 2
      ? ["H*0.22-h/2", "H*0.78-h/2"]
      : ["H*0.17-h/2", "(H-h)/2", "H*0.83-h/2"];

  let current = "freeze";
  for (let i = 0; i < n; i++) {
    const next = 'ov' + i;
    filterParts.push('[' + current + '][b' + i + ']overlay=x=(W-w)/2:y=' + ys[i] + ':shortest=1[' + next + ']');
    current = next;
  }

  filterParts.push(
    '[0:v]trim=start=' + t + ',setpts=PTS-STARTPTS[post]',
    '[pre][' + current + '][post]concat=n=3:v=1:a=0[vout]'
  );

  const args = ["-y", "-i", input];
  for (let i = 0; i < n; i++) args.push("-stream_loop", "-1", "-i", BANNER);

  if (info.hasAudio) {
    const sr = Number.isFinite(info.sampleRate) ? info.sampleRate : 48000;
    const layout = info.channelLayout || "stereo";
    filterParts.push(
      '[0:a]atrim=start=0:end=' + t + ',asetpts=PTS-STARTPTS[apre]',
      '[0:a]atrim=start=' + t + ',asetpts=PTS-STARTPTS[apost]'
    );
    if (bannerInfo.hasAudio) {
      filterParts.push(
        '[1:a]atrim=start=0:duration=' + dur + ',asetpts=PTS-STARTPTS,' +
        'aformat=sample_rates=' + sr + ':channel_layouts=' + layout + '[abanner]'
      );
    } else {
      filterParts.push('anullsrc=r=' + sr + ':cl=' + layout + ',atrim=duration=' + dur + ',asetpts=PTS-STARTPTS[abanner]');
    }
    filterParts.push('[apre][abanner][apost]concat=n=3:v=0:a=1[aout]');
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
 *  ЛОГИН
 * ============================================================ */

async function ensureLoggedIn(chatId, acc) {
  if (acc.cookies && acc.cookies.includes('sessionid=')) {
    return true;
  }
  
  await bot.sendMessage(chatId, 'Логинюсь в ' + acc.name + '...');
  const result = await acc.uploader.login(acc.login, acc.password);
  
  console.log('[LOGIN RAW]:', JSON.stringify(result).slice(0, 500));
  
  if (result && result.data && result.data.session_key) {
    acc.cookies = 'sessionid=' + result.data.session_key;
    await store.saveCookies(acc.id, acc.cookies);
    await bot.sendMessage(chatId, 'Залогинен в ' + acc.name + '.');
    return true;
  }
  
  if (result && (result.message === 'captcha' || (result.data && result.data.captcha))) {
    throw new Error('Капча при логине');
  }
  
  throw new Error('Логин не удался: ' + JSON.stringify(result).slice(0, 200));
}

/* ============================================================
 *  КЛАВИАТУРЫ
 * ============================================================ */

function settingsKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "Секунда", callback_data: "time" }, { text: "Длительность", callback_data: "duration" }],
      [{ text: "1", callback_data: "count1" }, { text: "2", callback_data: "count2" }, { text: "3", callback_data: "count3" }],
      [{ text: "ОБРАБОТАТЬ БАННЕР", callback_data: "render" }]
    ]
  };
}

function mainMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "Добавить аккаунт вручную", callback_data: "add_account" }],
      [{ text: "Массовое создание", callback_data: "factory" }],
      [{ text: "Список аккаунтов", callback_data: "list_accounts" }],
      [{ text: "Прогреть все", callback_data: "warm_all" }],
      [{ text: "Аватарка на все", callback_data: "set_avatar_all" }],
      [{ text: "Био на все", callback_data: "set_bio_all" }],
      [{ text: "Прокси", callback_data: "proxies" }],
      [{ text: "Сменить ник", callback_data: "change_nick" }],
      [{ text: "Остановить всё", callback_data: "stop_all" }],
      [{ text: "Удалить все аккаунты", callback_data: "delete_all_accounts" }],
      [{ text: "Статус", callback_data: "status" }]
    ]
  };
}

function accountsKeyboard(prefix) {
  const rows = [];
  for (const [id, acc] of accounts) {
    rows.push([
      { text: prefix + ' ' + acc.name + ' (' + acc.status + ')', callback_data: (prefix === "post" ? "post_" : "warm_") + id },
      { text: "tags", callback_data: 'preview_tags_' + id }
    ]);
  }
  return { inline_keyboard: rows };
}

function showSettings(chatId) {
  const s = sessions.get(chatId);
  const text = 'Настройки баннера\n\nВставка: ' + s.insertAt + ' сек.\nБаннер: ' + s.duration + ' сек.\nБаннеров: ' + s.count;
  return bot.sendMessage(chatId, text, { reply_markup: settingsKeyboard() });
}

/* ============================================================
 *  ИНИЦИАЛИЗАЦИЯ
 * ============================================================ */

(async () => {
  store.initDB();
  await store.migrate();

  try {
    const list = await store.loadAllAccounts();
    for (const a of list) {
      a.uploader = new TikTokMobile({
        deviceId: a.fingerprint ? a.fingerprint.deviceId : null,
        proxy: a.proxy,
        fingerprint: a.fingerprint,
        cookies: a.cookies,
        accountId: a.id,
        onCookies: async (cks) => { await store.saveCookies(a.id, cks); }
      });
      accounts.set(a.id, a);
    }
    console.log('[init] loaded ' + accounts.size + ' accounts');
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
  const text = 'Zenodrop TikTok Farm\n\n' +
    '/menu - меню\n' +
    'Отправь видео или ссылку TikTok - обработка\n' +
    'Отправь login:password:name:tag1,tag2 - добавить аккаунт вручную';
  bot.sendMessage(msg.chat.id, text, { reply_markup: mainMenuKeyboard() });
});

bot.onText(/^\/menu$/, msg => {
  bot.sendMessage(msg.chat.id, 'Меню:', { reply_markup: mainMenuKeyboard() });
});

/* ============================================================
 *  ВИДЕО
 * ============================================================ */

bot.on("video", async msg => {
  const chatId = msg.chat.id;
  const size = Number(msg.video.file_size || 0);
  if (size && size > MAX_MB * 1024 * 1024) return bot.sendMessage(chatId, 'Максимум ' + MAX_MB + ' МБ.');

  const input = path.join(TMP, crypto.randomUUID() + '_input.mp4');
  try {
    await bot.sendMessage(chatId, "Получаю видео...");
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
    bot.sendMessage(chatId, "Не удалось получить видео.");
  }
});

/* ============================================================
 *  ФОТО
 * ============================================================ */

bot.on("photo", async msg => {
  const chatId = msg.chat.id;
  if (!avatarWaiting.get(chatId)) return;

  const photos = msg.photo;
  const fileId = photos[photos.length - 1].file_id;

  try {
    await bot.sendMessage(chatId, "Получаю изображение...");
    const f = await bot.getFile(fileId);
    const url = 'https://api.telegram.org/file/bot' + TOKEN + '/' + f.file_path;

    await new Promise((resolve, reject) => {
      const stream = fs.createWriteStream(AVATAR_PATH);
      https.get(url, res => {
        if (res.statusCode !== 200) { stream.close(); return reject(new Error('HTTP ' + res.statusCode)); }
        res.pipe(stream);
        stream.on("finish", () => stream.close(resolve));
      }).on("error", reject);
    });

    avatarWaiting.delete(chatId);
    await bot.sendMessage(chatId, 'Сохранено. Ставлю на ' + accounts.size + ' аккаунтов...');
    await applyAvatarAll(chatId, AVATAR_PATH);
  } catch (e) {
    avatarWaiting.delete(chatId);
    await bot.sendMessage(chatId, e.message);
  }
});

bot.on("document", async msg => {
  const chatId = msg.chat.id;
  if (!avatarWaiting.get(chatId)) return;
  const doc = msg.document;
  if (!doc.mime_type || !doc.mime_type.startsWith('image/')) {
    return bot.sendMessage(chatId, "Это не изображение.");
  }

  try {
    await bot.sendMessage(chatId, "Получаю файл...");
    const f = await bot.getFile(doc.file_id);
    const url = 'https://api.telegram.org/file/bot' + TOKEN + '/' + f.file_path;

    await new Promise((resolve, reject) => {
      const stream = fs.createWriteStream(AVATAR_PATH);
      https.get(url, res => {
        if (res.statusCode !== 200) { stream.close(); return reject(new Error('HTTP ' + res.statusCode)); }
        res.pipe(stream);
        stream.on("finish", () => stream.close(resolve));
      }).on("error", reject);
    });

    avatarWaiting.delete(chatId);
    await bot.sendMessage(chatId, 'Сохранено. Ставлю на ' + accounts.size + ' аккаунтов...');
    await applyAvatarAll(chatId, AVATAR_PATH);
  } catch (e) {
    avatarWaiting.delete(chatId);
    await bot.sendMessage(chatId, e.message);
  }
});

/* ============================================================
 *  ТЕКСТ
 * ============================================================ */

bot.on("message", async msg => {
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();
  if (!text || text.startsWith("/")) return;

  if (bioWaiting.get(chatId)) {
    bioWaiting.delete(chatId);
    const bio = text === '-' ? DEFAULT_BIO : text;
    await bot.sendMessage(chatId, 'Ставлю био на ' + accounts.size + ' аккаунтов...');
    await applyBioAll(chatId, bio);
    return;
  }

  const job = factoryJobs.get(chatId);
  if (job && job.waiting) {
    if (job.waiting === "count") {
      const n = Number(text);
      if (!Number.isFinite(n) || n < 1 || n > 100) return bot.sendMessage(chatId, "Введи число 1..100");
      job.count = n;
      job.waiting = "niche";
      return bot.sendMessage(chatId, "Введи нишу через запятую (или - чтобы пропустить):");
    }
    if (job.waiting === "niche") {
      job.niche = text === "-" ? null : text.split(',').map(s => s.trim().toLowerCase());
      job.waiting = null;
      return startFactory(chatId, job);
    }
  }

  if (isTikTokUrl(text)) {
    const input = path.join(TMP, crypto.randomUUID() + '_tiktok.mp4');
    try {
      const old = sessions.get(chatId);
      if (old) cleanup(old.input, old.rendered);
      await bot.sendMessage(chatId, "Скачиваю TikTok...");
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
      await bot.sendMessage(chatId, String(e.message).slice(0, 800));
    }
    return;
  }

  if (isUrl(text)) return bot.sendMessage(chatId, "Только TikTok ссылки.");

  const accMatch = text.match(/^([^:]+):([^:]+):([^:]+)(?::(.+))?$/);
  if (accMatch && !sessions.get(chatId)) {
    const login = accMatch[1];
    const password = accMatch[2];
    const name = accMatch[3];
    const nicheStr = accMatch[4];
    const id = crypto.randomUUID().slice(0, 12);
    const fingerprint = generateFingerprint(id);
    const proxy = await proxyMgr.acquireProxyForAccount(id, null);
    const acc = {
      id, name: name.trim(), login: login.trim(), password: password.trim(),
      niche: nicheStr ? nicheStr.split(',').map(s => s.trim().toLowerCase()) : null,
      proxy, fingerprint, cookies: null, status: "new", postsCount: 0,
      profileUrl: null
    };
    acc.uploader = new TikTokMobile({
      deviceId: fingerprint ? fingerprint.deviceId : null,
      proxy, fingerprint, accountId: id,
      onCookies: async (cks) => { await store.saveCookies(id, cks); }
    });
    accounts.set(id, acc);
    await store.saveAccount(acc);
    return bot.sendMessage(chatId, 'Аккаунт "' + acc.name + '" добавлен.\nID: ' + id);
  }

  const s = sessions.get(chatId);
  if (!s) return;

  if (s.waiting === "time") {
    const v = Number(text.replace(",", "."));
    if (!Number.isFinite(v) || v < 0 || v >= s.videoDuration - 0.03)
      return bot.sendMessage(chatId, '0..' + (s.videoDuration - 0.03).toFixed(2));
    s.insertAt = v; s.waiting = null;
    return showSettings(chatId);
  }
  if (s.waiting === "duration") {
    const v = Number(text.replace(",", "."));
    if (!Number.isFinite(v) || v < 0.5 || v > 60) return bot.sendMessage(chatId, "0.5..60");
    s.duration = v; s.waiting = null;
    return showSettings(chatId);
  }
});

/* ============================================================
 *  ПРОКСИ
 * ============================================================ */

bot.on("message", async msg => {
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();
  if (!text) return;

  const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (lines.length >= 2) {
    const looksLikeProxy = lines.every(l =>
      /^[a-z]+:\/\//i.test(l) ||
      /^\d{1,3}(\.\d{1,3}){3}:\d+/.test(l) ||
      /^[^\s:]+:\d+:[^\s:]+:[^\s:]+$/.test(l) ||
      /^[^\s@]+:[^\s@]+@[^\s:]+:\d+$/.test(l)
    );
    if (looksLikeProxy) {
      await bot.sendMessage(chatId, 'Импортирую ' + lines.length + ' строк...');
      const r = await proxyMgr.importProxies(text, 'telegram');
      return bot.sendMessage(chatId, 'Добавлено: ' + r.added + '\nПропущено: ' + r.skipped);
    }
  }
});

/* ============================================================
 *  CALLBACK
 * ============================================================ */

bot.on("callback_query", async q => {
  const chatId = q.message.chat.id;
  const s = sessions.get(chatId);
  const data = q.data;

  if (data === "stop_all") {
    await bot.answerCallbackQuery(q.id);
    stopFlags.factory = true;
    stopFlags.warm = true;
    stopFlags.post = true;
    return bot.sendMessage(chatId, "Сигнал остановки отправлен.");
  }

  if (data === "delete_all_accounts") {
    await bot.answerCallbackQuery(q.id);
    const text = 'Удалить все аккаунты?\n\nБудет удалено: ' + accounts.size + '\nБаза данных очищена.';
    return bot.sendMessage(chatId, text, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "ДА, УДАЛИТЬ ВСЁ", callback_data: "delete_all_confirm" }],
          [{ text: "Отмена", callback_data: "delete_all_cancel" }]
        ]
      }
    });
  }

  if (data === "delete_all_confirm") {
    await bot.answerCallbackQuery(q.id);
    try {
      const count = accounts.size;
      for (const [id, acc] of accounts) {
        if (acc.proxy && acc.proxy.id) {
          await store.releaseProxyAtomic(acc.proxy.id).catch(() => {});
        }
      }
      accounts.clear();
      await store.deleteAllAccounts();
      return bot.sendMessage(chatId, 'Удалено аккаунтов: ' + count + '.');
    } catch (e) {
      return bot.sendMessage(chatId, 'Ошибка удаления: ' + e.message);
    }
  }

  if (data === "delete_all_cancel") {
    await bot.answerCallbackQuery(q.id);
    return bot.sendMessage(chatId, "Удаление отменено.");
  }

  if (data === "add_account") {
    await bot.answerCallbackQuery(q.id);
    return bot.sendMessage(chatId, "Отправь: login:password:name:tag1,tag2");
  }

  if (data === "list_accounts") {
    await bot.answerCallbackQuery(q.id);
    if (accounts.size === 0) return bot.sendMessage(chatId, "Пусто.");
    let txt = 'Аккаунты (' + accounts.size + '):\n\n';
    let i = 1;
    for (const [id, acc] of accounts) {
      txt += i + '. ' + acc.name + ' (' + id + ')\n';
      txt += '   ' + acc.login + ' | ' + acc.status + '\n';
      if (acc.profileUrl) {
        txt += '   ' + acc.profileUrl + '\n';
      } else {
        txt += '   нет ссылки\n';
      }
      txt += '\n';
      i++;
      if (i > 30) { txt += '... и ещё ' + (accounts.size - 30) + '\n'; break; }
    }
    return bot.sendMessage(chatId, txt);
  }

  if (data === "status") {
    await bot.answerCallbackQuery(q.id);
    const stats = await store.proxyStats();
    let txt = 'Статус\n\nАккаунтов: ' + accounts.size + '\nСессий: ' + sessions.size + '\n\n';
    txt += 'Прокси: всего ' + stats.total + '\nfree: ' + stats.free + '\nbusy: ' + stats.busy + '\ndead: ' + stats.dead + '\n\n';
    txt += 'Остановка: фабрика=' + stopFlags.factory + ' прогрев=' + stopFlags.warm + ' постинг=' + stopFlags.post + '\n\n';
    const accStats = {};
    for (const acc of accounts.values()) accStats[acc.status] = (accStats[acc.status] || 0) + 1;
    for (const st of Object.keys(accStats)) txt += st + ': ' + accStats[st] + '\n';
    return bot.sendMessage(chatId, txt);
  }

  if (data === "set_avatar_all") {
    await bot.answerCallbackQuery(q.id);
    if (accounts.size === 0) return bot.sendMessage(chatId, "Нет аккаунтов.");
    avatarWaiting.set(chatId, true);
    return bot.sendMessage(chatId, "Отправь изображение.");
  }

  if (data === "set_bio_all") {
    await bot.answerCallbackQuery(q.id);
    if (accounts.size === 0) return bot.sendMessage(chatId, "Нет аккаунтов.");
    bioWaiting.set(chatId, true);
    return bot.sendMessage(chatId, 'Отправь текст био. Дефолт:\n\n' + DEFAULT_BIO + '\n\nИли - для дефолта.');
  }

  if (data === "factory") {
    await bot.answerCallbackQuery(q.id);
    stopFlags.factory = false;
    factoryJobs.set(chatId, { waiting: "count" });
    return bot.sendMessage(chatId, "Сколько аккаунтов создать? (1..100)");
  }

  if (data === "proxies") {
    await bot.answerCallbackQuery(q.id);
    const list = await store.loadAllProxies();
    const free = list.filter(p => p.status === 'free').length;
    const busy = list.filter(p => p.status === 'busy').length;
    return bot.sendMessage(chatId,
      'Прокси\n\nВсего: ' + list.length + '\nfree: ' + free + '\nbusy: ' + busy + '\n\nОтправь список прокси одним сообщением.',
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "Проверить все", callback_data: "proxy_check" }]
          ]
        }
      });
  }

  if (data === "proxy_check") {
    await bot.answerCallbackQuery(q.id);
    const list = await store.loadAllProxies();
    await bot.sendMessage(chatId, 'Проверяю ' + list.length + ' прокси...');
    let ok = 0;
    let fail = 0;
    for (const p of list) {
      const r = await proxyMgr.checkProxy(p);
      if (r.ok) ok++;
      else { fail++; await store.saveProxy(Object.assign({}, p, { status: 'dead' })); }
    }
    return bot.sendMessage(chatId, 'Живых: ' + ok + '\nМёртвых: ' + fail);
  }

  if (data === "change_nick") {
    await bot.answerCallbackQuery(q.id);
    if (accounts.size === 0) return bot.sendMessage(chatId, "Нет аккаунтов.");
    const rows = [];
    for (const [id, acc] of accounts) {
      rows.push([{ text: acc.name, callback_data: 'nick_' + id }]);
    }
    return bot.sendMessage(chatId, "Выбери аккаунт:", { reply_markup: { inline_keyboard: rows } });
  }

  if (data.startsWith("nick_")) {
    const id = data.slice(5);
    await bot.answerCallbackQuery(q.id);
    accounts.forEach(a => a.__waitNick = false);
    const acc = accounts.get(id);
    if (acc) acc.__waitNick = true;
    return bot.sendMessage(chatId, 'Введи новый ник для ' + (acc ? acc.name : '') + ':');
  }

  if (data === "warm_all") {
    await bot.answerCallbackQuery(q.id);
    stopFlags.warm = false;
    return startWarmAll(chatId);
  }

  if (data.startsWith("warm_")) {
    const id = data.slice(5);
    await bot.answerCallbackQuery(q.id);
    return startWarm(chatId, id);
  }

  if (data.startsWith("preview_tags_")) {
    const id = data.slice("preview_tags_".length);
    await bot.answerCallbackQuery(q.id);
    const acc = accounts.get(id);
    if (!acc) return bot.sendMessage(chatId, "Нет.");
    const tags = buildHashtags({ niche: acc.niche || undefined });
    return bot.sendMessage(chatId, 'Хештеги ' + acc.name + ':\n\n' + tags.join(' '));
  }

  if (!s) return bot.answerCallbackQuery(q.id, { text: "Сначала видео." });

  if (data === "time") {
    s.waiting = "time";
    await bot.answerCallbackQuery(q.id);
    return bot.sendMessage(chatId, "На какой секунде?");
  }
  if (data === "duration") {
    s.waiting = "duration";
    await bot.answerCallbackQuery(q.id);
    return bot.sendMessage(chatId, "Длительность в секундах?");
  }
  if (/^count[123]$/.test(data)) {
    s.count = Number(data.slice(-1));
    await bot.answerCallbackQuery(q.id, { text: 'Баннеров: ' + s.count });
    return showSettings(chatId);
  }

  if (data === "render") {
    await bot.answerCallbackQuery(q.id);
    const output = path.join(TMP, crypto.randomUUID() + '_rendered.mp4');
    try {
      await bot.sendMessage(chatId, "Вставляю баннер...");
      await renderVideo(s.input, output, s.insertAt, s.duration, s.count);
      s.rendered = output;
      await bot.sendVideo(chatId, output, { caption: "Готово", supports_streaming: true });
      if (accounts.size === 0) return bot.sendMessage(chatId, "Нет аккаунтов.");
      await bot.sendMessage(chatId, "Куда заливаем?", { reply_markup: accountsKeyboard("post") });
    } catch (e) {
      console.error(e);
      await bot.sendMessage(chatId, String(e.message).slice(0, 1000));
    }
    return;
  }

  if (data.startsWith("post_")) {
    const id = data.slice(5);
    await bot.answerCallbackQuery(q.id);
    if (!s || !s.rendered) return bot.sendMessage(chatId, "Сначала баннер.");
    stopFlags.post = false;
    return startPost(chatId, id, s);
  }
});

/* ============================================================
 *  СМЕНА НИКА
 * ============================================================ */

bot.on("message", async msg => {
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();
  if (!text) return;
  for (const [id, acc] of accounts) {
    if (acc.__waitNick) {
      acc.__waitNick = false;
      await bot.sendMessage(chatId, 'Меняю ник на "' + text + '"...');
      try {
        await ensureLoggedIn(chatId, acc);
        const r = await acc.uploader.setNickname(text);
        if (r && !r.error) {
          acc.name = text;
          await store.saveAccount(acc);
          await bot.sendMessage(chatId, "Ник изменён.");
        } else {
          await bot.sendMessage(chatId, (r && r.error) || 'failed');
        }
      } catch (e) {
        await bot.sendMessage(chatId, e.message);
      }
      return;
    }
  }
});

/* ============================================================
 *  ФАБРИКА
 * ============================================================ */

async function startFactory(chatId, job) {
  const count = job.count;
  const niche = job.niche;
  factoryJobs.delete(chatId);
  stopFlags.factory = false;

  const stats = await store.proxyStats();
  const text = 'Фабрика запущена\n\n' +
    'Аккаунтов: ' + count + '\n' +
    'Ниша: ' + (niche ? niche.join(', ') : 'общая') + '\n' +
    'Прокси: ' + stats.free + ' free / ' + stats.total + ' всего\n' +
    'Параллельность: 10\n\n' +
    'Для остановки: /menu -> Остановить всё';

  await bot.sendMessage(chatId, text);

  let lastUpdate = 0;
  try {
    const r = await factory.createBatch({
      count: count,
      concurrency: 10,
      niche: niche,
      startSeq: 1,
      log: (m) => console.log(m),
      shouldStop: () => stopFlags.factory,
      onProgress: async (p) => {
        if (Date.now() - lastUpdate < 30000) return;
        lastUpdate = Date.now();
        const pct = Math.floor(p.done / p.total * 100);
        const bar = '='.repeat(Math.floor(pct / 5)) + '-'.repeat(20 - Math.floor(pct / 5));
        const progressText = 'Прогресс\n\n' + bar + ' ' + pct + '%\n\n' +
          'OK: ' + p.ok + '\nFail: ' + p.fail + '\n' +
          'В работе: ' + p.inFlight + '\n' +
          'Время: ' + Math.floor(p.elapsed / 60) + ':' + String(p.elapsed % 60).padStart(2, '0');
        await bot.sendMessage(chatId, progressText).catch(() => {});
      }
    });

    for (const acc of r.ok) {
      acc.uploader = new TikTokMobile({
        deviceId: acc.fingerprint ? acc.fingerprint.deviceId : null,
        proxy: acc.proxy, fingerprint: acc.fingerprint,
        cookies: acc.cookies, accountId: acc.id,
        onCookies: async (cks) => { await store.saveCookies(acc.id, cks); }
      });
      accounts.set(acc.id, acc);
    }

    const min = Math.floor(r.elapsed / 60);
    const sec = r.elapsed % 60;
    let finalText = 'Фабрика завершена' + (r.stopped ? ' (ОСТАНОВЛЕНА)' : '') + '\n\n' +
      'Создано: ' + r.ok.length + '\n' +
      'Ошибок: ' + r.fail.length + '\n' +
      'Время: ' + min + 'м ' + sec + 'с\n\n';

    if (r.fail.length) {
      const reasons = r.fail.reduce((a, f) => {
        a[f.reason] = (a[f.reason] || 0) + 1;
        return a;
      }, {});
      const top = Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 5);
      finalText += 'Причины:\n' + top.map(x => '- ' + x[0] + ': ' + x[1]).join('\n');
    }

    await bot.sendMessage(chatId, finalText);
  } catch (e) {
    console.error('factory error:', e);
    await bot.sendMessage(chatId, 'Фабрика упала: ' + e.message);
  }
}

/* ============================================================
 *  ПРОГРЕВ
 * ============================================================ */

async function startWarm(chatId, id) {
  const acc = accounts.get(id);
  if (!acc) return bot.sendMessage(chatId, "Нет аккаунта.");
  acc.status = "warming";
  await store.updateStatus(id, "warming");
  await bot.sendMessage(chatId, 'Прогрев ' + acc.name + '...');
  try {
    await ensureLoggedIn(chatId, acc);
    const warmer = new TikTokMobileWarmer(acc.uploader);
    await warmer.warmAccount(3, 20, () => stopFlags.warm);
    acc.status = "warmed";
    await store.updateStatus(id, "warmed");
    await bot.sendMessage(chatId, acc.name + ' прогрет!');
  } catch (e) {
    acc.status = "error";
    await store.updateStatus(id, "error");
    await bot.sendMessage(chatId, acc.name + ': ' + e.message);
  }
}

async function startWarmAll(chatId) {
  if (accounts.size === 0) return bot.sendMessage(chatId, "Нет аккаунтов.");
  await bot.sendMessage(chatId, 'Прогреваю ' + accounts.size + ' последовательно...');
  let done = 0;
  for (const [id, acc] of accounts) {
    if (stopFlags.warm) {
      await bot.sendMessage(chatId, 'Остановлено на ' + done + '/' + accounts.size);
      return;
    }
    if (acc.status === 'warming') continue;
    try { await startWarm(chatId, id); } catch {}
    done++;
    if (done % 5 === 0) await bot.sendMessage(chatId, done + '/' + accounts.size).catch(() => {});
    await new Promise(r => setTimeout(r, 30000));
  }
  await bot.sendMessage(chatId, 'Прогрев завершён: ' + done);
}

/* ============================================================
 *  АВАТАРКА + БИО
 * ============================================================ */

async function applyAvatarAll(chatId, imagePath) {
  let done = 0;
  let ok = 0;
  let fail = 0;
  for (const [id, acc] of accounts) {
    done++;
    try {
      await ensureLoggedIn(chatId, acc);
      const r = await acc.uploader.setAvatar(imagePath);
      if (r && !r.error) ok++;
      else fail++;
    } catch (e) { fail++; }
    if (done % 5 === 0 || done === accounts.size) {
      await bot.sendMessage(chatId, done + '/' + accounts.size + ' (OK: ' + ok + ' FAIL: ' + fail + ')').catch(() => {});
    }
    await new Promise(r => setTimeout(r, 15000));
  }
  await bot.sendMessage(chatId, 'Аватарка: ' + ok + ' успешно, ' + fail + ' ошибок.');
}

async function applyBioAll(chatId, bioText) {
  let done = 0;
  let ok = 0;
  let fail = 0;
  for (const [id, acc] of accounts) {
    done++;
    try {
      await ensureLoggedIn(chatId, acc);
      const r = await acc.uploader.setBio(bioText);
      if (r && !r.error) ok++;
      else fail++;
    } catch (e) { fail++; }
    if (done % 5 === 0 || done === accounts.size) {
      await bot.sendMessage(chatId, done + '/' + accounts.size + ' (OK: ' + ok + ' FAIL: ' + fail + ')').catch(() => {});
    }
    await new Promise(r => setTimeout(r, 15000));
  }
  await bot.sendMessage(chatId, 'Био: ' + ok + ' успешно, ' + fail + ' ошибок.');
}

/* ============================================================
 *  ПОСТИНГ
 * ============================================================ */

async function startPost(chatId, id, session) {
  const acc = accounts.get(id);
  if (!acc) return bot.sendMessage(chatId, "Нет аккаунта.");
  acc.status = "posting";
  await store.updateStatus(id, "posting");
  await bot.sendMessage(chatId, 'Заливаю в ' + acc.name + '...');

  try {
    await ensureLoggedIn(chatId, acc);
    const hashtags = buildHashtags({ niche: acc.niche || undefined });
    await bot.sendMessage(chatId, hashtags.join(' '));
    const caption = session.caption || "Check this out";
    const r = await acc.uploader.uploadVideo(session.rendered, caption, { hashtags: hashtags });
    acc.status = "posted";
    acc.postsCount = (acc.postsCount || 0) + 1;
    await store.updateStatus(id, "posted");
    await store.markPosted(id);
    await bot.sendMessage(chatId, acc.name + ' -> ' + (r.url || 'OK'));
  } catch (e) {
    acc.status = "error";
    await store.updateStatus(id, "error");
    await bot.sendMessage(chatId, acc.name + ': ' + String(e.message).slice(0, 500));
  } finally {
    if (session.input) cleanup(session.input);
    if (session.rendered) cleanup(session.rendered);
    sessions.delete(chatId);
  }
}

/* ============================================================
 *  СТАРТ
 * ============================================================ */

bot.on("polling_error", err => console.error("POLLING:", err && err.message || err));
console.log("Zenodrop TikTok Farm started.");
