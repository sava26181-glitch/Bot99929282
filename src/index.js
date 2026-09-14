const { Telegraf, Markup } = require("telegraf");
const { chromium } = require("playwright");
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const WebSocket = require("ws");

const PORT = Number(process.env.PORT || 10000);
const BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
const SESSION_TOKEN = (process.env.SESSION_TOKEN || "").trim();

if (!BOT_TOKEN) {
    console.error("ERROR: TELEGRAM_BOT_TOKEN is not set");
    process.exit(1);
}

if (!SESSION_TOKEN) {
    console.error("ERROR: SESSION_TOKEN is not set");
    process.exit(1);
}

const DATA_DIR = process.env.DATA_DIR || "/app/data";
const PROFILE_DIR = path.join(DATA_DIR, "tiktok-profile");

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(PROFILE_DIR, { recursive: true });

const bot = new Telegraf(BOT_TOKEN);

let browserContext = null;
let page = null;

const users = new Map();

function randomId() {
    return crypto.randomBytes(8).toString("hex");
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function safeError(err) {
    return err && err.message ? err.message : String(err);
}

/* =========================
   VIRTUAL DISPLAY
========================= */

function startProcess(command, args, name) {
    const child = spawn(command, args, {
        env: {
            ...process.env,
            DISPLAY: ":99"
        },
        stdio: ["ignore", "pipe", "pipe"]
    });

    child.stdout.on("data", data => {
        console.log(`[${name}] ${data.toString().trim()}`);
    });

    child.stderr.on("data", data => {
        const text = data.toString().trim();
        if (text) console.log(`[${name}] ${text}`);
    });

    child.on("error", err => {
        console.error(`[${name}] failed: ${err.message}`);
    });

    child.on("exit", (code, signal) => {
        console.log(`[${name}] exited code=${code} signal=${signal || "-"}`);
    });

    return child;
}

function startVirtualDisplay() {
    console.log("Starting virtual display...");

    const xvfb = startProcess(
        "Xvfb",
        [
            ":99",
            "-screen",
            "0",
            "1280x800x24",
            "-ac",
            "+extension",
            "GLX"
        ],
        "Xvfb"
    );

    setTimeout(() => {
        startProcess(
            "fluxbox",
            [
                "-display",
                ":99"
            ],
            "Fluxbox"
        );
    }, 1500);

    setTimeout(() => {
        startProcess(
            "x11vnc",
            [
                "-display",
                ":99",
                "-forever",
                "-shared",
                "-rfbport",
                "5900",
                "-nopw",
                "-localhost"
            ],
            "x11vnc"
        );
    }, 2500);

    return xvfb;
}

/* =========================
   PLAYWRIGHT
========================= */

async function startBrowser() {
    if (browserContext) {
        return browserContext;
    }

    console.log("Starting Chromium...");

    browserContext = await chromium.launchPersistentContext(
        PROFILE_DIR,
        {
            headless: false,

            viewport: {
                width: 1280,
                height: 800
            },

            args: [
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-dev-shm-usage",
                "--disable-gpu",
                "--disable-software-rasterizer",
                "--disable-blink-features=AutomationControlled",
                "--window-size=1280,800"
            ]
        }
    );

    const pages = browserContext.pages();

    if (pages.length > 0) {
        page = pages[0];
    } else {
        page = await browserContext.newPage();
    }

    page.on("close", () => {
        if (page) {
            console.log("TikTok page closed");
        }
    });

    await page.goto("https://www.tiktok.com/", {
        waitUntil: "domcontentloaded",
        timeout: 60000
    }).catch(err => {
        console.log("TikTok initial load:", safeError(err));
    });

    console.log("Chromium started");

    return browserContext;
}

/* =========================
   TIKTOK HELPERS
========================= */

async function isLoggedIn() {
    if (!page) return false;

    try {
        await page.goto("https://www.tiktok.com/", {
            waitUntil: "domcontentloaded",
            timeout: 30000
        }).catch(() => {});

        await sleep(3000);

        const loginButton = page.getByText(
            /Log in|Войти/i
        ).first();

        return !(await loginButton.isVisible().catch(() => false));
    } catch {
        return false;
    }
}

async function openTikTokProfile() {
    if (!page) {
        await startBrowser();
    }

    await page.goto("https://www.tiktok.com/", {
        waitUntil: "domcontentloaded",
        timeout: 60000
    }).catch(() => {});

    await sleep(3000);

    return page;
}

async function editProfile() {
    if (!page) {
        await startBrowser();
    }

    await page.goto(
        "https://www.tiktok.com/setting?lang=en",
        {
            waitUntil: "domcontentloaded",
            timeout: 60000
        }
    ).catch(() => {});

    await sleep(3000);
}

/* =========================
   REMOTE BROWSER
========================= */

function browserHtml() {
    return `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>TikTok Manager</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
html,body {
    margin:0;
    padding:0;
    width:100%;
    height:100%;
    background:#111;
    overflow:hidden;
}

iframe {
    width:100%;
    height:100%;
    border:0;
}
</style>
</head>

<body>
<iframe
    src="/novnc/vnc.html?autoconnect=true&resize=scale&path=novnc/websockify"
    allow="clipboard-read; clipboard-write">
</iframe>
</body>
</html>
`;
}

/* =========================
   HTTP SERVER
========================= */

const server = http.createServer((req, res) => {
    const url = new URL(
        req.url,
        `http://${req.headers.host}`
    );

    if (url.pathname === "/health") {
        res.writeHead(200, {
            "Content-Type": "application/json"
        });

        res.end(
            JSON.stringify({
                ok: true,
                browser: !!browserContext,
                page: !!page
            })
        );

        return;
    }

    if (url.pathname === "/browser") {
        const token = url.searchParams.get("token");

        if (!token || token !== SESSION_TOKEN) {
            res.writeHead(403, {
                "Content-Type": "text/plain"
            });

            res.end("Forbidden");
            return;
        }

        res.writeHead(200, {
            "Content-Type": "text/html; charset=utf-8"
        });

        res.end(browserHtml());
        return;
    }

    if (url.pathname.startsWith("/novnc/")) {
        const token = url.searchParams.get("token");

        if (token && token !== SESSION_TOKEN) {
            res.writeHead(403);
            res.end("Forbidden");
            return;
        }

        const noVncPath = url.pathname.replace(
            "/novnc/",
            "/usr/share/novnc/"
        );

        if (fs.existsSync(noVncPath)) {
            res.writeHead(200);
            fs.createReadStream(noVncPath).pipe(res);
            return;
        }

        res.writeHead(404);
        res.end("Not found");
        return;
    }

    res.writeHead(404);
    res.end("Not found");
});

/* =========================
   WEBSOCKET PROXY
========================= */

const wss = new WebSocket.Server({
    noServer: true
});

server.on("upgrade", (request, socket, head) => {
    const url = new URL(
        request.url,
        `http://${request.headers.host}`
    );

    if (!url.pathname.startsWith("/novnc/websockify")) {
        socket.destroy();
        return;
    }

    const token =
        url.searchParams.get("token") ||
        request.headers["x-session-token"];

    if (token && token !== SESSION_TOKEN) {
        socket.destroy();
        return;
    }

    wss.handleUpgrade(
        request,
        socket,
        head,
        ws => {
            const target = new WebSocket(
                "ws://127.0.0.1:5900"
            );

            ws.on("message", message => {
                if (target.readyState === WebSocket.OPEN) {
                    target.send(message);
                }
            });

            target.on("message", message => {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(message);
                }
            });

            ws.on("close", () => {
                target.close();
            });

            target.on("close", () => {
                ws.close();
            });

            ws.on("error", () => {
                target.close();
            });

            target.on("error", () => {
                ws.close();
            });
        }
    );
});

