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

/* ============================================================
 *  КОНФИГ
 * ============================================================ */

const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) {
  console.error("BOT_TOKEN is not set");
  process.exit(1);
}

const DEFAULT_INSERT = Number(process.env.INSERT_AT_SECONDS || 5);
const DEFAULT_DURATION = Number(process.env.BANNER_DURATION || 4);
const MAX_MB = Number(process.env.MAX_VIDEO_MB || 49);
const HEADLESS = String(process.env.HEADLESS || "true") !== "false";

const ROOT = __dirname;
const BANNER = path.join(ROOT, "banner.mp4");
const TMP = path.join(os.tmpdir(), "zenodrop-tiktok");
fs.mkdirSync(TMP, { recursive: true });

if (!fs.existsSync(BANNER)) {
  console.error("banner.mp4 not found in project root");
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: true });
const sessions = new Map();
const accounts = new Map();

/* ============================================================
 *  УТИЛИТЫ
 * ============================================================ */

function cleanup(...files) {
  for (const f of files) {
    try { if (f) fs.unlinkSync(f); } catch {}
  }
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args);
    let stderr = "";
    let stdout = "";
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
      "-of", "json",
      file
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
      if (res.statusCode !== 200) {
        stream.close(); cleanup(dest);
        return reject(new Error(`Telegram HTTP ${res.statusCode}`));
      }
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
  try {
    const u = new URL(text.trim());
    return u.protocol === "http:" || u.protocol === "https:";
  } catch { return false; }
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
    "-f", "bv*+ba/b",
    "--merge-output-format", "mp4",
    "-o", dest,
    url
  ], "yt-dlp");

  if (!fs.existsSync(dest)) throw new Error("yt-dlp не создал видеофайл.");
  const size = fs.statSync(dest).size;
  if (size > MAX_MB * 1024 * 1024) {
    cleanup(dest);
    throw new Error(`Скачанное видео слишком большое: ${(size / 1024 / 1024).toFixed(1)} МБ. Максимум ${MAX_MB} МБ.`);
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

  if (t <= 0.01) throw new Error("Для вставки в самое начало выбери секунду больше 0.");
  if (t >= info.duration - 0.03) {
    throw new Error(`Секунда вставки должна быть раньше конца видео (${info.duration.toFixed(2)} сек).`);
  }

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
      "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "128k",
      "-movflags", "+faststart",
      "-threads", "0",
      output
    );
  } else {
    args.push(
      "-filter_complex", filterParts.join(";"),
      "-map", "[vout]", "-an",
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "27",
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      "-threads", "0",
      output
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
      [
        { text: "⏱ Секунда", callback_data: "time" },
        { text: "⏳ Длительность", callback_data: "duration" }
      ],
      [
        { text: "🖼 1", callback_data: "count1" },
        { text: "🖼 2", callback_data: "count2" },
        { text: "🖼 3", callback_data: "count3" }
      ],
      [{ text: "🚀 ОБРАБОТАТЬ БАННЕР", callback_data: "render" }]
    ]
  };
}

function mainMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "➕ Добавить аккаунт", callback_data: "add_account" }],
      [{ text: "📋 Список аккаунтов", callback_data: "list_accounts" }],
      [{ text: "🔥 Прогреть аккаунт", callback_data: "warm" }],
      [{ text: "🏷 Обновить тренды", callback_data: "refresh_trends" }],
      [{ text: "📊 Статус", callback_data: "status" }]
    ]
  };
}

function accountsKeyboard(prefix, filterFn = () => true) {
  const rows = [];
  for (const [id, acc] of accounts) {
    if (!filterFn(acc)) continue;
    rows.push([
      {
        text: `${prefix} ${acc.name} (${acc.status})`,
        callback_data: `${prefix === "📤" ? "post_" : "warm_"}${id}`
      },
      {
        text: "🏷",
        callback_data: `preview_tags_${id}`
      }
    ]);
  }
  return { inline_keyboard: rows };
}

function showSettings(chatId) {
  const s = sessions.get(chatId);
  return bot.sendMessage(
    chatId,
    `⚙️ Настройки баннера\n\n` +
    `⏱ Вставка: ${s.insertAt} сек.\n` +
    `⏳ Баннер: ${s.duration} сек.\n` +
    `🖼 Баннеров одновременно: ${s.count}\n\n` +
    `Выбери параметры и жми «ОБРАБОТАТЬ».`,
    { reply_markup: settingsKeyboard() }
  );
}

