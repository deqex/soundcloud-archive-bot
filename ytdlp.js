'use strict';

const https = require('https');
const fs    = require('fs');
const path  = require('path');
const { execFile } = require('child_process');

const EXE_PATH   = path.join(__dirname, 'yt-dlp.exe');
const GITHUB_API = 'https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** HTTPS GET with redirect following. Returns { statusCode, body: Buffer }. */
function httpsGet(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 10) return reject(new Error('Too many redirects'));
    const req = https.get(url, { headers: { 'User-Agent': 'soundcloud-discord-bot' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(httpsGet(res.headers.location, redirects + 1));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
  });
}

/** Download a URL to dest, following redirects, writing atomically via a temp file. */
function downloadFile(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 10) return reject(new Error('Too many redirects'));
    const tmp = dest + '.tmp';
    https.get(url, { headers: { 'User-Agent': 'soundcloud-discord-bot' } }, res => {
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
    }).on('error', reject);
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
  process.stdout.write('[yt-dlp] Checking for updates… ');

  let latestTag, downloadUrl;
  try {
    const { statusCode, body } = await httpsGet(GITHUB_API);
    if (statusCode !== 200) throw new Error(`GitHub API returned HTTP ${statusCode}`);
    const release = JSON.parse(body.toString());
    latestTag   = release.tag_name;
    const asset = release.assets.find(a => a.name === 'yt-dlp.exe');
    if (!asset) throw new Error('yt-dlp.exe not found in latest release assets');
    downloadUrl = asset.browser_download_url;
  } catch (err) {
    if (fs.existsSync(EXE_PATH)) {
      process.stdout.write(`\n[yt-dlp] GitHub unreachable (${err.message}), using existing copy.\n`);
      return EXE_PATH;
    }
    throw new Error(`Cannot fetch yt-dlp release info and no local copy exists: ${err.message}`);
  }

  const localVersion = fs.existsSync(EXE_PATH) ? await getLocalVersion(EXE_PATH) : null;

  if (localVersion === latestTag) {
    console.log(`up to date (${latestTag})`);
    return EXE_PATH;
  }

  if (localVersion) {
    console.log(`updating ${localVersion} → ${latestTag}`);
  } else {
    console.log(`not found locally, downloading ${latestTag}`);
  }

  await downloadFile(downloadUrl, EXE_PATH);
  console.log(`[yt-dlp] Ready (${latestTag})`);
  return EXE_PATH;
}

module.exports = { ensureYtDlp };
