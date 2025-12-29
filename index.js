const express = require('express');
const axios = require('axios');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
require('dotenv').config();

// Database service (new)
const dbService = require('./db-service');
const USE_DATABASE = process.env.USE_DATABASE === 'true';

const app = express();

// Security middleware
app.use(helmet()); // Adds security headers
app.disable('x-powered-by'); // Hide Express

// CORS configuration for production
const allowedOrigins = [
  'http://localhost:4200',
  'http://localhost:4201',
  'http://localhost:61403',
  'https://nmtv.vercel.app',
  'https://nmtv.online',
  process.env.FRONTEND_URL
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps or curl)
    if (!origin) return callback(null, true);

    // Check if origin is in the whitelist
    if (allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    }
    // Allow all Vercel preview deployments (*.vercel.app)
    else if (origin.endsWith('.vercel.app')) {
      callback(null, true);
    }
    else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));

app.use(express.json()); // Parse JSON request bodies

// Rate limiting configuration
// General API rate limiter - 100 requests per minute per IP
const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 100, // Limit each IP to 100 requests per windowMs
  message: {
    error: 'Too many requests from this IP, please try again later.',
    retryAfter: '1 minute'
  },
  standardHeaders: true, // Return rate limit info in `RateLimit-*` headers
  legacyHeaders: false, // Disable `X-RateLimit-*` headers
});

// Strict rate limiter for playlist validation - 10 requests per minute per IP
const validationLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 10, // Limit each IP to 10 requests per windowMs
  message: {
    error: 'Too many playlist validations, please try again later.',
    retryAfter: '1 minute'
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Apply general rate limiter to all API routes
app.use('/api', apiLimiter);

const API_KEY = process.env.YOUTUBE_API_KEY;
const IMVDB_API_KEY = process.env.IMVDB_API_KEY;

// Cache configuration
const CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
const playlistCache = new Map(); // Map<playlistId, {videos: [], timestamp: number}>
let bumpersCache = null; // Cache for bumpers (fetched once on startup)

// Readiness state tracking
let isDataReady = false;
let dataLoadingStartTime = null;
let isNoaChannelReady = false; // Track if NOA channel playlists are loaded

const CHANNELS = {
  rock: [
    { id: "PLqKA0FE2hsOnyYVBZv2pcFyxNKPBaz2Nv", label: "Top Rock Of All Time" },
    { id: "PL300C32DA374417AA", label: "Classic Rock" },
    { id: "PL6Lt9p1lIRZ311J9ZHuzkR5A3xesae2pk", label: "Alt Revival: 2000s Reloaded" },
    { id: "PLD58ECddxRngHs9gZPQWOCAKwV1hTtYe4", label: "Flannel Frequency" },
    { id: "PL6Lt9p1lIRZ3m2X1Ur8ykG1XRGPFsTsbD", label: "Alternative rock of the 2010s" }
  ],
  hiphop: [
    { id: "PLYC_eh_Ae3Dw0iZucKzKjLv9Zys4FbdHI", label: "90's Hip Hop" },
    { id: "PLxo7H7n2_s1hwM1EdojpSGGl65fHaYAn7", label: "2000's Hip Hop" },
    { id: "PLdTuPwLzSCS5xNlwleM48YA8gJOBzrStV", label: "Golden Era Hip Hop & RnB" },
    { id: "PLn4GvABOzCQuZrM1YBvzlYVCkQpZkhXLS", label: "Top Hip-Hop and Rap Of All Time" }
  ],
  "2000s": [
    { id: "PLCh-xN1_B-eJazkwtVvYruDhfZyBCiMRn", label: "Millennium Mix" },
    { id: "PLId5xJ_xHV-nphbMh65l19EVyXZkSEVKr", label: "Y2K Anthems" },
    { id: "PLkESttpe0UDycidmhDo0PWqhGeohs6VfV", label: "Shuffle Time" },
    { id: "PL9tY0BWXOZFu4vlBOzIOmvT6wjYb2jNiV", label: "The 2000s Show" },
    { id: "PL6Lt9p1lIRZ311J9ZHuzkR5A3xesae2pk", label: "Alt Revival: 2000s Reloaded" }
  ],
  "1990s": [
    { id: "PL1Mmsa-U48mea1oIN-Eus78giJANx4D9W", label: "90's Mix" },
    { id: "PLD58ECddxRngHs9gZPQWOCAKwV1hTtYe4", label: "Flannel Frequency" },
    { id: "PLzRN-jh85ZxWAmGTRTmI54_wUPI1Ctfar", label: "90's Rock" },
    { id: "PLCQCtoOJpI_Dg1iO9xS2u24_2FtbyxCo2", label: "Classic 1990's" },
    { id: "PLkpn4UHlnIHnfh9Ye0ysC__1f29F2Bnv1", label: "90's Alternative" },
    { id: "PL_NwZs4ruMxGXczs29ssrIy1blOJq-BBw", label: "RHYTHM IS A DANCER" }
  ],
  "1980s": [
    { id: "PLd9auH4JIHvupoMgW5YfOjqtj6Lih0MKw", label: "Totally 80s!" },
    { id: "PLDHCLXs2vTkLK-Y7lCVSM5aC3wBYzAcyw", label: "Neon Rewind" },
    { id: "PLzRN-jh85ZxUe55BQvbT-7uhcYxUGlcED", label: "ROCK: 80s ARENA ANTHEMS" },
    { id: "PLmXxqSJJq-yWTswOPWtZVTrs5ZAAjFB_j", label: "Going Underground" }
  ],
  "live": [
    { id: "PLcIRQEExiw7ZD9SyyNvazIzYI8SkBM5LS", label: "" },
    { id: "PLXUBfJihF4_AhFBKu5UR2rhX_wKm5L9BO", label: "" }
  ],
  "shows": [
    { id: "PLjwvTaJGeSmQE2fDbYhkQY7zSB3k23cmh", label: "Celebrity Deathmatch - Nuggets" },
    { id: "PLBPLVvU_jvGvwo0Fev5kEyrjDm4oXkhxG", label: "Celebrity Deathmatch - Nuggets" },
    { id: "PLjwvTaJGeSmQfzhApDigzyCH0_Hu82fQf", label: "Cribs - Nuggets" },
    { id: "PL0exW-53ug6JHCQnY654-iSGBPRqkSEww", label: "Cribs - Nuggets" },
    { id: "PLA9_zFupTNzhk0O83A8dd1S9iKRcLh5dn", label: "Beavis and Butt-head - Nuggets" },
    { id: "PLjwvTaJGeSmTRxXrtO7ufnX28B3a4ojYk", label: "Punk'd - Nuggets" },
    { id: "PL0exW-53ug6LfnmcO4MOPg07kZqjDmkZv", label: "Pimp My Ride - Nuggets" },
    { id: "PLXUBfJihF4_BtodhxajQzb5Irkev4Yl3v", label: "Interviews" },
    { id: "PLjwvTaJGeSmTR9x_r_wXZCrwRXiNjDmnA", label: "Jackass - Nuggets" },
    { id: "PLjwvTaJGeSmTRxXrtO7ufnX28B3a4ojYk", label: "Punk'd - Full Episodes" },
    { id: "PLXUBfJihF4_Bj6INx79to31FAo-Dm7R8m", label: "Punk'd - Full Episodes" },
  ],
  "noa": [
    { id: "PLcIRQEExiw7aK3zIogUqYDQLi82XJvAiY", label: "30 Years of Noa" },
    { id: "PLcIRQEExiw7YQ3A0rJpFfinqpa_3eGBBm", label: "BerliNoa"},
    { id: "PLcIRQEExiw7YAWUtoixTBV5wAcLQzO8aa", label: "Noa Is Budapesting" },
    { id: "PLcIRQEExiw7aDBTUm4yY6qxkOFccpdzgr", label: "Noa's Winter" },
    { id: "PLcIRQEExiw7ZuW3rOAqqkKZfnZovAdauM", label: "NOA-LON-DON" },
    { id: "PLcIRQEExiw7aQ2RBhOhL3tDOvDKtNSGO_", label: "Chip-Chop Noa"}
  ]
};

// Bumper playlists - short videos to play between songs
const BUMPER_PLAYLISTS = [
  { id: "PLnG7oFaM6TYqDLvZ_PBY79Pn68BFbv17w", label: "MTV Bumpers 1" },
  { id: "PLLHK2qXpOJlq07tC0I0aMZ8LbdsSj3jAF", label: "MTV Bumpers 2" },
  { id: "PLMl84_AytMHWf2ZHFbtpskMANEwKoPvZ5", label: "MTV Bumpers 3" }
];

const MAX_BUMPER_DURATION = 90; // 1:30 in seconds

function cleanTitle(title) {
  // Remove any brackets (parentheses, square, curly) containing "Official Music Video" or "Official Video"
  let cleaned = title
    .replace(/[\(\[\{][^\)\]\}]*Official\s+Music\s+Video[^\)\]\}]*[\)\]\}]/gi, '')
    .replace(/[\(\[\{][^\)\]\}]*Official\s+Video[^\)\]\}]*[\)\]\}]/gi, '')
    .replace(/\[HD\]/gi, '');

  return cleaned.trim();
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