/* ============================================================
 *  КОМАНДЫ
 * ============================================================ */

bot.onText(/^\/start$/, msg => {
  bot.sendMessage(
    msg.chat.id,
    "🎬 *Zenodrop TikTok Bot v4*\n\n" +
    "1. Пришли видео (файлом) или ссылку TikTok.\n" +
    "2. Настрой вставку баннера.\n" +
    "3. Выбери аккаунт — бот прогреет его и зальёт готовое видео с хештегами.\n\n" +
    "Команды:\n" +
    "/menu — меню аккаунтов\n" +
    "Для добавления аккаунта: отправь `login:password:name:tag1,tag2`",
    { parse_mode: "Markdown", reply_markup: mainMenuKeyboard() }
  );
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

  if (size && size > MAX_MB * 1024 * 1024) {
    return bot.sendMessage(chatId, `❌ Максимальный размер видео: ${MAX_MB} МБ.`);
  }

  const input = path.join(TMP, `${crypto.randomUUID()}_input.mp4`);
  try {
    await bot.sendMessage(chatId, "⬇️ Получаю видео...");
    await download(msg.video.file_id, input);
    const info = await probe(input);

    const old = sessions.get(chatId);
    if (old) {
      cleanup(old.input, old.rendered);
    }

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
    console.error("DOWNLOAD/PROBE ERROR:", e);
    cleanup(input);
    bot.sendMessage(chatId, "❌ Не удалось получить видео.");
  }
});

/* ============================================================
 *  ТЕКСТОВЫЕ СООБЩЕНИЯ
 * ============================================================ */

bot.on("message", async msg => {
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();
  if (!text || text.startsWith("/")) return;

  // TikTok URL
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
        duration: DEFAULT_DURATION,
        count: 1,
        waiting: null,
        videoDuration: info.duration,
        caption: "",
        rendered: null
      });

      await showSettings(chatId);
    } catch (e) {
      cleanup(input);
      await bot.sendMessage(chatId, `❌ Не удалось скачать TikTok.\n\n${String(e.message || e).slice(0, 1200)}`);
    }
    return;
  }

  if (isUrl(text)) {
    return bot.sendMessage(chatId, "❌ Поддерживаются только ссылки на TikTok.");
  }

  const s = sessions.get(chatId);

  // Добавление аккаунта
  const accMatch = text.match(/^([^:]+):([^:]+):([^:]+)(?::(.+))?$/);
  if (!s && accMatch) {
    const [, login, password, name, nicheStr] = accMatch;
    const id = crypto.randomUUID().slice(0, 8);
    accounts.set(id, {
      id,
      name: name.trim(),
      login: login.trim(),
      password: password.trim(),
      niche: nicheStr
        ? nicheStr.split(',').map(t => t.trim().toLowerCase().replace(/^#/, '')).filter(Boolean)
        : null,
      status: "new",
      uploader: new TikTokUploader({
        cookiesPath: path.join(ROOT, `cookies_${id}.json`),
        headless: HEADLESS
      })
    });
    return bot.sendMessage(chatId,
      `✅ Аккаунт "${name.trim()}" добавлен.\nID: \`${id}\`\n` +
      (nicheStr ? `Ниша: ${nicheStr}` : `Ниша: общая`),
      { parse_mode: "Markdown" }
    );
  }

  if (!s) return;

  if (s.waiting === "time") {
    const value = Number(msg.text.replace(",", "."));
    if (!Number.isFinite(value) || value < 0 || value >= s.videoDuration - 0.03) {
      return bot.sendMessage(chatId, `❌ Введи секунду от 0 до ${(s.videoDuration - 0.03).toFixed(2)}.`);
    }
    s.insertAt = value;
    s.waiting = null;
    return showSettings(chatId);
  }

  if (s.waiting === "duration") {
    const value = Number(msg.text.replace(",", "."));
    if (!Number.isFinite(value) || value < 0.5 || value > 60) {
      return bot.sendMessage(chatId, "❌ От 0.5 до 60 секунд.");
    }
    s.duration = value;
    s.waiting = null;
    return showSettings(chatId);
  }
});

/* ============================================================
 *  CALLBACK QUERY
 * ============================================================ */

