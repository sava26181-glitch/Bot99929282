const { chromium } = require('playwright');
const fs = require('fs');
const https = require('https');

/* ============================================================
 *  ХЕШТЕГ-БАЗА
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

const GEO_TAGS = [
  'usa', 'uk', 'canada', 'australia', 'europe',
  'america', 'london', 'newyork', 'california', 'texas'
];

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
  if (!arr || arr.length === 0) return [];
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
    const insertAt = Math.min(4, unique.length);
    unique.splice(insertAt, 0, brandLower);
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
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://ads.tiktok.com/business/creativecenter/inspiration/popular/hashtag/pc/en'
      },
      timeout: 15000
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const tags = (json?.data?.list || [])
            .map(x => x.hashtag_name || x.hashtag || x.name)
            .filter(Boolean);
          resolve(tags);
        } catch {
          resolve([]);
        }
      });
    });

    req.on('error', () => resolve([]));
    req.on('timeout', () => { req.destroy(); resolve([]); });
  });
}

async function refreshTrending() {
  const tags = await fetchTrendingHashtags('US', 7);
  if (tags.length) {
    TRENDING_CACHE = tags;
    console.log(`[trending] updated: ${tags.length} tags`);
  }
  return TRENDING_CACHE;
}

/* ============================================================
 *  UPLOADER
 * ============================================================ */

class TikTokUploader {
  constructor(config = {}) {
    this.cookiesPath = config.cookiesPath || './tiktok_cookies.json';
    this.headless = config.headless !== false;
    this.proxy = config.proxy || null;
    this.browser = null;
    this.context = null;
    this.page = null;
    this.userAgent = config.userAgent ||
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  }

  async init() {
    if (this.browser) return;

    const launchOpts = {
      headless: this.headless,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu'
      ]
    };

    if (this.proxy) {
      launchOpts.proxy = {
        server: this.proxy.server,
        username: this.proxy.username,
        password: this.proxy.password
      };
    }

    this.browser = await chromium.launch(launchOpts);

    this.context = await this.browser.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent: this.userAgent,
      locale: 'en-US',
      timezoneId: 'America/New_York',
      geolocation: { latitude: 40.7128, longitude: -74.0060 },
      permissions: ['geolocation'],
      extraHTTPHeaders: {
        'Accept-Language': 'en-US,en;q=0.9',
        'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"'
      }
    });

    await this.context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
      window.chrome = { runtime: {} };
      const originalQuery = window.navigator.permissions.query;
      window.navigator.permissions.query = (parameters) => (
        parameters.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission })
          : originalQuery(parameters)
      );
    });

    if (fs.existsSync(this.cookiesPath)) {
      try {
        const cookies = JSON.parse(fs.readFileSync(this.cookiesPath, 'utf8'));
        if (Array.isArray(cookies) && cookies.length) await this.context.addCookies(cookies);
      } catch (e) {
        console.error('cookies load error:', e.message);
      }
    }

    this.page = await this.context.newPage();
  }

  async saveCookies() {
    try {
      const cookies = await this.context.cookies();
      fs.writeFileSync(this.cookiesPath, JSON.stringify(cookies, null, 2));
    } catch (e) {
      console.error('save cookies error:', e.message);
    }
  }

  async humanDelay(min, max) {
    const delay = Math.floor(Math.random() * (max - min) + min);
    await this.page.waitForTimeout(delay);
  }

  async login(username, password) {
    await this.page.goto('https://www.tiktok.com/login/phone-or-email/email', {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });
    await this.humanDelay(2500, 4500);

    // Закрываем возможный cookie-баннер
    try {
      const cookieBtn = await this.page.$('button:has-text("Accept"), button:has-text("Allow")');
      if (cookieBtn) {
        await cookieBtn.click();
        await this.humanDelay(800, 1500);
      }
    } catch {}

    await this.page.waitForSelector('input[name="username"]', { timeout: 30000 });

    await this.page.click('input[name="username"]');
    for (const ch of username) {
      await this.page.keyboard.type(ch, { delay: 60 + Math.random() * 80 });
    }
    await this.humanDelay(400, 900);

    await this.page.click('input[type="password"]');
    for (const ch of password) {
      await this.page.keyboard.type(ch, { delay: 60 + Math.random() * 80 });
    }
    await this.humanDelay(700, 1400);

    await this.page.click('button[type="submit"]');
    await this.page.waitForTimeout(6000);

    if (
      this.page.url().includes('captcha') ||
      await this.page.$('.captcha_verify_container') ||
      await this.page.$('#captcha_container')
    ) {
      await this.saveCookies();
      return { captcha: true };
    }

    // Проверяем, что залогинились
    const isLoggedIn = !this.page.url().includes('/login');
    await this.saveCookies();
    return { success: isLoggedIn, captcha: false };
  }

  async uploadVideo(videoPath, caption, options = {}) {
    await this.page.goto('https://www.tiktok.com/tiktokstudio/upload?from=upload', {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });
    await this.humanDelay(3000, 6000);

    await this.page.waitForSelector('input[type="file"]', { timeout: 60000 });
    const fileInput = await this.page.$('input[type="file"]');
    await fileInput.setInputFiles(videoPath);

    // Ждём загрузки и обработки
    await this.page.waitForTimeout(8000);
    await this.page.waitForSelector('.video-info-container, [data-e2e="video-info-container"]', { timeout: 180000 });
    await this.humanDelay(2000, 4000);

    // --- CAPTION ---
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

    // --- ХЕШТЕГИ ---
    const hashtags = options.hashtags && options.hashtags.length
      ? options.hashtags
      : buildHashtags({
          niche: options.niche,
          broad: options.broad,
          geo: options.geo,
          extra: options.extra
        });

    if (caption) {
      await this.page.keyboard.type(' ', { delay: 80 });
      await this.humanDelay(400, 900);
    }

    for (let i = 0; i < hashtags.length; i++) {
      const tag = hashtags[i];

      // Иногда "печатаем с ошибкой" и стираем — очень человечно
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
        if (Math.random() < 0.7) {
          await this.page.keyboard.type(' ', { delay: 60 });
        } else {
          await this.page.keyboard.press('Enter');
        }
        await this.humanDelay(200, 600);
      }
    }

    await this.humanDelay(1500, 3000);

    // Финальная пауза перед публикацией
    await this.humanDelay(2000, 5000);

    const postButton = await this.page.$('button[data-e2e="post_video_button"], button:has-text("Post")');
    if (!postButton) throw new Error('Кнопка публикации не найдена — вероятно, капча или ошибка загрузки.');

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
module.exports.BROAD_TAGS = BROAD_TAGS;
module.exports.NICHE_TAGS = NICHE_TAGS;
module.exports.BRAND_TAG = BRAND_TAG;