async function fetchPlaylistItems(playlistId, maxVideos = null, channel = null) {
  if (!API_KEY) {
    throw new Error('YOUTUBE_API_KEY not set');
  }

  let allVideos = [];
  let nextPageToken = null;
  let pageCount = 0;

  // Fetch pages until no more nextPageToken or reached maxVideos limit
  do {
    const url = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=50&playlistId=${playlistId}&key=${API_KEY}${nextPageToken ? `&pageToken=${nextPageToken}` : ''}`;

    try {
      const res = await axios.get(url);
      
      // Check if playlist is private or has no items
      if (!res.data.items) {
        console.warn(`  └─ Playlist ${playlistId} returned no items (may be private or deleted)`);
        break;
      }
      
      const items = res.data.items || [];

      // Process videos from this page
      const videos = items
        .filter(item => {
          const title = item.snippet.title;
          return title !== 'Deleted video' && title !== 'Private video';
        })
        .map(item => {
          const cleanedTitle = cleanTitle(item.snippet.title);
          const parsed = parseTitle(cleanedTitle, channel);

          return {
            id: item.snippet.resourceId.videoId,
            playlistId: playlistId,
            ...parsed
          };
        });

      allVideos = allVideos.concat(videos);
      pageCount++;

      // Check if we've reached the maxVideos limit
      if (maxVideos && allVideos.length >= maxVideos) {
        console.log(`  └─ Reached limit of ${maxVideos} videos from ${pageCount} page(s)`);
        return allVideos.slice(0, maxVideos); // Return only up to maxVideos
      }

      // Get next page token (will be undefined/null when no more pages)
      nextPageToken = res.data.nextPageToken;

      // Small delay to avoid rate limiting
      if (nextPageToken) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }

    } catch (error) {
      // Handle 404 or 403 errors for private/deleted playlists
      if (error.response && (error.response.status === 404 || error.response.status === 403)) {
        console.warn(`  └─ Playlist ${playlistId} is private, deleted, or inaccessible (${error.response.status})`);
      } else {
        console.error(`  └─ Error fetching page ${pageCount + 1} of playlist ${playlistId}:`, error.message);
      }
      break; // Stop on error
    }
  } while (nextPageToken); // Continue while there's a next page

  console.log(`  └─ Fetched ${allVideos.length} videos from ${pageCount} page(s)`);
  return allVideos;
}

function parseTitle(title, channel = null) {
  // For Live channel or bumpers, never split the title
  if (channel === 'live' || channel === 'bumper') {
    return {
      title: title.trim()
    };
  }

  // Check if title contains " - " separator
  const separatorIndex = title.indexOf(' - ');

  if (separatorIndex > 0) {
    // Has artist and song
    return {
      artist: title.substring(0, separatorIndex).trim(),
      song: title.substring(separatorIndex + 3).trim()
    };
  } else {
    // No separator, return as single title
    return {
      title: title.trim()
    };
  }
}

// Convert ISO 8601 duration (PT1M30S) to seconds
function parseDuration(isoDuration) {
  const match = isoDuration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;

  const hours = parseInt(match[1] || 0);
  const minutes = parseInt(match[2] || 0);
  const seconds = parseInt(match[3] || 0);

  return hours * 3600 + minutes * 60 + seconds;
}

// Fetch video details including duration
async function getVideoDurations(videoIds) {
  if (!API_KEY) {
    throw new Error('YOUTUBE_API_KEY not set');
  }

  const results = [];

  // YouTube API allows up to 50 video IDs per request
  for (let i = 0; i < videoIds.length; i += 50) {
    const batch = videoIds.slice(i, i + 50);
    const url = `https://www.googleapis.com/youtube/v3/videos?part=contentDetails&id=${batch.join(',')}&key=${API_KEY}`;

    try {
      const res = await axios.get(url);
      const items = res.data.items || [];

      items.forEach(item => {
        const duration = parseDuration(item.contentDetails.duration);
        results.push({
          id: item.id,
          duration
        });
      });
    } catch (error) {
      console.error('Error fetching video durations:', error.message);
    }
  }

  return results;
}

