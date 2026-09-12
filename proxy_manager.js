const { saveProxy, loadAllProxies } = require('./accounts_store');
const crypto = require('crypto');
const https = require('https');
const net = require('net');

function parseProxyLine(line) {
  line = line.trim();
  if (!line || line.startsWith('#')) return null;

  try {
    if (/^[a-z]+:\/\//i.test(line)) {
      const u = new URL(line);
      return {
        server: `${u.protocol}//${u.hostname}:${u.port}`,
        username: u.username || null,
        password: u.password || null,
        country: null
      };
    }
  } catch {}

  const parts = line.split(':');
  if (parts.length === 4) {
    return {
      server: `http://${parts[0]}:${parts[1]}`,
      username: parts[2],
      password: parts[3],
      country: null
    };
  }
  if (parts.length === 2) {
    return {
      server: `http://${parts[0]}:${parts[1]}`,
      username: null,
      password: null,
      country: null
    };
  }

  const m = line.match(/^([^:]+):([^@]+)@([^:]+):(\d+)$/);
  if (m) {
    return {
      server: `http://${m[3]}:${m[4]}`,
      username: m[1],
      password: m[2],
      country: null
    };
  }

  return null;
}

function checkProxy(proxy, timeoutMs = 10000) {
  return new Promise(resolve => {
    const u = new URL(proxy.server);
    const host = u.hostname;
    const port = Number(u.port);
    const start = Date.now();

    const socket = net.connect({ host, port, timeout: timeoutMs });

    socket.on('connect', () => {
      socket.destroy();
      resolve({ ok: true, latency: Date.now() - start });
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve({ ok: false, reason: 'timeout' });
    });
    socket.on('error', err => {
      socket.destroy();
      resolve({ ok: false, reason: err.code || err.message });
    });
  });
}

function checkProxyHttp(proxy, timeoutMs = 15000) {
  return new Promise(resolve => {
    const u = new URL(proxy.server);
    const auth = proxy.username
      ? 'Basic ' + Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64')
      : null;

    const req = https.request({
      host: u.hostname,
      port: Number(u.port),
      method: 'GET',
      path: 'http://api.ipify.org/?format=json',
      headers: auth ? { 'Proxy-Authorization': auth } : {},
      timeout: timeoutMs
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve({ ok: true, ip: json.ip });
        } catch {
          resolve({ ok: false, reason: 'bad response' });
        }
      });
    });

    req.on('error', e => resolve({ ok: false, reason: e.code || e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, reason: 'timeout' }); });
    req.end();
  });
}

async function importProxies(rawText, source = 'manual') {
  const lines = rawText.split(/\r?\n/);
  let added = 0, skipped = 0;
  const existing = await loadAllProxies();
  const existingKeys = new Set(existing.map(p => `${p.server}|${p.username || ''}`));

  for (const line of lines) {
    const parsed = parseProxyLine(line);
    if (!parsed) { skipped++; continue; }
    const key = `${parsed.server}|${parsed.username || ''}`;
    if (existingKeys.has(key)) { skipped++; continue; }

    const id = crypto.randomUUID().slice(0, 12);
    await saveProxy({
      id,
      server: parsed.server,
      username: parsed.username,
      password: parsed.password,
      country: parsed.country,
      status: 'free',
      accountId: null
    });
    existingKeys.add(key);
    added++;
  }

  return { added, skipped };
}

async function acquireProxyForAccount(accountId, country = null) {
  const all = await loadAllProxies();
  const candidate = all.find(p =>
    p.status === 'free' &&
    (!country || (p.country && p.country.toLowerCase() === country.toLowerCase()))
  );
  if (!candidate) {
    const any = all.find(p => p.status === 'free');
    if (!any) return null;
    await saveProxy({ ...any, status: 'busy', accountId });
    return any;
  }
  await saveProxy({ ...candidate, status: 'busy', accountId });
  return candidate;
}

async function releaseProxyFromAccount(accountId) {
  const all = await loadAllProxies();
  for (const p of all) {
    if (p.accountId === accountId) {
      await saveProxy({ ...p, status: 'free', accountId: null });
    }
  }
}

module.exports = {
  parseProxyLine,
  checkProxy,
  checkProxyHttp,
  importProxies,
  acquireProxyForAccount,
  releaseProxyFromAccount
};
