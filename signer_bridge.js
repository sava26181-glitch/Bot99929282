const { spawn } = require('child_process');
const path = require('path');

function signTikTokRequest(params, payload = null, options = {}) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(__dirname, 'signer', 'sign.py');
    const input = JSON.stringify({
      params,
      payload,
      version: options.version || 8404
    });

    const py = spawn('python3', [scriptPath, input]);
    let stdout = '';
    let stderr = '';

    py.stdout.on('data', d => stdout += d.toString());
    py.stderr.on('data', d => stderr += d.toString());

    py.on('close', code => {
      console.log('[SIGNER RAW]:', stdout.slice(0, 300));
      if (stderr) console.log('[SIGNER STDERR]:', stderr.slice(0, 300));

      if (code !== 0) {
        return reject(new Error(`Signer error: ${stderr || 'unknown'}`));
      }
      try {
        const result = JSON.parse(stdout);
        if (result.error) return reject(new Error(result.error));
        resolve(result);
      } catch (e) {
        reject(new Error(`Signer parse error: ${stdout.slice(0, 200)}`));
      }
    });

    py.on('error', (err) => {
      reject(new Error(`Python spawn error: ${err.message}`));
    });
  });
}

module.exports = { signTikTokRequest };
