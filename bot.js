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
      "-filter_complex", filterParts