bot.on("callback_query", async q => {
  const chatId = q.message.chat.id;
  const s = sessions.get(chatId);
  const data = q.data;

  /* --- МЕНЮ АККАУНТОВ --- */
  if (data === "add_account") {
    await bot.answerCallbackQuery(q.id);
    return bot.sendMessage(chatId,
      "➕ Отправь: `login:password:name:tag1,tag2,tag3`\n\n" +
      "Пример:\n`user@mail.com:pass123:myacc:dropshipping,ecommerce,money`\n\n" +
      "Последняя часть (ниша) — опционально.",
      { parse_mode: "Markdown" }
    );
  }

  if (data === "list_accounts") {
    await bot.answerCallbackQuery(q.id);
    if (accounts.size === 0) return bot.sendMessage(chatId, "📋 Нет аккаунтов.");
    let text = "📋 *Аккаунты:*\n\n";
    for (const [id, acc] of accounts) {
      text += `• *${acc.name}* (\`${id}\`)\n`;
      text += `  Статус: ${acc.status}\n`;
      text += `  Login: ${acc.login}\n`;
      if (acc.niche) text += `  Ниша: ${acc.niche.join(', ')}\n`;
      text += `\n`;
    }
    return bot.sendMessage(chatId, text, { parse_mode: "Markdown" });
  }

  if (data === "status") {
    await bot.answerCallbackQuery(q.id);
    let text = `📊 *Статус*\n\nАккаунтов: ${accounts.size}\nСессий: ${sessions.size}\n\n`;
    for (const [id, acc] of accounts) text += `• ${acc.name}: ${acc.status}\n`;
    return bot.sendMessage(chatId, text, { parse_mode: "Markdown" });
  }

  if (data === "refresh_trends") {
    await bot.answerCallbackQuery(q.id, { text: "Обновляю..." });
    try {
      const tags = await refreshTrending();
      return bot.sendMessage(chatId, `🔥 Тренды обновлены: ${tags.length} тегов\n\n${tags.slice(0, 15).join(' ')}`);
    } catch (e) {
      return bot.sendMessage(chatId, `❌ Ошибка: ${e.message}`);
    }
  }

  /* --- ПРОГРЕВ --- */
  if (data === "warm") {
    await bot.answerCallbackQuery(q.id);
    if (accounts.size === 0) return bot.sendMessage(chatId, "❌ Нет аккаунтов.");
    return bot.sendMessage(chatId, "🔥 Выбери аккаунт для прогрева:", {
      reply_markup: accountsKeyboard("🔥")
    });
  }

  if (data.startsWith("warm_")) {
    const accId = data.slice(5);
    await bot.answerCallbackQuery(q.id);
    return startWarm(chatId, accId);
  }

  /* --- ПРЕВЬЮ ХЕШТЕГОВ --- */
  if (data.startsWith("preview_tags_")) {
    const accId = data.slice("preview_tags_".length);
    await bot.answerCallbackQuery(q.id);
    const acc = accounts.get(accId);
    if (!acc) return bot.sendMessage(chatId, "❌ Аккаунт не найден.");

    const tags = buildHashtags({
      niche: acc.niche || undefined,
      extra: acc.extraTags || []
    });

    return bot.sendMessage(chatId,
      `🏷 *Хештеги для ${acc.name}:*\n\n${tags.join(' ')}\n\nВсего: ${tags.length}`,
      { parse_mode: "Markdown" }
    );
  }

  /* --- НАСТРОЙКИ БАННЕРА --- */
  if (!s) {
    return bot.answerCallbackQuery(q.id, { text: "Сначала отправь видео." });
  }

  if (data === "time") {
    s.waiting = "time";
    await bot.answerCallbackQuery(q.id);
    return bot.sendMessage(chatId, "⏱ На какой секунде вставить баннер?\nНапример: 7");
  }

  if (data === "duration") {
    s.waiting = "duration";
    await bot.answerCallbackQuery(q.id);
    return bot.sendMessage(chatId, "⏳ Сколько секунд показывать баннер?\nНапример: 4");
  }

  if (/^count[123]$/.test(data)) {
    s.count = Number(data.slice(-1));
    await bot.answerCallbackQuery(q.id, { text: `Выбрано: ${s.count}` });
    return showSettings(chatId);
  }

  /* --- РЕНДЕР --- */
  if (data === "render") {
    await bot.answerCallbackQuery(q.id);
    const output = path.join(TMP, `${crypto.randomUUID()}_rendered.mp4`);

    try {
      await bot.sendMessage(chatId, "🎬 Вставляю баннер...");
      await renderVideo(s.input, output, s.insertAt, s.duration, s.count);
      s.rendered = output;

      await bot.sendVideo(chatId, output, {
        caption: "✅ Баннер вставлен. Теперь выбери аккаунт для загрузки.",
        supports_streaming: true
      });

      if (accounts.size === 0) {
        return bot.sendMessage(chatId, "❌ Нет аккаунтов. Добавь: /menu → ➕");
      }

      await bot.sendMessage(chatId, "📤 Куда заливаем?", {
        reply_markup: accountsKeyboard("📤")
      });
    } catch (e) {
      console.error("=== FFMPEG ERROR ===", e);
      await bot.sendMessage(chatId, `❌ Ошибка FFmpeg:\n\n${String(e.message || e).slice(0, 1200)}`);
    }
    return;
  }

  /* --- ЗАЛИВ В TIKTOK --- */
  if (data.startsWith("post_")) {
    const accId = data.slice(5);
    await bot.answerCallbackQuery(q.id);
    if (!s?.rendered) {
      return bot.sendMessage(chatId, "❌ Сначала обработай баннер.");
    }
    return startPost(chatId, accId, s);
  }
});

