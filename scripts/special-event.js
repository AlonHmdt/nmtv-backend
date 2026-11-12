/**
 * Special Event Script
 *
 * Manage NMTV special-event channels straight from the command line:
 * list existing events, validate YouTube playlists, and add / enable /
 * disable / delete events.
 *
 * Every command that writes to the database is a DRY RUN unless you pass
 * --apply. Dry runs print exactly what would be written.
 *
 * Usage:
 *   node scripts/special-event.js list
 *   node scripts/special-event.js search "<query>" [--max 10]   (100 quota units)
 *   node scripts/special-event.js validate <playlist-id-or-url> [...] [--region IL]
 *   node scripts/special-event.js add --label "Halloween" --icons "🎃,👻" \
 *        --start 2026-10-24 --end 2026-11-01 \
 *        --playlist "PLxxxx::Halloween Classics" --playlist "PLyyyy" \
 *        [--region IL] [--disabled] [--apply]
 *
 *   Playlist label is optional: "<id-or-url>::<label>".
 *   "Playable" = public, embeddable and not blocked in --region (default IL).
 *   node scripts/special-event.js enable  <event-id> [--apply]
 *   node scripts/special-event.js disable <event-id> [--apply]
 *   node scripts/special-event.js delete  <event-id> [--apply]
 *
 * Notes:
 *   - Dates recur every year: the backend compares month+day only, and
 *     the end date is inclusive.
 *   - Only ONE event is shown at a time. If several enabled events cover
 *     today, the one with the latest start_date wins, so `add` warns about
 *     overlaps.
 *   - The backend caches the active event for 5 minutes, so changes can
 *     take up to 5 minutes to appear.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const axios = require('axios');
const { Pool } = require('pg');
const { getDbSslConfig } = require('../db-ssl');

const DATABASE_URL = process.env.DATABASE_URL;
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const YT = 'https://www.googleapis.com/youtube/v3';

// A playlist needs at least this many playable videos to be recommended.
const MIN_PLAYABLE_VIDEOS = 15;

// Country whose region blocks we check (override with --region XX).
const DEFAULT_REGION = 'IL';

// ============================================
// ARG PARSING
// ============================================

function parseArgs(argv) {
  const positional = [];
  const flags = { playlist: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (['apply', 'disabled'].includes(name)) {
      flags[name] = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      fail(`Missing value for --${name}`);
    }
    i++;
    if (name === 'playlist') flags.playlist.push(value);
    else flags[name] = value;
  }
  return { positional, flags };
}

function fail(message) {
  console.error(`❌ ${message}`);
  process.exit(1);
}

// ============================================
// HELPERS
// ============================================

function extractPlaylistId(input) {
  const trimmed = input.trim();
  const fromUrl = trimmed.match(/[?&]list=([a-zA-Z0-9_-]+)/);
  const id = fromUrl ? fromUrl[1] : trimmed;
  if (!/^[a-zA-Z0-9_-]{10,64}$/.test(id)) {
    fail(`Not a valid YouTube playlist ID or URL: ${input}`);
  }
  return id;
}

/** "PLxxx::Some label" (or "<url>::Some label") → { id, label } */
function parsePlaylistArg(raw) {
  const sep = raw.indexOf('::');
  const idPart = sep === -1 ? raw : raw.slice(0, sep);
  const label = sep === -1 ? '' : raw.slice(sep + 2).trim();
  return { id: extractPlaylistId(idPart), label };
}

function parseDate(value, flagName) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) {
    fail(`--${flagName} must be a date in YYYY-MM-DD format`);
  }
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    fail(`--${flagName} is not a real date: ${value}`);
  }
  return value;
}