/* =========================
   TELEGRAM UI
========================= */

function mainKeyboard() {
    return Markup.inlineKeyboard([
        [
            Markup.button.callback(
                "🌐 Открыть TikTok",
                "open_browser"
            )
        ],
        [
            Markup.button.callback(
                "🔐 Проверить вход",
                "check_login"
            )
        ],
        [
            Markup.button.callback(
                "👤 Профиль",
                "profile"
            )
        ],
        [
            Markup.button.callback(
                "✏️ Редактировать профиль",
                "edit_profile"
            )
        ],
        [
            Markup.button.callback(
                "🚪 Выйти",
                "logout"
            )
        ]
    ]);
}

/* =========================
   /START
========================= */

bot.start(async ctx => {
    users.set(ctx.from.id, {
        id: ctx.from.id,
        session: randomId()
    });

    await ctx.reply(
        "🎵 TikTok Manager\n\n" +
        "Управление твоим TikTok через браузер.\n\n" +
        "Нажми «Открыть TikTok», чтобы открыть браузер на сервере.",
        mainKeyboard()
    );
});

/* =========================
   /LOGIN
========================= */

bot.command("login", async ctx => {
    await sendBrowserLink(ctx);
});

/* =========================
   BROWSER BUTTON
========================= */

bot.action("open_browser", async ctx => {
    await ctx.answerCbQuery();

    await sendBrowserLink(ctx);
});