/* ============================================================
 *  ПРОГРЕВ + ПОСТИНГ
 * ============================================================ */

async function startWarm(chatId, accountId) {
  const acc = accounts.get(accountId);
  if (!acc) return bot.sendMessage(chatId, "❌ Аккаунт не найден.");

  acc.status = "warming";
  await bot.sendMessage(chatId, `🔥 Начинаю прогрев ${acc.name}...`);

  try {
    await acc.uploader.init();

    if (!fs.existsSync(acc.uploader.cookiesPath)) {
      const result = await acc.uploader.login(acc.login, acc.password);
      if (result.captcha) {
        acc.status = "captcha";
        return bot.sendMessage(chatId,
          `⚠️ Капча при логине ${acc.name}.\nОткрой Render Shell и реши вручную.`
        );
      }
    }

    const warmer = new TikTokWarmer(acc.uploader);
    await warmer.warmAccount(3, 20);

    acc.status = "warmed";
    await bot.sendMessage(chatId, `✅ Прогрев ${acc.name} завершён!`);
  } catch (e) {
    console.error("warm error:", e);
    acc.status = "error";
    await bot.sendMessage(chatId, `❌ Ошибка прогрева ${acc.name}:\n${e.message}`);
  } finally {
    await acc.uploader.close();
  }
}

async function startPost(chatId, accountId, session) {
  const acc = accounts.get(accountId);
  if (!acc) return bot.sendMessage(chatId, "❌ Аккаунт не найден.");

  acc.status = "posting";
  await bot.sendMessage(chatId, `📤 Логинюсь и заливаю в ${acc.name}...`);

  try {
    await acc.uploader.init();

    if (!fs.existsSync(acc.uploader.cookiesPath)) {
      const result = await acc.uploader.login(acc.login, acc.password);
      if (result.captcha) {
        acc.status = "captcha";
        return bot.sendMessage(chatId, `⚠️ Капча. Реши вручную.`);
      }
    }

    // Немного прогрева перед постом
    const warmer = new TikTokWarmer(acc.uploader);
    await warmer.randomScroll(60);

    // Хештеги
    const hashtags = buildHashtags({
      niche: acc.niche || undefined,
      extra: acc.extraTags || []
    });

    const caption = session.caption || "Check this out 🔥";

    await bot.sendMessage(
      chatId,
      `🏷 *Хештеги для ${acc.name}:*\n${hashtags.join(' ')}`,
      { parse_mode: "Markdown" }
    );

    const result = await acc.uploader.uploadVideo(session.rendered, caption, {
      hashtags
    });

    acc.status = "posted";
    await bot.sendMessage(chatId,
      `✅ Залито в ${acc.name}!\n${result.url || ''}\n\n` +
      `Хештеги: ${result.hashtags.join(' ')}`
    );
  } catch (e) {
    console.error("post error:", e);
    acc.status = "error";
    await bot.sendMessage(chatId, `❌ Ошибка заливки ${acc.name}:\n${String(e.message || e).slice(0, 1000)}`);
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

bot.on("polling_error", err => {
  console.error("TELEGRAM POLLING ERROR:", err?.message || err);
});

// Раз в сутки — обновление трендов
refreshTrending().catch(() => {});
setInterval(() => refreshTrending().catch(() => {}), 24 * 60 * 60 * 1000);

console.log("Zenodrop TikTok Bot v4 started.");
