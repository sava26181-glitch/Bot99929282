const fs = require('fs');
const path = require('path');

let pool = null;

function initDB() {
  if (!process.env.DATABASE_URL) {
    console.log('[store] DATABASE_URL not set, using local JSON');
    return null;
  }
  try {
    const { Pool } = require('pg');
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 20
    });
    return pool;
  } catch (e) {
    console.error('[store] pg init error:', e.message);
    return null;
  }
}

async function migrate() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      login TEXT NOT NULL,
      password TEXT NOT NULL,
      niche TEXT,
      proxy_json TEXT,
      fingerprint_json TEXT,
      cookies_json TEXT,
      profile_url TEXT,
      status TEXT DEFAULT 'new',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      last_post_at TIMESTAMPTZ,
      posts_count INT DEFAULT 0
    )
  `);
  await pool.query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS profile_url TEXT`).catch(() => {});
  await pool.query(`
    CREATE TABLE IF NOT EXISTS proxies (
      id TEXT PRIMARY KEY,
      server TEXT NOT NULL,
      username TEXT,
      password TEXT,
      country TEXT,
      status TEXT DEFAULT 'free',
      account_id TEXT,
      latency_ms INT,
      last_checked TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_proxies_status ON proxies(status)
  `);
}

async function saveAccount(acc) {
  if (!pool) {
    const file = path.join(__dirname, 'accounts.json');
    const all = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : {};
    all[acc.id] = {
      id: acc.id,
      name: acc.name,
      login: acc.login,
      password: acc.password,
      niche: acc.niche ? acc.niche.join(',') : null,
      proxy_json: JSON.stringify(acc.proxy),
      fingerprint_json: JSON.stringify(acc.fingerprint),
      cookies_json: acc.cookies ? JSON.stringify(acc.cookies) : null,
      profile_url: acc.profileUrl || null,
      status: acc.status,
      posts_count: acc.postsCount || 0
    };
    fs.writeFileSync(file, JSON.stringify(all, null, 2));
    return;
  }
  await pool.query(`
    INSERT INTO accounts (id, name, login, password, niche, proxy_json, fingerprint_json, cookies_json, profile_url, status, posts_count)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    ON CONFLICT (id) DO UPDATE SET
      name=EXCLUDED.name,
      status=EXCLUDED.status,
      proxy_json=EXCLUDED.proxy_json,
      fingerprint_json=EXCLUDED.fingerprint_json,
      cookies_json=EXCLUDED.cookies_json,
      profile_url=EXCLUDED.profile_url,
      posts_count=EXCLUDED.posts_count,
      updated_at=NOW()
  `, [
    acc.id, acc.name, acc.login, acc.password,
    acc.niche ? acc.niche.join(',') : null,
    JSON.stringify(acc.proxy || null),
    JSON.stringify(acc.fingerprint || null),
    acc.cookies ? JSON.stringify(acc.cookies) : null,
    acc.profileUrl || null,
    acc.status, acc.postsCount || 0
  ]);
}

async function saveCookies(accId, cookies) {
  if (!pool) {
    const file = path.join(__dirname, 'accounts.json');
    if (!fs.existsSync(file)) return;
    const all = JSON.parse(fs.readFileSync(file));
    if (all[accId]) {
      all[accId].cookies_json = JSON.stringify(cookies);
      fs.writeFileSync(file, JSON.stringify(all, null, 2));
    }
    return;
  }
  await pool.query(
    `UPDATE accounts SET cookies_json=$1, updated_at=NOW() WHERE id=$2`,
    [JSON.stringify(cookies), accId]
  );
}