async function sendBrowserLink(ctx) {
    try {
        await startBrowser();

        const hostname =
            process.env.RENDER_EXTERNAL_HOSTNAME;

        if (!hostname) {
            await ctx.reply(
                "❌ RENDER_EXTERNAL_HOSTNAME не установлен.\n\n" +
                "На Render он обычно добавляется автоматически."
            );

            return;
        }

        const link =
            `https://${hostname}/browser?token=${encodeURIComponent(SESSION_TOKEN)}`;

        await ctx.reply(
            "🌐 Браузер TikTok запущен.\n\n" +
            "Открой ссылку ниже и вручную войди в TikTok.\n\n" +
            "Если TikTok попросит код, CAPTCHA или подтверждение — пройди их вручную.\n\n" +
            "🔗 " + link
        );

    } catch (err) {
        console.error(err);

        await ctx.reply(
            "❌ Не удалось запустить браузер:\n" +
            safeError(err)
        );
    }
}

/* =========================
   CHECK LOGIN
========================= */

bot.action("check_login", async ctx => {
    await ctx.answerCbQuery();

    try {
        const logged = await isLoggedIn();

        if (logged) {
            await ctx.reply(
                "✅ Похоже, ты вошёл в TikTok.",
                mainKeyboard()
            );
        } else {
            await ctx.reply(
                "❌ Вход не обнаружен.\n\n" +
                "Открой браузер через кнопку и войди вручную.",
                mainKeyboard()
            );
        }
    } catch (err) {
        await ctx.reply(
            "❌ Ошибка проверки:\n" +
            safeError(err)
        );
    }
});

/* =========================
   PROFILE
========================= */

bot.action("profile", async ctx => {
    await ctx.answerCbQuery();

    try {
        await openTikTokProfile();

        await ctx.reply(
            "👤 Профиль TikTok открыт в браузере.\n\n" +
            "Для изменения данных используй «Редактировать профиль».",
            mainKeyboard()
        );
    } catch (err) {
        await ctx.reply(
            "❌ Ошибка:\n" +
            safeError(err)
        );
    }
});

/* =========================
   EDIT PROFILE
========================= */

bot.action("edit_profile", async ctx => {
    await ctx.answerCbQuery();

    try {
        await editProfile();

        await ctx.reply(
            "✏️ Открыл настройки профиля TikTok.\n\n" +
            "Изменения можно выполнить непосредственно в открытом браузере."
        );
    } catch (err) {
        await ctx.reply(
            "❌ Не удалось открыть редактирование профиля:\n" +
            safeError(err)
        );
    }
});

/* =========================
   LOGOUT
========================= */

bot.action("logout", async ctx => {
    await ctx.answerCbQuery();

    try {
        if (page) {
            await page.goto(
                "https://www.tiktok.com/",
                {
                    waitUntil: "domcontentloaded",
                    timeout: 30000
                }
            ).catch(() => {});

            await sleep(1000);
        }

        await ctx.reply(
            "🚪 Для полного выхода из TikTok открой браузер и используй кнопку Log out в настройках TikTok."
        );
    } catch (err) {
        await ctx.reply(
            "❌ Ошибка:\n" +
            safeError(err)
        );
    }
});

/* =========================
   ERROR HANDLER
========================= */

bot.catch((err, ctx) => {
    console.error(
        "Telegram bot error:",
        err
    );

    ctx.reply(
        "❌ Произошла ошибка бота."
    ).catch(() => {});
});

/* =========================
   START
========================= */

async function main() {
    console.log("Starting Zenodrop/TikTok Manager...");

    startVirtualDisplay();

    await sleep(4000);

    await startBrowser();

    server.listen(PORT, "0.0.0.0", () => {
        console.log(
            `HTTP server running on ${PORT}`
        );

        console.log(
            "PUBLIC URL:",
            process.env.RENDER_EXTERNAL_URL ||
            process.env.RENDER_EXTERNAL_HOSTNAME ||
            "(not set)"
        );
    });

    await bot.launch();

    console.log("Telegram bot started");
}

main().catch(err => {
    console.error(
        "FATAL ERROR:",
        err
    );

    process.exit(1);
});

process.once("SIGINT", () => {
    bot.stop("SIGINT");
});

process.once("SIGTERM", () => {
    bot.stop("SIGTERM");
});
