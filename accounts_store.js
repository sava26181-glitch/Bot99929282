const crypto = require('crypto');
const https = require('https');
const fs = require('fs');
const { signTikTokRequest } = require('./signer_bridge');

const MOBILE_API_HOST = 'api16-normal-c-useast1a.tiktokv.com';

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

function httpRequest(url, options, body = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: options.method || 'GET',
      headers: options.headers || {},
      timeout: 60000
    }, res => {
      let out = '';
      res.on('data', c => out += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(out);
          resolve({ status: res.statusCode, data: json });
        } catch {
          resolve({ status: res.statusCode, data: { raw: out } });
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('request timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

class TikTokMobile {
  constructor(config = {}) {
    this.deviceId = config.deviceId || null;
    this.iid = config.iid || null;
    this.installId = config.installId || null;
    this.openudid = config.openudid || crypto.randomBytes(16).toString('hex');
    this.cdid = config.cdid || crypto.randomUUID();
    this.cookies = config.cookies || null;
    this.accountId = config.accountId || null;
    this.onCookies = config.onCookies || null;
  }

  baseParams() {
    return {
      aid: 1233,
      app_name: 'musical_ly',
      version_code: 300904,
      version_name: '30.9.4',
      manifest_version_code: 2023009040,
      update_version_code: 2023009040,
      channel: 'googleplay',
      device_platform: 'android',
      device_type: 'Pixel 7',
      device_brand: 'google',
      os_version: '13',
      os_api: 33,
      resolution: '1080*2400',
      dpi: 420,
      language: 'en',
      os: 'android',
      timezone_name: 'America/New_York',
      timezone_offset: '-14400',
      openudid: this.openudid,
      cdid: this.cdid,
      device_id: this.deviceId || 0,
      iid: this.iid || 0,
      ts: Math.floor(Date.now() / 1000),
      _rticket: Date.now()
    };
  }

  headersFor(sig) {
    const headers = {
      'User-Agent': 'com.zhiliaoapp.musically/2023009040 (Linux; U; Android 13; en_US; Pixel 7; Build/TQ3A.230805.001;tt-ok/3.12.13.4-tiktok)',
      'Accept-Encoding': 'gzip',
      'Content-Type': 'application/x-www-form-urlencoded'
    };
    if (sig['x-gorgon']) headers['x-gorgon'] = sig['x-gorgon'];
    if (sig['x-khronos']) headers['x-khronos'] = sig['x-khronos'];
    if (sig['x-argus']) headers['x-argus'] = sig['x-argus'];
    if (sig['x-ladon']) headers['x-ladon'] = sig['x-ladon'];
    if (sig['x-ss-req-ticket']) headers['x-ss-req-ticket'] = sig['x-ss-req-ticket'];
    if (sig['x-ss-stub']) headers['x-ss-stub'] = sig['x-ss-stub'];
    if (sig['x-bogus']) headers['x-bogus'] = sig['x-bogus'];
    if (this.cookies) headers['Cookie'] = this.cookies;
    return headers;
  }

  async signedRequest(pathname, params, payload = null) {
    const allParams = { ...this.baseParams(), ...params };
    const sig = await signTikTokRequest(allParams, payload, { version: 8404 });
    const headers = this.headersFor(sig);

    const body = new URLSearchParams(allParams).toString();
    const url = `https://${MOBILE_API_HOST}${pathname}?${body}`;

    const res = await httpRequest(url, { method: payload ? 'POST' : 'GET', headers }, payload);
    return res.data;
  }

  async registerDevice() {
    const result = await this.signedRequest('/service/2/device_register/', {});

    console.log('[DEVICE REGISTER RAW]:', JSON.stringify(result).slice(0, 600));

    if (result.device_id_str) this.deviceId = result.device_id_str;
    else if (result.device_id) this.deviceId = String(result.device_id);
    if (result.iid) this.iid = result.iid;
    if (result.install_id) this.installId = result.install_id;

    console.log('[DEVICE REGISTER] deviceId =', this.deviceId, '| iid =', this.iid);

    if (!this.deviceId) {
      throw new Error('device_register failed: no device_id — проверь SignerPy и прокси');
    }

    return result;
  }

  async signup(email, password, username, birthDate = { month: 6, day: 15, year: 1995 }) {
    const params = {
      email,
      password,
      username,
      birthday: `${birthDate.year}-${String(birthDate.month).padStart(2, '0')}-${String(birthDate.day).padStart(2, '0')}`,
      mix_mode: '1'
    };

    const result = await this.signedRequest('/passport/user/register/', params);

    console.log('[SIGNUP RAW]:', JSON.stringify(result).slice(0, 800));

    if (result.message === 'captcha' || result.data?.captcha || result.error_code === 10001) {
      return { captcha: true, raw: result };
    }
    if (result.data?.need_verify || result.message === 'verify') {
      return { needsCode: true, email };
    }
    if (result.data?.session_key) {
      this.cookies = `sessionid=${result.data.session_key}`;
      if (this.onCookies) await this.onCookies(this.cookies);
      return { success: true, raw: result };
    }
    return { success: false, raw: result };
  }

  async submitSignupCode(code) {
    const result = await this.signedRequest('/passport/user/verify/', {
      code,
      type: 'email'
    });
    if (result.data?.session_key) {
      this.cookies = `sessionid=${result.data.session_key}`;
      if (this.onCookies) await this.onCookies(this.cookies);
    }
    return result;
  }

  async login(username, password) {
    const result = await this.signedRequest('/passport/user/login/', {
      username,
      password,
      mix_mode: '1'
    });
    if (result.data?.session_key) {
      this.cookies = `sessionid=${result.data.session_key}`;
      if (this.onCookies) await this.onCookies(this.cookies);
    }
    return result;
  }

  async setNickname(newNickname) {
    return this.signedRequest('/aweme/v1/user/update/', {
      nickname: newNickname
    });
  }

  async setBio(bio) {
    return this.signedRequest('/aweme/v1/user/update/', {
      signature: bio
    });
  }

  async setAvatar(imagePath) {
    if (!fs.existsSync(imagePath)) throw new Error('image not found');
    const imageData = fs.readFileSync(imagePath).toString('base64');
    return this.signedRequest('/aweme/v1/upload/image/', {
      image_data: imageData
    });
  }

  async uploadVideo(videoPath, caption, options = {}) {
    if (!fs.existsSync(videoPath)) throw new Error('video not found');
    const stat = fs.statSync(videoPath);
    const size = stat.size;

    const initResult = await this.signedRequest('/aweme/v1/upload/create/', {
      video_size: size,
      video_type: 'mp4'
    });

    if (!initResult.upload_url) {
      throw new Error('No upload_url: ' + JSON.stringify(initResult).slice(0, 300));
    }

    await new Promise((resolve, reject) => {
      const u = new URL(initResult.upload_url);
      const req = https.request({
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': size
        },
        timeout: 120000
      }, res => {
        res.on('data', () => {});
        res.on('end', resolve);
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('upload timeout')); });
      fs.createReadStream(videoPath).pipe(req);
    });

    const hashtags = options.hashtags && options.hashtags.length
      ? options.hashtags
      : buildHashtags({ niche: options.niche, extra: options.extra });

    const text = [caption, ...hashtags].filter(Boolean).join(' ');

    const publishResult = await this.signedRequest('/aweme/v1/publish/', {
      text,
      upload_id: initResult.upload_id,
      video_id: initResult.video_id || ''
    });

    return { success: true, hashtags, data: publishResult };
  }
}

module.exports = TikTokMobile;
module.exports.buildHashtags = buildHashtags;
module.exports.refreshTrending = refreshTrending;
module.exports.BRAND_TAG = BRAND_TAG;
module.exports.DEFAULT_BIO = 'депать последние деньги только тут\n👉 zenodrop.fun\n👉тгк: zenodrp';
