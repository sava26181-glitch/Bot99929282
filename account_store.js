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
      ssl: { rejectUnauthorized: false }
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
      status TEXT DEFAULT 'new',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      last_post_at TIMESTAMPTZ,
      posts_count INT DEFAULT 0
    )
  `);
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
}

async function saveAccount(acc) {
  if (!pool) {
    const file = path.join(__dirname, 'accounts.json');
    const all = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : {};
    all[acc.id] = {
      id: acc.id, name: acc.name, login: acc.login, password: acc.password,
      niche: acc.niche ? acc.niche.join(',') : null,
      proxy_json: JSON.stringify(acc.proxy),
      fingerprint_json: JSON.stringify(acc.fingerprint),
      cookies_json: acc.cookies ? JSON.stringify(acc.cookies) : null,
      status: acc.status, posts_count: acc.postsCount || 0
    };
    fs.writeFileSync(file, JSON.stringify(all, null, 2));
    return;
  }
  await pool.query(`
    INSERT INTO accounts (id, name, login, password, niche, proxy_json, fingerprint_json, cookies_json, status, posts_count)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    ON CONFLICT (id) DO UPDATE SET
      name=EXCLUDED.name,
      status=EXCLUDED.status,
      proxy_json=EXCLUDED.proxy_json,
      fingerprint_json=EXCLUDED.fingerprint_json,
      cookies_json=EXCLUDED.cookies_json,
      posts_count=EXCLUDED.posts_count,
      updated_at=NOW()
  `, [
    acc.id, acc.name, acc.login, acc.password,
    acc.niche ? acc.niche.join(',') : null,
    JSON.stringify(acc.proxy || null),
    JSON.stringify(acc.fingerprint || null),
    acc.cookies ? JSON.stringify(acc.cookies) : null,
    acc.status, acc.postsCount || 0
  ]);
}

async function saveCookies(accId, cookies) {
  if (!pool) return;
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
      id: a.id, name: a.name, login: a.login, password: a.password,
      niche: a.niche ? a.niche.split(',') : null,
      proxy: a.proxy_json ? JSON.parse(a.proxy_json) : null,
      fingerprint: a.fingerprint_json ? JSON.parse(a.fingerprint_json) : null,
      cookies: a.cookies_json ? JSON.parse(a.cookies_json) : null,
      status: a.status, postsCount: a.posts_count
    }));
  }
  const { rows } = await pool.query('SELECT * FROM accounts ORDER BY created_at ASC');
  return rows.map(r => ({
    id: r.id, name: r.name, login: r.login, password: r.password,
    niche: r.niche ? r.niche.split(',') : null,
    proxy: r.proxy_json ? JSON.parse(r.proxy_json) : null,
    fingerprint: r.fingerprint_json ? JSON.parse(r.fingerprint_json) : null,
    cookies: r.cookies_json ? JSON.parse(r.cookies_json) : null,
    status: r.status, postsCount: r.posts_count,
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
  if (!pool) return;
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
    id: r.id, server: r.server, username: r.username, password: r.password,
    country: r.country, status: r.status, accountId: r.account_id,
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
    id: r.id, server: r.server, username: r.username, password: r.password,
    country: r.country, status: 'busy'
  };
}

async function releaseProxy(id) {
  if (!pool) return;
  await pool.query(`UPDATE proxies SET status='free', account_id=NULL WHERE id=$1`, [id]);
}

module.exports = {
  initDB, migrate,
  saveAccount, loadAllAccounts, updateStatus, markPosted, saveCookies,
  saveProxy, loadAllProxies, freeProxy, releaseProxy
};
