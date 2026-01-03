/**
 * Merge Live Channel Playlists
 * 
 * Combines all playlists associated with the 'live' channel into a single unified playlist.
 * This script will:
 * 1. Find all playlists linked to the 'live' channel
 * 2. Create a new combined playlist (or use existing one)
 * 3. Copy all videos from all live playlists to the combined playlist
 * 4. Update channel_playlists to point to the combined playlist
 * 5. Optionally remove old playlists
 */

const { Pool } = require('pg');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function mergeLivePlaylists() {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    console.log('🔍 Finding live channel playlists...');
    
    // Get all playlists for the live channel
    const playlistsResult = await client.query(`
      SELECT p.id, p.name, p.description, COUNT(pv.video_id) as video_count
      FROM playlists p
      JOIN channel_playlists cp ON p.id = cp.playlist_id
      LEFT JOIN playlist_videos pv ON p.id = pv.playlist_id
      WHERE cp.channel_id = 'live'
      GROUP BY p.id, p.name, p.description
      ORDER BY p.id
    `);
    
    const livePlaylists = playlistsResult.rows;
    console.log(`Found ${livePlaylists.length} playlist(s) for live channel:`);
    livePlaylists.forEach(p => {
      console.log(`  - ID: ${p.id}, Name: ${p.name}, Videos: ${p.video_count}`);
    });
    
    if (livePlaylists.length === 0) {
      console.log('❌ No playlists found for live channel');
      await client.query('ROLLBACK');
      return;
    }
    
    if (livePlaylists.length === 1) {
      console.log('✅ Only one playlist exists, no merge needed');
      await client.query('ROLLBACK');
      return;
    }
    
    // Create or find the combined playlist
    console.log('\n📝 Creating combined playlist...');
    
    // Check if combined playlist already exists
    const existingPlaylist = await client.query(`
      SELECT id FROM playlists WHERE name = 'Live Performances - Combined'
    `);
    
    let combinedPlaylistId;
    
    if (existingPlaylist.rows.length > 0) {
      combinedPlaylistId = existingPlaylist.rows[0].id;
      console.log(`✓ Found existing combined playlist ID: ${combinedPlaylistId}`);
    } else {
      const newPlaylist = await client.query(`
        INSERT INTO playlists (name, description)
        VALUES ('Live Performances - Combined', 'All live performance videos from multiple sources')
        RETURNING id
      `);
      combinedPlaylistId = newPlaylist.rows[0].id;
      console.log(`✓ Created new combined playlist ID: ${combinedPlaylistId}`);
    }
    
    // Get all unique videos from all live playlists
    console.log('\n📦 Collecting all videos from live playlists...');
    const allVideosResult = await client.query(`
      SELECT DISTINCT v.id
      FROM videos v
      JOIN playlist_videos pv ON v.id = pv.video_id
      JOIN playlists p ON pv.playlist_id = p.id
      JOIN channel_playlists cp ON p.id = cp.playlist_id
      WHERE cp.channel_id = 'live'
    `);
    
    const videoIds = allVideosResult.rows.map(row => row.id);
    console.log(`✓ Found ${videoIds.length} unique videos across all live playlists`);
    
    // Insert all videos into the combined playlist
    console.log('\n🔗 Linking videos to combined playlist...');
    for (const videoId of videoIds) {
      await client.query(`
        INSERT INTO playlist_videos (playlist_id, video_id)
        VALUES ($1, $2)
        ON CONFLICT (playlist_id, video_id) DO NOTHING
      `, [combinedPlaylistId, videoId]);
    }
    console.log(`✓ Linked ${videoIds.length} videos to combined playlist`);
    
    // Link combined playlist to live channel (if not already linked)
    console.log('\n🔗 Linking combined playlist to live channel...');
    await client.query(`
      INSERT INTO channel_playlists (channel_id, playlist_id)
      VALUES ('live', $1)
      ON CONFLICT (channel_id, playlist_id) DO NOTHING
    `, [combinedPlaylistId]);
    console.log('✓ Combined playlist linked to live channel');
    
    // Remove old playlist associations from live channel
    console.log('\n🗑️  Removing old playlist associations from live channel...');
    const oldPlaylistIds = livePlaylists.map(p => p.id);
    await client.query(`
      DELETE FROM channel_playlists
      WHERE channel_id = 'live' 
        AND playlist_id = ANY($1)
        AND playlist_id != $2
    `, [oldPlaylistIds, combinedPlaylistId]);
    console.log('✓ Old playlist associations removed');
    
    // Delete playlist_videos entries for old playlists
    console.log('\n🗑️  Deleting old playlist-video associations...');
    await client.query(`
      DELETE FROM playlist_videos
      WHERE playlist_id = ANY($1) AND playlist_id != $2
    `, [oldPlaylistIds, combinedPlaylistId]);
    console.log('✓ Old playlist-video associations deleted');
    
    // Delete old playlists
    console.log('\n🗑️  Deleting old playlists...');
    await client.query(`
      DELETE FROM playlists
      WHERE id = ANY($1) AND id != $2
    `, [oldPlaylistIds, combinedPlaylistId]);
    console.log('✓ Old playlists deleted');
    
    await client.query('COMMIT');
    
    console.log('\n✅ Live playlists successfully merged!');
    console.log(`\nSummary:`);
    console.log(`  - Combined ${livePlaylists.length} playlists into 1`);
    console.log(`  - Total videos: ${videoIds.length}`);
    console.log(`  - Combined playlist ID: ${combinedPlaylistId}`);
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Error merging playlists:', error);
    throw error;
  } finally {
    client.release();
  }
}

// Run the script
(async () => {
  try {
    await mergeLivePlaylists();
  } catch (error) {
    console.error('Script failed:', error);
    process.exit(1);
  } finally {
    await pool.end();
    console.log('\n👋 Database connection closed');
  }
})();
