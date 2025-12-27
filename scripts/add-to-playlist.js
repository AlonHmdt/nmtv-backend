/**
 * Add to Playlist Script
 * 
 * Adds videos from a YouTube playlist OR a single YouTube video to an existing playlist in the database.
 * If videos already exist in the DB, they are reused. Otherwise, new video records are created.
 * 
 * Usage:
 *   node add-to-playlist.js <playlist-id-or-name> <youtube-url>
 * 
 * Example:
 *   node add-to-playlist.js "5" "https://www.youtube.com/playlist?list=PLxxx"
 *   node add-to-playlist.js "My Custom Playlist" "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
 *   node add-to-playlist.js "5" "dQw4w9WgXcQ"
 * 
 * Run without arguments to see available playlists.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const axios = require('axios');
const { Pool } = require('pg');

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;

if (!YOUTUBE_API_KEY) {
  console.error('Error: YOUTUBE_API_KEY not found in environment variables');
  process.exit(1);
}

if (!DATABASE_URL) {
  console.error('Error: DATABASE_URL not found in environment variables');
  process.exit(1);
}

// Show available playlists
async function showAvailablePlaylists() {
  const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: DATABASE_URL.includes('supabase') ? { rejectUnauthorized: false } : false
  });
  
  try {
    const result = await pool.query(`
      SELECT 
        p.id, 
        p.name, 
        p.description,
        COUNT(pv.video_id) as video_count,
        STRING_AGG(DISTINCT c.name, ', ' ORDER BY c.name) as channels
      FROM playlists p
      LEFT JOIN playlist_videos pv ON p.id = pv.playlist_id
      LEFT JOIN channel_playlists cp ON p.id = cp.playlist_id
      LEFT JOIN channels c ON cp.channel_id = c.id
      GROUP BY p.id, p.name, p.description
      ORDER BY p.id
    `);
    
    console.log('\n🎵 Available Playlists:');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    result.rows.forEach(pl => {
      console.log(`  ${pl.id}. ${pl.name} (${pl.video_count} videos)`);
      if (pl.channels) {
        console.log(`     Channels: ${pl.channels}`);
      }
      if (pl.description) {
        console.log(`     ${pl.description}`);
      }
    });
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  } finally {
    await pool.end();
  }
}

// Parse command line arguments
const args = process.argv.slice(2);

if (args.length < 2) {
  console.error('Usage: node add-to-playlist.js <playlist-id-or-name> <youtube-url>');
  console.error('Example (playlist): node add-to-playlist.js "5" "https://www.youtube.com/playlist?list=PLxxx"');
  console.error('Example (single video): node add-to-playlist.js "5" "https://www.youtube.com/watch?v=dQw4w9WgXcQ"');
  showAvailablePlaylists().then(() => process.exit(1));
  return;
}

const playlistIdentifier = args[0];
const youtubeUrl = args[1];

// Extract video ID from URL
function extractVideoId(url) {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]+)/,  // Standard URL
    /^([a-zA-Z0-9_-]{11})$/  // Just the ID (11 characters)
  ];
  
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  
  return null;
}

// Extract playlist ID from URL
function extractPlaylistId(url) {
  const patterns = [
    /[?&]list=([a-zA-Z0-9_-]+)/,  // Standard URL
    /^([a-zA-Z0-9_-]+)$/            // Just the ID
  ];
  
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  
  throw new Error('Could not extract playlist ID from URL');
}

// Clean title by removing common suffixes
function cleanTitle(title) {
  return title
    .replace(/\s*\(Official Music Video\)/gi, '')
    .replace(/\s*\[Official Music Video\]/gi, '')
    .replace(/\s*Official Music Video/gi, '')
    .replace(/\s*\(Official Video\)/gi, '')
    .replace(/\s*\[Official Video\]/gi, '')
    .replace(/\s*Official Video/gi, '')
    .replace(/\s*\(Official Audio\)/gi, '')
    .replace(/\s*\[Official Audio\]/gi, '')
    .replace(/\s*Official Audio/gi, '')
    .replace(/\s*\(Lyric Video\)/gi, '')
    .replace(/\s*\[Lyric Video\]/gi, '')
    .replace(/\s*\(Lyrics\)/gi, '')
    .replace(/\s*\[Lyrics\]/gi, '')
    .replace(/\s*\(HD\)/gi, '')
    .replace(/\s*\[HD\]/gi, '')
    .trim();
}

// Parse title into artist and song
function parseTitle(title) {
  const cleanedTitle = cleanTitle(title);
  
  // Try to split by common separators
  const separators = [' - ', ' – ', ' — ', ' | '];
  
  for (const sep of separators) {
    if (cleanedTitle.includes(sep)) {
      const parts = cleanedTitle.split(sep);
      if (parts.length >= 2) {
        return {
          title: cleanedTitle,
          artist: parts[0].trim(),
          song: parts.slice(1).join(sep).trim()
        };
      }
    }
  }
  
  // If no separator found, return full title
  return {
    title: cleanedTitle,
    artist: null,
    song: null
  };
}

// Parse duration from ISO 8601 format (PT4M33S) to seconds
function parseDuration(isoDuration) {
  const match = isoDuration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;
  
  const hours = parseInt(match[1] || 0);
  const minutes = parseInt(match[2] || 0);
  const seconds = parseInt(match[3] || 0);
  
  return hours * 3600 + minutes * 60 + seconds;
}

// Fetch all videos from YouTube playlist
async function fetchPlaylistItems(playlistId) {
  console.log(`Fetching videos from YouTube playlist: ${playlistId}`);
  
  let videos = [];
  let nextPageToken = null;
  
  do {
    const url = 'https://www.googleapis.com/youtube/v3/playlistItems';
    const params = {
      part: 'snippet,contentDetails',
      playlistId: playlistId,
      maxResults: 50,
      key: YOUTUBE_API_KEY
    };
    
    if (nextPageToken) {
      params.pageToken = nextPageToken;
    }
    
    const response = await axios.get(url, { params });
    const items = response.data.items || [];
    
    videos = videos.concat(items.map(item => ({
      videoId: item.contentDetails.videoId,
      title: item.snippet.title,
      position: item.snippet.position
    })));
    
    nextPageToken = response.data.nextPageToken;
    console.log(`Fetched ${videos.length} videos so far...`);
    
  } while (nextPageToken);
  
  console.log(`Total videos found: ${videos.length}`);
  return videos;
}

// Fetch video durations in batches
async function getVideoDurations(videoIds) {
  const durations = {};
  const batchSize = 50;
  
  for (let i = 0; i < videoIds.length; i += batchSize) {
    const batch = videoIds.slice(i, i + batchSize);
    const url = 'https://www.googleapis.com/youtube/v3/videos';
    const params = {
      part: 'contentDetails',
      id: batch.join(','),
      key: YOUTUBE_API_KEY
    };
    
    const response = await axios.get(url, { params });
    const items = response.data.items || [];
    
    items.forEach(item => {
      durations[item.id] = parseDuration(item.contentDetails.duration);
    });
  }
  
  return durations;
}

// Fetch single video details
async function fetchSingleVideo(videoId) {
  console.log(`Fetching video details: ${videoId}`);
  
  const url = 'https://www.googleapis.com/youtube/v3/videos';
  const params = {
    part: 'snippet,contentDetails',
    id: videoId,
    key: YOUTUBE_API_KEY
  };
  
  const response = await axios.get(url, { params });
  const items = response.data.items || [];
  
  if (items.length === 0) {
    throw new Error(`Video not found: ${videoId}`);
  }
  
  const item = items[0];
  const duration = parseDuration(item.contentDetails.duration);
  
  console.log(`Found video: ${item.snippet.title}`);
  
  return [{
    videoId: item.id,
    title: item.snippet.title,
    position: 0,
    duration: duration
  }];
}

// Find playlist by ID or name
async function findPlaylist(client, identifier) {
  // Try as ID first
  const idAsNumber = parseInt(identifier);
  if (!isNaN(idAsNumber)) {
    const result = await client.query(
      'SELECT id, name, description FROM playlists WHERE id = $1',
      [idAsNumber]
    );
    if (result.rows.length > 0) {
      return result.rows[0];
    }
  }
  
  // Try as name
  const result = await client.query(
    'SELECT id, name, description FROM playlists WHERE name = $1',
    [identifier]
  );
  
  if (result.rows.length > 0) {
    return result.rows[0];
  }
  
  throw new Error(`Playlist not found: ${identifier}`);
}

// Insert or get existing video
async function insertOrGetVideo(client, videoData) {
  const { videoId, title, artist, song, durationSeconds } = videoData;
  
  // Check if video already exists
  const checkResult = await client.query(
    'SELECT id FROM videos WHERE youtube_video_id = $1',
    [videoId]
  );
  
  if (checkResult.rows.length > 0) {
    return checkResult.rows[0].id;
  }
  
  // Insert new video
  const result = await client.query(
    `INSERT INTO videos (youtube_video_id, title, artist, song, duration_seconds)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [videoId, title, artist, song, durationSeconds]
  );
  
  return result.rows[0].id;
}

// Get max position in playlist
async function getMaxPosition(client, playlistId) {
  const result = await client.query(
    'SELECT COALESCE(MAX(position), -1) as max_pos FROM playlist_videos WHERE playlist_id = $1',
    [playlistId]
  );
  return result.rows[0].max_pos;
}

// Link video to playlist
async function linkVideoToPlaylist(client, playlistId, videoId, position) {
  // Check if link already exists
  const checkResult = await client.query(
    'SELECT 1 FROM playlist_videos WHERE playlist_id = $1 AND video_id = $2',
    [playlistId, videoId]
  );
  
  if (checkResult.rows.length > 0) {
    return false; // Already existed
  }
  
  // Insert new link
  await client.query(
    'INSERT INTO playlist_videos (playlist_id, video_id, position) VALUES ($1, $2, $3)',
    [playlistId, videoId, position]
  );
  
  return true; // Newly created
}

// Main execution
async function main() {
  const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: DATABASE_URL.includes('supabase') ? { rejectUnauthorized: false } : false
  });
  
  try {
    // Find the playlist in database
    console.log(`Looking up playlist: ${playlistIdentifier}`);
    const playlist = await findPlaylist(pool, playlistIdentifier);
    console.log(`Found playlist: "${playlist.name}" (ID: ${playlist.id})\n`);
    
    // Determine if it's a single video or playlist
    const videoId = extractVideoId(youtubeUrl);
    const playlistId = extractPlaylistId(youtubeUrl);
    
    let youtubeVideos;
    let durations = {};
    
    if (videoId) {
      // Single video
      console.log(`Detected single video URL\n`);
      youtubeVideos = await fetchSingleVideo(videoId);
      durations[videoId] = youtubeVideos[0].duration;
    } else if (playlistId) {
      // YouTube playlist
      console.log(`Detected YouTube playlist URL`);
      console.log(`YouTube Playlist ID: ${playlistId}\n`);
      youtubeVideos = await fetchPlaylistItems(playlistId);
      
      if (youtubeVideos.length === 0) {
        console.log('No videos found in YouTube playlist');
        return;
      }
      
      // Fetch durations
      console.log('Fetching video durations...');
      const videoIds = youtubeVideos.map(v => v.videoId);
      durations = await getVideoDurations(videoIds);
    } else {
      throw new Error('Could not extract video ID or playlist ID from URL');
    }
    
    // Get current max position in playlist
    const maxPosition = await getMaxPosition(pool, playlist.id);
    let nextPosition = maxPosition + 1;
    
    // Process videos
    console.log('\nAdding videos to playlist...');
    let newVideos = 0;
    let existingVideos = 0;
    let newLinks = 0;
    let skippedLinks = 0;
    
    for (const video of youtubeVideos) {
      const durationSeconds = durations[video.videoId] || 0;
      const parsed = parseTitle(video.title);
      
      // Check if video existed before
      const existedBefore = await pool.query(
        'SELECT id FROM videos WHERE youtube_video_id = $1',
        [video.videoId]
      );
      
      // Insert or get video
      const videoDbId = await insertOrGetVideo(pool, {
        videoId: video.videoId,
        title: parsed.title,
        artist: parsed.artist,
        song: parsed.song,
        durationSeconds
      });
      
      if (existedBefore.rows.length > 0) {
        existingVideos++;
      } else {
        newVideos++;
      }
      
      // Link to playlist with new position
      const isNewLink = await linkVideoToPlaylist(pool, playlist.id, videoDbId, nextPosition);
      
      if (isNewLink) {
        newLinks++;
        nextPosition++;
      } else {
        skippedLinks++;
      }
      
      process.stdout.write(`\rProcessed: ${newVideos + existingVideos}/${youtubeVideos.length} videos`);
    }
    
    console.log('\n\n✅ Videos added to playlist successfully!');
    console.log(`\nSummary:`);
    console.log(`  Playlist: ${playlist.name} (ID: ${playlist.id})`);
    console.log(`  Videos from YouTube: ${youtubeVideos.length}`);
    console.log(`  New videos created: ${newVideos}`);
    console.log(`  Existing videos reused: ${existingVideos}`);
    console.log(`  New videos added to playlist: ${newLinks}`);
    console.log(`  Videos already in playlist (skipped): ${skippedLinks}`);
    
  } catch (error) {
    console.error('\n❌ Error:', error.message);
    throw error;
  } finally {
    await pool.end();
  }
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
