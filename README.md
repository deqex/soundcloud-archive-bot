# soundcloud-archives

Discord bot that monitors SoundCloud artists and automatically posts new uploads as MP3s to a Discord channel.

## Features

- **Automatic polling** — periodically checks your artist list for new tracks and posts them to Discord
- **MP3 downloads** — downloads tracks via yt-dlp and attaches them directly to messages
- **Slash commands**
  - `/add <artist>` — add a SoundCloud artist to the watch list at runtime
  - `/discography <artist>` — download and post an artist's entire discography
- **Auto-updating yt-dlp** — downloads and keeps yt-dlp up to date from GitHub Releases on startup
- **Import followings** — one-time script to populate your artist list from a SoundCloud account's followings

## Setup

### Prerequisites

- Node.js 18+
- A [Discord bot](https://discord.com/developers/applications) with the `bot` and `applications.commands` scopes
- ffmpeg installed and in your PATH (required by yt-dlp for audio conversion)

### Installation

```bash
git clone <repo-url>
cd soundcloud-archives
npm install
```

### Configuration

1. Copy the example files:

```bash
cp .env.example .env
cp config.example.json config.json
```

2. Fill in `.env`:

| Variable | Description |
|---|---|
| `DISCORD_TOKEN` | Your Discord bot token |
| `DISCORD_CHANNEL_ID` | Channel ID where tracks will be posted |
| `YT_DLP_PATH` | *(optional)* Custom path to yt-dlp binary |

3. Edit `config.json`:

```json
{
  "artists": ["some-artist", "another-artist"],
  "pollIntervalMinutes": 15,
  "playlistLimit": 50,
  "maxFileSizeMB": 8
}
```

| Key | Default | Description |
|---|---|---|
| `artists` | `[]` | SoundCloud usernames to monitor |
| `pollIntervalMinutes` | `15` | Minutes between each polling cycle |
| `playlistLimit` | `50` | Max tracks to check per artist per poll |
| `maxFileSizeMB` | `8` | Files larger than this are posted as link-only |

## Usage

```bash
npm start
```

The bot will log in, register slash commands, run an initial poll, then continue polling on the configured interval.

### Import followings from a SoundCloud account

Populate your artist list with everyone a SoundCloud user follows:

```bash
node get-following.js <soundcloud-username>
```

This overwrites the `artists` array in `config.json`.

### Running with pm2

```bash
pm2 start index.js --name soundcloud-archives
```

## Project structure

```
index.js              Main bot — polling, downloading, Discord integration
ytdlp.js              yt-dlp auto-download and update logic
get-following.js      One-time script to import followings into config
config.json           Artist list and bot settings
data/seen.json        Track IDs already processed (auto-managed)
downloads/            Temporary directory for MP3 files (auto-cleaned)
```
