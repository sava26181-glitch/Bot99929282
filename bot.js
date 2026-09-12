const TelegramBot = require("node-telegram-bot-api");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");
const https = require("https");

const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) {
  console.error("BOT_TOKEN is not set");
  process.exit(1);
}

const DEFAULT_INSERT = Number(process.env.INSERT_AT_SECONDS || 5);
const DEFAULT_DURATION = Number(process.env.BANNER_DURATION || 4);
const MAX_MB = Number(process.env.MAX_VIDEO_MB || 49);

const ROOT = __dirname;
const BANNER = path.join(ROOT, "banner.mp4");
const TMP = path.join(os.tmpdir(), "zenodrop-fast");
fs.mkdirSync(TMP, { recursive: true });

if (!fs.existsSync(BANNER)) {
  console.error("banner.mp4 not found");
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: true });
const sessions = new Map();

function cleanup(...files) {
  for (const f of files) {
    try { if (f) fs.unlinkSync(f); } catch {}
  }
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args);
    let stderr = "";
    p.stderr.on("data", d => stderr += d.toString());
    p.on("error", reject);
    p.on("close", code => {
      if (code === 0) resolve();
      else reject(new Error(stderr.slice(-5000) || `exit ${code}`));
    });
  });
}

async function probe(file) {
  return new Promise((resolve, reject) => {
    const p = spawn("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration:stream=width,height,r_frame_rate",
      "-of", "json",
      file
    ]);
    let out = "", err = "";
    p.stdout.on("data", d => out += d.toString());
    p.stderr.on("data", d => err += d.toString());
    p.on("error", reject);
    p.on("close", code => {
      if (code !== 0) return reject(new Error(err));
      try {
        const j = JSON.parse(out);
        const video = (j.streams || []).find(x => x.width && x.height);
        resolve({
          duration: Number(j.format?.duration || 0),
          width: video?.width || 1280,
          height: video?.height || 720
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
        stream.close();
        cleanup(dest);
        return reject(new Error(`Telegram HTTP ${res.statusCode}`));
      }
      res.pipe(stream);
      stream.on("finish", () => stream.close(resolve));
    });
    req.on("error", e => {
      stream.close();
      cleanup(dest);
      reject(e);
    });
  });
}

/*
 * FAST pipeline.
 *
 * We encode only:
 *   1) the 4-second banner segment
 *
 * The original before/after parts are copied with -c copy.
 *
 * To keep final concat compatible, the banner segment is encoded
 * using the same H.264/AAC family. FFmpeg can concatenate compatible
 * MP4 fragments using the concat demuxer without another full encode.
 */
async function renderFast(input, output, insertAt, bannerDuration, count) {
  const info = await probe(input);
  if (info.duration < 0.2) throw new Error("Видео слишком короткое.");

  const t = Math.max(0.05, Math.min(Number(insertAt), info.duration - 0.05));
  const dur = Math.max(0.5, Math.min(60, Number(bannerDuration)));
  const n = Math.max(1, Math.min(3, Number(count)));

  const id = crypto.randomUUID();
  const before = path.join(TMP, `${id}_before.mp4`);
  const after = path.join(TMP, `${id}_after.mp4`);
  const segment = path.join(TMP, `${id}_segment.mp4`);
  const list = path.join(TMP, `${id}_list.txt`);
  const freeze = path.join(TMP, `${id}_freeze.png`);

  try {
    // No re-encode of source segments.
    // -avoid_negative_ts helps the fragments concatenate cleanly.
    await run("ffmpeg", [
      "-y", "-i", input,
      "-t", String(t),
      "-map", "0",
      "-c", "copy",
      "-avoid_negative_ts", "make_zero",
      before
    ]);

    await run("ffmpeg", [
      "-y", "-ss", String(t), "-i", input,
      "-map", "0",
      "-c", "copy",
      "-avoid_negative_ts", "make_zero",
      after
    ]);

    // Extract one frame only. This is tiny compared with transcoding the video.
    await run("ffmpeg", [
      "-y", "-sseof", "-0.05", "-i", before,
      "-frames:v", "1",
      "-q:v", "2",
      freeze
    ]);

    // Build the banner pause. Only this short segment is encoded.
    const inputArgs = ["-y", "-loop", "1", "-i", freeze];
    for (let i = 0; i < n; i++) {
      inputArgs.push("-stream_loop", "-1", "-i", BANNER);
    }

    const scale = n === 1 ? "0.62" : n === 2 ? "0.47" : "0.36";

    let graph = `[0:v]scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p[bg];`;

    for (let i = 0; i < n; i++) {
      graph += `[${i + 1}:v]scale=w=iw*${scale}:h=-2:force_original_aspect_ratio=decrease,format=rgba[b${i}];`;
    }

    const ys = n === 1
      ? ["(H-h)/2"]
      : n === 2
        ? ["H*0.22-h/2", "H*0.78-h/2"]
        : ["H*0.17-h/2", "(H-h)/2", "H*0.83-h/2"];

    let current = "bg";
    for (let i = 0; i < n; i++) {
      const next = `x${i}`;
      graph += `[${current}][b${i}]overlay=x=(W-w)/2:y=${ys[i]}:shortest=0[tmp${i}];`;
      current = `tmp${i}`;
    }
    graph += `[${current}]null[v]`;

    await run("ffmpeg", [
      ...inputArgs,
      "-filter_complex", graph,
      "-map", "[v]",
      "-map", "0:a:0?",
      "-t", String(dur),
      "-r", "30",
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-crf", "23",
      "-pix_fmt", "yuv420p",
      "-an",
      segment
    ]);

    // Final assembly: NO video re-encode here.
    fs.writeFileSync(
      list,
      `file '${before.replaceAll("'", "'\\''")}'\n` +
      `file '${segment.replaceAll("'", "'\\''")}'\n` +
      `file '${after.replaceAll("'", "'\\''")}'\n`
    );

    await run("ffmpeg", [
      "-y",
      "-f", "concat",
      "-safe", "0",
      "-i", list,
      "-c", "copy",
      "-movflags", "+faststart",
      output
    ]);
  } finally {
    cleanup(before, after, segment, list, freeze);
  }
}

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
      [{ text: "🚀 ОБРАБОТАТЬ", callback_data: "go" }]
    ]
  };
}

