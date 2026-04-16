'use strict';

require('dotenv').config();

const { Client, GatewayIntentBits, AttachmentBuilder, REST, Routes, SlashCommandBuilder } = require('discord.js');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { ensureYtDlp } = require('./ytdlp');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
if (!process.env.DISCORD_TOKEN) {
  console.error('DISCORD_TOKEN is not set. Copy .env.example to .env and fill in your values.');
  process.exit(1);
}
if (!process.env.DISCORD_CHANNEL_ID) {
  console.error('DISCORD_CHANNEL_ID is not set. Copy .env.example to .env and fill in your values.');
  process.exit(1);
}

const CONFIG_FILE = path.join(__dirname, 'config.json');
let config;
try {
  config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
} catch {
  console.error('config.json not found. Copy config.example.json to config.json and fill in your values.');
  process.exit(1);
}

const SEEN_FILE    = path.join(__dirname, 'data', 'seen.json');
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
let YT_DLP         = path.join(__dirname, 'yt-dlp'); // resolved at startup by ensureYtDlp()

/** Convert a plain SoundCloud username to its tracks URL. */
const scUrl = name => `https://soundcloud.com/${name}/tracks`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const YTDLP_TIMEOUT_MS = 180_000; // 3 minutes per yt-dlp invocation

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }

/** Update the bot's Discord presence/activity status. */
function setStatus(text, type = 'Custom') {
  try {
    const typeMap = { Watching: 3, Listening: 2, Playing: 0, Custom: 4 };
    client.user?.setActivity({ name: text, type: typeMap[type] ?? 4 });
  } catch { /* ignore if not ready */ }
}

/** Run yt-dlp with the given argument array (no shell, avoids injection). Kills after timeout. */
function runYtDlp(args, timeoutMs = YTDLP_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const out  = [];
    const err  = [];
    const proc = spawn(YT_DLP, args);
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      proc.kill('SIGKILL');
      reject(new Error(`yt-dlp timed out after ${timeoutMs / 1000}s — args: ${args.join(' ')}`));
    }, timeoutMs);

    proc.stdout.on('data', chunk => out.push(chunk));
    proc.stderr.on('data', chunk => err.push(chunk));

    proc.on('error', e => { clearTimeout(timer); reject(new Error(`Failed to start yt-dlp ("${YT_DLP}"): ${e.message}`)); });
    proc.on('close', code => {
      clearTimeout(timer);
      if (killed) return; // already rejected
      if (code !== 0) {
        reject(new Error(`yt-dlp exited ${code}: ${Buffer.concat(err).toString().trim()}`));
      } else {
        resolve(Buffer.concat(out).toString());
      }
    });
  });
}

