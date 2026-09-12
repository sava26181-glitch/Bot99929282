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
      max: 20 // пул соединений для параллельности
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
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_proxies_status ON proxies(status)
  `);
}

/* ... saveAccount, loadAllAccounts, updateStatus, markPosted, saveCookies — без изменений ... */

/* ============================================================
 *  ПРОКСИ — АТОМАРНАЯ РОТАЦИЯ
 * ============================================================ */

/**
 * Атомарно захватывает свободный прокси.
 * Использует FOR UPDATE SKIP LOCKED — два воркера не возьмут один прокси.
 */
async function acquireProxyAtomic(accountId, country = null) {
  if (!pool) {
    // JSON fallback — простая блокировка в памяти
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
    // Фолбэк — любой свободный
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

module.exports = {
  initDB, migrate,
  saveAccount, loadAllAccounts, updateStatus, markPosted, saveCookies,
  saveProxy, loadAllProxies, freeProxy, releaseProxy,
  acquireProxyAtomic, releaseProxyAtomic, proxyStats
};
