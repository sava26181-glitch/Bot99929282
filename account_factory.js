const crypto = require('crypto');
const https = require('https');
const { generateFingerprint } = require('./fingerprint');
const TikTokUploader = require('./tiktok_uploader');
const { acquireProxyForAccount } = require('./proxy_manager');
const store = require('./accounts_store');

/* ============================================================
 *  EMAIL-ПРОВАЙДЕРЫ
 * ============================================================ */

// mail.tm — бесплатный, без API-ключа
async function createMailTm() {
  const domainRes = await fetchJson('https://api.mail.tm/domains?page=1');
  const domain = domainRes['hydra:member'][0].domain;

  const addr = `${randStr(10)}@${domain}`;
  const password = randStr(16);

  const acc = await fetchJson('https://api.mail.tm/accounts', {
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
    provider: 'mail.tm',
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

// 1secmail — простой, но домены часто в бане
async function create1SecMail() {
  const domains = ['1secmail.com', '1secmail.net', '1secmail.org'];
  const domain = domains[Math.floor(Math.random() * domains.length)];
  const login = randStr(10).toLowerCase();
  const email = `${login}@${domain}`;

  return {
    email,
    password: null,
    provider: '1secmail',
    getMessages: async () => {
      const list = await fetchJson(
        `https://www.1secmail.com/api/v1/?action=getMessages&login=${login}&domain=${domain}`
      );
      return Array.isArray(list) ? list : [];
    },
    readMessage: async (id) => fetchJson(
      `https://www.1secmail.com/api/v1/?action=readMessage&login=${login}&domain=${domain}&id=${id}`
    )
  };
}

// Guerrilla Mail
async function createGuerrilla() {
  const init = await fetchJson('https://api.guerrillaemail.com/ajax.php?f=get_email_address');
  const email = init.email_addr;
  const sid = init.sid_token;

  return {
    email,
    password: null,
    provider: 'guerrilla',
    getMessages: async () => {
      const list = await fetchJson(
        `https://api.guerrillaemail.com/ajax.php?f=get_email_list&offset=0&sid_token=${sid}`
      );
      return list.list || [];
    },
    readMessage: async (id) => fetchJson(
      `https://api.guerrillaemail.com/ajax.php?f=fetch_email&email_id=${id}&sid_token=${sid}`
    )
  };
}

function randStr(n) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < n; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

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

/* ============================================================
 *  ГЕНЕРАЦИЯ УЧЁТОК
 * ============================================================ */

function randomPassword(len = 14) {
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
  // zenodrop_XXXX, где XXXX — 4-значный номер или буквы
  const suffix = String(seq).padStart(4, '0');
  return `zenodrop_${suffix}`;
}

/* ============================================================
 *  СОЗДАНИЕ ОДНОГО АККАУНТА
 * ============================================================ */

async function createOneAccount({
  seq,
  emailProvider = 'mail.tm',
  nickname,
  niche,
  proxy,
  log = console.log
}) {
  log(`[factory] #${seq} создаю почту...`);
  let mailer;
  if (emailProvider === 'mail.tm') mailer = await createMailTm();
  else if (emailProvider === '1secmail') mailer = await create1SecMail();
  else mailer = await createGuerrilla();

  log(`[factory] #${seq} email=${mailer.email}`);

  const password = randomPassword();
  const nick = nickname || zenodropNickname(seq);
  const birthDate = randomBirthDate();
  const id = crypto.randomUUID().slice(0, 12);

  // Прокси
  let usedProxy = proxy;
  if (!usedProxy) {
    usedProxy = await acquireProxyForAccount(id, null);
  }

  if (!usedProxy) {
    throw new Error('Нет свободных прокси в пуле');
  }

  const fingerprint = generateFingerprint(id);

  const uploader = new TikTokUploader({
    proxy: usedProxy,
    fingerprint,
    headless: process.env.HEADLESS !== 'false',
    cookiesPath: null,
    accountId: id
  });

  try {
    await uploader.init();

    log(`[factory] #${seq} регистрирую...`);
    const result = await uploader.signup(mailer.email, password, nick, birthDate);

    if (result.captcha) {
      await uploader.close();
      return { success: false, reason: 'captcha', email: mailer.email };
    }

    if (result.needsCode) {
      log(`[factory] #${seq} жду код подтверждения...`);
      // Ждём письмо
      let code = null;
      for (let attempt = 0; attempt < 30 && !code; attempt++) {
        await new Promise(r => setTimeout(r, 6000));
        const messages = await mailer.getMessages();
        for (const msg of messages) {
          const full = await mailer.readMessage(msg.id || msg.mail_id);
          const text = JSON.stringify(full);
          const m = text.match(/\b(\d{6})\b/);
          if (m) { code = m[1]; break; }
        }
      }
      if (!code) {
        await uploader.close();
        return { success: false, reason: 'no_code', email: mailer.email };
      }
      log(`[factory] #${seq} code=${code}`);
      const sub = await uploader.submitSignupCode(code);
      if (sub.error) {
        await uploader.close();
        return { success: false, reason: sub.error, email: mailer.email };
      }
    }

    // Меняем ник на zenodrop_XXXX
    log(`[factory] #${seq} ставлю ник ${nick}...`);
    await uploader.setNickname(nick).catch(e => log(`[factory] #${seq} nick err: ${e.message}`));

    const cookies = await uploader.saveCookies();
    await uploader.close();

    // Сохраняем в БД
    const acc = {
      id,
      name: nick,
      login: mailer.email,
      password,
      niche: niche || null,
      proxy: usedProxy,
      fingerprint,
      cookies,
      status: 'ready',
      postsCount: 0
    };
    await store.saveAccount(acc);

    log(`[factory] #${seq} OK → ${mailer.email} / ${nick}`);
    return { success: true, account: acc };
  } catch (e) {
    log(`[factory] #${seq} ERROR: ${e.message}`);
    try { await uploader.close(); } catch {}
    return { success: false, reason: e.message, email: mailer.email };
  }
}

/* ============================================================
 *  МАССОВОЕ СОЗДАНИЕ
 * ============================================================ */

async function createBatch({
  count,
  emailProvider = 'mail.tm',
  niche,
  startSeq = 1,
  concurrency = 2,
  log = console.log,
  onProgress = null
}) {
  const results = { ok: [], fail: [] };
  const queue = Array.from({ length: count }, (_, i) => startSeq + i);

  async function worker() {
    while (queue.length) {
      const seq = queue.shift();
      if (seq === undefined) return;

      const r = await createOneAccount({
        seq,
        emailProvider,
        niche,
        log
      });
      if (r.success) results.ok.push(r.account);
      else results.fail.push({ seq, reason: r.reason });

      if (onProgress) {
        try { await onProgress({ done: results.ok.length + results.fail.length, total: count, last: r }); } catch {}
      }
    }
  }

  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, 5)) }, () => worker());
  await Promise.all(workers);

  return results;
}

module.exports = {
  createOneAccount,
  createBatch,
  createMailTm,
  create1SecMail,
  createGuerrilla,
  zenodropNickname
};
