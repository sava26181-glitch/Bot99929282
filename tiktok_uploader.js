const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const fs = require('fs');
const https = require('https');
const { fingerprintInitScript } = require('./fingerprint');

chromium.use(stealth);

/* ============================================================
 *  ХЕШТЕГ-БАЗА (без изменений)
 * ============================================================ */

const BROAD_TAGS = [
  'fyp', 'foryou', 'foryoupage', 'viral', 'trending',
  'viralvideo', 'fy', 'explore', 'recommended', 'tiktok'
];

const NICHE_TAGS = [
  'dropshipping', 'ecommerce', 'sidehustle', 'makemoneyonline',
  'business', 'entrepreneur', 'onlinebusiness', 'digitalproducts',
  'passiveincome', 'smallbusiness', 'money', 'hustle',
  'marketing', 'shopify', 'amazonfba', 'affiliatemarketing',
  'workfromhome', 'financialfreedom', 'success', 'motivation'
];

const BRAND_TAG = 'zenodrop';
const GEO_TAGS = ['usa', 'uk', 'canada', 'australia', 'europe', 'america'];
const SEASONAL_TAGS = {
  '01': ['newyear', 'newyear2026', 'freshstart'],
  '02': ['valentines', 'love', 'couplegoals'],
  '03': ['spring', 'springbreak', 'march'],
  '04': ['easter', 'springvibes'],
  '05': ['summer', 'summervibes', 'memorialday'],
  '06': ['summer2026', 'vacation', 'beachvibes'],
  '07': ['summer', '4thofjuly', 'hotgirlsummer'],
  '08': ['backtoschool', 'summerending'],
  '09': ['fall', 'autumnvibes', 'backtoschool'],
  '10': ['halloween', 'spookyseason', 'fallvibes'],
  '11': ['thanksgiving', 'blackfriday', 'cybermonday'],
  '12': ['christmas', 'holidays', 'winter', 'newyearseve']
};

let TRENDING_CACHE = [];

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function pickRandom(arr, n) {
  if (!arr || !arr.length) return [];
  return shuffle(arr).slice(0, n);
}

function buildHashtags(options = {}) {
  const {
    niche = NICHE_TAGS,
    broad = BROAD_TAGS,
    geo = GEO_TAGS,
    month = String(new Date().getMonth() + 1).padStart(2, '0'),
    brand = BRAND_TAG,
    extra = [],
    count = { broad: 3, niche: 4, geo: 1, seasonal: 1, trending: 1 }
  } = options;

  const seasonal = SEASONAL_TAGS[month] || [];
  const tags = [
    ...pickRandom(broad, count.broad),
    ...pickRandom(niche, count.niche),
    brand,
    ...pickRandom(geo, count.geo),
    ...pickRandom(seasonal, count.seasonal),
    ...pickRandom(TRENDING_CACHE, count.trending),
    ...extra
  ];

  const unique = [...new Set(tags.map(t => String(t).toLowerCase().replace(/^#/, '').trim()).filter(Boolean))];
  const brandLower = brand.toLowerCase();
  const brandIdx = unique.indexOf(brandLower);
  if (brandIdx > -1) {
    unique.splice(brandIdx, 1);
    unique.splice(Math.min(4, unique.length), 0, brandLower);
  }
  return unique.map(t => '#' + t);
}

function fetchTrendingHashtags(region = 'US', period = 7) {
  return new Promise(resolve => {
    const url = `https://ads.tiktok.com/creative_radar_api/v1/popular_trend/hashtag/list` +
                `?period=${period}&page=1&limit=20&order_by=popular&country_code=${region}`;
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Referer': 'https://ads.tiktok.com/business/creativecenter/inspiration/popular/hashtag/pc/en'
      },
      timeout: 15000
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve((json?.data?.list || []).map(x => x.hashtag_name).filter(Boolean));
        } catch { resolve([]); }
      });
    });
    req.on('error', () => resolve([]));
    req.on('timeout', () => { req.destroy(); resolve([]); });
  });
}

async function refreshTrending() {
  const tags = await fetchTrendingHashtags('US', 7);
  if (tags.length) TRENDING_CACHE = tags;
  return TRENDING_CACHE;
}

