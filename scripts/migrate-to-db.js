/**
 * Database Migration Script
 * 
 * This script populates the Supabase database with videos from YouTube playlists.
 * It fetches all videos from the CHANNELS configuration and inserts them into
 * the database with proper relationships.
 * 
 * Usage: node migrate-to-db.js
 */

const axios = require('axios');
const { Client } = require('pg');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// ============================================
// CONFIGURATION (from index.js)
// ============================================

const API_KEY = process.env.YOUTUBE_API_KEY;
const MAX_BUMPER_DURATION = 90; // 1:30 in seconds

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
    { id: "PLcIRQEExiw7ZD9SyyNvazIzYI8SkBM5LS", label: "Live Performances 1" },
    { id: "PLXUBfJihF4_AhFBKu5UR2rhX_wKm5L9BO", label: "Live Performances 2" }
  ],
  "shows": [
    { id: "PLjwvTaJGeSmQE2fDbYhkQY7zSB3k23cmh", label: "Celebrity Deathmatch - Nuggets" },
    { id: "PLBPLVvU_jvGvwo0Fev5kEyrjDm4oXkhxG", label: "Celebrity Deathmatch - Nuggets 2" },
    { id: "PLjwvTaJGeSmQfzhApDigzyCH0_Hu82fQf", label: "Cribs - Nuggets" },
    { id: "PL0exW-53ug6JHCQnY654-iSGBPRqkSEww", label: "Cribs - Nuggets 2" },
    { id: "PLA9_zFupTNzhk0O83A8dd1S9iKRcLh5dn", label: "Beavis and Butt-head - Nuggets" },
    { id: "PLjwvTaJGeSmTRxXrtO7ufnX28B3a4ojYk", label: "Punk'd - Nuggets" },
    { id: "PL0exW-53ug6LfnmcO4MOPg07kZqjDmkZv", label: "Pimp My Ride - Nuggets" },
    { id: "PLXUBfJihF4_BtodhxajQzb5Irkev4Yl3v", label: "Interviews" },
    { id: "PLjwvTaJGeSmTR9x_r_wXZCrwRXiNjDmnA", label: "Jackass - Nuggets" },
    { id: "PLjwvTaJGeSmTRxXrtO7ufnX28B3a4ojYk", label: "Punk'd - Full Episodes" },
    { id: "PLXUBfJihF4_Bj6INx79to31FAo-Dm7R8m", label: "Punk'd - Full Episodes 2" },
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

const BUMPER_PLAYLISTS = [
  { id: "PLnG7oFaM6TYqDLvZ_PBY79Pn68BFbv17w", label: "MTV Bumpers 1" },
  { id: "PLLHK2qXpOJlq07tC0I0aMZ8LbdsSj3jAF", label: "MTV Bumpers 2" },
  { id: "PLMl84_AytMHWf2ZHFbtpskMANEwKoPvZ5", label: "MTV Bumpers 3" }
];

// ============================================
// HELPER FUNCTIONS (from index.js)
// ============================================

function cleanTitle(title) {
  let cleaned = title
    .replace(/[\(\[\{][^\)\]\}]*Official\s+Music\s+Video[^\)\]\}]*[\)\]\}]/gi, '')
    .replace(/[\(\[\{][^\)\]\}]*Official\s+Video[^\)\]\}]*[\)\]\}]/gi, '')
    .replace(/\[HD\]/gi, '');
  return cleaned.trim();
}

function parseTitle(title, channel = null) {
  if (channel === 'live' || channel === 'bumper') {
    return { title };
  }

  const separatorIndex = title.indexOf(' - ');
  if (separatorIndex > 0) {
    return {
      title: title,  // Always keep the full title
      artist: title.substring(0, separatorIndex).trim(),
      song: title.substring(separatorIndex + 3).trim()
    };
  } else {
    return { title };
  }
}

function parseDuration(isoDuration) {
  const match = isoDuration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;
  const hours = parseInt(match[1] || 0);
  const minutes = parseInt(match[2] || 0);
  const seconds = parseInt(match[3] || 0);
  return hours * 3600 + minutes * 60 + seconds;
}

async function fetchPlaylistItems(playlistId, channel = null) {
  if (!API_KEY) {
    throw new Error('YouTube API key not found in .env');
  }

  let allVideos = [];
  let nextPageToken = null;
  let pageCount = 0;

  do {
    try {
      const response = await axios.get('https://www.googleapis.com/youtube/v3/playlistItems', {
        params: {
          part: 'snippet,contentDetails',
          playlistId: playlistId,
          maxResults: 50,
          pageToken: nextPageToken,
          key: API_KEY
        }
      });

      const items = response.data.items || [];
      
      for (const item of items) {
        const videoId = item.contentDetails?.videoId;
        const rawTitle = item.snippet?.title || '';

        if (!videoId || rawTitle === 'Private video' || rawTitle === 'Deleted video') {
          continue;
        }

        const cleanedTitle = cleanTitle(rawTitle);
        const parsed = parseTitle(cleanedTitle, channel);

        allVideos.push({
          id: videoId,
          ...parsed
        });
      }

      nextPageToken = response.data.nextPageToken;
      pageCount++;

    } catch (error) {
      console.error(`Error fetching playlist ${playlistId}:`, error.message);
      break;
    }
  } while (nextPageToken);

  console.log(`  └─ Fetched ${allVideos.length} videos from ${pageCount} page(s)`);
  return allVideos;
}