function loadSeen() {
  try {
    return JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveSeen(seen) {
  fs.mkdirSync(path.dirname(SEEN_FILE), { recursive: true });
  fs.writeFileSync(SEEN_FILE, JSON.stringify(seen, null, 2));
}

// ---------------------------------------------------------------------------
// SoundCloud polling
// ---------------------------------------------------------------------------

/**
 * Fetch the track list for an artist URL using yt-dlp's flat-playlist mode.
 * Returns an array of { id, title, url }.
 */
async function getArtistTracks(artistUrl, limit = config.playlistLimit || 50) {
  log(`[tracks] Fetching track list: ${artistUrl} (limit ${limit})`);
  const stdout = await runYtDlp([
    '--flat-playlist',
    '-j',
    '--no-warnings',
    '--playlist-end', String(limit),
    artistUrl,
  ]);

  const tracks = stdout
    .trim()
    .split('\n')
    .filter(line => line.trim())
    .map(line => {
      try {
        const entry = JSON.parse(line);
        return {
          id:    entry.id,
          title: entry.title || entry.id,
          url:   entry.webpage_url || entry.url,
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  log(`[tracks] Got ${tracks.length} tracks from ${artistUrl}`);
  return tracks;
}

/**
 * Download a single track as MP3 into DOWNLOADS_DIR.
 * Returns the full path to the mp3, or null if it can't be found.
 */
async function downloadTrack(track) {
  setStatus(`Downloading: ${track.title}`, 'Listening');
  log(`[download] Starting download: "${track.title}" (${track.id})`);
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });

  // Use the track ID as the filename to avoid collisions.
  const outputTemplate = path.join(DOWNLOADS_DIR, `${track.id}.%(ext)s`);

  await runYtDlp([
    '-x',
    '--audio-format', 'mp3',
    '--audio-quality', '0',
    '--no-warnings',
    '-o', outputTemplate,
    track.url,
  ], 600_000); // 10 min timeout for download + conversion

  const mp3Path = path.join(DOWNLOADS_DIR, `${track.id}.mp3`);
  const exists = fs.existsSync(mp3Path);
  log(`[download] Finished: "${track.title}" — ${exists ? `saved to ${mp3Path}` : 'NO MP3 PRODUCED'}`);
  return exists ? mp3Path : null;
}

// ---------------------------------------------------------------------------
// Discord posting
// ---------------------------------------------------------------------------

async function postTrack(client, track, filePath, artistLabel) {
  setStatus(`Posting: ${track.title}`, 'Playing');
  log(`[post] Sending "${track.title}" by ${artistLabel} to Discord…`);
  const channel     = await client.channels.fetch(process.env.DISCORD_CHANNEL_ID);
  const fileSizeBytes = fs.statSync(filePath).size;
  const maxBytes    = (config.maxFileSizeMB || 8) * 1024 * 1024;

  // Sanitise title for use as a filename.
  const safeTitle = track.title
    .replace(/[<>:"/\\|?*]/g, '')
    .slice(0, 100)
    .trim() || track.id;

  const message = `New upload from **${artistLabel}**\n**${track.title}**\n<${track.url}>`;

  if (fileSizeBytes <= maxBytes) {
    const attachment = new AttachmentBuilder(filePath, { name: `${safeTitle}.mp3` });
    await channel.send({ content: message, files: [attachment] });
    log(`[post] Sent "${track.title}" (${(fileSizeBytes / 1024 / 1024).toFixed(1)} MB)`);
  } else {
    const sizeMB = (fileSizeBytes / (1024 * 1024)).toFixed(1);
    await channel.send(`${message}\n*(File is ${sizeMB} MB — too large to attach)*`);
    log(`[post] Sent "${track.title}" (too large: ${sizeMB} MB, link only)`);
  }

  fs.unlinkSync(filePath);
}

// ---------------------------------------------------------------------------
// Per-artist check
// ---------------------------------------------------------------------------

async function checkArtist(discordClient, artistUrl) {
  const artistLabel = artistUrl
    .replace(/^https?:\/\/soundcloud\.com\//, '')
    .replace(/\/tracks\/?$/, '')
    .split('/')[0];
  setStatus(`Checking ${artistLabel}…`, 'Watching');
  log(`[check] Checking artist: ${artistUrl}`);
  const seen       = loadSeen();
  const isFirstRun = !(artistUrl in seen);

  let tracks;
  try {
    tracks = await getArtistTracks(artistUrl);
  } catch (err) {
    log(`[check] FAILED to fetch track list for ${artistUrl}: ${err.message}`);
    return;
  }

  if (isFirstRun) {
    seen[artistUrl] = tracks.map(t => t.id);
    saveSeen(seen);
    log(`[check] First run for ${artistUrl} – marked ${tracks.length} existing tracks as seen.`);
    return;
  }

  const seenSet  = new Set(seen[artistUrl]);
  const newTracks = tracks.filter(t => !seenSet.has(t.id));

  if (newTracks.length === 0) {
    log(`[check] No new tracks for ${artistUrl}`);
    return;
  }

  log(`[check] Found ${newTracks.length} new track(s) for ${artistLabel}`);

  for (const track of newTracks) {
    log(`[check] Processing new track: "${track.title}" (${track.id})`);
    try {
      const filePath = await downloadTrack(track);
      if (filePath) {
        await postTrack(discordClient, track, filePath, artistLabel);
        log(`[check] Successfully posted: "${track.title}"`);
      } else {
        log(`[check] WARNING: Download produced no mp3 for: "${track.title}"`);
      }
    } catch (err) {
      log(`[check] ERROR processing "${track.title}": ${err.message}`);
      // Clean up any partial download.
      const partial = path.join(DOWNLOADS_DIR, `${track.id}.mp3`);
      if (fs.existsSync(partial)) fs.unlinkSync(partial);
    }

    // Mark seen even on failure so we don't retry the same track forever.
    seenSet.add(track.id);
    seen[artistUrl] = Array.from(seenSet);
    saveSeen(seen);
  }
  log(`[check] Done with ${artistLabel}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function poll(discordClient) {
  setStatus(`Polling ${config.artists.length} artist(s)…`, 'Watching');
  log(`[poll] Starting poll for ${config.artists.length} artist(s)…`);
  for (const name of config.artists) {
    await checkArtist(discordClient, scUrl(name));
  }
  log(`[poll] Poll complete.`);
  setStatus(`Idle — watching ${config.artists.length} artists`, 'Watching');
}

// ---------------------------------------------------------------------------
// Slash command: /discography
// ---------------------------------------------------------------------------

const discographyCommand = new SlashCommandBuilder()
  .setName('discography')
  .setDescription('Download and post the full discography of a SoundCloud artist')
  .addStringOption(opt =>
    opt.setName('artist')
      .setDescription('SoundCloud username (e.g. archivepex)')
      .setRequired(true)
  );

const addCommand = new SlashCommandBuilder()
  .setName('add')
  .setDescription('Add a SoundCloud artist to the watch list')
  .addStringOption(opt =>
    opt.setName('artist')
      .setDescription('SoundCloud username (e.g. archivepex)')
      .setRequired(true)
  );

async function registerCommands(clientId) {
  log('[commands] Registering slash commands…');
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  await rest.put(Routes.applicationCommands(clientId), {
    body: [discographyCommand.toJSON(), addCommand.toJSON()],
  });
  log('[commands] Slash commands registered.');
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'add') {
    const artistName = interaction.options.getString('artist').trim().toLowerCase();
    if (!/^[a-z0-9_-]+$/.test(artistName)) {
      await interaction.reply({ content: 'Invalid artist name. Use only letters, numbers, hyphens, or underscores.', ephemeral: true });
      return;
    }
    if (config.artists.includes(artistName)) {
      await interaction.reply({ content: `**${artistName}** is already on the watch list.`, ephemeral: true });
      return;
    }
    config.artists.push(artistName);
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
    log(`[add] Added artist: ${artistName}`);
    await interaction.reply(`Added **${artistName}** to the watch list (${config.artists.length} artists total).`);
    return;
  }

  if (interaction.commandName !== 'discography') return;

  const artistName = interaction.options.getString('artist').trim().toLowerCase();
  log(`[discography] Command received for artist: ${artistName}`);
  // Validate: only allow safe SoundCloud usernames (alphanumeric, hyphens, underscores)
  if (!/^[a-z0-9_-]+$/.test(artistName)) {
    await interaction.reply({ content: 'Invalid artist name. Use only letters, numbers, hyphens, or underscores.', ephemeral: true });
    return;
  }

  const artistUrl = scUrl(artistName);
  setStatus(`Discography: ${artistName}`, 'Listening');
  await interaction.reply(`Fetching discography for **${artistName}**… this may take a while.`);

  let tracks;
  try {
    tracks = await getArtistTracks(artistUrl, 9999);
  } catch (err) {
    log(`[discography] FAILED to fetch tracks for ${artistName}: ${err.message}`);
    await interaction.editReply(`Failed to fetch track list: ${err.message}`);
    return;
  }

  if (tracks.length === 0) {
    log(`[discography] No tracks found for ${artistName}`);
    await interaction.editReply(`No tracks found for **${artistName}**.`);
    return;
  }

  log(`[discography] Found ${tracks.length} tracks for ${artistName}, starting downloads…`);
  await interaction.editReply(`Found **${tracks.length}** tracks for **${artistName}**. Downloading and posting…`);

  let posted = 0;
  for (const track of tracks) {
    try {
      log(`[discography] Downloading "${track.title}" (${track.id})…`);
      const filePath = await downloadTrack(track);
      if (filePath) {
        await postTrack(client, track, filePath, artistName);
        posted++;
        log(`[discography] Posted "${track.title}" (${posted}/${tracks.length})`);
      }
    } catch (err) {
      log(`[discography] ERROR on "${track.title}": ${err.message}`);
      const partial = path.join(DOWNLOADS_DIR, `${track.id}.mp3`);
      if (fs.existsSync(partial)) fs.unlinkSync(partial);
    }
  }

  log(`[discography] Done for ${artistName}: ${posted}/${tracks.length} posted`);
  setStatus(`Idle — watching ${config.artists.length} artists`, 'Watching');
  await interaction.editReply(`Done! Posted **${posted}/${tracks.length}** tracks for **${artistName}**.`);
});

client.once('clientReady', async () => {
  log(`Logged in as ${client.user.tag}`);
  setStatus(`Starting up…`, 'Watching');
  await registerCommands(client.user.id);

  // Run immediately, then on a fixed interval.
  try {
    await poll(client);
  } catch (err) {
    log(`[poll] ERROR in initial poll: ${err.message}`);
  }
  setInterval(async () => {
    try {
      await poll(client);
    } catch (err) {
      log(`[poll] ERROR in scheduled poll: ${err.message}`);
    }
  }, (config.pollIntervalMinutes || 15) * 60 * 1000);
});

// ---------------------------------------------------------------------------
// Process-level safety nets
// ---------------------------------------------------------------------------
process.on('unhandledRejection', (reason) => {
  log(`[FATAL] Unhandled promise rejection: ${reason instanceof Error ? reason.stack : reason}`);
});
process.on('uncaughtException', (err) => {
  log(`[FATAL] Uncaught exception: ${err.stack}`);
  process.exit(1);
});

(async () => {
  log('Starting up…');
  YT_DLP = await ensureYtDlp();
  log(`Using yt-dlp at: ${YT_DLP}`);
  log('Logging in to Discord…');
  client.login(process.env.DISCORD_TOKEN);
})();