/* ============================================================
 *  UPLOADER
 * ============================================================ */

class TikTokUploader {
  constructor(config = {}) {
    this.cookiesPath = config.cookiesPath || null;
    this.cookies = config.cookies || null;
    this.headless = config.headless !== false;
    this.proxy = config.proxy || null;
    this.fingerprint = config.fingerprint || null;
    this.accountId = config.accountId || null;
    this.onCookies = config.onCookies || null;
    this.browser = null;
    this.context = null;
    this.page = null;
  }

  async init() {
    if (this.browser) return;

    const fp = this.fingerprint || {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
      timezone: 'America/New_York',
      geolocation: { latitude: 40.7128, longitude: -74.0060 },
      locale: 'en-US',
      platform: 'Win32',
      hardwareConcurrency: 8,
      deviceMemory: 8,
      canvasNoise: 'default'
    };

    const launchOpts = {
      headless: this.headless,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-features=IsolateOrigins,site-per-process',
        '--no-first-run',
        '--no-zygote'
      ]
    };

    if (this.proxy) {
      launchOpts.proxy = {
        server: this.proxy.server,
        username: this.proxy.username || undefined,
        password: this.proxy.password || undefined
      };
    }

    this.browser = await chromium.launch(launchOpts);

    this.context = await this.browser.newContext({
      viewport: fp.viewport,
      userAgent: fp.userAgent,
      locale: fp.locale,
      timezoneId: fp.timezone,
      geolocation: fp.geolocation,
      permissions: ['geolocation'],
      colorScheme: 'light',
      deviceScaleFactor: fp.pixelRatio || 1,
      extraHTTPHeaders: {
        'Accept-Language': `${fp.locale},${fp.locale.split('-')[0]};q=0.9`,
        'sec-ch-ua-platform': `"${fp.platform === 'MacIntel' ? 'macOS' : 'Windows'}"`
      }
    });

    // Инжектим фингерпринт
    await this.context.addInitScript(fingerprintInitScript(fp));

    // Cookies
    const cookies = this.cookies || (this.cookiesPath && fs.existsSync(this.cookiesPath)
      ? JSON.parse(fs.readFileSync(this.cookiesPath, 'utf8'))
      : null);
    if (Array.isArray(cookies) && cookies.length) {
      try { await this.context.addCookies(cookies); } catch (e) {}
    }

