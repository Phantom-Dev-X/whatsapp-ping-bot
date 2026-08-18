const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync, spawnSync } = require('child_process');

const REPO = process.env.GITHUB_REPO || 'Phantom-Dev-X/whatsapp-ping-bot';
const BRANCH = process.env.GITHUB_BRANCH || 'main';
const SHA_FILE = path.join(__dirname, '.deploy-sha');
const SKIP = new Set([
  'session',
  'node_modules',
  '.deploy-sha',
  '.git',
  '.env',
]);

function enabled() {
  return !/^(0|false|off|no)$/i.test(String(process.env.AUTO_DEPLOY || 'true'));
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          'User-Agent': 'whatsapp-ping-bot-autodeploy',
          Accept: 'application/vnd.github+json',
        },
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return httpGet(res.headers.location).then(resolve, reject);
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          if (res.statusCode >= 400) {
            reject(new Error(`GitHub ${res.statusCode}: ${buf.toString().slice(0, 200)}`));
          } else {
            resolve(buf);
          }
        });
      }
    );
    req.on('error', reject);
  });
}

function localSha() {
  if (fs.existsSync(SHA_FILE)) {
    return fs.readFileSync(SHA_FILE, 'utf8').trim();
  }
  try {
    return execSync('git rev-parse HEAD', { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return '';
  }
}

async function remoteSha() {
  const buf = await httpGet(`https://api.github.com/repos/${REPO}/commits/${BRANCH}`);
  const json = JSON.parse(buf.toString());
  if (!json.sha) throw new Error('No sha from GitHub');
  return json.sha;
}

function hasGit() {
  if (!fs.existsSync(path.join(__dirname, '.git'))) return false;
  const r = spawnSync('git', ['--version'], { stdio: 'ignore' });
  return r.status === 0;
}

function pullWithGit() {
  execSync(`git fetch origin ${BRANCH}`, { cwd: __dirname, stdio: 'inherit' });
  execSync(`git reset --hard origin/${BRANCH}`, { cwd: __dirname, stdio: 'inherit' });
}

async function pullWithZip(sha) {
  const AdmZip = require('adm-zip');
  const zipBuf = await httpGet(`https://codeload.github.com/${REPO}/zip/${sha}`);
  const tmp = path.join(__dirname, `.update-${Date.now()}.zip`);
  fs.writeFileSync(tmp, zipBuf);
  try {
    const zip = new AdmZip(tmp);
    const entries = zip.getEntries();
    const rootPrefix = entries[0] && entries[0].entryName.split('/')[0];
    for (const entry of entries) {
      let rel = entry.entryName;
      if (rootPrefix && rel.startsWith(rootPrefix + '/')) {
        rel = rel.slice(rootPrefix.length + 1);
      }
      if (!rel || rel.endsWith('/')) continue;
      const top = rel.split(/[/\\]/)[0];
      if (SKIP.has(top)) continue;
      const dest = path.join(__dirname, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, entry.getData());
    }
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

function npmInstall() {
  console.log('[deploy] npm install…');
  execSync('npm install --omit=dev', { cwd: __dirname, stdio: 'inherit' });
}

async function checkAndUpdate({ restart = false } = {}) {
  if (!enabled()) return false;
  try {
    const remote = await remoteSha();
    const local = localSha();
    if (local && remote === local) return false;

    console.log(`[deploy] New commit ${remote.slice(0, 7)} (was ${local.slice(0, 7) || 'none'})`);

    if (hasGit()) pullWithGit();
    else await pullWithZip(remote);

    fs.writeFileSync(SHA_FILE, remote + '\n');
    npmInstall();
    console.log('[deploy] Update applied. session/ was kept.');

    if (restart) {
      console.log('[deploy] Restarting process so the panel picks up new code…');
      process.exit(0);
    }
    return true;
  } catch (err) {
    console.warn('[deploy] Check failed:', err.message);
    return false;
  }
}

function startWatcher() {
  if (!enabled()) {
    console.log('[deploy] AUTO_DEPLOY=false — skipping GitHub watch');
    return;
  }
  const ms = Number(process.env.DEPLOY_INTERVAL_MS) || 3 * 60 * 1000;
  console.log(`[deploy] Watching github.com/${REPO} (${BRANCH}) every ${Math.round(ms / 1000)}s`);
  setInterval(() => {
    checkAndUpdate({ restart: true }).catch(() => {});
  }, ms);
}

module.exports = { checkAndUpdate, startWatcher };