async function getVideoDurations(videoIds) {
  if (!API_KEY) {
    throw new Error('YouTube API key not found in .env');
  }

  const results = [];

  for (let i = 0; i < videoIds.length; i += 50) {
    const batch = videoIds.slice(i, i + 50);
    
    try {
      const response = await axios.get('https://www.googleapis.com/youtube/v3/videos', {
        params: {
          part: 'contentDetails',
          id: batch.join(','),
          key: API_KEY
        }
      });

      const items = response.data.items || [];
      for (const item of items) {
        const duration = parseDuration(item.contentDetails.duration);
        results.push({ id: item.id, duration });
      }
    } catch (error) {
      console.error('Error fetching video durations:', error.message);
    }
  }

  return results;
}

// ============================================
// DATABASE FUNCTIONS
// ============================================

async function initDatabase() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15000
  });

  console.log('Attempting to connect to database...');
  await client.connect();
  console.log('✅ Connected to database\n');
  return client;
}

async function insertOrGetVideo(client, videoData) {
  const { youtube_video_id, title, artist, song, duration_seconds } = videoData;

  // Check if video already exists
  const checkResult = await client.query(
    'SELECT id FROM videos WHERE youtube_video_id = $1',
    [youtube_video_id]
  );

  if (checkResult.rows.length > 0) {
    return checkResult.rows[0].id;
  }

  // Insert new video
  const insertResult = await client.query(
    `INSERT INTO videos (youtube_video_id, title, artist, song, duration_seconds)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [youtube_video_id, title || null, artist || null, song || null, duration_seconds]
  );

  return insertResult.rows[0].id;
}

async function insertOrGetPlaylist(client, name, description = null) {
  // Check if playlist already exists by name
  const checkResult = await client.query(
    'SELECT id FROM playlists WHERE name = $1',
    [name]
  );

  if (checkResult.rows.length > 0) {
    return checkResult.rows[0].id;
  }

  // Insert new playlist
  const insertResult = await client.query(
    `INSERT INTO playlists (name, description)
     VALUES ($1, $2)
     RETURNING id`,
    [name, description]
  );

  return insertResult.rows[0].id;
}

async function linkPlaylistToChannel(client, playlistId, channelId) {
  // Check if link already exists
  const checkResult = await client.query(
    'SELECT 1 FROM channel_playlists WHERE channel_id = $1 AND playlist_id = $2',
    [channelId, playlistId]
  );

  if (checkResult.rows.length > 0) {
    return; // Already linked
  }

  await client.query(
    'INSERT INTO channel_playlists (channel_id, playlist_id) VALUES ($1, $2)',
    [channelId, playlistId]
  );
}

async function linkVideoToPlaylist(client, videoId, playlistId, position = null) {
  // Check if link already exists
  const checkResult = await client.query(
    'SELECT 1 FROM playlist_videos WHERE playlist_id = $1 AND video_id = $2',
    [playlistId, videoId]
  );

  if (checkResult.rows.length > 0) {
    return; // Already linked
  }

  await client.query(
    'INSERT INTO playlist_videos (playlist_id, video_id, position) VALUES ($1, $2, $3)',
    [playlistId, videoId, position]
  );
}

async function insertBumper(client, bumperData) {
  const { youtube_video_id, title, duration_seconds } = bumperData;

  // Check if bumper already exists
  const checkResult = await client.query(
    'SELECT id FROM bumpers WHERE youtube_video_id = $1',
    [youtube_video_id]
  );

  if (checkResult.rows.length > 0) {
    return checkResult.rows[0].id;
  }

  // Insert new bumper
  const insertResult = await client.query(
    `INSERT INTO bumpers (youtube_video_id, title, duration_seconds)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [youtube_video_id, title, duration_seconds]
  );

  return insertResult.rows[0].id;
}

// ============================================
// MAIN MIGRATION LOGIC
// ============================================