async function loadAllAccounts() {
  if (!pool) {
    const file = path.join(__dirname, 'accounts.json');
    if (!fs.existsSync(file)) return [];
    const all = JSON.parse(fs.readFileSync(file));
    return Object.values(all).map(a => ({
      id: a.id,
      name: a.name,
      login: a.login,
      password: a.password,
      niche: a.niche ? a.niche.split(',') : null,
      proxy: a.proxy_json ? JSON.parse(a.proxy_json) : null,
      fingerprint: a.fingerprint_json ? JSON.parse(a.fingerprint_json) : null,
      cookies: a.cookies_json ? JSON.parse(a.cookies_json) : null,
      profileUrl: a.profile_url || null,
      status: a.status,
      postsCount: a.posts_count
    }));
  }
  const { rows } = await pool.query('SELECT * FROM accounts ORDER BY created_at ASC');
  return rows.map(r => ({
    id: r.id,
    name: r.name,
    login: r.login,
    password: r.password,
    niche: r.niche ? r.niche.split(',') : null,
    proxy: r.proxy_json ? JSON.parse(r.proxy_json) : null,
    fingerprint: r.fingerprint_json ? JSON.parse(r.fingerprint_json) : null,
    cookies: r.cookies_json ? JSON.parse(r.cookies_json) : null,
    profileUrl: r.profile_url || null,
    status: r.status,
    postsCount: r.posts_count,
    lastPostAt: r.last_post_at
  }));
}

async function updateStatus(accId, status) {
  if (!pool) {
    const file = path.join(__dirname, 'accounts.json');
    if (!fs.existsSync(file)) return;
    const all = JSON.parse(fs.readFileSync(file));
    if (all[accId]) {
      all[accId].status = status;
      fs.writeFileSync(file, JSON.stringify(all, null, 2));
    }
    return;
  }
  await pool.query(`UPDATE accounts SET status=$1, updated_at=NOW() WHERE id=$2`, [status, accId]);
}

async function markPosted(accId) {
  if (!pool) {
    const file = path.join(__dirname, 'accounts.json');
    if (!fs.existsSync(file)) return;
    const all = JSON.parse(fs.readFileSync(file));
    if (all[accId]) {
      all[accId].posts_count = (all[accId].posts_count || 0) + 1;
      fs.writeFileSync(file, JSON.stringify(all, null, 2));
    }
    return;
  }
  await pool.query(
    `UPDATE accounts SET posts_count = posts_count + 1, last_post_at = NOW() WHERE id=$1`,
    [accId]
  );
}

async function saveProxy(p) {
  if (!pool) {
    const file = path.join(__dirname, 'proxies.json');
    const all = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : {};
    all[p.id] = p;
    fs.writeFileSync(file, JSON.stringify(all, null, 2));
    return;
  }
  await pool.query(`
    INSERT INTO proxies (id, server, username, password, country, status, account_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT (id) DO UPDATE SET
      status=EXCLUDED.status,
      account_id=EXCLUDED.account_id,
      last_checked=NOW()
  `, [p.id, p.server, p.username, p.password, p.country, p.status, p.accountId || null]);
}

async function loadAllProxies() {
  if (!pool) {
    const file = path.join(__dirname, 'proxies.json');
    if (!fs.existsSync(file)) return [];
    return Object.values(JSON.parse(fs.readFileSync(file)));
  }
  const { rows } = await pool.query('SELECT * FROM proxies ORDER BY created_at ASC');
  return rows.map(r => ({
    id: r.id,
    server: r.server,
    username: r.username,
    password: r.password,
    country: r.country,
    status: r.status,
    accountId: r.account_id,
    latencyMs: r.latency_ms
  }));
}

async function freeProxy() {
  if (!pool) {
    const file = path.join(__dirname, 'proxies.json');
    if (!fs.existsSync(file)) return null;
    const all = Object.values(JSON.parse(fs.readFileSync(file)));
    return all.find(p => p.status === 'free') || null;
  }
  const { rows } = await pool.query(
    `SELECT * FROM proxies WHERE status='free' ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED`
  );
  if (!rows.length) return null;
  const r = rows[0];
  await pool.query(`UPDATE proxies SET status='busy' WHERE id=$1`, [r.id]);
  return {
    id: r.id,
    server: r.server,
    username: r.username,
    password: r.password,
    country: r.country,
    status: 'busy'
  };
}

async function releaseProxy(id) {
  if (!pool) return;
  await pool.query(`UPDATE proxies SET status='free', account_id=NULL WHERE id=$1`, [id]);
}

