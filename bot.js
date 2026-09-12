const TelegramBot = require("node-telegram-bot-api");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");

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
const TMP = path.join(os.tmpdir(), "zenodrop-banner-bot");
fs.mkdirSync(TMP, { recursive: true });

if (!fs.existsSync(BANNER)) {
  console.error("banner.mp4 not found");
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: true });
const sessions = new Map();

function cleanup(...files) {
  for (const file of files) {
    try { if (file) fs.unlinkSync(file); } catch {}
  }
}

function exec(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args);
    let err = "";
    p.stderr.on("data", d => err += d.toString());
    p.on("error", reject);
    p.on("close", code => {
      if (code === 0) resolve();
      else reject(new Error(err.slice(-6000) || `exit ${code}`));
    });
  });
}

async function probeVideo(file) {
  return new Promise((resolve, reject) => {
    const p = spawn("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      file
    ]);
    let out = "", err = "";
    p.stdout.on("data", d => out += d.toString());
    p.stderr.on("data", d => err += d.toString());
    p.on("error", reject);
    p.on("close", code => {
      const duration = Number(out.trim());
      if (code !== 0 || !Number.isFinite(duration)) {
        return reject(new Error(err || "ffprobe failed"));
      }
      resolve(duration);
    });
  });
}

async function downloadTelegramFile(fileId, destination) {
  const info = await bot.getFile(fileId);
  const url = `https://api.telegram.org/file/bot${TOKEN}/${info.file_path}`;
  const https = require("https");

  await new Promise((resolve, reject) => {
    const stream = fs.createWriteStream(destination);
    const req = https.get(url, res => {
      if (res.statusCode !== 200) {
        stream.close();
        cleanup(destination);
        return reject(new Error(`Telegram HTTP ${res.statusCode}`));
      }
      res.pipe(stream);
      stream.on("finish", () => stream.close(resolve));
    });
    req.on("error", err => {
      stream.close();
      cleanup(destination);
      reject(err);
    });
  });
}

/*
  Main effect:
  before = source [0..insertAt]
  frozen = last frame of before, extended for duration
  banner(s) = banner video(s), scaled and stacked vertically over frozen
  after = source [insertAt..end]

  Audio is silent during the banner pause, then resumes with "after".
*/
async function render(input, output, insertAt, bannerDuration, count) {
  const total = await probeVideo(input);

  if (total < 0.15) throw new Error("Видео слишком короткое.");

  // If the requested second is outside the video, put the pause near the end.
  const t = Math.max(0.05, Math.min(Number(insertAt), total - 0.05));

  const id = crypto.randomUUID();
  const before = path.join(TMP, `${id}_before.mp4`);
  const after = path.join(TMP, `${id}_after.mp4`);
  const freeze = path.join(TMP, `${id}_freeze.mp4`);
  const concatList = path.join(TMP, `${id}_list.txt`);

  const duration = Math.max(0.5, Number(bannerDuration));
  const n = Math.max(1, Math.min(3, Number(count)));

  try {
    // Keep source dimensions, normalize to H.264/AAC.
    await exec("ffmpeg", [
      "-y", "-i", input,
      "-t", String(t),
      "-map", "0:v:0", "-map", "0:a:0?",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "21",
      "-c:a", "aac", "-b:a", "128k",
      "-pix_fmt", "yuv420p",
      before
    ]);

    await exec("ffmpeg", [
      "-y", "-ss", String(t), "-i", input,
      "-map", "0:v:0", "-map", "0:a:0?",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "21",
      "-c:a", "aac", "-b:a", "128k",
      "-pix_fmt", "yuv420p",
      after
    ]);

    // Make a clean frozen background from the final frame before the pause.
    await exec("ffmpeg", [
      "-y", "-sseof", "-0.05", "-i", before,
      "-frames:v", "1",
      "-vf", `scale=trunc(iw/2)*2:trunc(ih/2)*2`,
      "-q:v", "2",
      freeze
    ]);

    // Scale each banner to a reasonable width and place banners vertically.
    // We use the same banner file for every selected slot.
    const widthRatio = n === 1 ? 0.62 : (n === 2 ? 0.48 : 0.40);
    const scaleW = `min(iw*${widthRatio}\\,W*${widthRatio})`;

    // Filter graph: frozen background + N independently scaled banner inputs.
    const inputs = [];
    for (let i = 0; i < n; i++) inputs.push("-stream_loop", "-1", "-i", BANNER);

    let graph = `[0:v]scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p[bg];`;
    for (let i = 0; i < n; i++) {
      graph += `[${i + 1}:v]scale=w=${scaleW}:h=-2:force_original_aspect_ratio=decrease,format=rgba[b${i}];`;
    }

    // Positions are vertical and never overlap. Keep a small margin.
    const yPositions = n === 1
      ? ["(H-h)/2"]
      : n === 2
        ? ["H*0.16-h/2", "H*0.84-h/2"]
        : ["H*0.17-h/2", "(H-h)/2", "H*0.83-h/2"];

    let last = "bg";
    for (let i = 0; i < n; i++) {
      const next = `o${i}`;
      graph += `[${last}][b${i}]overlay=x=(W-w)/2:y=${yPositions[i]}:eof_action=pass:repeatlast=0[${next}];`;
      last = next;
    }

    graph = graph.slice(0, -1); // remove final semicolon

    await exec("ffmpeg", [
      "-y",
      "-i", freeze,
      ...inputs,
      "-filter_complex", graph,
      "-map", `[${last}]`,
      "-t", String(duration),
      "-an",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "21",
      "-pix_fmt", "yuv420p",
      path.join(TMP, `${id}_banner.mp4`)
    ]);

    const bannerSegment = path.join(TMP, `${id}_banner.mp4`);

    fs.writeFileSync(
      concatList,
      `file '${before.replaceAll("'", "'\\''")}'\n` +
      `file '${bannerSegment.replaceAll("'", "'\\''")}'\n` +
      `file '${after.replaceAll("'", "'\\''")}'\n`
    );

    // Concat normalized segments. We keep video/audio streams compatible.
    await exec("ffmpeg", [
      "-y",
      "-f", "concat", "-safe", "0",
      "-i", concatList,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "21",
      "-c:a", "aac", "-b:a", "128k",
      "-af", "aresample=async=1:first_pts=0",
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      output
    ]);

    cleanup(bannerSegment);
  } finally {
    cleanup(before, after, freeze, concatList);
  }
}