    this.page = await this.context.newPage();
  }

  async saveCookies() {
    try {
      const cookies = await this.context.cookies();
      if (this.cookiesPath) fs.writeFileSync(this.cookiesPath, JSON.stringify(cookies, null, 2));
      if (this.onCookies) await this.onCookies(cookies);
      return cookies;
    } catch { return null; }
  }

  async humanDelay(min, max) {
    await this.page.waitForTimeout(Math.floor(Math.random() * (max - min) + min));
  }

  /* --- РЕГИСТРАЦИЯ АККАУНТА --- */
  async signup(email, password, username, birthDate = { month: 6, day: 15, year: 1995 }) {
    await this.page.goto('https://www.tiktok.com/signup/phone-or-email/email', {
      waitUntil: 'domcontentloaded', timeout: 60000
    });
    await this.humanDelay(3000, 5000);

    // Месяц
    try {
      await this.page.selectOption('select[name="month"]', String(birthDate.month));
      await this.humanDelay(300, 800);
      await this.page.selectOption('select[name="day"]', String(birthDate.day));
      await this.humanDelay(300, 800);
      await this.page.selectOption('select[name="year"]', String(birthDate.year));
    } catch {}

    // Email
    await this.page.waitForSelector('input[name="email"]', { timeout: 30000 });
    await this.page.click('input[name="email"]');
    for (const ch of email) {
      await this.page.keyboard.type(ch, { delay: 50 + Math.random() * 80 });
    }
    await this.humanDelay(400, 900);

    // Password
    await this.page.click('input[type="password"]');
    for (const ch of password) {
      await this.page.keyboard.type(ch, { delay: 50 + Math.random() * 80 });
    }
    await this.humanDelay(600, 1200);

    // Submit
    const submit = await this.page.$('button[type="submit"]');
    if (submit) await submit.click();

    // Ждём капчу или код
    await this.page.waitForTimeout(5000);

    if (this.page.url().includes('captcha') || await this.page.$('.captcha_verify_container')) {
      await this.saveCookies();
      return { captcha: true, step: 'signup_captcha' };
    }

    // Может потребоваться код из email — передаём наверх
    const needsCode = await this.page.$('input[name="code"], input[placeholder*="code" i], input[inputmode="numeric"]');
    if (needsCode) {
      return { needsCode: true, email };
    }

    // Пробуем поставить username, если форма предложит
    try {
      await this.page.waitForSelector('input[name="username"]', { timeout: 5000 });
      await this.page.click('input[name="username"]');
      for (const ch of username) {
        await this.page.keyboard.type(ch, { delay: 60 + Math.random() * 80 });
      }
      await this.humanDelay(500, 1000);
    } catch {}

    await this.saveCookies();
    return { success: true, email, username };
  }

  /* --- ВВОД КОДА ПОДТВЕРЖДЕНИЯ --- */
  async submitSignupCode(code) {
    try {
      const input = await this.page.$('input[name="code"], input[inputmode="numeric"]');
      if (!input) return { error: 'code input not found' };
      await input.fill('');
      for (const ch of code) {
        await this.page.keyboard.type(ch, { delay: 100 + Math.random() * 100 });
      }
      await this.humanDelay(500, 1000);
      const btn = await this.page.$('button[type="submit"]');
      if (btn) await btn.click();
     Until await this.page.waitForTimeout(5000);
      await this.saveCookies();
      return { success: true };
    } catch (e:) {
      return { error: e.message };
    }
 '  }

  /* --- ЛОГИН ---dom */
  async login(username, passwordcontent)loaded {
    await this.page.goto('https://www.tiktok.com/login/phone-or-email/email', {
      waitUntil: 'domcontentloaded', timeout: 60000
    });
    await this.humanDelay(2500, 4500);

    // Cookie banner
    try {
      const btn = await this.page.$('button:has-text("Accept"), button:has-text("Allow")');
      if (btn) { await btn.click(); await this.humanDelay(800, 1500); }
    } catch {}

    await this.page.waitForSelector('input[name="username"]', { timeout: 30000 });

    await this.page.click('input[name="username"]');
    for (const ch of username) await this.page.keyboard.type(ch, { delay: 60 + Math.random() * 80 });
    await this.humanDelay(400, 900);

    await this.page.click('input[type="password"]');
    for (const ch of password) await this.page.keyboard.type(ch, { delay: 60 + Math.random() * 80 });
    await this.humanDelay(700, 1400);

    await this.page.click('button[type="submit"]');
    await this.page.waitForTimeout(6000);

    if (this.page.url().includes('captcha') || await this.page.$('.captcha_verify_container')) {
      await this.saveCookies();
      return { captcha: true };
    }

    const isLoggedIn = !this.page.url().includes('/login');
    await this.saveCookies();
    return { success: isLoggedIn, captcha: false };
  }

  /* --- СМЕНА НИКА НА zenodrop_XXXX --- */
  async setNickname(newNickname) {
    // Идём в настройки профиля
    await this.page.goto('https://www.tiktok.com/setting', {
      waitUntil: 'domcontentloaded', timeout: 60000
    });
    await this.humanDelay(3000, 5000);

    // Открываем вкладку Edit profile / Manage account
    try {
      const link = await this.page.$('a[href*="/setting/profile"], [data-e2e="profile-setting"]');
      if (link) { await link.click(); await this.humanDelay(2000, 4000); }
      else {
        await this.page.goto('https://www.tiktok.com/setting/profile', {
          wait', timeout: 60000
        });
        await this.humanDelay(2000, 4000);
      }
    } catch {}

    // Ждём форму
    let usernameInput = null;
    for (let i = 0; i < 10 && !usernameInput; i++) {
      usernameInput = await this.page.$('input[name="username"], input[placeholder*="Username" i]');
      if (!usernameInput) await this.humanDelay(1000, 2000);
    }
    if (!usernameInput) return { error: 'nickname input not found' };

    // Очищаем
    await usernameInput.click();
    await this.page.keyboard.down('Control');
    await this.page.keyboard.press('A');
    await this.page.keyboard.up('Control');
    await this.page.keyboard.press('Backspace');
    await this.humanDelay(500, 1000);

    // Вводим новый
    for (const ch of newNickname) {
      await this.page.keyboard.type(ch, { delay: 70 + Math.random() * 80 });
    }
    await this.humanDelay(800, 1500);

    // Save
    const saveBtn = await this.page.$('button:has-text("Save"), button[type="submit"]');
    if (saveBtn) await saveBtn.click();

    await this.page.waitForTimeout(4000);
    await this.saveCookies();
    return { success: true, nickname: newNickname };
  }

  /* --- UPLOAD VIDEO --- */
  async uploadVideo(videoPath, caption, options = {}) {
    await this.page.goto('https://www.tiktok.com/tiktokstudio/upload?from=upload', {
      waitUntil: 'domcontentloaded', timeout: 60000
    });
    await this.humanDelay(3000, 6000);

    await this.page.waitForSelector('input[type="file"]', { timeout: 60000 });
    const fileInput = await this.page.$('input[type="file"]');
    await fileInput.setInputFiles(videoPath);

    await this.page.waitForTimeout(8000);
    await this.page.waitForSelector('.video-info-container, [data-e2e="video-info-container"]', { timeout: 180000 });
    await this.humanDelay(2000, 4000);

    const captionSelector = '.public-DraftEditor-content, [contenteditable="true"]';
    await this.page.waitForSelector(captionSelector, { timeout: 30000 });
    await this.page.click(captionSelector);
    await this.humanDelay(500, 1000);

    if (caption) {
      for (const char of caption) {
        await this.page.keyboard.type(char, { delay: Math.random() * 120 + 40 });
        if (Math.random() < 0.08) await this.humanDelay(300, 1200);
      }
      await this.humanDelay(500, 1500);
    }

    const hashtags = options.hashtags && options.hashtags.length
      ? options.hashtags
      : buildHashtags({ niche: options.niche, extra: options.extra });

    if (caption) {
      await this.page.keyboard.type(' ', { delay: 80 });
      await this.humanDelay(400, 900);
    }

    for (let i = 0; i < hashtags.length; i++) {
      const tag = hashtags[i];
      if (Math.random() < 0.07) {
        const typo = tag.slice(0, Math.max(2, tag.length - 1)) + 'x';
        await this.page.keyboard.type(typo, { delay: 90 });
        await this.humanDelay(300, 700);
        for (let k = 0; k < typo.length; k++) {
          await this.page.keyboard.press('Backspace');
          await this.page.waitForTimeout(40 + Math.random() * 60);
        }
        await this.humanDelay(200, 500);
      }
      await this.page.keyboard.type(tag, { delay: Math.random() * 100 + 50 });
      await this.humanDelay(300, 1000);
      if (i < hashtags.length - 1) {
        if (Math.random() < 0.7) await this.page.keyboard.type(' ', { delay: 60 });
        else await this.page.keyboard.press('Enter');
        await this.humanDelay(200, 600);
      }
    }

    await this.humanDelay(1500, 3000);
    await this.humanDelay(2000, 5000);

    const postButton = await this.page.$('button[data-e2e="post_video_button"], button:has-text("Post")');
    if (!postButton) throw new Error('Кнопка публикации не найдена');

    await postButton.click();
    await this.page.waitForTimeout(12000);

    const currentUrl = this.page.url();
    await this.saveCookies();
    return { success: true, url: currentUrl, hashtags };
  }

  async close() {
    try { await this.saveCookies(); } catch {}
    try { if (this.browser) await this.browser.close(); } catch {}
    this.browser = null;
    this.context = null;
    this.page = null;
  }
}

module.exports = TikTokUploader;
module.exports.buildHashtags = buildHashtags;
module.exports.refreshTrending = refreshTrending;
module.exports.BRAND_TAG = BRAND_TAG;