async function acquireProxyAtomic(accountId, country = null) {
  if (!pool) {
    const file = path.join(__dirname, 'proxies.json');
    if (!fs.existsSync(file)) return null;
    const all = JSON.parse(fs.readFileSync(file));
    const list = Object.values(all);
    const candidate = list.find(p =>
      p.status === 'free' &&
      (!country || p.country === country)
    ) || list.find(p => p.status === 'free');

    if (!candidate) return null;
    candidate.status = 'busy';
    candidate.accountId = accountId;
    all[candidate.id] = candidate;
    fs.writeFileSync(file, JSON.stringify(all, null, 2));
    return candidate;
  }

  const query = country
    ? `SELECT * FROM proxies WHERE status='free' AND country=$1
       ORDER BY last_checked ASC NULLS FIRST
       LIMIT 1 FOR UPDATE SKIP LOCKED`
    : `SELECT * FROM proxies WHERE status='free'
       ORDER BY last_checked ASC NULLS FIRST
       LIMIT 1 FOR UPDATE SKIP LOCKED`;

  const params = country ? [country] : [];
  const { rows } = await pool.query(query, params);

  if (!rows.length) {
    const { rows: fallback } = await pool.query(
      `SELECT * FROM proxies WHERE status='free'
       ORDER BY last_checked ASC NULLS FIRST
       LIMIT 1 FOR UPDATE SKIP LOCKED`
    );
    if (!fallback.length) return null;
    const p = fallback[0];
    await pool.query(
      `UPDATE proxies SET status='busy', account_id=$1 WHERE id=$2`,
      [accountId, p.id]
    );
    return {
      id: p.id, server: p.server, username: p.username,
      password: p.password, country: p.country, status: 'busy'
    };
  }

  const p = rows[0];
  await pool.query(
    `UPDATE proxies SET status='busy', account_id=$1 WHERE id=$2`,
    [accountId, p.id]
  );
  return {
    id: p.id, server: p.server, username: p.username,
    password: p.password, country: p.country, status: 'busy'
  };
}

async function releaseProxyAtomic(proxyId) {
  if (!pool) {
    const file = path.join(__dirname, 'proxies.json');
    if (!fs.existsSync(file)) return;
    const all = JSON.parse(fs.readFileSync(file));
    if (all[proxyId]) {
      all[proxyId].status = 'free';
      all[proxyId].accountId = null;
      all[proxyId].last_checked = new Date().toISOString();
      fs.writeFileSync(file, JSON.stringify(all, null, 2));
    }
    return;
  }
  await pool.query(
    `UPDATE proxies SET status='free', account_id=NULL, last_checked=NOW() WHERE id=$1`,
    [proxyId]
  );
}

async function proxyStats() {
  if (!pool) {
    const file = path.join(__dirname, 'proxies.json');
    if (!fs.existsSync(file)) return { total: 0, free: 0, busy: 0, dead: 0 };
    const list = Object.values(JSON.parse(fs.readFileSync(file)));
    return {
      total: list.length,
      free: list.filter(p => p.status === 'free').length,
      busy: list.filter(p => p.status === 'busy').length,
      dead: list.filter(p => p.status === 'dead').length
    };
  }
  const { rows } = await pool.query(`
    SELECT status, COUNT(*)::int as count FROM proxies GROUP BY status
  `);
  const result = { total: 0, free: 0, busy: 0, dead: 0 };
  for (const r of rows) {
    result[r.status] = r.count;
    result.total += r.count;
  }
  return result;
}

async function deleteAllAccounts() {
  if (!pool) {
    const file = path.join(__dirname, 'accounts.json');
    if (fs.existsSync(file)) fs.writeFileSync(file, '{}');
    const pfile = path.join(__dirname, 'proxies.json');
    if (fs.existsSync(pfile)) {
      const all = JSON.parse(fs.readFileSync(pfile));
      for (const id of Object.keys(all)) {
        all[id].status = 'free';
        all[id].accountId = null;
      }
      fs.writeFileSync(pfile, JSON.stringify(all, null, 2));
    }
    return;
  }
  await pool.query('DELETE FROM accounts');
  await pool.query(`UPDATE proxies SET status='free', account_id=NULL`);
}

module.exports = {
  initDB,
  migrate,
  saveAccount,
  loadAllAccounts,
  updateStatus,
  markPosted,
  saveCookies,
  saveProxy,
  loadAllProxies,
  freeProxy,
  releaseProxy,
  acquireProxyAtomic,
  releaseProxyAtomic,
  proxyStats,
  deleteAllAccounts
};