// Fetch and filter bumpers by duration
async function fetchBumpers() {
  console.log('🎬 Fetching bumpers from playlists...');

  const allBumperPromises = BUMPER_PLAYLISTS.map(p =>
    fetchPlaylistItems(p.id, null, 'bumper').catch(error => {
      console.error(`Error fetching bumper playlist ${p.id}:`, error.message);
      return [];
    })
  );

  const bumperResults = await Promise.all(allBumperPromises);
  let allBumpers = bumperResults.flat();

  // Get durations for all bumpers
  const videoIds = allBumpers.map(b => b.id);
  const durationsData = await getVideoDurations(videoIds);

  // Create a map of id -> duration
  const durationMap = new Map();
  durationsData.forEach(({ id, duration }) => {
    durationMap.set(id, duration);
  });

  // Filter bumpers by duration (≤ 90 seconds)
  const filteredBumpers = allBumpers
    .filter(bumper => {
      const duration = durationMap.get(bumper.id);
      return duration && duration <= MAX_BUMPER_DURATION;
    })
    .map(bumper => ({
      ...bumper,
      isBumper: true
    }));

  console.log(`  ✓ Found ${filteredBumpers.length} bumpers (≤ ${MAX_BUMPER_DURATION}s) out of ${allBumpers.length} total`);

  return filteredBumpers;
}

async function getPlaylistVideos(playlistId, maxVideos = null, timeout = null, channel = null) {
  const now = Date.now();
  const cached = playlistCache.get(playlistId);

  // Return cached version if it exists and is still valid
  if (cached && (now - cached.timestamp) < CACHE_DURATION) {
    return cached.videos;
  }

  // Fetch with timeout
  const limitMsg = maxVideos ? ` (limit: ${maxVideos} videos)` : '';
  console.log(`Fetching videos from playlist: ${playlistId}${limitMsg}...`);

  // Use different timeouts based on whether it's limited or full fetch
  // Custom playlists (limited to 100): 15 seconds
  // Official playlists (unlimited): 60 seconds
  const actualTimeout = timeout || (maxVideos ? 15000 : 60000);

  // Create timeout promise
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`Playlist fetch timeout after ${actualTimeout}ms`)), actualTimeout);
  });

  try {
    // Race between fetch and timeout
    const videos = await Promise.race([
      fetchPlaylistItems(playlistId, maxVideos, channel),
      timeoutPromise
    ]);

    // Cache even if empty (to avoid repeated failed fetches)
    playlistCache.set(playlistId, { videos, timestamp: now });
    return videos;
  } catch (error) {
    console.error(`Error fetching playlist ${playlistId}:`, error.message);
    // Cache empty result to avoid repeated attempts
    playlistCache.set(playlistId, { videos: [], timestamp: now });
    return []; // Return empty array instead of throwing
  }
}

async function getAllChannelVideos(channel, customPlaylistIds = [], skipCustom = false, includeBumpers = true) {
  const officialPlaylists = CHANNELS[channel];
  if (!officialPlaylists) {
    throw new Error('Channel not found: ' + channel);
  }

  // Fetch official playlists in parallel (always from cache, instant)
  const officialPromises = officialPlaylists.map(pid => getPlaylistVideos(pid, null, null, channel));
  const officialResults = await Promise.all(officialPromises);
  let officialVideos = dedupe(officialResults.flat());
  shuffle(officialVideos);
  let videos;

  // If skipCustom flag is set or no custom playlists, use only official videos
  if (skipCustom || customPlaylistIds.length === 0) {
    videos = officialVideos;
  } else {
    // Fetch custom playlists in parallel (limit to 100 videos each)
    const customPromises = customPlaylistIds
      .filter(isValidPlaylistId)
      .map(pid =>
        getPlaylistVideos(pid, 100, null, channel).catch(error => { // Limit custom playlists to 100 videos
          console.error(`Error fetching custom playlist ${pid}:`, error.message);
          return []; // Return empty array on error, don't fail entire request
        })
      );

    const customResults = await Promise.all(customPromises);

    // Weight-based mixing: Give each custom playlist equal representation
    videos = mixVideos(customResults, officialVideos);
  }

  // Insert bumpers (if available and requested)
  if (includeBumpers && bumpersCache && bumpersCache.length > 0) {
    videos = insertBumpers(videos, bumpersCache);
  }

  return videos;
}

