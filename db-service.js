/**
 * Database Service Layer
 * 
 * Provides abstraction for all database operations with caching.
 * All functions throw errors to be caught by caller for fallback logic.
 */

const { Pool } = require('pg');
require('dotenv').config();

// ============================================
// CONNECTION POOL (Singleton)
// ============================================

let pool = null;

function initializePool() {
  if (pool) {
    return pool;
  }

  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 20, // Maximum pool size
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });

  // Handle pool errors
  pool.on('error', (err) => {
    console.error('Unexpected database pool error:', err);
  });

  console.log('✅ Database connection pool initialized');
  return pool;
}

function getPool() {
  if (!pool) {
    return initializePool();
  }
  return pool;
}

async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
    console.log('Database connection pool closed');
  }
}

async function healthCheck() {
  const client = getPool();
  const result = await client.query('SELECT NOW()');
  return result.rows[0];
}

// ============================================
// CACHING LAYER
// ============================================

const cache = new Map();
const CACHE_TTL = {
  CHANNELS: 24 * 60 * 60 * 1000,    // 24 hours
  PLAYLISTS: 60 * 60 * 1000,        // 1 hour
  VIDEOS: 60 * 60 * 1000,           // 1 hour
  BUMPERS: 24 * 60 * 60 * 1000      // 24 hours
};

function getCached(key) {
  const cached = cache.get(key);
  if (!cached) return null;

  const { value, timestamp, ttl } = cached;
  const now = Date.now();

  if (now - timestamp > ttl) {
    cache.delete(key);
    return null;
  }

  return value;
}

function setCached(key, value, ttl) {
  cache.set(key, {
    value,
    timestamp: Date.now(),
    ttl
  });
}

function clearCache(pattern = null) {
  if (pattern) {
    // Clear cache entries matching pattern
    for (const key of cache.keys()) {
      if (key.includes(pattern)) {
        cache.delete(key);
      }
    }
  } else {
    cache.clear();
  }
}

// ============================================
// CHANNEL FUNCTIONS
// ============================================

async function getAllChannels() {
  const cacheKey = 'channels:all';
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const client = getPool();
  const result = await client.query(`
    SELECT id, name, icon, is_easter_egg
    FROM channels
    ORDER BY 
      CASE id
        WHEN 'rock' THEN 1
        WHEN 'hiphop' THEN 2
        WHEN '2000s' THEN 3
        WHEN '1990s' THEN 4
        WHEN '1980s' THEN 5
        WHEN 'live' THEN 6
        WHEN 'shows' THEN 7
        WHEN 'noa' THEN 8
      END
  `);

  setCached(cacheKey, result.rows, CACHE_TTL.CHANNELS);
  return result.rows;
}

async function getChannelById(channelId) {
  const client = getPool();
  const result = await client.query(
    'SELECT id, name, icon, is_easter_egg FROM channels WHERE id = $1',
    [channelId]
  );

  if (result.rows.length === 0) {
    throw new Error(`Channel not found: ${channelId}`);
  }

  return result.rows[0];
}

// ============================================
// PLAYLIST FUNCTIONS
// ============================================