/** month*100 + day, the same "day of year" key the backend uses. */
function monthDay(dateLike) {
  const d = new Date(dateLike);
  return (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
}

/** Set of month-day keys covered by [start, end] (handles year wraparound). */
function coveredDays(start, end) {
  const days = new Set();
  // 2000 is a leap year, so Feb 29 exists while walking the calendar.
  const mm = String(Math.floor(start / 100)).padStart(2, '0');
  const dd = String(start % 100).padStart(2, '0');
  const cursor = new Date(`2000-${mm}-${dd}T00:00:00Z`);
  for (let i = 0; i < 366; i++) {
    const key = monthDay(cursor);
    days.add(key);
    if (key === end) break;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

function formatMD(md) {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[Math.floor(md / 100) - 1]} ${md % 100}`;
}

function formatRange(start, end) {
  if (!start || !end) return 'always (no dates)';
  return `${formatMD(monthDay(start))} → ${formatMD(monthDay(end))} (every year)`;
}

function createPool() {
  if (!DATABASE_URL) fail('DATABASE_URL not found in .env');
  return new Pool({
    connectionString: DATABASE_URL,
    ssl: DATABASE_URL.includes('supabase') ? getDbSslConfig() : false,
    max: 2,
    connectionTimeoutMillis: 15000,
  });
}

// ============================================
// YOUTUBE VALIDATION
// ============================================

/** True if a video's regionRestriction blocks playback in `region`. */
function isBlockedIn(restriction, region) {
  if (!restriction || !region) return false;
  if (restriction.blocked && restriction.blocked.includes(region)) return true;
  if (restriction.allowed && !restriction.allowed.includes(region)) return true;
  return false;
}

async function validatePlaylist(playlistId, region = DEFAULT_REGION) {
  if (!YOUTUBE_API_KEY) fail('YOUTUBE_API_KEY not found in .env');

  const { data } = await axios.get(`${YT}/playlists`, {
    params: { part: 'snippet,contentDetails,status', id: playlistId, key: YOUTUBE_API_KEY },
  });
  const playlist = data.items && data.items[0];
  if (!playlist) {
    return { id: playlistId, ok: false, problem: 'not found or private' };
  }

  // Collect video IDs (cap at 200 videos to keep quota use small).
  const videoIds = [];
  let pageToken;
  do {
    const page = await axios.get(`${YT}/playlistItems`, {
      params: { part: 'contentDetails', playlistId, maxResults: 50, pageToken, key: YOUTUBE_API_KEY },
    });
    for (const item of page.data.items || []) videoIds.push(item.contentDetails.videoId);
    pageToken = page.data.nextPageToken;
  } while (pageToken && videoIds.length < 200);

  // Check each video's status.
  let playable = 0;
  let notEmbeddable = 0;
  let unavailable = 0;
  let blockedInRegion = 0;
  for (let i = 0; i < videoIds.length; i += 50) {
    const batch = videoIds.slice(i, i + 50);
    const { data: videos } = await axios.get(`${YT}/videos`, {
      params: { part: 'status,contentDetails', id: batch.join(','), key: YOUTUBE_API_KEY },
    });
    const found = new Set();
    for (const v of videos.items || []) {
      found.add(v.id);
      if (v.status.privacyStatus !== 'public') unavailable++;
      else if (!v.status.embeddable) notEmbeddable++;
      else if (isBlockedIn(v.contentDetails.regionRestriction, region)) blockedInRegion++;
      else playable++;
    }
    unavailable += batch.filter(id => !found.has(id)).length; // deleted videos
  }

  const problems = [];
  if (playlist.status.privacyStatus === 'private') problems.push('playlist is private');
  if (playable < MIN_PLAYABLE_VIDEOS) problems.push(`only ${playable} playable videos (min ${MIN_PLAYABLE_VIDEOS})`);

  return {
    id: playlistId,
    ok: problems.length === 0,
    problem: problems.join('; '),
    title: playlist.snippet.title,
    channel: playlist.snippet.channelTitle,
    privacy: playlist.status.privacyStatus,
    totalItems: playlist.contentDetails.itemCount,
    checked: videoIds.length,
    playable,
    notEmbeddable,
    unavailable,
    blockedInRegion,
    region,
  };
}

/**
 * Search YouTube for playlists. Costs 100 quota units per call (the daily
 * quota is shared with the backend), so keep searches few and specific.
 */
async function cmdSearch(queryParts, flags) {
  if (!YOUTUBE_API_KEY) fail('YOUTUBE_API_KEY not found in .env');
  const query = queryParts.join(' ').trim();
  if (!query) fail('Pass a search query, e.g. search "halloween music videos 80s"');
  const max = Math.min(parseInt(flags.max || '10', 10) || 10, 25);

  const { data } = await axios.get(`${YT}/search`, {
    params: { part: 'snippet', type: 'playlist', q: query, maxResults: max, key: YOUTUBE_API_KEY },
  });
  const ids = (data.items || []).map(i => i.id.playlistId);
  if (ids.length === 0) {
    console.log('No playlists found.');
    return;
  }

  // One cheap call to get the video count of every result.
  const { data: details } = await axios.get(`${YT}/playlists`, {
    params: { part: 'contentDetails', id: ids.join(','), key: YOUTUBE_API_KEY },
  });
  const counts = Object.fromEntries((details.items || []).map(p => [p.id, p.contentDetails.itemCount]));

  for (const item of data.items) {
    const id = item.id.playlistId;
    console.log(`${id}  (${counts[id] ?? '?'} videos)`);
    console.log(`     "${item.snippet.title}" by ${item.snippet.channelTitle}`);
  }
  console.log('\nRun `validate` on the promising ones before using them.');
}

function printValidation(r, label) {
  const mark = r.ok ? '✅' : '⚠️ ';
  console.log(`${mark} ${r.id}${label ? `  [label: ${label}]` : ''}`);
  if (!r.title) {
    console.log(`     ${r.problem}`);
    return;
  }
  console.log(`     "${r.title}" by ${r.channel} (${r.privacy})`);
  console.log(`     videos: ${r.totalItems} total, checked ${r.checked}: ${r.playable} playable, ` +
    `${r.notEmbeddable} not embeddable, ${r.unavailable} private/deleted, ${r.blockedInRegion} blocked in ${r.region}`);
  if (!r.ok) console.log(`     problem: ${r.problem}`);
}

// ============================================
// COMMANDS
// ============================================

async function fetchEvents(pool) {
  const { rows: events } = await pool.query(`
    SELECT id, label, icon1, icon2, is_enabled,
           to_char(start_date, 'YYYY-MM-DD') AS start_date,
           to_char(end_date, 'YYYY-MM-DD') AS end_date
    FROM special_events ORDER BY start_date NULLS LAST, id
  `);
  const { rows: playlists } = await pool.query(`
    SELECT special_event_id, youtube_playlist_id, label, position
    FROM special_event_playlists ORDER BY special_event_id, position
  `);
  for (const e of events) {
    e.playlists = playlists.filter(p => p.special_event_id === e.id);
  }
  return events;
}

async function cmdList() {
  const pool = createPool();
  try {
    const events = await fetchEvents(pool);
    if (events.length === 0) {
      console.log('No special events in the database.');
      return;
    }
    for (const e of events) {
      console.log(`#${e.id} ${e.icon1} ${e.label} ${e.icon2}  ${e.is_enabled ? '🟢 enabled' : '⚪ disabled'}`);
      console.log(`     ${formatRange(e.start_date, e.end_date)}`);
      for (const p of e.playlists) {
        console.log(`     - ${p.youtube_playlist_id}${p.label ? `  (${p.label})` : ''}`);
      }
    }
  } finally {
    await pool.end();
  }
}

