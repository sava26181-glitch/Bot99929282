
const { Telegraf, Markup } = require("telegraf");
const { chromium } = require("playwright");
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const PORT = Number(process.env.PORT || 10000);
const BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
const SESSION_TOKEN = (process.env.SESSION_TOKEN || "").trim();

const DATA_DIR = process.env.DATA_DIR || "/app/data";
const PROFILE_DIR = path.join(DATA_DIR, "tiktok-profile");

const DISPLAY = ":99";
const NOVNC_PORT = 6080;
const VNC_PORT = 5900;

if (!BOT_TOKEN) {
    console.error("❌ TELEGRAM_BOT_TOKEN is not set");
    process.exit(1);
}

if (!SESSION_TOKEN) {
    console.error("❌ SESSION_TOKEN is not set");
    process.exit(1);
}

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(PROFILE_DIR, { recursive: true });

const bot = new Telegraf(BOT_TOKEN);

let browserContext = null;
let page = null;

const users = new Map();

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function randomId() {
    return crypto.randomBytes(16).toString("hex");
}

function errorText(error) {
    return error?.message || String(error);
}

/* =========================================================
   PROCESS MANAGEMENT
========================================================= */

const processes = [];

function startProcess(command, args, name, options = {}) {
    console.log(`▶ Starting ${name}: ${command} ${args.join(" ")}`);

    const child = spawn(command, args, {
        env: {
            ...process.env,
            DISPLAY
        },
        stdio: ["ignore", "pipe", "pipe"],
        ...options
    });

    processes.push(child);

    child.stdout?.on("data", data => {
        const text = data.toString().trim();

        if (text) {
            console.log(`[${name}] ${text}`);
        }
    });

    child.stderr?.on("data", data => {
        const text = data.toString().trim();

        if (text) {
            console.log(`[${name}] ${text}`);
        }
    });

    child.on("error", error => {
        console.error(`❌ ${name}: ${error.message}`);
    });

    child.on("exit", (code, signal) => {
        console.log(
            `ℹ ${name} exited: code=${code}, signal=${signal || "-"}`
        );
    });

    return child;
}

/* =========================================================
   VIRTUAL DISPLAY + VNC + NOVNC
========================================================= */

async function startVirtualDisplay() {
    console.log("🖥 Starting virtual display...");

    startProcess(
        "Xvfb",
        [
            DISPLAY,
            "-screen",
            "0",
            "1280x800x24",
            "-ac",
            "+extension",
            "GLX"
        ],
        "Xvfb"
    );

    await sleep(2000);

    startProcess(
        "fluxbox",
        [
            "-display",
            DISPLAY
        ],
        "Fluxbox"
    );

    await sleep(1500);

    startProcess(
        "x11vnc",
        [
            "-display",
            DISPLAY,
            "-forever",
            "-shared",
            "-rfbport",
            String(VNC_PORT),
            "-nopw",
            "-localhost",
            "-noxdamage"
        ],
        "x11vnc"
    );

    await sleep(1500);

    /*
     * websockify:
     *
     * 6080 -> noVNC web interface
     *        + WebSocket -> 5900 VNC
     */
    startProcess(
        "websockify",
        [
            "--web=/usr/share/novnc",
            String(NOVNC_PORT),
            `127.0.0.1:${VNC_PORT}`
        ],
        "websockify"
    );

    await sleep(2000);

    console.log("✅ Virtual display started");
}

/* =========================================================
   PLAYWRIGHT
========================================================= */