function showSettings(chatId) {
  const s = sessions.get(chatId);
  return bot.sendMessage(
    chatId,
    `⚙️ Настройки\n\n` +
    `⏱ Вставка: ${s.insertAt} сек.\n` +
    `⏳ Баннер: ${s.duration} сек.\n` +
    `🖼 Баннеров одновременно: ${s.count}\n\n` +
    `Выбери параметры и нажми «ОБРАБОТАТЬ».`,
    { reply_markup: settingsKeyboard() }
  );
}

bot.onText(/^\/start$/, msg => {
  bot.sendMessage(
    msg.chat.id,
    "🎬 Отправь видео — я вставлю баннер в выбранный момент и верну готовый ролик."
  );
});

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

    sessions.set(chatId, {
      input,
      insertAt: DEFAULT_INSERT,
      duration: DEFAULT_DURATION,
      count: 1,
      waiting: null
    });

    await showSettings(chatId);
  } catch (e) {
    console.error(e);
    cleanup(input);
    bot.sendMessage(chatId, "❌ Не удалось скачать видео.");
  }
});

bot.on("callback_query", async q => {
  const chatId = q.message.chat.id;
  const s = sessions.get(chatId);

  if (!s) {
    return bot.answerCallbackQuery(q.id, { text: "Сначала отправь видео." });
  }

  if (q.data === "time") {
    s.waiting = "time";
    await bot.answerCallbackQuery(q.id);
    return bot.sendMessage(chatId, "⏱ На какой секунде вставить баннер?\nНапример: 7");
  }

  if (q.data === "duration") {
    s.waiting = "duration";
    await bot.answerCallbackQuery(q.id);
    return bot.sendMessage(chatId, "⏳ Сколько секунд показывать баннер?\nНапример: 4");
  }

  if (/^count[123]$/.test(q.data)) {
    s.count = Number(q.data.slice(-1));
    await bot.answerCallbackQuery(q.id, { text: `Выбрано: ${s.count}` });
    return showSettings(chatId);
  }

  if (q.data === "go") {
    await bot.answerCallbackQuery(q.id);

    const output = path.join(TMP, `${crypto.randomUUID()}_output.mp4`);

    try {
      await bot.sendMessage(chatId, "⚡ Быстрая обработка...");
      await renderFast(s.input, output, s.insertAt, s.duration, s.count);

      await bot.sendVideo(chatId, output, {
        caption: "✅ Готово",
        supports_streaming: true
      });
    } catch (e) {
      console.error(e);
      await bot.sendMessage(
        chatId,
        "❌ Не удалось обработать видео. Если ошибка повторяется, пришли текст ошибки из логов Render."
      );
    } finally {
      cleanup(s.input, output);
      sessions.delete(chatId);
    }
  }
});

bot.on("message", async msg => {
  const chatId = msg.chat.id;
  const s = sessions.get(chatId);
  if (!s || !msg.text || msg.text.startsWith("/")) return;

  if (s.waiting === "time") {
    const value = Number(msg.text.replace(",", "."));
    if (!Number.isFinite(value) || value < 0) {
      return bot.sendMessage(chatId, "❌ Например: 7");
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

console.log("Zenodrop FAST Banner Bot started.");