function isValidPlaylistId(playlistId) {
  // YouTube playlist IDs are alphanumeric with dashes/underscores, 13+ chars
  return /^[a-zA-Z0-9_-]{13,}$/.test(playlistId);
}

// Insert bumpers into video list at intervals of 4 songs
function insertBumpers(videos, bumpers) {
  if (!bumpers || bumpers.length === 0) {
    return videos;
  }

  const result = [];
  let bumperIndex = 0;
  let songCount = 0;

  // Shuffle bumpers to ensure variety
  const shuffledBumpers = [...bumpers].sort(() => Math.random() - 0.5);

  for (let i = 0; i < videos.length; i++) {
    const video = videos[i];

    // Skip if this video is already a bumper (shouldn't happen, but safety check)
    if (video.isBumper) {
      result.push(video);
      continue;
    }

    result.push(video);
    songCount++;

    // Insert bumper after every 4 songs
    if (songCount === 4) {
      result.push(shuffledBumpers[bumperIndex % shuffledBumpers.length]);
      bumperIndex++;
      songCount = 0; // Reset counter
    }
  }

  return result;
}

function mixVideos(customPlaylistResults, officialVideos) {
  // If no custom playlists, return official only
  if (!customPlaylistResults || customPlaylistResults.length === 0) {
    return officialVideos;
  }

  // If no official videos, return custom only
  if (officialVideos.length === 0) {
    const allCustom = dedupe(customPlaylistResults.flat());
    shuffle(allCustom);
    return allCustom;
  }

  // Step 1: Separate and shuffle each custom playlist
  const customPlaylists = customPlaylistResults
    .filter(arr => arr.length > 0)
    .map(playlist => {
      shuffle(playlist);
      return playlist;
    });

  const numCustomPlaylists = customPlaylists.length;

  if (numCustomPlaylists === 0) {
    return officialVideos;
  }

  console.log(`Mixing ${numCustomPlaylists} custom playlist(s) with official videos`);

  // Step 2: Round-robin through custom playlists to build custom pool
  // This ensures even distribution across all custom playlists
  let weightedCustom = [];
  let playlistIndices = new Array(numCustomPlaylists).fill(0);
  let hasMore = true;

  while (hasMore && weightedCustom.length < 100) {
    hasMore = false;

    for (let i = 0; i < numCustomPlaylists; i++) {
      const playlist = customPlaylists[i];
      const index = playlistIndices[i];

      if (index < playlist.length) {
        weightedCustom.push(playlist[index]);
        playlistIndices[i]++;
        hasMore = true;
      }
    }
  }

  console.log(`Custom pool built: ${weightedCustom.length} videos distributed across ${numCustomPlaylists} playlist(s)`);

  // Step 3: Dedupe between custom and official
  const customIds = new Set(weightedCustom.map(v => v.id));
  const officialIds = new Set(officialVideos.map(v => v.id));

  let uniqueCustom = weightedCustom.filter(v => !officialIds.has(v.id));
  let uniqueOfficial = officialVideos.filter(v => !customIds.has(v.id));

  // Step 5: Calculate true 50/50 split
  const maxPerSource = Math.min(uniqueCustom.length, uniqueOfficial.length);
  uniqueCustom = uniqueCustom.slice(0, maxPerSource);
  uniqueOfficial = uniqueOfficial.slice(0, maxPerSource);

  console.log(`True 50/50 mix: ${uniqueCustom.length} custom + ${uniqueOfficial.length} official = ${uniqueCustom.length + uniqueOfficial.length} total videos`);

  // Step 6: Interleave custom and official videos alternately
  // Pattern: custom, official, custom, official, custom, official...
  const mixed = [];
  const maxLength = Math.max(uniqueCustom.length, uniqueOfficial.length);

  for (let i = 0; i < maxLength; i++) {
    if (i < uniqueCustom.length) {
      mixed.push(uniqueCustom[i]);
    }
    if (i < uniqueOfficial.length) {
      mixed.push(uniqueOfficial[i]);
    }
  }

  return mixed;
}

function dedupe(videos) {
  const seenIds = new Set();
  return videos.filter(v => {
    if (seenIds.has(v.id)) return false;
    seenIds.add(v.id);
    return true;
  });
}

// NEW PROGRAMMING BLOCK FUNCTIONS

// Get playlist name from YouTube API
async function getPlaylistName(playlistId) {
  if (!API_KEY) {
    return null;
  }

  try {
    const url = `https://www.googleapis.com/youtube/v3/playlists?part=snippet&id=${playlistId}&key=${API_KEY}`;
    const response = await axios.get(url);

    if (response.data.items && response.data.items.length > 0) {
      return response.data.items[0].snippet.title;
    }
    return null;
  } catch (error) {
    console.error(`Error fetching playlist name for ${playlistId}:`, error.message);
    return null;
  }
}

