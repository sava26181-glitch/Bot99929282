const https = require('https');
const fs = require('fs');

const API_KEY = process.env.CAPTCHA_API_KEY || '';
const BASE = 'https://2captcha.com';

function httpPost(url, data) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(data).toString();
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: 30000
    }, res => {
      let out = '';
      res.on('data', c => out += c);
      res.on('end', () => resolve(out));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body);
    req.end();
  });
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 30000 }, res => {
      let out = '';
      res.on('data', c => out += c);
      res.on('end', () => resolve(out));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function solveRecaptchaV2(sitekey, pageurl, invisible = false) {
  if (!API_KEY) throw new Error('CAPTCHA_API_KEY not set');
  const create = await httpPost(`${BASE}/in.php`, {
    key: API_KEY,
    method: 'userrecaptcha',
    googlekey: sitekey,
    pageurl: pageurl,
    invisible: invisible ? 1 : 0,
    json: 1
  });
  const cj = JSON.parse(create);
  if (cj.status !== 1) throw new Error(`2captcha create: ${cj.request}`);
  const id = cj.request;

  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const res = await httpGet(`${BASE}/res.php?key=${API_KEY}&action=get&id=${id}&json=1`);
    const rj = JSON.parse(res);
    if (rj.status === 1) return rj.request;
    if (rj.request !== 'CAPCHA_NOT_READY') throw new Error(`2captcha poll: ${rj.request}`);
  }
  throw new Error('2captcha timeout');
}

async function solveRecaptchaV3(sitekey, pageurl, action = 'verify', minScore = 0.7) {
  if (!API_KEY) throw new Error('CAPTCHA_API_KEY not set');
  const create = await httpPost(`${BASE}/in.php`, {
    key: API_KEY,
    method: 'userrecaptcha',
    version: 'v3',
    googlekey: sitekey,
    pageurl: pageurl,
    action: action,
    min_score: minScore,
    json: 1
  });
  const cj = JSON.parse(create);
  if (cj.status !== 1) throw new Error(`2captcha create: ${cj.request}`);
  const id = cj.request;

  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const res = await httpGet(`${BASE}/res.php?key=${API_KEY}&action=get&id=${id}&json=1`);
    const rj = JSON.parse(res);
    if (rj.status === 1) return rj.request;
    if (rj.request !== 'CAPCHA_NOT_READY') throw new Error(`2captcha poll: ${rj.request}`);
  }
  throw new Error('2captcha timeout');
}

async function solveHCaptcha(sitekey, pageurl) {
  if (!API_KEY) throw new Error('CAPTCHA_API_KEY not set');
  const create = await httpPost(`${BASE}/in.php`, {
    key: API_KEY,
    method: 'hcaptcha',
    sitekey: sitekey,
    pageurl: pageurl,
    json: 1
  });
  const cj = JSON.parse(create);
  if (cj.status !== 1) throw new Error(`2captcha create: ${cj.request}`);
  const id = cj.request;

  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const res = await httpGet(`${BASE}/res.php?key=${API_KEY}&action=get&id=${id}&json=1`);
    const rj = JSON.parse(res);
    if (rj.status === 1) return rj.request;
    if (rj.request !== 'CAPCHA_NOT_READY') throw new Error(`2captcha poll: ${rj.request}`);
  }
  throw new Error('2captcha timeout');
}

async function solveImage(base64Image) {
  if (!API_KEY) throw new Error('CAPTCHA_API_KEY not set');
  const create = await httpPost(`${BASE}/in.php`, {
    key: API_KEY,
    method: 'base64',
    body: base64Image,
    json: 1
  });
  const cj = JSON.parse(create);
  if (cj.status !== 1) throw new Error(`2captcha create: ${cj.request}`);
  const id = cj.request;

  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const res = await httpGet(`${BASE}/res.php?key=${API_KEY}&action=get&id=${id}&json=1`);
    const rj = JSON.parse(res);
    if (rj.status === 1) return rj.request;
    if (rj.request !== 'CAPCHA_NOT_READY') throw new Error(`2captcha poll: ${rj.request}`);
  }
  throw new Error('2captcha timeout');
}

async function getBalance() {
  if (!API_KEY) return null;
  const res = await httpGet(`${BASE}/res.php?key=${API_KEY}&action=getbalance&json=1`);
  const j = JSON.parse(res);
  return j.status === 1 ? Number(j.request) : null;
}

module.exports = {
  solveRecaptchaV2,
  solveRecaptchaV3,
  solveHCaptcha,
  solveImage,
  getBalance
};
