/**
 * Add Playlist Script
 * 
 * Creates a new playlist in the database and populates it with videos from a YouTube playlist.
 * If videos already exist in the DB, they are reused. Otherwise, new video records are created.
 * 
 * Usage:
 *   node add-playlist.js <youtube-playlist-url> "<playlist-name>" "<channel-ids>" [description]
 * 
 * Example:
 *   node add-playlist.js "https://www.youtube.com/playlist?list=PLxxx" "My Custom Playlist" "1,2,3" "Optional description"
 *   node add-playlist.js "https://www.youtube.com/playlist?list=PLxxx" "Rock Hits" "1" "Best rock songs"
 * 
 * Channel IDs: Comma-separated list of channel IDs (e.g., "1,2,3")
 * Run without arguments to see available channels.
 */

require('dotenv').config();
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

// Parse command line arguments
const args = process.argv.slice(2);

// Show available channels if no arguments
async function showAvailableChannels() {
  const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: DATABASE_URL.includes('supabase') ? { rejectUnauthorized: false } : false
  });
  
  try {
    const result = await pool.query('SELECT id, name, icon FROM channels ORDER BY id');
    console.log('\n📺 Available Channels:');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    result.rows.forEach(ch => {
      console.log(`  ${ch.id}. ${ch.icon} ${ch.name}`);
    });
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  } finally {
    await pool.end();
  }
}

if (args.length < 3) {
  console.error('Usage: node add-playlist.js <youtube-playlist-url> "<playlist-name>" "<channel-ids>" [description]');
  console.error('Example: node add-playlist.js "https://www.youtube.com/playlist?list=PLxxx" "My Playlist" "1,2,3" "Optional description"');
  console.error('\nChannel IDs: Comma-separated list (e.g., "1,2,3")');
  showAvailableChannels().then(() => process.exit(1));
  return;
}

const playlistUrl = args[0];
const playlistName = args[1];
const channelIds = args[2].split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id));
const playlistDescription = args[3] || '';

if (channelIds.length === 0) {
  console.error('Error: Invalid channel IDs provided');
  showAvailableChannels().then(() => process.exit(1));
  return;
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

// Create or get existing playlist
async function createPlaylist(client, name, description) {
  // Check if playlist already exists
  const checkResult = await client.query(
    'SELECT id FROM playlists WHERE name = $1',
    [name]
  );
  
  if (checkResult.rows.length > 0) {
    console.log(`Playlist "${name}" already exists with ID: ${checkResult.rows[0].id}`);
    return checkResult.rows[0].id;
  }
  
  // Create new playlist
  const result = await client.query(
    'INSERT INTO playlists (name, description) VALUES ($1, $2) RETURNING id',
    [name, description]
  );
  
  console.log(`Created new playlist "${name}" with ID: ${result.rows[0].id}`);
  return result.rows[0].id;
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

// Link video to playlist
async function linkVideoToPlaylist(client, playlistId, videoId, position) {
  // Check if link already exists
  const checkResult = await client.query(
    'SELECT 1 FROM playlist_videos WHERE playlist_id = $1 AND video_id = $2',
    [playlistId, videoId]
  );
  
  if (checkResult.rows.length > 0) {
    // Update position if it changed
    await client.query(
      'UPDATE playlist_videos SET position = $3 WHERE playlist_id = $1 AND video_id = $2',
      [playlistId, videoId, position]
    );
    return false; // Already existed
  }
  
  // Insert new link
  await client.query(
    'INSERT INTO playlist_videos (playlist_id, video_id, position) VALUES ($1, $2, $3)',
    [playlistId, videoId, position]
  );
  
  return true; // Newly created
}

// Link playlist to channels
async function linkPlaylistToChannels(client, playlistId, channelIds) {
  let newLinks = 0;
  let existingLinks = 0;
  
  for (const channelId of channelIds) {
    // Check if channel exists
    const channelCheck = await client.query(
      'SELECT id, name FROM channels WHERE id = $1',
      [channelId]
    );
    
    if (channelCheck.rows.length === 0) {
      console.warn(`\n⚠️  Channel ID ${channelId} not found, skipping...`);
      continue;
    }
    
    // Check if link already exists
    const linkCheck = await client.query(
      'SELECT 1 FROM channel_playlists WHERE channel_id = $1 AND playlist_id = $2',
      [channelId, playlistId]
    );
    
    if (linkCheck.rows.length > 0) {
      existingLinks++;
      continue;
    }
    
    // Create link
    await client.query(
      'INSERT INTO channel_playlists (channel_id, playlist_id) VALUES ($1, $2)',
      [channelId, playlistId]
    );
    
    newLinks++;
    console.log(`  ✓ Linked to channel: ${channelCheck.rows[0].name}`);
  }
  
  return { newLinks, existingLinks };
}

// Main execution
async function main() {
  const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: DATABASE_URL.includes('supabase') ? { rejectUnauthorized: false } : false
  });
  
  try {
    // Extract YouTube playlist ID
    const youtubePlaylistId = extractPlaylistId(playlistUrl);
    console.log(`YouTube Playlist ID: ${youtubePlaylistId}`);
    console.log(`Playlist Name: ${playlistName}`);
    console.log(`Channel IDs: ${channelIds.join(', ')}`);
    if (playlistDescription) {
      console.log(`Description: ${playlistDescription}`);
    }
    console.log('');
    
    // Fetch videos from YouTube
    const youtubeVideos = await fetchPlaylistItems(youtubePlaylistId);
    
    if (youtubeVideos.length === 0) {
      console.log('No videos found in playlist');
      return;
    }
    
    // Fetch durations
    console.log('Fetching video durations...');
    const videoIds = youtubeVideos.map(v => v.videoId);
    const durations = await getVideoDurations(videoIds);
    
    // Create playlist in database
    console.log('\nCreating playlist in database...');
    const playlistId = await createPlaylist(pool, playlistName, playlistDescription);
    
    // Process videos
    console.log('\nProcessing videos...');
    let newVideos = 0;
    let existingVideos = 0;
    let newLinks = 0;
    let existingLinks = 0;
    
    for (const video of youtubeVideos) {
      const durationSeconds = durations[video.videoId] || 0;
      const parsed = parseTitle(video.title);
      
      // Insert or get video
      const existedBefore = await pool.query(
        'SELECT id FROM videos WHERE youtube_video_id = $1',
        [video.videoId]
      );
      
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
      
      // Link to playlist
      const isNewLink = await linkVideoToPlaylist(pool, playlistId, videoDbId, video.position);
      
      if (isNewLink) {
        newLinks++;
      } else {
        existingLinks++;
      }
      
      process.stdout.write(`\rProcessed: ${newVideos + existingVideos}/${youtubeVideos.length} videos`);
    }
    
    console.log('\n');
    
    // Link playlist to channels
    console.log('Linking playlist to channels...');
    const channelLinks = await linkPlaylistToChannels(pool, playlistId, channelIds);
    
    console.log('\n✅ Playlist added successfully!');
    console.log(`\nSummary:`);
    console.log(`  Playlist ID: ${playlistId}`);
    console.log(`  Playlist Name: ${playlistName}`);
    console.log(`  Total videos: ${youtubeVideos.length}`);
    console.log(`  New videos created: ${newVideos}`);
    console.log(`  Existing videos reused: ${existingVideos}`);
    console.log(`  New playlist links: ${newLinks}`);
    console.log(`  Existing playlist links: ${existingLinks}`);
    console.log(`  Channels linked: ${channelLinks.newLinks} new, ${channelLinks.existingLinks} existing`);
    
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
