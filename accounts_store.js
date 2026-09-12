const fs = require('fs');
const path = require('path');

let pool = null;
const DATA_DIR = process.env.DATA_DIR || __dirname;
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
const PROXIES_FILE = path.join(DATA_DIR, 'proxies.json');

function readJson(file, fallback = {}) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, 'utf8');
    return raw.trim() ? JSON.parse(raw) : fallback;
  } catch (e) {
    console.error(`[store] read ${path.basename(file)}:`, e.message);
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function initDB() {
  if (!process.env.DATABASE_URL) {
    console.log('[store] DATABASE_URL not set, using local JSON');
    return null;
  }
  try {
    const { Pool } = require('pg');
    // Render/PostgreSQL URLs can contain sslmode=require. In pg 8 this can
    // override the ssl object and make a self-signed CA fail verification.
    // Strip sslmode from the URL and explicitly allow the provider's CA.
    let connectionString = process.env.DATABASE_URL.trim();
    try {
      const u = new URL(connectionString);
      u.searchParams.delete('sslmode');
      u.searchParams.delete('uselibpqcompat');
      connectionString = u.toString();
    } catch (_) {}

    pool = new Pool({
      connectionString,
      ssl: { rejectUnauthorized: false },
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000
    });
    pool.on('error', err => console.error('[store] postgres pool error:', err.message));
    return pool;
  } catch (e) {
    console.error('[store] pg init error:', e.message);
    pool = null;
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
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_proxies_status ON proxies(status)`);
}

function serializeAccount(a) {
  return {
    id: String(a.id),
    name: String(a.name || a.login || a.id),
    login: String(a.login || ''),
    password: String(a.password || ''),
    niche: a.niche ?? null,
    proxy: a.proxy ?? null,
    fingerprint: a.fingerprint ?? null,
    cookies: a.cookies ?? null,
    status: a.status || 'new',
    postsCount: Number(a.postsCount || 0),
    lastPostAt: a.lastPostAt || null
  };
}

function hydrateAccount(row) {
  return {
    id: row.id,
    name: row.name,
    login: row.login,
    password: row.password,
    niche: row.niche ? JSON.parse(row.niche) : null,
    proxy: row.proxy_json ? JSON.parse(row.proxy_json) : null,
    fingerprint: row.fingerprint_json ? JSON.parse(row.fingerprint_json) : null,
    cookies: row.cookies_json || null,
    status: row.status || 'new',
    postsCount: Number(row.posts_count || 0),
    lastPostAt: row.last_post_at || null
  };
}

async function saveAccount(account) {
  const a = serializeAccount(account);
  if (!pool) {
    const all = readJson(ACCOUNTS_FILE, {});
    all[a.id] = a;
    writeJson(ACCOUNTS_FILE, all);
    return a;
  }
  await pool.query(`
    INSERT INTO accounts
      (id,name,login,password,niche,proxy_json,fingerprint_json,cookies_json,status,posts_count,updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
    ON CONFLICT (id) DO UPDATE SET
      name=EXCLUDED.name, login=EXCLUDED.login, password=EXCLUDED.password,
      niche=EXCLUDED.niche, proxy_json=EXCLUDED.proxy_json,
      fingerprint_json=EXCLUDED.fingerprint_json, cookies_json=EXCLUDED.cookies_json,
      status=EXCLUDED.status, posts_count=EXCLUDED.posts_count, updated_at=NOW()
  `, [
    a.id, a.name, a.login, a.password,
    a.niche ? JSON.stringify(a.niche) : null,
    a.proxy ? JSON.stringify(a.proxy) : null,
    a.fingerprint ? JSON.stringify(a.fingerprint) : null,
    a.cookies, a.status, a.postsCount
  ]);
  return a;
}

async function loadAllAccounts() {
  if (!pool) return Object.values(readJson(ACCOUNTS_FILE, {}));
  const { rows } = await pool.query('SELECT * FROM accounts ORDER BY created_at ASC');
  return rows.map(hydrateAccount);
}

async function updateStatus(id, status) {
  if (!pool) {
    const all = readJson(ACCOUNTS_FILE, {});
    if (all[id]) {
      all[id].status = status;
      writeJson(ACCOUNTS_FILE, all);
    }
    return;
  }
  await pool.query('UPDATE accounts SET status=$1, updated_at=NOW() WHERE id=$2', [status, id]);
}

async function markPosted(id) {
  if (!pool) {
    const all = readJson(ACCOUNTS_FILE, {});
    if (all[id]) {
      all[id].postsCount = Number(all[id].postsCount || 0) + 1;
      all[id].lastPostAt = new Date().toISOString();
      writeJson(ACCOUNTS_FILE, all);
    }
    return;
  }
  await pool.query(`
    UPDATE accounts
    SET posts_count = posts_count + 1, last_post_at = NOW(), updated_at = NOW()
    WHERE id=$1
  `, [id]);
}

async function saveCookies(id, cookies) {
  if (!pool) {
    const all = readJson(ACCOUNTS_FILE, {});
    if (all[id]) {
      all[id].cookies = cookies || null;
      writeJson(ACCOUNTS_FILE, all);
    }
    return;
  }
  await pool.query(
    'UPDATE accounts SET cookies_json=$1, updated_at=NOW() WHERE id=$2',
    [cookies || null, id]
  );
}

function serializeProxy(p) {
  return {
    id: String(p.id),
    server: String(p.server),
    username: p.username || null,
    password: p.password || null,
    country: p.country || null,
    status: p.status || 'free',
    accountId: p.accountId || null,
    latency: p.latency ?? null,
    lastChecked: p.lastChecked || null
  };
}

function hydrateProxy(row) {
  return {
    id: row.id,
    server: row.server,
    username: row.username,
    password: row.password,
    country: row.country,
    status: row.status || 'free',
    accountId: row.account_id || null,
    latency: row.latency_ms ?? null,
    lastChecked: row.last_checked || null
  };
}

async function saveProxy(proxy) {
  const p = serializeProxy(proxy);
  if (!pool) {
    const all = readJson(PROXIES_FILE, {});
    all[p.id] = p;
    writeJson(PROXIES_FILE, all);
    return p;
  }
  await pool.query(`
    INSERT INTO proxies
      (id,server,username,password,country,status,account_id,latency_ms,last_checked)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    ON CONFLICT (id) DO UPDATE SET
      server=EXCLUDED.server, username=EXCLUDED.username, password=EXCLUDED.password,
      country=EXCLUDED.country, status=EXCLUDED.status, account_id=EXCLUDED.account_id,
      latency_ms=EXCLUDED.latency_ms, last_checked=EXCLUDED.last_checked
  `, [
    p.id, p.server, p.username, p.password, p.country, p.status,
    p.accountId, p.latency, p.lastChecked
  ]);
  return p;
}

async function loadAllProxies() {
  if (!pool) return Object.values(readJson(PROXIES_FILE, {}));
  const { rows } = await pool.query('SELECT * FROM proxies ORDER BY created_at ASC');
  return rows.map(hydrateProxy);
}

async function freeProxy(id) {
  if (!id) return;
  if (!pool) {
    const all = readJson(PROXIES_FILE, {});
    if (all[id]) {
      all[id].status = 'free';
      all[id].accountId = null;
      all[id].lastChecked = new Date().toISOString();
      writeJson(PROXIES_FILE, all);
    }
    return;
  }
  await pool.query(
    `UPDATE proxies SET status='free', account_id=NULL, last_checked=NOW() WHERE id=$1`,
    [id]
  );
}

async function releaseProxy(id) {
  return freeProxy(id);
}

async function acquireProxyAtomic(accountId, country = null) {
  if (!pool) {
    const all = readJson(PROXIES_FILE, {});
    const list = Object.values(all);
    const candidate = list.find(p =>
      p.status === 'free' &&
      (!country || String(p.country || '').toLowerCase() === String(country).toLowerCase())
    ) || list.find(p => p.status === 'free');
    if (!candidate) return null;
    candidate.status = 'busy';
    candidate.accountId = accountId;
    all[candidate.id] = candidate;
    writeJson(PROXIES_FILE, all);
    return candidate;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let sql = `SELECT * FROM proxies WHERE status='free'`;
    const params = [];
    if (country) {
      sql += ` AND country=$1`;
      params.push(country);
    }
    sql += ` ORDER BY last_checked ASC NULLS FIRST LIMIT 1 FOR UPDATE SKIP LOCKED`;
    let { rows } = await client.query(sql, params);

    if (!rows.length && country) {
      ({ rows } = await client.query(
        `SELECT * FROM proxies WHERE status='free'
         ORDER BY last_checked ASC NULLS FIRST LIMIT 1 FOR UPDATE SKIP LOCKED`
      ));
    }
    if (!rows.length) {
      await client.query('ROLLBACK');
      return null;
    }
    const p = rows[0];
    await client.query(
      `UPDATE proxies SET status='busy', account_id=$1 WHERE id=$2`,
      [accountId, p.id]
    );
    await client.query('COMMIT');
    return hydrateProxy({ ...p, status: 'busy', account_id: accountId });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    throw e;
  } finally {
    client.release();
  }
}

async function releaseProxyAtomic(proxyId) {
  return freeProxy(proxyId);
}

async function proxyStats() {
  if (!pool) {
    const list = Object.values(readJson(PROXIES_FILE, {}));
    return {
      total: list.length,
      free: list.filter(p => p.status === 'free').length,
      busy: list.filter(p => p.status === 'busy').length,
      dead: list.filter(p => p.status === 'dead').length
    };
  }
  const { rows } = await pool.query(`SELECT status, COUNT(*)::int AS count FROM proxies GROUP BY status`);
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