// Create a programming block from a single playlist
async function createProgrammingBlock(playlistObj, channel, excludeVideoIds = []) {
  const playlistId = playlistObj.id;
  const playlistLabel = playlistObj.label;

  // Creating programming block from playlist

  // Fetch all videos from the playlist (from cache)
  let allVideos = await getPlaylistVideos(playlistId, null, null, channel);

  // Filter out excluded videos (for 100-song deduplication)
  const excludeSet = new Set(excludeVideoIds);
  let availableVideos = allVideos.filter(v => !excludeSet.has(v.id));

  // If we don't have enough videos after filtering, use all videos
  if (availableVideos.length === 0) {
    // No available videos after filtering, using all videos
    availableVideos = allVideos;
  }

  // Shuffle the available videos
  shuffle(availableVideos);

  // Determine block size based on channel type
  let blockSize, bumperInterval;
  if (channel === 'shows') {
    blockSize = 3;
    bumperInterval = 'shows'; // Special pattern: [v1, BUMPER, v2, v3, BUMPER]
  } else if (channel === 'live') {
    // Live channel uses random mixing, not blocks
    blockSize = 12;
    bumperInterval = 4; // Position-based pattern
  } else {
    // Music channels: rock, hiphop, 2000s, 1990s, 1980s
    blockSize = 12;
    bumperInterval = 4; // Position-based pattern
  }

  // Take the required number of videos
  let blockVideos = availableVideos.slice(0, blockSize);

  // If playlist is smaller than block size, repeat videos to fill the block
  if (blockVideos.length < blockSize) {
    // Playlist smaller than block size, repeating videos
    while (blockVideos.length < blockSize) {
      const needed = blockSize - blockVideos.length;
      blockVideos = blockVideos.concat(availableVideos.slice(0, needed));
    }
  }

  // Insert bumpers
  const items = insertBumpersIntoBlock(blockVideos, bumperInterval);

  // Block created successfully

  return {
    playlistLabel,
    playlistId,
    items
  };
}

// Insert bumpers into a block of videos
function insertBumpersIntoBlock(videos, interval) {
  if (!bumpersCache || bumpersCache.length === 0 || !interval) {
    return videos;
  }

  const result = [];
  const shuffledBumpers = [...bumpersCache].sort(() => Math.random() - 0.5);
  let bumperIndex = 0;

  // Special pattern for shows channel: [v1, BUMPER, v2, v3, BUMPER]
  if (interval === 'shows') {
    result.push(videos[0]); // First video
    result.push(shuffledBumpers[bumperIndex % shuffledBumpers.length]);
    bumperIndex++;
    
    result.push(videos[1]); // Second video
    result.push(videos[2]); // Third video
    result.push(shuffledBumpers[bumperIndex % shuffledBumpers.length]);
    
    return result;
  }

  // Pattern for music/live channels: [v1, v2, BUMPER, v3-v6, BUMPER, v7-v10, BUMPER, v11-v12, BUMPER]
  for (let i = 0; i < videos.length; i++) {
    result.push(videos[i]);

    // Insert bumper after positions 2, 6, 10, 12 (indices 1, 5, 9, 11)
    if (i === 1 || i === 5 || i === 9 || i === 11) {
      result.push(shuffledBumpers[bumperIndex % shuffledBumpers.length]);
      bumperIndex++;
    }
  }

  return result;
}

// Get a random playlist for a channel (excluding certain playlists)
function selectRandomPlaylist(channel, customPlaylistIds = [], excludePlaylistIds = [], preferCustom = false) {
  const officialPlaylists = CHANNELS[channel] || [];

  // Build custom playlist objects with labels (will fetch from YouTube API)
  const customPlaylists = customPlaylistIds
    .filter(isValidPlaylistId)
    .map(id => ({ id, label: null, isCustom: true })); // label will be fetched later

  // Combine official and custom playlists
  const allPlaylists = [...officialPlaylists, ...customPlaylists];

  if (allPlaylists.length === 0) {
    throw new Error(`No playlists available for channel: ${channel}`);
  }

  // Filter out excluded playlists
  const excludeSet = new Set(excludePlaylistIds);
  const availablePlaylists = allPlaylists.filter(p => !excludeSet.has(p.id));

  // If all playlists are excluded, reset and use all playlists
  if (availablePlaylists.length === 0) {
    // All playlists excluded, resetting
    return allPlaylists[Math.floor(Math.random() * allPlaylists.length)];
  }

  // Zig-zag pattern: prefer custom or official based on preferCustom flag
  let selectedPlaylist;

  if (customPlaylists.length > 0 && preferCustom) {
    // Try to select from custom playlists first
    const availableCustom = availablePlaylists.filter(p => p.isCustom);
    if (availableCustom.length > 0) {
      selectedPlaylist = availableCustom[Math.floor(Math.random() * availableCustom.length)];
      // Selected custom playlist
    } else {
      // No custom available, fall back to official
      const availableOfficial = availablePlaylists.filter(p => !p.isCustom);
      selectedPlaylist = availableOfficial[Math.floor(Math.random() * availableOfficial.length)];
      // No custom available, using official
    }
  } else if (customPlaylists.length > 0 && !preferCustom) {
    // Try to select from official playlists first
    const availableOfficial = availablePlaylists.filter(p => !p.isCustom);
    if (availableOfficial.length > 0) {
      selectedPlaylist = availableOfficial[Math.floor(Math.random() * availableOfficial.length)];
      // Selected official playlist
    } else {
      // No official available, fall back to custom
      const availableCustom = availablePlaylists.filter(p => p.isCustom);
      selectedPlaylist = availableCustom[Math.floor(Math.random() * availableCustom.length)];
      // No official available, using custom
    }
  } else {
    // No custom playlists, just select randomly from available
    selectedPlaylist = availablePlaylists[Math.floor(Math.random() * availablePlaylists.length)];
    // Selected playlist randomly
  }
  return selectedPlaylist;
}

// Get programming block for channel (for LIVE channel, use random mixing)
async function getChannelBlock(channel, customPlaylistIds = [], excludePlaylistIds = [], excludeVideoIds = [], preferCustom = false) {
  // Getting programming block for channel

  // Special handling for LIVE channel - use random mixing from all playlists
  if (channel === 'live') {
    return await getLiveChannelBlock(customPlaylistIds, excludeVideoIds);
  }

  // For other channels, select a random playlist and create a block
  const selectedPlaylist = selectRandomPlaylist(channel, customPlaylistIds, excludePlaylistIds, preferCustom);

  // If it's a custom playlist, fetch the YouTube playlist name
  if (selectedPlaylist.isCustom) {
    const playlistName = await getPlaylistName(selectedPlaylist.id);
    selectedPlaylist.label = playlistName || `Custom Playlist (${selectedPlaylist.id})`;
  }

  // Create programming block from the selected playlist
  return await createProgrammingBlock(selectedPlaylist, channel, excludeVideoIds);
}