async function startBrowser() {
    if (browserContext) {
        return browserContext;
    }

    console.log("🌐 Starting Chromium...");

    browserContext = await chromium.launchPersistentContext(
        PROFILE_DIR,
        {
            headless: false,

            viewport: {
                width: 1280,
                height: 800
            },

            screen: {
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
                "--disable-features=Translate,OptimizationHints",
                "--no-first-run",
                "--no-default-browser-check",
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
        console.log("ℹ Chromium page closed");
        page = null;
    });

    browserContext.on("close", () => {
        console.log("ℹ Chromium context closed");
        browserContext = null;
        page = null;
    });

    await page.goto(
        "https://www.tiktok.com/",
        {
            waitUntil: "domcontentloaded",
            timeout: 60000
        }
    ).catch(error => {
        console.log(
            "TikTok initial page:",
            errorText(error)
        );
    });

    console.log("✅ Chromium started");

    return browserContext;
}

/* =========================================================
   TIKTOK
========================================================= */

async function openTikTok() {
    if (!page) {
        await startBrowser();
    }

    if (!page) {
        throw new Error("Chromium page is not available");
    }

    await page.goto(
        "https://www.tiktok.com/",
        {
            waitUntil: "domcontentloaded",
            timeout: 60000
        }
    ).catch(() => {});

    await sleep(3000);

    return page;
}

async function checkTikTokLogin() {
    if (!page) {
        await startBrowser();
    }

    if (!page) {
        return false;
    }

    try {
        await page.goto(
            "https://www.tiktok.com/",
            {
                waitUntil: "domcontentloaded",
                timeout: 45000
            }
        ).catch(() => {});

        await sleep(3000);

        const loginSelectors = [
            'a[href*="login"]',
            'button:has-text("Log in")',
            'button:has-text("Войти")',
            'div:has-text("Log in")'
        ];

        for (const selector of loginSelectors) {
            const visible = await page
                .locator(selector)
                .first()
                .isVisible()
                .catch(() => false);

            if (visible) {
                return false;
            }
        }

        /*
         * Если URL уже содержит профиль/настройки,
         * это дополнительный признак авторизации.
         */
        const currentUrl = page.url();

        if (
            currentUrl.includes("/login") ||
            currentUrl.includes("/signup")
        ) {
            return false;
        }

        return true;
    } catch {
        return false;
    }
}

/* =========================================================
   BROWSER URL
========================================================= */

function getExternalHost() {
    const hostname =
        process.env.RENDER_EXTERNAL_HOSTNAME ||
        "";

    if (!hostname) {
        return null;
    }

    return hostname;
}

function getBrowserUrl() {
    const hostname = getExternalHost();

    if (!hostname) {
        return null;
    }

    return (
        `https://${hostname}/browser?token=` +
        encodeURIComponent(SESSION_TOKEN)
    );
}

/* =========================================================
   HTML PAGE
========================================================= */

function browserHtml() {
    const encodedToken =
        encodeURIComponent(SESSION_TOKEN);

    /*
     * token передаём и в websocket path,
     * чтобы внешний endpoint можно было проверить.
     */
    const vncPath =
        `/novnc/websockify?token=${encodedToken}`;

    const vncUrl =
        `/novnc/vnc.html` +
        `?autoconnect=true` +
        `&resize=scale` +
        `&view_only=false` +
        `&reconnect=true` +
        `&reconnect_delay=2000` +
        `&path=${encodeURIComponent(vncPath)}`;

    return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">

<meta
    name="viewport"
    content="width=device-width, initial-scale=1.0"
>

<title>TikTok Manager</title>

<style>
html,
body {
    margin: 0;
    padding: 0;
    width: 100%;
    height: 100%;
    overflow: hidden;
    background: #111;
}

iframe {
    display: block;
    width: 100%;
    height: 100%;
    border: 0;
    background: #111;
}
</style>
</head>

<body>

<iframe
    src="${vncUrl}"
    allow="clipboard-read; clipboard-write"
></iframe>

</body>
</html>`;
}

/* =========================================================
   TOKEN CHECK
========================================================= */

function tokenFromRequest(req, url) {
    const queryToken =
        url.searchParams.get("token");

    const headerToken =
        req.headers["x-session-token"];

    const authHeader =
        req.headers.authorization || "";

    let bearerToken = "";

    if (authHeader.startsWith("Bearer ")) {
        bearerToken =
            authHeader.slice(7).trim();
    }

    return (
        queryToken ||
        headerToken ||
        bearerToken ||
        ""
    );
}

function isValidToken(req, url) {
    const token = tokenFromRequest(req, url);

    return (
        token.length > 0 &&
        token === SESSION_TOKEN
    );
}

/* =========================================================
   PROXY HTTP -> NOVNC
========================================================= */

function proxyHttpToNoVNC(req, res) {
    const url = new URL(
        req.url,
        `http://${req.headers.host}`
    );

    let targetPath =
        url.pathname.replace(/^\/novnc/, "");

    if (!targetPath) {
        targetPath = "/";
    }

    /*
     * Передаём query без нашего внешнего token,
     * чтобы он не мешал noVNC.
     */
    const params = new URLSearchParams();

    for (const [key, value] of url.searchParams.entries()) {
        if (key === "token") {
            continue;
        }

        params.append(key, value);
    }

    const query =
        params.toString();

    if (query) {
        targetPath += `?${query}`;
    }

    const proxyReq = http.request(
        {
            hostname: "127.0.0.1",
            port: NOVNC_PORT,
            path: targetPath,
            method: req.method,
            headers: {
                ...req.headers,
                host: `127.0.0.1:${NOVNC_PORT}`
            }
        },
        proxyRes => {
            res.writeHead(
                proxyRes.statusCode || 502,
                proxyRes.headers
            );

            proxyRes.pipe(res);
        }
    );

    proxyReq.on("error", error => {
        console.error(
            "noVNC HTTP proxy error:",
            error.message
        );

        if (!res.headersSent) {
            res.writeHead(502, {
                "Content-Type": "text/plain; charset=utf-8"
            });
        }

        res.end(
            "noVNC server is not ready"
        );
    });

    req.pipe(proxyReq);
}