async function getPlaylistsForChannel(channelId) {
  const cacheKey = `playlists:channel:${channelId}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const client = getPool();
  const result = await client.query(`
    SELECT p.id, p.name, p.description
    FROM playlists p
    JOIN channel_playlists cp ON p.id = cp.playlist_id
    WHERE cp.channel_id = $1
    ORDER BY p.name
  `, [channelId]);

  setCached(cacheKey, result.rows, CACHE_TTL.PLAYLISTS);
  return result.rows;
}

async function getRandomPlaylistForChannel(channelId, excludePlaylistIds = []) {
  const client = getPool();

  let query = `
    SELECT p.id, p.name, p.description
    FROM playlists p
    JOIN channel_playlists cp ON p.id = cp.playlist_id
    WHERE cp.channel_id = $1
  `;

  const params = [channelId];

  if (excludePlaylistIds.length > 0) {
    query += ` AND p.id NOT IN (${excludePlaylistIds.map((_, i) => `$${i + 2}`).join(',')})`;
    params.push(...excludePlaylistIds);
  }

  query += ' ORDER BY RANDOM() LIMIT 1';

  const result = await client.query(query, params);

  if (result.rows.length === 0) {
    // All playlists exhausted, reset and try again without exclusions
    const resetResult = await client.query(`
      SELECT p.id, p.name, p.description
      FROM playlists p
      JOIN channel_playlists cp ON p.id = cp.playlist_id
      WHERE cp.channel_id = $1
      ORDER BY RANDOM()
      LIMIT 1
    `, [channelId]);

    return resetResult.rows[0] || null;
  }

  return result.rows[0];
}

async function getAllPlaylistsForChannel(channelId) {
  const client = getPool();

  const result = await client.query(`
    SELECT p.id, p.name, p.description
    FROM playlists p
    JOIN channel_playlists cp ON p.id = cp.playlist_id
    WHERE cp.channel_id = $1
    ORDER BY p.id
  `, [channelId]);

  return result.rows.map(row => ({
    id: row.id,
    name: row.name,
    description: row.description,
    isCustom: false
  }));
}

async function getPlaylistById(playlistId) {
  const client = getPool();
  const result = await client.query(
    'SELECT id, name, description FROM playlists WHERE id = $1',
    [playlistId]
  );

  if (result.rows.length === 0) {
    throw new Error(`Playlist not found: ${playlistId}`);
  }

  return result.rows[0];
}

// ============================================
// VIDEO FUNCTIONS
// ============================================

async function getVideosByPlaylistId(playlistId, limit = null, excludeVideoIds = []) {
  const client = getPool();

  let query = `
    SELECT 
      v.youtube_video_id as id,
      v.title,
      v.artist,
      v.song,
      v.duration_seconds,
      v.is_limited,
      v.year,
      p.name as playlist_name,
      p.id as playlist_id
    FROM videos v
    JOIN playlist_videos pv ON v.id = pv.video_id
    JOIN playlists p ON pv.playlist_id = p.id
    WHERE p.id = $1 AND v.is_flagged = false
  `;

  const params = [playlistId];

  if (excludeVideoIds.length > 0) {
    query += ` AND v.youtube_video_id NOT IN (${excludeVideoIds.map((_, i) => `$${i + 2}`).join(',')})`;
    params.push(...excludeVideoIds);
  }

  query += ' ORDER BY RANDOM()';

  if (limit) {
    query += ` LIMIT ${parseInt(limit)}`;
  }

  const result = await client.query(query, params);

  return {
    videos: result.rows,
    playlistLabel: result.rows[0]?.playlist_name || '',
    playlistId: playlistId.toString()
  };
}

async function getVideosForChannelBlock(channelId, excludeVideoIds = [], excludePlaylistIds = []) {
  // Get random playlist for this channel
  const playlist = await getRandomPlaylistForChannel(channelId, excludePlaylistIds);

  if (!playlist) {
    throw new Error(`No playlists available for channel: ${channelId}`);
  }

  // Determine block size based on channel type
  // Shows channel: 3 videos, Music/Live channels: 12 videos
  const blockSize = channelId === 'shows' ? 3 : 12;

  // Get videos from this playlist (bumpers will be added separately)
  const result = await getVideosByPlaylistId(playlist.id, blockSize, excludeVideoIds);

  return {
    playlistLabel: playlist.name,
    playlistId: playlist.id.toString(),
    items: result.videos.map(v => ({
      id: v.id,
      title: v.title,
      artist: v.artist,
      song: v.song,
      year: v.year,
      isLimited: v.is_limited,
      isBumper: false
    }))
  };
}

async function getVideoByYoutubeId(youtubeVideoId) {
  const client = getPool();
  const result = await client.query(
    'SELECT * FROM videos WHERE youtube_video_id = $1',
    [youtubeVideoId]
  );

  return result.rows[0] || null;
}

async function markVideoUnavailable(youtubeVideoId, errorCode = null) {
  const client = getPool();

  // Get current video state
  const videoResult = await client.query(
    'SELECT unavailable_count, last_unavailable_at FROM videos WHERE youtube_video_id = $1',
    [youtubeVideoId]
  );

  if (videoResult.rows.length === 0) {
    console.log(`Video ${youtubeVideoId} not found in database`);
    return;
  }

  const video = videoResult.rows[0];
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  let newCount;
  let shouldFlag = false;

  // If last unavailable was > 30 days ago (or never), reset counter to 1
  if (!video.last_unavailable_at || new Date(video.last_unavailable_at) < thirtyDaysAgo) {
    newCount = 1;
    console.log(`Video ${youtubeVideoId}: Resetting counter to 1 (last report was >30 days ago)`);
  } else {
    // Otherwise, increment counter
    newCount = (video.unavailable_count || 0) + 1;
    console.log(`Video ${youtubeVideoId}: Incrementing counter to ${newCount}`);
  }

  // Auto-flag if counter reaches threshold
  if (newCount >= 50) {
    shouldFlag = true;
    console.log(`Video ${youtubeVideoId}: Auto-flagging (counter >= 50)`);
  }

  // Build flag reason
  let flagReason = null;
  if (shouldFlag) {
    flagReason = errorCode
      ? `Auto-flagged: ${newCount} unavailable reports (Error: ${errorCode})`
      : `Auto-flagged: ${newCount} unavailable reports`;
  }

  // Update video
  if (shouldFlag) {
    await client.query(
      `UPDATE videos 
       SET unavailable_count = $1, 
           last_unavailable_at = $2, 
           is_flagged = true,
           flag_reason = $3,
           updated_at = NOW() 
       WHERE youtube_video_id = $4`,
      [newCount, now, flagReason, youtubeVideoId]
    );
  } else {
    await client.query(
      `UPDATE videos 
       SET unavailable_count = $1, 
           last_unavailable_at = $2,
           updated_at = NOW() 
       WHERE youtube_video_id = $3`,
      [newCount, now, youtubeVideoId]
    );
  }

  // Clear related cache
  clearCache('videos:');
}

async function updateVideoYear(youtubeVideoId, year) {
  const client = getPool();

  await client.query(
    'UPDATE videos SET year = $1, updated_at = NOW() WHERE youtube_video_id = $2',
    [year, youtubeVideoId]
  );

  // Clear related cache
  clearCache('videos:');
}

// ============================================
// BUMPER FUNCTIONS
// ============================================

async function getRandomBumpers(count = 1) {
  const cacheKey = 'bumpers:all';
  let bumpers = getCached(cacheKey);

  if (!bumpers) {
    const client = getPool();
    const result = await client.query(`
      SELECT youtube_video_id as id, title, duration_seconds
      FROM bumpers
      ORDER BY id
    `);

    bumpers = result.rows;
    setCached(cacheKey, bumpers, CACHE_TTL.BUMPERS);
  }

  // Shuffle and return requested count
  const shuffled = [...bumpers].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count).map(b => ({
    id: b.id,
    title: b.title,
    isBumper: true
  }));
}

async function getAllBumpers() {
  const cacheKey = 'bumpers:all';
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const client = getPool();
  const result = await client.query(`
    SELECT youtube_video_id as id, title, duration_seconds
    FROM bumpers
    ORDER BY id
  `);

  const bumpers = result.rows;
  setCached(cacheKey, bumpers, CACHE_TTL.BUMPERS);
  return bumpers;
}

/**
 * Check if videos exist in bumpers table
 * @param {string[]} videoIds - Array of YouTube video IDs
 * @returns {Object} Map of videoId -> { isBumper: boolean, title?: string }
 */
async function checkBumpersExistence(videoIds) {
  if (!videoIds || videoIds.length === 0) return {};

  const client = getPool();
  const result = await client.query(`
    SELECT youtube_video_id as id, title, duration_seconds
    FROM bumpers
    WHERE youtube_video_id = ANY($1)
  `, [videoIds]);

  const bumperMap = {};
  result.rows.forEach(row => {
    bumperMap[row.id] = {
      isBumper: true,
      title: row.title,
      duration: row.duration_seconds
    };
  });

  // Fill in non-bumpers
  videoIds.forEach(id => {
    if (!bumperMap[id]) {
      bumperMap[id] = { isBumper: false };
    }
  });

  return bumperMap;
}

/**
 * Add a video to bumpers table
 * @param {Object} bumperData - { youtube_video_id, title, duration_seconds }
 * @returns {Object} { success: boolean, id?: number, error?: string }
 */
async function addBumper(bumperData) {
  const { youtube_video_id, title, duration_seconds } = bumperData;

  if (!youtube_video_id) {
    return { success: false, error: 'youtube_video_id is required' };
  }

  const client = getPool();

  // Check if already exists
  const existing = await client.query(
    'SELECT id FROM bumpers WHERE youtube_video_id = $1',
    [youtube_video_id]
  );

  if (existing.rows.length > 0) {
    return { success: false, error: 'Video is already a bumper', existingId: existing.rows[0].id };
  }

  // Insert new bumper
  const result = await client.query(
    `INSERT INTO bumpers (youtube_video_id, title, duration_seconds)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [youtube_video_id, title || 'Bumper', duration_seconds || 0]
  );

  // Clear bumpers cache
  clearCachePattern('bumpers:');

  return { success: true, id: result.rows[0].id };
}

