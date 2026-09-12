const crypto = require('crypto');

const UA_LIST = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
];

const VIEWPORTS = [
  { width: 1280, height: 800 },
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1536, height: 864 },
  { width: 1600, height: 900 },
  { width: 1920, height: 1080 }
];

const TIMEZONES = [
  { tz: 'America/New_York', geo: { latitude: 40.7128, longitude: -74.0060 }, locale: 'en-US' },
  { tz: 'America/Chicago', geo: { latitude: 41.8781, longitude: -87.6298 }, locale: 'en-US' },
  { tz: 'America/Los_Angeles', geo: { latitude: 34.0522, longitude: -118.2437 }, locale: 'en-US' },
  { tz: 'Europe/London', geo: { latitude: 51.5074, longitude: -0.1278 }, locale: 'en-GB' },
  { tz: 'Europe/Berlin', geo: { latitude: 52.5200, longitude: 13.4050 }, locale: 'de-DE' },
  { tz: 'Australia/Sydney', geo: { latitude: -33.8688, longitude: 151.2093 }, locale: 'en-AU' }
];

function generateFingerprint(seed) {
  const hash = crypto.createHash('sha256').update(String(seed)).digest();
  let idx = 0;
  const rand = () => {
    const v = hash[idx % hash.length] / 256;
    idx++;
    return v;
  };
  const pickSeeded = arr => arr[Math.floor(rand() * arr.length)];
  const randSeeded = (min, max) => Math.floor(rand() * (max - min) + min);

  const ua = pickSeeded(UA_LIST);
  const vp = pickSeeded(VIEWPORTS);
  const tz = pickSeeded(TIMEZONES);
  const platform = ua.includes('Macintosh') ? 'MacIntel' : 'Win32';

  const canvasNoise = crypto.createHash('md5').update(`${seed}-canvas`).digest('hex');

  return {
    userAgent: ua,
    viewport: vp,
    timezone: tz.tz,
    geolocation: tz.geo,
    locale: tz.locale,
    platform,
    hardwareConcurrency: randSeeded(4, 17),
    deviceMemory: pickSeeded([4, 8, 16, 32]),
    canvasNoise,
    webglVendor: pickSeeded(['Google Inc. (NVIDIA)', 'Google Inc. (Intel)', 'Google Inc. (AMD)']),
    webglRenderer: pickSeeded([
      'ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 Direct3D11 vs_5_0 ps_5_0)',
      'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0)',
      'ANGLE (AMD, AMD Radeon RX 580 Direct3D11 vs_5_0 ps_5_0)'
    ]),
    colorDepth: 24,
    pixelRatio: pickSeeded([1, 1.25, 1.5, 2]),
    fontList: pickSeeded([
      'Arial,Helvetica,sans-serif',
      'Segoe UI,Tahoma,Geneva,Verdana,sans-serif',
      'Roboto,Oxygen,Ubuntu,Cantarell,sans-serif'
    ])
  };
}

function fingerprintInitScript(fp) {
  return `
    (() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'platform', { get: () => '${fp.platform}' });
      Object.defineProperty(navigator, 'languages', { get: () => ['${fp.locale}', '${fp.locale.split('-')[0]}'] });
      Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => ${fp.hardwareConcurrency} });
      Object.defineProperty(navigator, 'deviceMemory', { get: () => ${fp.deviceMemory} });

      Object.defineProperty(navigator, 'plugins', {
        get: () => [
          { name: 'PDF Viewer', filename: 'internal-pdf-viewer' },
          { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer' },
          { name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer' }
        ]
      });

      const getParameter = WebGLRenderingContext.prototype.getParameter;
      WebGLRenderingContext.prototype.getParameter = function(p) {
        if (p === 37445) return '${fp.webglVendor}';
        if (p === 37446) return '${fp.webglRenderer}';
        return getParameter.call(this, p);
      };

      const toDataURL = HTMLCanvasElement.prototype.toDataURL;
      HTMLCanvasElement.prototype.toDataURL = function(...args) {
        const ctx = this.getContext('2d');
        if (ctx) {
          const noise = '${fp.canvasNoise}';
          for (let i = 0; i < noise.length; i += 2) {
            const x = (i * 7) % this.width;
            const y = (i * 13) % this.height;
            try {
              const d = ctx.getImageData(x, y, 1, 1);
              d.data[0] = (d.data[0] + noise.charCodeAt(i)) % 256;
              ctx.putImageData(d, x, y);
            } catch {}
          }
        }
        return toDataURL.apply(this, args);
      };

      window.chrome = { runtime: {} };

      const originalQuery = window.navigator.permissions.query;
      window.navigator.permissions.query = (parameters) => (
        parameters.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission })
          : originalQuery(parameters)
      );
    })();
  `;
}

module.exports = { generateFingerprint, fingerprintInitScript };