// Special handler for LIVE channel - random mixing from all playlists
async function getLiveChannelBlock(customPlaylistIds = [], excludeVideoIds = []) {
  // Getting LIVE channel block (random mixing)

  const officialPlaylists = CHANNELS['live'] || [];

  // Fetch all videos from all playlists
  const allPromises = officialPlaylists.map(p =>
    getPlaylistVideos(p.id, null, null, 'live').catch(error => {
      console.error(`Error fetching playlist ${p.id}:`, error.message);
      return [];
    })
  );

  // Add custom playlists if any
  if (customPlaylistIds.length > 0) {
    const customPromises = customPlaylistIds
      .filter(isValidPlaylistId)
      .map(pid =>
        getPlaylistVideos(pid, 100, null, 'live').catch(error => {
          console.error(`Error fetching custom playlist ${pid}:`, error.message);
          return [];
        })
      );
    allPromises.push(...customPromises);
  }

  const results = await Promise.all(allPromises);
  let allVideos = dedupe(results.flat());

  // Filter out excluded videos
  const excludeSet = new Set(excludeVideoIds);
  let availableVideos = allVideos.filter(v => !excludeSet.has(v.id));

  if (availableVideos.length === 0) {
    availableVideos = allVideos;
  }

  // Shuffle and take 12 videos
  shuffle(availableVideos);
  const blockVideos = availableVideos.slice(0, 12);

  // Insert bumpers
  const items = insertBumpersIntoBlock(blockVideos, 4);

  return {
    playlistLabel: 'Live Performances', // Fixed label for live channel
    playlistId: 'live-mix',
    items
  };
}

// ============================================
// DATABASE INTEGRATION WITH FALLBACK
// ============================================

/**
 * Wrapper function to get channel block from DB or YouTube API
 * @param {string} channel - Channel ID
 * @param {string[]} customPlaylistIds - Custom playlist IDs (YouTube API only for now)
 * @param {string[]} excludePlaylistIds - Exclude these playlists
 * @param {string[]} excludeVideoIds - Exclude these videos
 * @param {boolean} preferCustom - Prefer custom playlists
 * @returns {Promise<VideoBlock>}
 */
async function getChannelBlockWithFallback(channel, customPlaylistIds = [], excludePlaylistIds = [], excludeVideoIds = [], preferCustom = false) {
  if (USE_DATABASE) {
    try {
      console.log(`[DB] Fetching block for channel: ${channel}`);
      
      // For now, ignore custom playlists in DB mode (can add later)
      // Use DB to get programming block
      const block = await dbService.getVideosForChannelBlock(
        channel,
        excludeVideoIds,
        excludePlaylistIds
      );
      
      // Insert bumpers - fetch enough for variety (need ~4 per block)
      const bumpers = await dbService.getRandomBumpers(10);
      const bumperInterval = channel === 'shows' ? 'shows' : 4;
      const items = insertBumpersIntoBlockFromDB(block.items, bumpers, bumperInterval);
      
      return {
        ...block,
        items
      };
    } catch (dbError) {
      console.error('[DB] Error, falling back to YouTube API:', dbError.message);
      // Fall through to YouTube API
    }
  }
  
  // Use existing YouTube API implementation
  return await getChannelBlock(channel, customPlaylistIds, excludePlaylistIds, excludeVideoIds, preferCustom);
}

/**
 * Helper to insert bumpers from DB into video list
 */
function insertBumpersIntoBlockFromDB(videos, bumpers, interval = 4) {
  if (!bumpers || bumpers.length === 0) {
    return videos;
  }
  
  const result = [];
  let lastBumperIndex = -1;
  
  // Helper to get a random bumper (avoiding consecutive duplicates)
  const getRandomBumper = () => {
    if (bumpers.length === 1) return bumpers[0];
    
    let bumperIndex;
    do {
      bumperIndex = Math.floor(Math.random() * bumpers.length);
    } while (bumperIndex === lastBumperIndex);
    
    lastBumperIndex = bumperIndex;
    return bumpers[bumperIndex];
  };
  
  // Special pattern for shows channel: [v1, BUMPER, v2, v3, BUMPER]
  if (interval === 'shows') {
    result.push(videos[0]); // First video
    result.push(getRandomBumper());
    
    result.push(videos[1]); // Second video
    result.push(videos[2]); // Third video
    result.push(getRandomBumper());
    
    return result;
  }
  
  // Pattern for music/live channels: [v1, v2, BUMPER, v3-v6, BUMPER, v7-v10, BUMPER, v11-v12, BUMPER]
  videos.forEach((video, index) => {
    result.push(video);
    
    // Insert bumper after positions 2, 6, 10, 12 (indices 1, 5, 9, 11)
    if (index === 1 || index === 5 || index === 9 || index === 11) {
      result.push(getRandomBumper());
    }
  });
  
  return result;
}

app.get('/api/channel/:id', async (req, res) => {
  const channel = req.params.id;
  const customParam = req.query.custom || '';
  const customPlaylistIds = customParam.split(',').filter(Boolean);

  // Fetching programming block for channel

  try {
    // Get a programming block (DB or YouTube API with fallback)
    const block = await getChannelBlockWithFallback(channel, customPlaylistIds, [], []);

    // Cache for 5 minutes on CDN (reduces backend load)
    res.set('Cache-Control', 'public, max-age=300, s-maxage=300');
    res.json(block);
  } catch (e) {
    console.error('Error:', e.message);
    res.status(404).json({ error: e.message });
  }
});