function getRegion(flags) {
  const region = (flags.region || DEFAULT_REGION).toUpperCase();
  if (!/^[A-Z]{2}$/.test(region)) fail('--region must be a 2-letter country code, e.g. IL or US');
  return region;
}

async function cmdValidate(inputs, flags) {
  if (inputs.length === 0) fail('Pass at least one playlist ID or URL');
  const region = getRegion(flags);
  let allOk = true;
  for (const input of inputs) {
    const { id, label } = parsePlaylistArg(input);
    const result = await validatePlaylist(id, region);
    printValidation(result, label);
    if (!result.ok) allOk = false;
  }
  process.exitCode = allOk ? 0 : 2;
}

async function cmdAdd(flags) {
  const label = (flags.label || '').trim();
  if (!label) fail('--label is required');
  if (label.length > 255) fail('--label is too long (max 255 characters)');

  const icons = (flags.icons || '⭐,⭐').split(',').map(s => s.trim()).filter(Boolean);
  if (icons.length !== 2) fail('--icons must be two emojis separated by a comma, e.g. "🎃,👻"');
  for (const icon of icons) {
    if ([...icon].length > 10) fail(`Icon too long (max 10 characters): ${icon}`);
  }

  const start = parseDate(flags.start, 'start');
  const end = parseDate(flags.end, 'end');

  if (flags.playlist.length === 0) fail('Add at least one --playlist');
  const playlists = flags.playlist.map(parsePlaylistArg);
  const ids = playlists.map(p => p.id);
  if (new Set(ids).size !== ids.length) fail('The same playlist was passed twice');

  const isEnabled = !flags.disabled;
  const region = getRegion(flags);

  // 1. Validate every playlist on YouTube.
  console.log('Checking playlists on YouTube...\n');
  const results = [];
  for (const p of playlists) {
    const r = await validatePlaylist(p.id, region);
    printValidation(r, p.label);
    results.push(r);
  }
  const bad = results.filter(r => !r.ok);

  // 2. Check overlap with existing enabled events.
  const pool = createPool();
  try {
    const events = await fetchEvents(pool);
    const newDays = coveredDays(monthDay(start), monthDay(end));
    const overlaps = events.filter(e => {
      if (!e.is_enabled) return false;
      if (!e.start_date || !e.end_date) return true; // always-on event
      const days = coveredDays(monthDay(e.start_date), monthDay(e.end_date));
      for (const d of days) if (newDays.has(d)) return true;
      return false;
    });

    // 3. Summary.
    console.log('\n──────── Event to create ────────');
    console.log(`  ${icons[0]} ${label} ${icons[1]}`);
    console.log(`  dates:   ${formatRange(start, end)}  [stored as ${start} → ${end}]`);
    console.log(`  status:  ${isEnabled ? 'enabled' : 'disabled'}`);
    console.log('  playlists (in order):');
    playlists.forEach((p, i) => console.log(`    ${i}. ${p.id}${p.label ? `  (${p.label})` : ''}`));

    if (overlaps.length > 0) {
      console.log('\n⚠️  Overlaps with enabled events (only one event shows at a time — latest start_date wins):');
      for (const e of overlaps) console.log(`    #${e.id} ${e.label}: ${formatRange(e.start_date, e.end_date)}`);
    }
    if (bad.length > 0) {
      console.log(`\n⚠️  ${bad.length} playlist(s) failed validation: ${bad.map(b => b.id).join(', ')}`);
    }

    if (!flags.apply) {
      console.log('\nDRY RUN — nothing was written. Re-run with --apply to create the event.');
      return;
    }
    if (bad.length > 0) {
      fail('Refusing to write: fix or remove the playlists that failed validation.');
    }

    // 4. Write in a single real transaction (one dedicated connection).
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(`
        INSERT INTO special_events (label, icon1, icon2, is_enabled, start_date, end_date, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, NOW())
        RETURNING id
      `, [label, icons[0], icons[1], isEnabled, start, end]);
      const eventId = rows[0].id;
      for (let i = 0; i < playlists.length; i++) {
        await client.query(`
          INSERT INTO special_event_playlists (special_event_id, youtube_playlist_id, label, position)
          VALUES ($1, $2, $3, $4)
        `, [eventId, playlists[i].id, playlists[i].label, i]);
      }
      await client.query('COMMIT');
      console.log(`\n✅ Created special event #${eventId}. It may take up to 5 minutes to appear (backend cache).`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

async function cmdSetEnabled(idArg, enabled, apply) {
  const id = parseInt(idArg, 10);
  if (Number.isNaN(id)) fail('Pass a numeric event id');
  const pool = createPool();
  try {
    const { rows } = await pool.query('SELECT id, label, is_enabled FROM special_events WHERE id = $1', [id]);
    if (rows.length === 0) fail(`Special event #${id} not found`);
    const e = rows[0];
    console.log(`#${e.id} ${e.label}: ${e.is_enabled ? 'enabled' : 'disabled'} → ${enabled ? 'enabled' : 'disabled'}`);
    if (!apply) {
      console.log('DRY RUN — re-run with --apply to save.');
      return;
    }
    await pool.query('UPDATE special_events SET is_enabled = $2, updated_at = NOW() WHERE id = $1', [id, enabled]);
    console.log('✅ Saved. It may take up to 5 minutes to take effect (backend cache).');
  } finally {
    await pool.end();
  }
}

async function cmdDelete(idArg, apply) {
  const id = parseInt(idArg, 10);
  if (Number.isNaN(id)) fail('Pass a numeric event id');
  const pool = createPool();
  try {
    const events = await fetchEvents(pool);
    const e = events.find(ev => ev.id === id);
    if (!e) fail(`Special event #${id} not found`);
    console.log(`Will delete #${e.id} ${e.label} (${formatRange(e.start_date, e.end_date)}) and its ${e.playlists.length} playlist link(s).`);
    if (!apply) {
      console.log('DRY RUN — re-run with --apply to delete. This cannot be undone.');
      return;
    }
    await pool.query('DELETE FROM special_events WHERE id = $1', [id]);
    console.log('✅ Deleted.');
  } finally {
    await pool.end();
  }
}

// ============================================
// MAIN
// ============================================

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseArgs(rest);

  switch (command) {
    case 'list': return cmdList();
    case 'search': return cmdSearch(positional, flags);
    case 'validate': return cmdValidate(positional, flags);
    case 'add': return cmdAdd(flags);
    case 'enable': return cmdSetEnabled(positional[0], true, flags.apply);
    case 'disable': return cmdSetEnabled(positional[0], false, flags.apply);
    case 'delete': return cmdDelete(positional[0], flags.apply);
    default:
      console.log('Usage: node scripts/special-event.js <list|search|validate|add|enable|disable|delete> [...]');
      console.log('See the comment at the top of this file for details.');
      process.exitCode = command ? 1 : 0;
  }
}

main().catch(err => {
  const apiError = err.response && err.response.data && err.response.data.error;
  console.error('❌', apiError ? `YouTube API: ${apiError.message}` : err.message);
  process.exit(1);
});