/**
 * Remove a video from bumpers table
 * @param {string} videoId - YouTube video ID
 * @returns {Object} { success: boolean, error?: string }
 */
async function removeBumper(videoId) {
  if (!videoId) {
    return { success: false, error: 'videoId is required' };
  }

  const client = getPool();
  const result = await client.query(
    'DELETE FROM bumpers WHERE youtube_video_id = $1 RETURNING id',
    [videoId]
  );

  if (result.rows.length === 0) {
    return { success: false, error: 'Video is not a bumper' };
  }

  // Clear bumpers cache
  clearCachePattern('bumpers:');

  return { success: true };
}

// Helper to clear cache entries matching pattern
function clearCachePattern(pattern) {
  for (const key of cache.keys()) {
    if (key.startsWith(pattern)) {
      cache.delete(key);
    }
  }
}

// ============================================
// ADMIN FUNCTIONS (Future)
// ============================================

async function flagVideo(youtubeVideoId, reason = null) {
  const client = getPool();
  await client.query(
    'UPDATE videos SET is_flagged = true, flag_reason = $1, updated_at = NOW() WHERE youtube_video_id = $2',
    [reason, youtubeVideoId]
  );

  clearCache('videos:');
}

async function unflagVideo(youtubeVideoId) {
  const client = getPool();
  await client.query(
    'UPDATE videos SET is_flagged = false, flag_reason = NULL, updated_at = NOW() WHERE youtube_video_id = $1',
    [youtubeVideoId]
  );

  clearCache('videos:');
}