app.post('/api/channel/:id/next', async (req, res) => {
  const channel = req.params.id;
  const { excludeIds, customPlaylistIds, excludePlaylistIds, preferCustom } = req.body;

  // Validate request body
  const excludeVideoArray = Array.isArray(excludeIds) ? excludeIds : [];
  const customArray = Array.isArray(customPlaylistIds) ? customPlaylistIds : [];
  const excludePlaylistArray = Array.isArray(excludePlaylistIds) ? excludePlaylistIds : [];
  const preferCustomFlag = preferCustom === true;

  // Fetching next block

  try {
    // Get next programming block (DB or YouTube API with fallback)
    const block = await getChannelBlockWithFallback(channel, customArray, excludePlaylistArray, excludeVideoArray, preferCustomFlag);

    res.json(block);
  } catch (e) {
    console.error('Error:', e.message);
    res.status(404).json({ error: e.message });
  }
});

app.get('/health', (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.json({ status: 'OK', message: 'NMTV backend is running' });
});

// Flag a video (mark as is_flagged = true)
app.post('/api/videos/:videoId/flag', async (req, res) => {
  try {
    const { videoId } = req.params;
    
    if (!videoId) {
      return res.status(400).json({ error: 'Video ID is required' });
    }

    if (!USE_DATABASE) {
      // In non-database mode, just return success (no-op)
      return res.json({ 
        success: true, 
        message: 'Video flagged (memory only - not persisted)',
        videoId 
      });
    }

    await dbService.flagVideo(videoId);
    
    res.json({ 
      success: true, 
      message: 'Video flagged successfully',
      videoId 
    });
  } catch (error) {
    console.error('Error flagging video:', error);
    res.status(500).json({ error: 'Failed to flag video' });
  }
});

// Mark a video as unavailable (set is_available = false)
app.post('/api/videos/:videoId/unavailable', async (req, res) => {
  try {
    if (!USE_DATABASE) {
      // In non-database mode, just return success (no-op)
      return res.json({ 
        success: true, 
        message: 'Video marked as unavailable (memory only)',
        videoId: req.params.videoId 
      });
    }

    const { videoId } = req.params;
    
    if (!videoId) {
      return res.status(400).json({ error: 'Video ID is required' });
    }

    await dbService.markVideoUnavailable(videoId);
    
    res.json({ 
      success: true, 
      message: 'Video marked as unavailable',
      videoId 
    });
  } catch (error) {
    console.error('Error marking video unavailable:', error);
    res.status(500).json({ error: 'Failed to mark video unavailable' });
  }
});

// Readiness endpoint - checks if playlist data is loaded
app.get('/api/ready', async (req, res) => {
  // Database mode: always ready (data already in DB)
  if (USE_DATABASE) {
    try {
      await dbService.healthCheck();
      return res.json({
        ready: true,
        mode: 'database',
        cacheSize: 0,
        totalPlaylists: 0,
        bumpersLoaded: true,
        bumpersCount: 0,
        loadingTime: 0,
        noaChannelReady: true
      });
    } catch (error) {
      return res.json({
        ready: false,
        mode: 'database',
        error: 'Database connection failed'
      });
    }
  }

  // YouTube API mode: check if playlists are cached
  const cacheSize = playlistCache.size;
  const bumpersLoaded = bumpersCache !== null && bumpersCache.length > 0;
  const ready = isDataReady && cacheSize > 0 && bumpersLoaded;

  // Calculate total unique playlists (excluding NOA which loads on demand)
  const allPlaylistIds = new Set();
  for (const [channel, playlists] of Object.entries(CHANNELS)) {
    if (channel === 'noa') continue; // Skip NOA
    playlists.forEach(p => allPlaylistIds.add(p.id));
  }
  const totalPlaylists = allPlaylistIds.size;

  res.json({
    ready,
    mode: 'youtube_api',
    cacheSize,
    totalPlaylists,
    bumpersLoaded,
    bumpersCount: bumpersCache?.length || 0,
    loadingTime: dataLoadingStartTime ? Date.now() - dataLoadingStartTime : 0,
    noaChannelReady: isNoaChannelReady
  });
});

// Load NOA channel endpoint - loads NOA channel playlists on demand
app.post('/api/channel/noa/load', async (req, res) => {
  // If already loaded, return immediately
  if (isNoaChannelReady) {
    return res.json({ success: true, message: 'NOA channel already loaded' });
  }
  
  try {
    const noaPlaylists = CHANNELS['noa'];
    if (!noaPlaylists) {
      return res.status(404).json({ error: 'NOA channel not configured' });
    }

    // Fetch all NOA playlists in parallel
    const fetchPromises = noaPlaylists.map(p => 
      fetchPlaylistItems(p.id, null, 'noa')
        .then(videos => {
          playlistCache.set(p.id, {
            videos: videos,
            timestamp: Date.now()
          });
          console.log(`  ✓ Cached ${videos.length} videos from playlist: ${p.label}`);
          return videos.length;
        })
        .catch(error => {
          console.error(`  ✗ Error fetching playlist ${p.label}:`, error.message);
          return 0;
        })
    );

    const results = await Promise.all(fetchPromises);
    const totalVideos = results.reduce((sum, count) => sum + count, 0);

    isNoaChannelReady = true;

    res.json({ 
      success: true, 
      message: 'NOA channel loaded successfully',
      totalVideos: totalVideos
    });
  } catch (error) {
    console.error('Error loading NOA channel:', error);
    res.status(500).json({ error: 'Failed to load NOA channel' });
  }
});

