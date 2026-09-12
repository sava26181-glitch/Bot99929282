const crypto = require('crypto');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { generateFingerprint } = require('./fingerprint');
const TikTokMobile = require('./tiktok_uploader');
const { acquireProxyAtomic, releaseProxyAtomic } = require('./accounts_store');
const store = require('./accounts_store');

const DEFAULT_BIO = process.env.GLOBAL_BIO ||
  'депать последние деньги только тут\n👉 zenodrop.fun\n👉тгк: zenodrp';

function fetchJson(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const body = opts.body ? JSON.stringify(opts.body) : null;
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: opts.method || 'GET',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0',
        ...(opts.headers || {}),
        ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {})
      },
      timeout: 20000
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(data); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

async function createMailTm() {
  const domainRes = await fetchJson('https://api.mail.tm/domains?page=1');
  const rawDomains = Array.isArray(domainRes?.['hydra:member'])
    ? domainRes['hydra:member']
    : Array.isArray(domainRes)
      ? domainRes
      : (domainRes && typeof domainRes === 'object' ? [domainRes] : []);

  const domains = rawDomains.filter(x =>
    x && typeof x.domain === 'string' && x.domain.trim().length > 0
  );

  if (!domains.length) {
    const detail = domainRes?.message || domainRes?.detail || `Mail.tm вернул неожиданный ответ: ${JSON.stringify(domainRes).slice(0, 300)}`;
    throw new Error(`Не удалось получить домен Mail.tm: ${detail}`);
  }

  const domain = domains[0].domain;
  const addr = `${randStr(12)}@${domain}`;
  const password = randStr(18);

  await fetchJson('https://api.mail.tm/accounts', {
    method: 'POST',
    body: { address: addr, password }
  });

  const token = await fetchJson('https://api.mail.tm/token', {
    method: 'POST',
    body: { address: addr, password }
  });

  return {
    email: addr,
    password,
    token: token.token,
    getMessages: async () => {
      const list = await fetchJson('https://api.mail.tm/messages', {
        headers: { 'Authorization': `Bearer ${token.token}` }
      });
      return list['hydra:member'] || [];
    },
    readMessage: async (id) => fetchJson(`https://api.mail.tm/messages/${id}`, {
      headers: { 'Authorization': `Bearer ${token.token}` }
    })
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

async function createOneAccount({ seq, nickname, niche, log = () => {} }) {
  const id = crypto.randomUUID().slice(0, 12);
  const nick = nickname || zenodropNickname(seq);

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
    const [mailResult, deviceResult] = await Promise.allSettled([
      createMailTm(),
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

    const signupResult = await api.signup(mailer.email, password, nick, birthDate);

    if (signupResult.captcha) {
      throw new Error('captcha');
    }

    if (signupResult.needsCode) {
      log(`[#${seq}] ждём код...`);
      let code = null;
      for (let i = 0; i < 20 && !code; i++) {
        await new Promise(r => setTimeout(r, 3000));
        try {
          const messages = await mailer.getMessages();
          for (const msg of messages) {
            const full = await mailer.readMessage(msg.id);
            const text = JSON.stringify(full);
            const m = text.match(/\b(\d{6})\b/);
            if (m) { code = m[1]; break; }
          }
        } catch {}
      }
      if (!code) throw new Error('no_code');

      const sub = await api.submitSignupCode(code);
      if (sub.error) throw new Error(`code_submit: ${sub.error}`);
    }

    await api.setNickname(nick).catch(e => log(`[#${seq}] nick: ${e.message}`));

    const avatarPath = path.join(__dirname, 'avatar.png');
    if (fs.existsSync(avatarPath)) {
      await api.setAvatar(avatarPath).catch(e => log(`[#${seq}] avatar: ${e.message}`));
    }

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
      status: 'ready',
      postsCount: 0
    };
    await store.saveAccount(acc);

    log(`[#${seq}] OK → ${mailer.email}`);
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

async function createBatch({
  count,
  concurrency = 10,
  niche,
  startSeq = 1,
  log = console.log,
  onProgress = null
}) {
  const results = { ok: [], fail: [], total: count, started: Date.now() };
  const queue = Array.from({ length: count }, (_, i) => startSeq + i);
  let inFlight = 0;

  async function worker(workerId) {
    while (queue.length) {
      const seq = queue.shift();
      if (seq === undefined) return;

      inFlight++;
      const r = await createOneAccount({ seq, niche, log });
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
  createMailTm,
  zenodropNickname,
  DEFAULT_BIO
};
