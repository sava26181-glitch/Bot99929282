const https = require('https');

const SIGNER_API = process.env.SIGNER_API || '';
const SIGNER_KEY = process.env.SIGNER_KEY || '';

function signTikTokRequest(params, payload = null, options = {}) {
  return new Promise((resolve, reject) => {
    if (!SIGNER_API) {
      return reject(new Error('SIGNER_API not set'));
    }

    const body = JSON.stringify({
      key: SIGNER_KEY,
      params,
      payload,
      version: options.version || 8404
    });

    const u = new URL(SIGNER_API);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: 30000
    }, res => {
      let out = '';
      res.on('data', c => out += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(out);
          if (json.error) return reject(new Error(json.error));
          resolve(json);
        } catch (e) {
          reject(new Error(`Signer parse error: ${out.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('signer timeout')); });
    req.write(body);
    req.end();
  });
}

module.exports = { signTikTokRequest };
