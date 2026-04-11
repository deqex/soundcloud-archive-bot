'use strict';

const https = require('https');
const fs    = require('fs');
const path  = require('path');
const { execFile, execSync } = require('child_process');

const EXE_PATH   = path.join(__dirname, 'yt-dlp');
const GITHUB_API = 'https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest';

const HTTP_TIMEOUT_MS = 30_000;   // 30s for API / small fetches
const DL_TIMEOUT_MS   = 300_000;  // 5min for binary download

function log(msg) { console.log(`[yt-dlp] ${msg}`); }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** HTTPS GET with redirect following and timeout. Returns { statusCode, body: Buffer }. */
function httpsGet(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 10) return reject(new Error('Too many redirects'));
    const req = https.get(url, { headers: { 'User-Agent': 'soundcloud-discord-bot' }, timeout: HTTP_TIMEOUT_MS }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(httpsGet(res.headers.location, redirects + 1));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on('timeout', () => { req.destroy(); reject(new Error(`HTTP request timed out after ${HTTP_TIMEOUT_MS}ms: ${url}`)); });
    req.on('error', reject);
  });
}

/** Download a URL to dest, following redirects, writing atomically via a temp file. */
function downloadFile(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 10) return reject(new Error('Too many redirects'));
    const tmp = dest + '.tmp';
    const req = https.get(url, { headers: { 'User-Agent': 'soundcloud-discord-bot' }, timeout: DL_TIMEOUT_MS }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(downloadFile(res.headers.location, dest, redirects + 1));
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`Download failed: HTTP ${res.statusCode}`));
      }
      const out = fs.createWriteStream(tmp);
      res.pipe(out);
      out.on('finish', () => out.close(() => {
        fs.renameSync(tmp, dest);
        resolve();
      }));
      out.on('error', err => { fs.unlink(tmp, () => {}); reject(err); });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error(`Download timed out after ${DL_TIMEOUT_MS}ms`)); });
    req.on('error', reject);
  });
}

/** Get the version string reported by a local yt-dlp binary. Returns null on failure. */
function getLocalVersion(exePath) {
  return new Promise(resolve => {
    execFile(exePath, ['--version'], (err, stdout) => resolve(err ? null : stdout.trim()));
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Ensures yt-dlp.exe in the project folder is present and up to date.
 * Downloads or updates it from GitHub Releases if needed.
 * Returns the absolute path to the executable.
 */
async function ensureYtDlp() {
  log('Checking for updates…');

  let latestTag, downloadUrl;
  try {
    log('Fetching latest release info from GitHub…');
    const { statusCode, body } = await httpsGet(GITHUB_API);
    if (statusCode !== 200) throw new Error(`GitHub API returned HTTP ${statusCode}`);
    const release = JSON.parse(body.toString());
    latestTag   = release.tag_name;
    const asset = release.assets.find(a => a.name === 'yt-dlp_linux');
    if (!asset) throw new Error('yt-dlp_linux not found in latest release assets');
    downloadUrl = asset.browser_download_url;
    log(`Latest release: ${latestTag}`);
  } catch (err) {
    if (fs.existsSync(EXE_PATH)) {
      log(`GitHub unreachable (${err.message}), using existing copy.`);
      return EXE_PATH;
    }
    // No local copy — try system-installed yt-dlp as fallback
    try {
      const systemPath = execSync('which yt-dlp', { encoding: 'utf8' }).trim();
      if (systemPath) {
        log(`GitHub unreachable (${err.message}), using system yt-dlp at ${systemPath}`);
        return systemPath;
      }
    } catch {}
    throw new Error(`Cannot fetch yt-dlp release info and no local or system copy exists: ${err.message}\nInstall it with: sudo apt install yt-dlp  OR  pip install yt-dlp`);
  }

  const localVersion = fs.existsSync(EXE_PATH) ? await getLocalVersion(EXE_PATH) : null;
  log(`Local version: ${localVersion || 'none'}`);

  if (localVersion === latestTag) {
    log(`Up to date (${latestTag})`);
    return EXE_PATH;
  }

  if (localVersion) {
    log(`Updating ${localVersion} → ${latestTag}…`);
  } else {
    log(`Not found locally, downloading ${latestTag}…`);
  }

  await downloadFile(downloadUrl, EXE_PATH);
  fs.chmodSync(EXE_PATH, 0o755);
  log(`Ready (${latestTag})`);
  return EXE_PATH;
}

module.exports = { ensureYtDlp };
