'use strict';

/**
 * One-time script: fetches all SoundCloud followings for a given user
 * and writes their slugs into config.json.
 *
 * Usage: node get-following.js <soundcloud-username>
 * Example: node get-following.js archivepex
 */

const https = require('https');
const fs    = require('fs');
const path  = require('path');

const CONFIG_FILE = path.join(__dirname, 'config.json');
const username    = process.argv[2];

if (!username) {
  console.error('Usage: node get-following.js <soundcloud-username>');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function httpsGet(url, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      'Accept': 'text/html,application/xhtml+xml,*/*',
      ...extraHeaders,
    };
    const req = https.get(url, { headers }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(httpsGet(res.headers.location, extraHeaders));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Step 1 – scrape client_id from SoundCloud's boot JS
// ---------------------------------------------------------------------------

async function getClientId() {
  process.stdout.write('Fetching SoundCloud client_id… ');

  const { body: html } = await httpsGet('https://soundcloud.com/');

  // Find script URLs that look like the webpack bundle
  const scriptUrls = [...html.matchAll(/src="(https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js)"/g)]
    .map(m => m[1]);

  for (const url of scriptUrls.slice(-5)) {
    const { body: js } = await httpsGet(url);
    const m = js.match(/client_id\s*:\s*"([a-zA-Z0-9]{20,32})"/);
    if (m) {
      console.log(`found (${m[1].slice(0, 8)}…)`);
      return m[1];
    }
  }
  throw new Error('Could not extract client_id from SoundCloud scripts. The site may have changed.');
}

// ---------------------------------------------------------------------------
// Step 2 – resolve username → numeric user ID
// ---------------------------------------------------------------------------

async function getUserId(clientId, user) {
  process.stdout.write(`Resolving user ID for "${user}"… `);
  const url = `https://api-v2.soundcloud.com/resolve?url=https://soundcloud.com/${encodeURIComponent(user)}&client_id=${clientId}`;
  const { statusCode, body } = await httpsGet(url, { Accept: 'application/json' });
  if (statusCode !== 200) throw new Error(`Resolve failed: HTTP ${statusCode} — ${body.slice(0, 200)}`);
  const data = JSON.parse(body);
  if (!data.id) throw new Error(`No id in resolve response: ${body.slice(0, 200)}`);
  console.log(data.id);
  return data.id;
}

// ---------------------------------------------------------------------------
// Step 3 – paginate through /followings
// ---------------------------------------------------------------------------

async function getFollowings(clientId, userId) {
  const slugs   = [];
  let   nextUrl = `https://api-v2.soundcloud.com/users/${userId}/followings?client_id=${clientId}&limit=200`;

  while (nextUrl) {
    process.stdout.write(`  Fetching page… `);
    const { statusCode, body } = await httpsGet(nextUrl, { Accept: 'application/json' });
    if (statusCode !== 200) throw new Error(`Followings fetch failed: HTTP ${statusCode}`);
    const page = JSON.parse(body);
    const batch = (page.collection || []).map(u => u.permalink).filter(Boolean);
    slugs.push(...batch);
    console.log(`${batch.length} users (total so far: ${slugs.length})`);
    nextUrl = page.next_href ? page.next_href + `&client_id=${clientId}` : null;
  }

  return slugs;
}

// ---------------------------------------------------------------------------
// Step 4 – patch config.json
// ---------------------------------------------------------------------------

function updateConfig(slugs) {
  let config = {};
  try { config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { /* new file */ }
  config.artists = slugs;
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  console.log(`\nWrote ${slugs.length} artist(s) to config.json`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

(async () => {
  try {
    const clientId = await getClientId();
    const userId   = await getUserId(clientId, username);
    const slugs    = await getFollowings(clientId, userId);
    updateConfig(slugs);
  } catch (err) {
    console.error(`\nError: ${err.message}`);
    process.exit(1);
  }
})();