/* =========================================================
   HTTP SERVER
========================================================= */

const server = http.createServer(
    (req, res) => {
        const url = new URL(
            req.url,
            `http://${req.headers.host}`
        );

        /* -------------------------
           HEALTH
        ------------------------- */

        if (url.pathname === "/health") {
            res.writeHead(200, {
                "Content-Type":
                    "application/json; charset=utf-8"
            });

            res.end(
                JSON.stringify({
                    ok: true,
                    browser: !!browserContext,
                    page: !!page,
                    novnc: true
                })
            );

            return;
        }

        /* -------------------------
           BROWSER
        ------------------------- */

        if (url.pathname === "/browser") {
            if (!isValidToken(req, url)) {
                res.writeHead(403, {
                    "Content-Type":
                        "text/plain; charset=utf-8"
                });

                res.end("Forbidden");

                return;
            }

            res.writeHead(200, {
                "Content-Type":
                    "text/html; charset=utf-8",
                "Cache-Control":
                    "no-store, no-cache, must-revalidate"
            });

            res.end(browserHtml());

            return;
        }

        /* -------------------------
           NOVNC
        ------------------------- */

        if (url.pathname.startsWith("/novnc/")) {
            proxyHttpToNoVNC(req, res);
            return;
        }

        /* -------------------------
           ROOT
        ------------------------- */

        if (url.pathname === "/") {
            res.writeHead(200, {
                "Content-Type":
                    "text/html; charset=utf-8"
            });

            res.end(`
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>TikTok Manager</title>
<style>
body {
    margin: 0;
    background: #111;
    color: white;
    font-family: Arial, sans-serif;
    display: flex;
    justify-content: center;
    align-items: center;
    height: 100vh;
}
.box {
    text-align: center;
}
a {
    display: inline-block;
    margin-top: 20px;
    padding: 14px 22px;
    border-radius: 10px;
    background: #fe2c55;
    color: white;
    text-decoration: none;
}
</style>
</head>
<body>
<div class="box">
<h2>🎵 TikTok Manager</h2>
<p>Бот работает.</p>
</div>
</body>
</html>
`);

            return;
        }

        res.writeHead(404, {
            "Content-Type":
                "text/plain; charset=utf-8"
        });

        res.end("Not found");
    }
);

/* =========================================================
   WEBSOCKET PROXY
========================================================= */

