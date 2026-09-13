const { spawn } = require('child_process');
const path = require('path');

function runPython(args = []) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(__dirname, 'gmail_temp.py');
    const py = spawn('python3', [scriptPath, ...args]);
    
    let stdout = '';
    let stderr = '';
    
    py.stdout.on('data', (data) => stdout += data.toString());
    py.stderr.on('data', (data) => stderr += data.toString());
    
    py.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(stderr || `Exit code ${code}`));
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (e) {
        reject(new Error(`Parse error: ${stdout}`));
      }
    });
    
    py.on('error', reject);
  });
}

async function createTempGmail() {
  return runPython(['create']);
}

async function checkInbox() {
  return runPython(['check']);
}

async function readMessage(msgId) {
  return runPython(['read', String(msgId)]);
}

async function searchInbox(keyword) {
  return runPython(['search', keyword]);
}

module.exports = {
  createTempGmail,
  checkInbox,
  readMessage,
  searchInbox
};
