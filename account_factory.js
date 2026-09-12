const https = require('https');
const { signTikTokRequest } = require('./signer_bridge');

const MOBILE_API_HOST = 'api16-normal-c-useast1a.tiktokv.com';
const DEVICE_REGISTER_PATH = '/service/2/device_register/';

/**
 * Регистрирует device_id на серверах TikTok.
 * Возвращает валидный device_id + iid, которые потом используются
 * для всех запросов аккаунта.
 */
async function registerDevice(proxy) {
  const params = {
    aid: 1233,              // TikTok Global
    device_id: 0,
    iid: 0,
    device_type: 'Pixel 7',
    device_brand: 'google',
    os_version: '13',
    os_api: 33,
    openudid: generateOpenUDID(),
    cdid: generateUUID(),
    version_code: 300904,
    version_name: '30.9.4',
    manifest_version_code: 2023009040,
    update_version_code: 2023009040,
    channel: 'googleplay',
    app_type: 'normal',
    resolution: '1080*2400',
    dpi: 420,
    language: 'en',
    os: 'android',
    timezone_name: 'America/New_York',
    timezone_offset: '-14400',
    _rticket: Date.now(),
    ts: Math.floor(Date.now() / 1000)
  };

  // Генерим подписи
  const sig = await signTikTokRequest(params, null, { version: 8404 });
  
  const headers = {
    'User-Agent': 'com.zhiliaoapp.musically/2023009040 (Linux; U; Android 13; en_US; Pixel 7; Build/TQ3A.230805.001;tt-ok/3.12.13.4-tiktok)',
    'x-argus': sig['x-argus'],
    'x-gorgon': sig['x-gorgon'],
    'x-ladon': sig['x-ladon'],
    'x-khronos': sig['x-khronos'],
    'x-ss-req-ticket': sig['x-ss-req-ticket'],
    'x-ss-stub': sig['x-ss-stub'],
    'Content-Type': 'application/json'
  };

  // Отправляем device_register
  const result = await httpPost(`https://${MOBILE_API_HOST}${DEVICE_REGISTER_PATH}`, headers, {}, proxy);
  
  return {
    device_id: result.device_id_str || result.device_id,
    iid: result.iid,
    install_id: result.install_id
  };
}

function generateOpenUDID() {
  return require('crypto').randomBytes(16).toString('hex');
}

function generateUUID() {
  return require('crypto').randomUUID();
}

async function httpPost(url, headers, body, proxy) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = JSON.stringify(body);
    
    const opts = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        ...headers,
        'Content-Length': Buffer.byteLength(data)
      }
    };

    if (proxy) {
      // Для прокси нужно использовать агент или отдельную либу
      // Здесь упрощённо — для работы без прокси
    }

    const req = https.request(opts, res => {
      let out = '';
      res.on('data', c => out += c);
      res.on('end', () => {
        try { resolve(JSON.parse(out)); }
        catch { resolve({ raw: out }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// Экспортируем для использования в createOneAccount
module.exports = { registerDevice, ... };
