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
const TMP = path.join(os.tmpdir(), "zenodrop-banner");
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
 * Reliable pipeline.
 *
 * The previous "fast" version used concat -c copy between source fragments
 * and a separately encoded banner fragment. That is fragile because the
 * fragments can have different stream layouts/time bases (and the banner
 * fragment had no audio while the source fragments could have audio).
 *
 * This version deliberately re-encodes the final video. It is slower, but
 * the output is much more reliable and the source video is preserved
 * visually: before -> frozen frame + banner(s) -> after.
 */
async function renderVideo(input, output, insertAt, bannerDuration, count) {
  const info = await probe(input);
  if (info.duration < 0.2) throw new Error("Видео слишком короткое.");

  const t = Math.max(0, Math.min(Number(insertAt), info.duration));
  const dur = Math.max(0.5, Math.min(60, Number(bannerDuration)));
  const n = Math.max(1, Math.min(3, Number(count)));

  if (t <= 0.01) throw new Error("Для вставки в самое начало выбери секунду больше 0.");
  if (t >= info.duration - 0.03) {
    throw new Error(`Секунда вставки должна быть раньше конца видео (${info.duration.toFixed(2)} сек).`);
  }

  const id = crypto.randomUUID();
  const filterParts = [];

  // Video before insertion.
  filterParts.push(
    `[0:v]trim=start=0:end=${t},setpts=PTS-STARTPTS[pre]`
  );

  // Take a tiny slice at the insertion point, then freeze its first frame.
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
    filterParts.push(
      `[${current}][b${i}]overlay=x=(W-w)/2:y=${ys[i]}:shortest=1[${next}]`
    );
    current = next;
  }

  filterParts.push(
    `[0:v]trim=start=${t},setpts=PTS-STARTPTS[post]`,
    `[pre][${current}][post]concat=n=3:v=1:a=0[vout]`
  );

  const args = [
    "-y",
    "-i", input
  ];

  // Banner inputs are looped forever; the video filter cuts them to dur.
  for (let i = 0; i < n; i++) {
    args.push("-stream_loop", "-1", "-i", BANNER);
  }

  if (info.hasAudio) {
    const sr = Number.isFinite(info.sampleRate) ? info.sampleRate : 48000;
    const layout = info.channelLayout || "stereo";

    filterParts.push(
      `[0:a]atrim=start=0:end=${t},asetpts=PTS-STARTPTS[apre]`,
      `anullsrc=r=${sr}:cl=${layout},atrim=duration=${dur},asetpts=PTS-STARTPTS[asil]`,
      `[0:a]atrim=start=${t},asetpts=PTS-STARTPTS[apost]`,
      `[apre][asil][apost]concat=n=3:v=0:a=1[aout]`
    );

    args.push(
      "-filter_complex", filterParts.join(";"),
      "-map", "[vout]",
      "-map", "[aout]",
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-crf", "27",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-b:a", "128k",
      "-movflags", "+faststart",
      "-threads", "0",
      output
    );
  } else {
    args.push(
      "-filter_complex", filterParts.join(";"),
      "-map", "[vout]",
      "-an",
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-crf", "27",
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      "-threads", "0",
      output
    );
  }

  await run("ffmpeg", args);
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

    const info = await probe(input);
    sessions.set(chatId, {
      input,
      insertAt: DEFAULT_INSERT,
      duration: DEFAULT_DURATION,
      count: 1,
      waiting: null,
      videoDuration: info.duration
    });

    await showSettings(chatId);
  } catch (e) {
    console.error("DOWNLOAD/PROBE ERROR:", e);
    cleanup(input);
    bot.sendMessage(chatId, "❌ Не удалось получить видео. Подробность есть в логах Render.");
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
      await bot.sendMessage(chatId, "🎬 Обрабатываю видео...");
      await renderVideo(s.input, output, s.insertAt, s.duration, s.count);

      await bot.sendVideo(chatId, output, {
        caption: "✅ Готово",
        supports_streaming: true
      });
    } catch (e) {
      console.error("=== FFMPEG ERROR ===");
      console.error(e.stack || e.message || e);
      console.error("=== END FFMPEG ERROR ===");

      const short = String(e.message || e)
        .replace(/\s+/g, " ")
        .slice(0, 1200);

      await bot.sendMessage(
        chatId,
        `❌ Ошибка FFmpeg:\n\n${short}\n\nПодробная ошибка также записана в Render Logs.`
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
    if (!Number.isFinite(value) || value < 0 || value >= s.videoDuration - 0.03) {
      return bot.sendMessage(
        chatId,
        `❌ Введи секунду от 0 до ${(s.videoDuration - 0.03).toFixed(2)}.`
      );
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

bot.on("polling_error", err => {
  console.error("TELEGRAM POLLING ERROR:", err?.message || err);
});

console.log("Zenodrop Banner Bot v3 started.");