function menu(chatId) {
  const s = sessions.get(chatId);
  const text =
    `⚙️ Настройки видео\n\n` +
    `⏱ Момент: ${s.insertAt} сек.\n` +
    `⏳ Длительность: ${s.duration} сек.\n` +
    `🖼 Баннеров: ${s.count}\n\n` +
    `Выбери параметр или нажми «Готово».`;

  return bot.sendMessage(chatId, text, {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "⏱ Секунда", callback_data: "set_time" },
          { text: "⏳ Длительность", callback_data: "set_duration" }
        ],
        [
          { text: "🖼 1 баннер", callback_data: "count_1" },
          { text: "🖼 2 баннера", callback_data: "count_2" },
          { text: "🖼 3 баннера", callback_data: "count_3" }
        ],
        [{ text: "✅ Готово", callback_data: "render" }]
      ]
    }
  });
}

bot.onText(/^\/start$/, msg => {
  bot.sendMessage(
    msg.chat.id,
    "🎬 Отправь видео.\n\nПосле загрузки я дам выбрать момент вставки, длительность и количество баннеров."
  );
});

bot.on("video", async msg => {
  const chatId = msg.chat.id;
  const size = Number(msg.video.file_size || 0);

  if (size && size > MAX_MB * 1024 * 1024) {
    return bot.sendMessage(chatId, `❌ Видео больше ${MAX_MB} МБ.`);
  }

  const id = crypto.randomUUID();
  const input = path.join(TMP, `${id}_input.mp4`);

  try {
    await bot.sendMessage(chatId, "⬇️ Загружаю видео...");
    await downloadTelegramFile(msg.video.file_id, input);

    sessions.set(chatId, {
      input,
      insertAt: DEFAULT_INSERT,
      duration: DEFAULT_DURATION,
      count: 1
    });

    await menu(chatId);
  } catch (e) {
    console.error(e);
    cleanup(input);
    bot.sendMessage(chatId, "❌ Не удалось получить видео.");
  }
});

bot.on("callback_query", async q => {
  const chatId = q.message.chat.id;
  const s = sessions.get(chatId);
  if (!s) {
    return bot.answerCallbackQuery(q.id, { text: "Сначала отправь видео." });
  }

  const data = q.data;

  if (data === "count_1" || data === "count_2" || data === "count_3") {
    s.count = Number(data.slice(-1));
    await bot.answerCallbackQuery(q.id, { text: `Баннеров: ${s.count}` });
    return menu(chatId);
  }

  if (data === "set_time") {
    s.waiting = "time";
    await bot.answerCallbackQuery(q.id);
    return bot.sendMessage(chatId, "⏱ Напиши секунду, например: 7");
  }

  if (data === "set_duration") {
    s.waiting = "duration";
    await bot.answerCallbackQuery(q.id);
    return bot.sendMessage(chatId, "⏳ Напиши длительность баннера в секундах, например: 4");
  }

  if (data === "render") {
    await bot.answerCallbackQuery(q.id);
    const output = path.join(TMP, `${crypto.randomUUID()}_output.mp4`);

    try {
      await bot.sendMessage(
        chatId,
        `🎬 Обрабатываю...\n` +
        `Момент: ${s.insertAt} сек.\n` +
        `Пауза: ${s.duration} сек.\n` +
        `Баннеров: ${s.count}`
      );

      await render(s.input, output, s.insertAt, s.duration, s.count);

      await bot.sendVideo(chatId, output, {
        caption: "✅ Готово!",
        supports_streaming: true
      });
    } catch (e) {
      console.error(e);
      await bot.sendMessage(chatId, "❌ Ошибка FFmpeg при обработке видео.");
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
      return bot.sendMessage(chatId, "❌ Введи нормальную секунду, например 7.");
    }
    s.insertAt = value;
    s.waiting = null;
    return menu(chatId);
  }

  if (s.waiting === "duration") {
    const value = Number(msg.text.replace(",", "."));
    if (!Number.isFinite(value) || value <= 0 || value > 60) {
      return bot.sendMessage(chatId, "❌ Введи длительность от 0.5 до 60 секунд.");
    }
    s.duration = value;
    s.waiting = null;
    return menu(chatId);
  }
});

console.log("Zenodrop Banner Bot started.");
