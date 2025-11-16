const express = require('express');
const axios = require('axios');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
require('dotenv').config();

const app = express();

// Security middleware
app.use(helmet()); // Adds security headers
app.disable('x-powered-by'); // Hide Express

// CORS configuration for production
const allowedOrigins = [
  'http://localhost:4200',
  'http://localhost:4201',
  'https://nmtv-frontend.vercel.app',
  process.env.FRONTEND_URL
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps or curl)
    if (!origin) return callback(null, true);
    
    if (allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
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

const CHANNELS = {
  rock: [
    "PLqKA0FE2hsOnyYVBZv2pcFyxNKPBaz2Nv",
    "PL300C32DA374417AA",
    "PL6Lt9p1lIRZ311J9ZHuzkR5A3xesae2pk",
    "PLD58ECddxRngHs9gZPQWOCAKwV1hTtYe4",
    "PL6Lt9p1lIRZ3m2X1Ur8ykG1XRGPFsTsbD"
  ],
  hiphop: [
    "PLYC_eh_Ae3Dw0iZucKzKjLv9Zys4FbdHI",
    "PLxo7H7n2_s1hwM1EdojpSGGl65fHaYAn7",
    "PLdTuPwLzSCS5xNlwleM48YA8gJOBzrStV",
    "PLn4GvABOzCQuZrM1YBvzlYVCkQpZkhXLS"
  ],
  "2000s": [
    "PLCh-xN1_B-eJazkwtVvYruDhfZyBCiMRn",
    "PLId5xJ_xHV-nphbMh65l19EVyXZkSEVKr",
    "PLKprw7268DO18sgw3yz4BA0GnpBl2SK0l",
    "PLkESttpe0UDycidmhDo0PWqhGeohs6VfV"
  ],
  "1990s": [
    "PL1Mmsa-U48mea1oIN-Eus78giJANx4D9W",
    "PLD58ECddxRngHs9gZPQWOCAKwV1hTtYe4",
    "PLNMTXgsQnLlCAYdQGh3sVAvun2hWZ_a6x",
    "PLzRN-jh85ZxWAmGTRTmI54_wUPI1Ctfar",
    "PLCQCtoOJpI_Dg1iO9xS2u24_2FtbyxCo2",
    "PLkpn4UHlnIHnfh9Ye0ysC__1f29F2Bnv1"
  ],
  "1980s": [
    "PLd9auH4JIHvupoMgW5YfOjqtj6Lih0MKw",
    "PLDHCLXs2vTkLK-Y7lCVSM5aC3wBYzAcyw",
    "PLzRN-jh85ZxUe55BQvbT-7uhcYxUGlcED",
    "PLmXxqSJJq-yWTswOPWtZVTrs5ZAAjFB_j"
  ],
  "live": [
    "PLcIRQEExiw7ZD9SyyNvazIzYI8SkBM5LS"
  ],
  "shows":[
    "PLjwvTaJGeSmQE2fDbYhkQY7zSB3k23cmh",
    "PLjwvTaJGeSmQfzhApDigzyCH0_Hu82fQf",
    "PLjwvTaJGeSmTRxXrtO7ufnX28B3a4ojYk",
    "PL0exW-53ug6LfnmcO4MOPg07kZqjDmkZv"
  ]
};

// Bumper/Ident playlists - short videos to play between songs
const BUMPER_PLAYLISTS = [
  "PLnG7oFaM6TYqDLvZ_PBY79Pn68BFbv17w",
  "PLLHK2qXpOJlq07tC0I0aMZ8LbdsSj3jAF",
  "PLMl84_AytMHWf2ZHFbtpskMANEwKoPvZ5",
  "PLA9_zFupTNzhk0O83A8dd1S9iKRcLh5dn"
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
      console.error(`  └─ Error fetching page ${pageCount + 1} of playlist ${playlistId}:`, error.message);
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
  
  const allBumperPromises = BUMPER_PLAYLISTS.map(pid => 
    fetchPlaylistItems(pid, null, 'bumper').catch(error => {
      console.error(`Error fetching bumper playlist ${pid}:`, error.message);
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
    
    playlistCache.set(playlistId, { videos, timestamp: now });
    return videos;
  } catch (error) {
    console.error(`Error fetching playlist ${playlistId}:`, error.message);
    throw error;
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
  
  // Step 4: Shuffle official videos only (custom are already distributed)
  shuffle(uniqueOfficial);
  
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

app.get('/api/channel/:id', async (req, res) => {
  const channel = req.params.id;
  const customParam = req.query.custom || '';
  const customPlaylistIds = customParam.split(',').filter(Boolean);
  const skipCustom = req.query.skipCustom === 'true';
  
  console.log(`Fetching channel ${channel} with ${customPlaylistIds.length} custom playlists (skipCustom: ${skipCustom})`);
  
  try {
    const allVideos = await getAllChannelVideos(channel, customPlaylistIds, skipCustom, false); // Don't insert bumpers yet
    
    // Only shuffle if there are no custom playlists (official only)
    // mixVideos() already handles shuffling when custom playlists are present
    if (customPlaylistIds.length === 0 || skipCustom) {
      shuffle(allVideos);
    }
    
    // Slice to desired count, then insert bumpers
    const slicedVideos = allVideos.slice(0, 12);
    const videosWithBumpers = insertBumpers(slicedVideos, bumpersCache);
    
    res.json(videosWithBumpers);
  } catch (e) {
    console.error('Error:', e.message);
    res.status(404).json({ error: e.message });
  }
});

app.post('/api/channel/:id/next', async (req, res) => {
  const channel = req.params.id;
  const { excludeIds, customPlaylistIds } = req.body;
  
  // Validate request body
  const excludeArray = Array.isArray(excludeIds) ? excludeIds : [];
  const customArray = Array.isArray(customPlaylistIds) ? customPlaylistIds : [];
  const excludeSet = new Set(excludeArray);
  
  console.log(`Fetching next batch for ${channel}: excluding ${excludeArray.length} videos, ${customArray.length} custom playlists`);
  
  try {
    const allVideos = await getAllChannelVideos(channel, customArray, false, false); // Don't insert bumpers yet
    
    // Filter out excluded videos
    const availableVideos = allVideos.filter(v => !excludeSet.has(v.id));
    
    // Only shuffle if there are no custom playlists (official only)
    // mixVideos() already handles shuffling when custom playlists are present
    if (customArray.length === 0) {
      shuffle(availableVideos);
    }
    
    // Slice to desired count, then insert bumpers
    const slicedVideos = availableVideos.slice(0, 12);
    const videosWithBumpers = insertBumpers(slicedVideos, bumpersCache);
    
    res.json(videosWithBumpers);
  } catch (e) {
    console.error('Error:', e.message);
    res.status(404).json({ error: e.message });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'OK', message: 'NMTV backend is running' });
});

// Readiness endpoint - checks if playlist data is loaded
app.get('/api/ready', (req, res) => {
  const cacheSize = playlistCache.size;
  const bumpersLoaded = bumpersCache !== null && bumpersCache.length > 0;
  const ready = isDataReady && cacheSize > 0 && bumpersLoaded;
  
  res.json({ 
    ready,
    cacheSize,
    bumpersLoaded,
    bumpersCount: bumpersCache?.length || 0,
    loadingTime: dataLoadingStartTime ? Date.now() - dataLoadingStartTime : 0
  });
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
  
  // Collect all playlist IDs with their channel
  for (const [channel, playlists] of Object.entries(CHANNELS)) {
    playlists.forEach(pid => allPlaylistsByChannel.push({ pid, channel }));
  }
  
  console.log(`📋 Found ${allPlaylistsByChannel.length} playlists across all channels`);
  
  let successCount = 0;
  let totalVideos = 0;
  
  for (const { pid, channel } of allPlaylistsByChannel) {
    try {
      const videos = await getPlaylistVideos(pid, null, null, channel);
      totalVideos += videos.length;
      successCount++;
      console.log(`  ✓ [${successCount}/${allPlaylistsByChannel.length}] Cached ${videos.length} videos from ${pid} (${channel})`);
    } catch (e) {
      console.error(`  ✗ Failed to fetch playlist ${pid}:`, e.message);
    }
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
  if (!API_KEY) {
    console.warn('WARNING: YOUTUBE_API_KEY not set');
  }
  
  // Pre-fetch playlists after server starts
  try {
    await preFetchAllPlaylists();
    console.log('✓ All playlists cached and ready to serve');
  } catch (e) {
    console.error('Error during pre-fetch:', e.message);
  }
});