async function deleteVideo(youtubeVideoId) {
  const client = getPool();
  // CASCADE will handle playlist_videos relationships
  await client.query(
    'DELETE FROM videos WHERE youtube_video_id = $1',
    [youtubeVideoId]
  );

  clearCache('videos:');
}

async function addVideoToPlaylist(playlistId, videoData) {
  const { youtube_video_id, title, artist, song, duration_seconds } = videoData;

  const client = getPool();

  // Begin transaction
  await client.query('BEGIN');

  try {
    // Check if video already exists
    let videoResult = await client.query(
      'SELECT id FROM videos WHERE youtube_video_id = $1',
      [youtube_video_id]
    );

    let videoId;

    if (videoResult.rows.length === 0) {
      // Insert new video
      const insertResult = await client.query(
        `INSERT INTO videos (youtube_video_id, title, artist, song, duration_seconds)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [youtube_video_id, title, artist, song, duration_seconds]
      );
      videoId = insertResult.rows[0].id;
    } else {
      videoId = videoResult.rows[0].id;
    }

    // Link video to playlist (if not already linked)
    await client.query(
      `INSERT INTO playlist_videos (playlist_id, video_id)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [playlistId, videoId]
    );

    await client.query('COMMIT');

    clearCache('videos:');
    clearCache('playlists:');

    return videoId;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function removeVideoFromPlaylist(playlistId, youtubeVideoId) {
  const client = getPool();

  await client.query(`
    DELETE FROM playlist_videos
    WHERE playlist_id = $1
    AND video_id = (SELECT id FROM videos WHERE youtube_video_id = $2)
  `, [playlistId, youtubeVideoId]);

  clearCache('videos:');
  clearCache('playlists:');
}

async function checkVideosExistence(youtubeVideoIds) {
  const client = getPool();

  // 1. Get all existing videos from the list
  const query = `
    SELECT 
      v.youtube_video_id,
      v.title,
      p.id as playlist_id,
      p.name as playlist_name,
      c.id as channel_id,
      c.name as channel_name
    FROM videos v
    LEFT JOIN playlist_videos pv ON v.id = pv.video_id
    LEFT JOIN playlists p ON pv.playlist_id = p.id
    LEFT JOIN channel_playlists cp ON p.id = cp.playlist_id
    LEFT JOIN channels c ON cp.channel_id = c.id
    WHERE v.youtube_video_id = ANY($1)
  `;

  const result = await client.query(query, [youtubeVideoIds]);

  // 2. Process results into a map
  const videoMap = {};

  // Initialize all as not found
  youtubeVideoIds.forEach(id => {
    videoMap[id] = { exists: false, playlists: [] };
  });

  result.rows.forEach(row => {
    const id = row.youtube_video_id;
    videoMap[id].exists = true;
    videoMap[id].title = row.title;

    if (row.playlist_id) {
      videoMap[id].playlists.push({
        id: row.playlist_id,
        name: row.playlist_name,
        channelId: row.channel_id,
        channelName: row.channel_name
      });
    }
  });

  return videoMap;
}

async function createPlaylist(name, description, channelId) {
  const client = getPool();

  await client.query('BEGIN');

  try {
    // 1. Create playlist
    const insertMsg = await client.query(
      'INSERT INTO playlists (name, description) VALUES ($1, $2) RETURNING id',
      [name, description]
    );
    const playlistId = insertMsg.rows[0].id;

    // 2. Link to channel
    if (channelId) {
      await client.query(
        'INSERT INTO channel_playlists (channel_id, playlist_id) VALUES ($1, $2)',
        [channelId, playlistId]
      );
    }

    await client.query('COMMIT');
    clearCache('playlists:');

    return playlistId;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}


// ============================================
// EXPORTS
// ============================================

module.exports = {
  // Connection
  initializePool,
  getPool,
  closePool,
  healthCheck,

  // Cache
  clearCache,

  // Channels
  getAllChannels,
  getChannelById,

  // Playlists
  getPlaylistsForChannel,
  getRandomPlaylistForChannel,
  getAllPlaylistsForChannel,
  getPlaylistById,

  // Videos
  getVideosByPlaylistId,
  getVideosForChannelBlock,
  getVideoByYoutubeId,
  markVideoUnavailable,
  updateVideoYear,

  // Bumpers
  getRandomBumpers,
  getAllBumpers,
  checkBumpersExistence,
  addBumper,
  removeBumper,

  // Admin
  flagVideo,
  unflagVideo,
  deleteVideo,
  addVideoToPlaylist,
  removeVideoFromPlaylist,
  checkVideosExistence,
  createPlaylist
};