async function migrateChannelPlaylists(client) {
  console.log('📺 Migrating channel playlists...\n');

  let totalPlaylists = 0;
  let totalVideos = 0;

  for (const [channelId, playlists] of Object.entries(CHANNELS)) {
    console.log(`\n🎵 Processing channel: ${channelId.toUpperCase()}`);

    for (const playlistConfig of playlists) {
      const { id: youtubePlaylistId, label } = playlistConfig;
      
      console.log(`\n  📋 Playlist: "${label}"`);
      console.log(`     YouTube ID: ${youtubePlaylistId}`);

      try {
        // Fetch videos from YouTube
        const videos = await fetchPlaylistItems(youtubePlaylistId, channelId);

        if (videos.length === 0) {
          console.log('     ⚠️ No videos found, skipping...');
          continue;
        }

        // Get video durations
        const videoIds = videos.map(v => v.id);
        const durations = await getVideoDurations(videoIds);
        const durationMap = new Map(durations.map(d => [d.id, d.duration]));

        // Create app playlist
        const playlistId = await insertOrGetPlaylist(client, label);
        console.log(`     ✅ Playlist created/found (DB ID: ${playlistId})`);

        // Link playlist to channel
        await linkPlaylistToChannel(client, playlistId, channelId);
        console.log(`     🔗 Linked to channel "${channelId}"`);

        // Insert videos
        let videoCount = 0;
        for (let i = 0; i < videos.length; i++) {
          const video = videos[i];
          const duration = durationMap.get(video.id) || 0;

          const videoId = await insertOrGetVideo(client, {
            youtube_video_id: video.id,
            title: video.title || null,
            artist: video.artist || null,
            song: video.song || null,
            duration_seconds: duration
          });

          await linkVideoToPlaylist(client, videoId, playlistId, i + 1);
          videoCount++;
        }

        console.log(`     ✅ Inserted ${videoCount} videos`);
        totalPlaylists++;
        totalVideos += videoCount;

      } catch (error) {
        console.error(`     ❌ Error processing playlist: ${error.message}`);
      }
    }
  }

  console.log(`\n✅ Migration complete!`);
  console.log(`   Total playlists: ${totalPlaylists}`);
  console.log(`   Total videos: ${totalVideos}`);
}

async function migrateBumpers(client) {
  console.log('\n\n🎬 Migrating bumpers...\n');

  let totalBumpers = 0;

  for (const playlistConfig of BUMPER_PLAYLISTS) {
    const { id: youtubePlaylistId, label } = playlistConfig;
    
    console.log(`  📋 Bumper Playlist: "${label}"`);
    console.log(`     YouTube ID: ${youtubePlaylistId}`);

    try {
      // Fetch bumpers from YouTube
      const bumpers = await fetchPlaylistItems(youtubePlaylistId, 'bumper');

      if (bumpers.length === 0) {
        console.log('     ⚠️ No bumpers found, skipping...');
        continue;
      }

      // Get video durations
      const videoIds = bumpers.map(b => b.id);
      const durations = await getVideoDurations(videoIds);
      const durationMap = new Map(durations.map(d => [d.id, d.duration]));

      // Filter bumpers by duration (≤ 90 seconds)
      let bumperCount = 0;
      for (const bumper of bumpers) {
        const duration = durationMap.get(bumper.id) || 0;

        if (duration <= MAX_BUMPER_DURATION && duration > 0) {
          await insertBumper(client, {
            youtube_video_id: bumper.id,
            title: bumper.title || 'Bumper',
            duration_seconds: duration
          });
          bumperCount++;
        }
      }

      console.log(`     ✅ Inserted ${bumperCount} bumpers (≤${MAX_BUMPER_DURATION}s)`);
      totalBumpers += bumperCount;

    } catch (error) {
      console.error(`     ❌ Error processing bumper playlist: ${error.message}`);
    }
  }

  console.log(`\n✅ Bumpers migration complete!`);
  console.log(`   Total bumpers: ${totalBumpers}`);
}

async function main() {
  console.log('🚀 Starting NMTV Database Migration\n');
  console.log('=' .repeat(60));

  if (!API_KEY) {
    console.error('❌ ERROR: YOUTUBE_API_KEY not found in .env file');
    process.exit(1);
  }

  if (!process.env.DATABASE_URL) {
    console.error('❌ ERROR: DATABASE_URL not found in .env file');
    console.error('   Please add your Supabase connection string to .env');
    process.exit(1);
  }

  let client;

  try {
    // Connect to database
    client = await initDatabase();

    // Migrate channel playlists and videos
    await migrateChannelPlaylists(client);

    // Migrate bumpers
    await migrateBumpers(client);

    console.log('\n' + '='.repeat(60));
    console.log('🎉 Migration completed successfully!');
    console.log('   Check your Supabase dashboard to verify the data.');

  } catch (error) {
    console.error('\n❌ Migration failed:', error);
    process.exit(1);
  } finally {
    if (client) {
      await client.end();
      console.log('\n📊 Database connection closed');
    }
  }
}

// Run migration
main();