// Apply strict rate limiting to validation endpoint (costs YouTube API quota)
app.get('/api/validate-playlist/:playlistId', validationLimiter, async (req, res) => {
  const playlistId = req.params.playlistId;

  if (!API_KEY) {
    return res.status(500).json({ error: 'YouTube API key not configured' });
  }

  if (!isValidPlaylistId(playlistId)) {
    return res.status(400).json({ error: 'Invalid playlist ID format' });
  }

  try {
    // Fetch playlist metadata to get video count and title
    const url = `https://www.googleapis.com/youtube/v3/playlists?part=contentDetails,snippet&id=${playlistId}&key=${API_KEY}`;
    const response = await axios.get(url);

    if (!response.data.items || response.data.items.length === 0) {
      return res.status(404).json({ error: 'Playlist not found or is private' });
    }

    const playlist = response.data.items[0];
    const videoCount = playlist.contentDetails.itemCount;
    const playlistName = playlist.snippet.title;

    res.json({ videoCount, playlistName });
  } catch (error) {
    console.error('Error validating playlist:', error.message);
    res.status(500).json({ error: 'Failed to validate playlist' });
  }
});

// Pre-fetch all playlists on startup
async function preFetchAllPlaylists() {
  console.log('🚀 Fetching ALL videos from all playlists...');
  dataLoadingStartTime = Date.now();
  isDataReady = false;

  const allPlaylistsByChannel = [];
  const fetchedPlaylistIds = new Set();

  // Collect all unique playlist IDs with their channel (excluding NOA - loaded on demand)
  for (const [channel, playlists] of Object.entries(CHANNELS)) {
    // Skip NOA channel - it will be loaded on demand when user unlocks it
    if (channel === 'noa') {
      continue;
    }
    
    playlists.forEach(p => {
      // Only add if we haven't seen this playlist ID before
      if (!fetchedPlaylistIds.has(p.id)) {
        allPlaylistsByChannel.push({ pid: p.id, channel });
        fetchedPlaylistIds.add(p.id);
      }
    });
  }

  console.log(`📋 Found ${allPlaylistsByChannel.length} unique playlists across all channels (deduplicated)`);

  let successCount = 0;
  let totalVideos = 0;

  // Parallel fetching with concurrency limit
  const CONCURRENCY_LIMIT = 8; // Fetch 8 playlists at a time

  // Helper function to process a single playlist
  const fetchPlaylist = async ({ pid, channel }) => {
    try {
      const videos = await getPlaylistVideos(pid, null, null, channel);
      
      // Check if playlist returned videos
      if (!videos || videos.length === 0) {
        console.warn(`  ⚠ Playlist ${pid} (${channel}) is empty or private - skipping`);
        return { success: false, error: 'Empty or private playlist' };
      }
      
      successCount++;
      totalVideos += videos.length;
      console.log(`  ✓ [${successCount}/${allPlaylistsByChannel.length}] Cached ${videos.length} videos from ${pid} (${channel})`);
      return { success: true, videos: videos.length };
    } catch (e) {
      console.error(`  ✗ Failed to fetch playlist ${pid} (${channel}):`, e.message);
      return { success: false, error: e.message };
    }
  };

  // Process playlists in batches with concurrency limit
  for (let i = 0; i < allPlaylistsByChannel.length; i += CONCURRENCY_LIMIT) {
    const batch = allPlaylistsByChannel.slice(i, i + CONCURRENCY_LIMIT);
    await Promise.all(batch.map(fetchPlaylist));
  }

  console.log(`\n✅ Cache complete: ${successCount}/${allPlaylistsByChannel.length} playlists, ${totalVideos} total videos`);

  // Fetch and cache bumpers
  try {
    bumpersCache = await fetchBumpers();
  } catch (e) {
    bumpersCache = []; // Set to empty array so app doesn't crash
  }

  // Mark data as ready
  isDataReady = true;
  const loadTime = ((Date.now() - dataLoadingStartTime) / 1000).toFixed(2);
}

// IMVDb API endpoint to get video release year
app.get('/api/video/year', async (req, res) => {
  const { title } = req.query;

  if (!title) {
    return res.status(400).json({ error: 'Title parameter is required' });
  }

  if (!IMVDB_API_KEY) {
    console.error('IMVDB_API_KEY not set');
    return res.json({ year: null });
  }

  try {
    const encodedTitle = encodeURIComponent(title);
    const url = `http://imvdb.com/api/v1/search/videos?q=${encodedTitle}&limit=1`;

    console.log(`🎬 Fetching year for: "${url}"`);

    const response = await axios.get(url, {
      headers: {
        'IMVDB-APP-KEY': IMVDB_API_KEY
      },
      timeout: 5000 // 5 second timeout
    });

    if (response.data && response.data.results && response.data.results.length > 0) {
      const video = response.data.results[0];
      const year = video.year;

      if (year) {
        console.log(`  ✓ Found year: ${year}`);
        return res.json({ year });
      }
    }

    console.log(`  ✗ No year found for "${title}"`);
    return res.json({ year: null });

  } catch (error) {
    console.error('Error fetching from IMVDb:', error.message);
    // Return null instead of error to gracefully handle failures
    return res.json({ year: null });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, async () => {
  console.log('NMTV backend running on port ' + PORT);
  console.log(`Mode: ${USE_DATABASE ? 'DATABASE' : 'YOUTUBE_API'}`);
  
  if (!API_KEY) {
    console.warn('WARNING: YOUTUBE_API_KEY not set');
  }

  // Initialize database connection pool if using database
  if (USE_DATABASE) {
    try {
      await dbService.initializePool();
      await dbService.healthCheck();
      console.log('✓ Database connection established');
    } catch (e) {
      console.error('❌ Database connection failed:', e.message);
      console.error('   Will fall back to YouTube API');
    }
  }

  // Pre-fetch playlists after server starts (YouTube API mode only)
  if (!USE_DATABASE) {
    try {
      await preFetchAllPlaylists();
      console.log('✓ All playlists cached and ready to serve');
    } catch (e) {
      console.error('Error during pre-fetch:', e.message);
    }
  }
});