server.on(
    "upgrade",
    (req, socket, head) => {
        const url = new URL(
            req.url,
            `http://${req.headers.host}`
        );

        if (
            !url.pathname.startsWith(
                "/novnc/websockify"
            )
        ) {
            socket.destroy();
            return;
        }

        if (!isValidToken(req, url)) {
            console.log(
                "❌ WebSocket rejected: invalid token"
            );

            socket.write(
                "HTTP/1.1 403 Forbidden\r\n" +
                "Connection: close\r\n" +
                "\r\n"
            );

            socket.destroy();

            return;
        }

        /*
         * Удаляем внешний /novnc,
         * websockify ожидает /websockify.
         */
        const targetPath =
            url.pathname.replace(
                /^\/novnc/,
                ""
            ) +
            (url.search || "");

        const target = require("net").connect(
            NOVNC_PORT,
            "127.0.0.1"
        );

        target.on("connect", () => {
            let headers =
                `GET ${targetPath} HTTP/1.1\r\n`;

            headers +=
                "Host: 127.0.0.1:6080\r\n";

            headers +=
                "Connection: Upgrade\r\n";

            headers +=
                "Upgrade: websocket\r\n";

            /*
             * Передаём WebSocket handshake headers.
             */
            for (const [key, value] of Object.entries(
                req.headers
            )) {
                const lower = key.toLowerCase();

                if (
                    lower === "host" ||
                    lower === "connection" ||
                    lower === "upgrade"
                ) {
                    continue;
                }

                if (Array.isArray(value)) {
                    headers +=
                        `${key}: ${value.join(", ")}\r\n`;
                } else if (value != null) {
                    headers +=
                        `${key}: ${value}\r\n`;
                }
            }

            headers += "\r\n";

            target.write(headers);

            if (head && head.length) {
                target.write(head);
            }

            /*
             * После handshake просто прокидываем
             * байты в обе стороны.
             */
            socket.pipe(target);
            target.pipe(socket);
        });

        target.on("error", error => {
            console.error(
                "❌ WebSocket proxy error:",
                error.message
            );

            socket.destroy();
        });

        target.on("close", () => {
            socket.destroy();
        });

        socket.on("error", () => {
            target.destroy();
        });

        socket.on("close", () => {
            target.destroy();
        });
    }
);

/* =========================================================
   TELEGRAM KEYBOARD
========================================================= */

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

/* =========================================================
   SEND BROWSER LINK
========================================================= */

async function sendBrowserLink(ctx) {
    try {
        await startBrowser();

        const link = getBrowserUrl();

        if (!link) {
            await ctx.reply(
                "❌ Render не передал RENDER_EXTERNAL_HOSTNAME.\n\n" +
                "Проверь, что бот запущен именно на Render."
            );

            return;
        }

        await ctx.reply(
            "🌐 Браузер TikTok готов.\n\n" +
            "Открой ссылку ниже:\n\n" +
            `${link}\n\n` +
            "После открытия ты увидишь окно Chromium. " +
            "Войди в TikTok вручную. Если TikTok попросит " +
            "код, 2FA или CAPTCHA — пройди проверку вручную."
        );
    } catch (error) {
        console.error(
            "Browser start error:",
            error
        );

        await ctx.reply(
            "❌ Не удалось запустить браузер:\n\n" +
            errorText(error)
        );
    }
}

/* =========================================================
   /START
========================================================= */

bot.start(async ctx => {
    users.set(
        ctx.from.id,
        {
            id: ctx.from.id,
            session: randomId()
        }
    );

    await ctx.reply(
        "🎵 TikTok Manager\n\n" +
        "Управление TikTok через браузер на сервере.\n\n" +
        "Нажми кнопку ниже.",
        mainKeyboard()
    );
});

/* =========================================================
   /LOGIN
========================================================= */

bot.command(
    "login",
    async ctx => {
        await sendBrowserLink(ctx);
    }
);

/* =========================================================
   OPEN BROWSER
========================================================= */

bot.action(
    "open_browser",
    async ctx => {
        await ctx.answerCbQuery().catch(() => {});

        await sendBrowserLink(ctx);
    }
);

/* =========================================================
   CHECK LOGIN
========================================================= */

bot.action(
    "check_login",
    async ctx => {
        await ctx.answerCbQuery().catch(() => {});

        try {
            const logged =
                await checkTikTokLogin();

            if (logged) {
                await ctx.reply(
                    "✅ Похоже, ты вошёл в TikTok.",
                    mainKeyboard()
                );
            } else {
                await ctx.reply(
                    "❌ Вход не обнаружен.\n\n" +
                    "Открой браузер и войди в TikTok вручную.",
                    mainKeyboard()
                );
            }
        } catch (error) {
            await ctx.reply(
                "❌ Ошибка проверки:\n\n" +
                errorText(error)
            );
        }
    }
);

/* =========================================================
   PROFILE
========================================================= */

bot.action(
    "profile",
    async ctx => {
        await ctx.answerCbQuery().catch(() => {});

        try {
            await openTikTok();

            await ctx.reply(
                "👤 TikTok открыт в браузере.\n\n" +
                "Используй браузер для просмотра профиля.",
                mainKeyboard()
            );
        } catch (error) {
            await ctx.reply(
                "❌ Не удалось открыть TikTok:\n\n" +
                errorText(error)
            );
        }
    }
);

/* =========================================================
   EDIT PROFILE
========================================================= */

