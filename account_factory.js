const crypto = require('crypto');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { generateFingerprint } = require('./fingerprint');
const TikTokMobile = require('./tiktok_uploader');
const { acquireProxyAtomic, releaseProxyAtomic } = require('./accounts_store');
const store = require('./accounts_store');
const { createTempGmail, checkInbox, readMessage, searchInbox } = require('./gmail_bridge');

const DEFAULT_BIO = process.env.GLOBAL_BIO ||
  'депать последние деньги только тут\n👉 zenodrop.fun\n👉тгк: zenodrp';

/* ============================================================
 *  EMAIL ЧЕРЕЗ TEMP-GMAIL (Python)
 * ============================================================ */

async function createMailer() {
  const { email } = await createTempGmail();

  return {
    email,
    getMessages: async () => {
      try {
        const { emails } = await checkInbox();
        return emails || [];
      } catch (e) {
        return [];
      }
    },
    readMessage: async (id) => {
      try {
        const { content } = await readMessage(id);
        return content;
      } catch (e) {
        return null;
      }
    },
    searchCode: async (keyword = 'TikTok') => {
      try {
        const { result } = await searchInbox(keyword);
        return result;
      } catch (e) {
        return null;
      }
    }
  };
}

function randStr(n) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < n; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function randomPassword(len = 16) {
  const chars = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$';
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function randomBirthDate() {
  return {
    month: 1 + Math.floor(Math.random() * 12),
    day: 1 + Math.floor(Math.random() * 28),
    year: 1985 + Math.floor(Math.random() * 15)
  };
}

function zenodropNickname(seq) {
  return `zenodrop_${String(seq).padStart(4, '0')}`;
}

async function resolveProfileUrl(api, username) {
  if (username) {
    return `https://www.tiktok.com/@${username}`;
  }
  return null;
}

/* ============================================================
 *  СОЗДАНИЕ ОДНОГО АККАУНТА
 * ============================================================ */

async function createOneAccount({ seq, nickname, niche, log = () => {}, shouldStop = () => false }) {
  const id = crypto.randomUUID().slice(0, 12);
  const nick = nickname || zenodropNickname(seq);

  if (shouldStop()) {
    return { success: false, reason: 'stopped', seq };
  }

  let proxy = null;
  try {
    proxy = await acquireProxyAtomic(id);
  } catch (e) {
    log(`[#${seq}] proxy acquire error: ${e.message}`);
  }

  if (!proxy) {
    return { success: false, reason: 'no_proxy', seq };
  }

  const fingerprint = generateFingerprint(id);
  const password = randomPassword();
  const birthDate = randomBirthDate();

  let mailer = null;
  const api = new TikTokMobile({
    deviceId: null,
    accountId: id,
    proxy,
    fingerprint,
    onCookies: async (cks) => {
      await store.saveCookies(id, cks).catch(() => {});
    }
  });

  try {
    // 1. Почта (temp-gmail через Python) + регистрация device
    const [mailResult, deviceResult] = await Promise.allSettled([
      createMailer(),
      api.registerDevice()
    ]);

    if (mailResult.status !== 'fulfilled') {
      throw new Error(`email: ${mailResult.reason?.message || 'failed'}`);
    }
    mailer = mailResult.value;

    if (deviceResult.status !== 'fulfilled') {
      throw new Error(`device: ${deviceResult.reason?.message || 'failed'}`);
    }

    log(`[#${seq}] ${mailer.email} | device=${api.deviceId}`);

    if (shouldStop()) throw new Error('stopped');

    // 2. Регистрация аккаунта
    const signupResult = await api.signup(mailer.email, password, nick, birthDate);

    if (signupResult.captcha) {
      throw new Error('captcha');
    }

    if (signupResult.needsCode) {
      log(`[#${seq}] ждём код...`);
      let code = null;
      for (let i = 0; i < 20 && !code; i++) {
        if (shouldStop()) throw new Error('stopped');
        await new Promise(r => setTimeout(r, 3000));
        try {
          // Сначала пробуем через searchCode — ищем "TikTok" в письмах
          const searchResult = await mailer.searchCode('TikTok');
          if (searchResult) {
            const text = JSON.stringify(searchResult);
            const m = text.match(/\b(\d{6})\b/);
            if (m) { code = m[1]; break; }
          }
          // Фолбэк — читаем все письма
          const messages = await mailer.getMessages();
          for (const msg of messages) {
            const full = await mailer.readMessage(msg.id || msg.mail_id);
            const text = JSON.stringify(full);
            const m2 = text.match(/\b(\d{6})\b/);
            if (m2) { code = m2[1]; break; }
          }
        } catch (e) {
          log(`[#${seq}] mail check err: ${e.message}`);
        }
      }
      if (!code) throw new Error('no_code');

      const sub = await api.submitSignupCode(code);
      if (sub.error) throw new Error(`code_submit: ${sub.error}`);
    }

    // 3. Ник + ссылка на профиль
    await api.setNickname(nick).catch(e => log(`[#${seq}] nick: ${e.message}`));
    const profileUrl = await resolveProfileUrl(api, nick);

    // 4. Аватарка
    const avatarPath = path.join(__dirname, 'avatar.png');
    if (fs.existsSync(avatarPath)) {
      await api.setAvatar(avatarPath).catch(e => log(`[#${seq}] avatar: ${e.message}`));
    }

    // 5. Био
    await api.setBio(DEFAULT_BIO).catch(e => log(`[#${seq}] bio: ${e.message}`));

    const cookies = api.cookies;
    await store.saveCookies(id, cookies).catch(() => {});

    const acc = {
      id,
      name: nick,
      login: mailer.email,
      password,
      niche: niche || null,
      proxy,
      fingerprint,
      cookies,
      profileUrl,
      status: 'ready',
      postsCount: 0
    };
    await store.saveAccount(acc);

    log(`[#${seq}] OK → ${mailer.email} | ${profileUrl}`);
    return { success: true, account: acc, seq };
  } catch (e) {
    log(`[#${seq}] FAIL: ${e.message}`);
    return { success: false, reason: e.message, seq, email: mailer?.email };
  } finally {
    if (proxy?.id) {
      await releaseProxyAtomic(proxy.id).catch(() => {});
    }
  }
}

/* ============================================================
 *  ПАРАЛЛЕЛЬНАЯ ФАБРИКА
 * ============================================================ */

async function createBatch({
  count,
  concurrency = 10,
  niche,
  startSeq = 1,
  log = console.log,
  onProgress = null,
  shouldStop = () => false
}) {
  const results = { ok: [], fail: [], total: count, started: Date.now(), stopped: false };
  const queue = Array.from({ length: count }, (_, i) => startSeq + i);
  let inFlight = 0;

  async function worker(workerId) {
    while (queue.length) {
      if (shouldStop()) { results.stopped = true; return; }
      const seq = queue.shift();
      if (seq === undefined) return;

      inFlight++;
      const r = await createOneAccount({ seq, niche, log, shouldStop });
      inFlight--;

      if (r.success) results.ok.push(r.account);
      else results.fail.push({ seq, reason: r.reason });

      if (onProgress) {
        await onProgress({
          done: results.ok.length + results.fail.length,
          total: count,
          ok: results.ok.length,
          fail: results.fail.length,
          inFlight,
          elapsed: Math.floor((Date.now() - results.started) / 1000)
        }).catch(() => {});
      }
    }
  }

  const workers = Array.from({ length: concurrency }, (_, i) => worker(i));
  await Promise.all(workers);

  results.elapsed = Math.floor((Date.now() - results.started) / 1000);
  return results;
}

module.exports = {
  createOneAccount,
  createBatch,
  createMailer,
  zenodropNickname,
  DEFAULT_BIO
};