bot.action(
    "edit_profile",
    async ctx => {
        await ctx.answerCbQuery().catch(() => {});

        try {
            if (!page) {
                await startBrowser();
            }

            await page.goto(
                "https://www.tiktok.com/setting",
                {
                    waitUntil: "domcontentloaded",
                    timeout: 60000
                }
            ).catch(() => {});

            await sleep(3000);

            await ctx.reply(
                "✏️ Открыл страницу настроек TikTok.\n\n" +
                "Измени аватар, имя, описание и другие данные " +
                "непосредственно в открытом окне браузера."
            );
        } catch (error) {
            await ctx.reply(
                "❌ Не удалось открыть настройки:\n\n" +
                errorText(error)
            );
        }
    }
);

/* =========================================================
   LOGOUT
========================================================= */

bot.action(
    "logout",
    async ctx => {
        await ctx.answerCbQuery().catch(() => {});

        try {
            if (!page) {
                await startBrowser();
            }

            await page.goto(
                "https://www.tiktok.com/",
                {
                    waitUntil: "domcontentloaded",
                    timeout: 45000
                }
            ).catch(() => {});

            await ctx.reply(
                "🚪 Для выхода из TikTok используй кнопку выхода " +
                "в самом TikTok через открытый браузер."
            );
        } catch (error) {
            await ctx.reply(
                "❌ Ошибка:\n\n" +
                errorText(error)
            );
        }
    }
);

/* =========================================================
   TELEGRAM ERROR
========================================================= */

bot.catch(
    async (error, ctx) => {
        console.error(
            "Telegram bot error:",
            error
        );

        try {
            await ctx.reply(
                "❌ Произошла ошибка бота."
            );
        } catch {}
    }
);

/* =========================================================
   GRACEFUL SHUTDOWN
========================================================= */

async function shutdown(signal) {
    console.log(
        `\nReceived ${signal}. Shutting down...`
    );

    try {
        bot.stop(signal);
    } catch {}

    try {
        if (browserContext) {
            await browserContext.close();
        }
    } catch {}

    for (const child of processes) {
        try {
            child.kill("SIGTERM");
        } catch {}
    }

    try {
        server.close();
    } catch {}

    process.exit(0);
}

process.once(
    "SIGINT",
    () => shutdown("SIGINT")
);

process.once(
    "SIGTERM",
    () => shutdown("SIGTERM")
);

/* =========================================================
   START
========================================================= */

async function main() {
    console.log("=================================");
    console.log("🎵 TikTok Manager");
    console.log("=================================");

    console.log("PORT:", PORT);
    console.log("DISPLAY:", DISPLAY);
    console.log("DATA_DIR:", DATA_DIR);
    console.log("PROFILE_DIR:", PROFILE_DIR);
    console.log(
        "RENDER_EXTERNAL_HOSTNAME:",
        process.env.RENDER_EXTERNAL_HOSTNAME ||
        "(not set)"
    );

    /*
     * Сначала запускаем HTTP,
     * чтобы Render увидел открытый порт.
     */
    server.listen(
        PORT,
        "0.0.0.0",
        () => {
            console.log(
                `✅ HTTP server listening on ${PORT}`
            );
        }
    );

    /*
     * Затем графическая среда.
     */
    await startVirtualDisplay();

    /*
     * Затем Chromium.
     */
    await startBrowser();

    /*
     * Telegram polling.
     */
    console.log("🤖 Starting Telegram bot...");

    try {
        await bot.launch();

        console.log(
            "✅ Telegram bot started successfully"
        );
    } catch (error) {
        console.error(
            "❌ Bot failed to start:",
            error
        );

        /*
         * Важно:
         * 409 означает, что другой процесс использует
         * тот же Telegram bot token.
         */
        if (
            String(error).includes("409") ||
            String(error).includes(
                "terminated by other getUpdates request"
            )
        ) {
            console.error("");
            console.error(
                "============================================"
            );
            console.error(
                "❌ TELEGRAM 409 CONFLICT"
            );
            console.error(
                "Другой экземпляр этого бота уже запущен."
            );
            console.error(
                "Останови старый экземпляр бота."
            );
            console.error(
                "============================================"
            );
        }

        /*
         * Не закрываем HTTP сразу,
         * чтобы можно было открыть /health
         * и посмотреть состояние сервиса.
         */
        return;
    }
}

main().catch(error => {
    console.error(
        "❌ FATAL ERROR:",
        error
    );

    process.exit(1);
});
