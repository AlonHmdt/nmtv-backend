/**
 * Merge Playlists Script
 * 
 * This script merges two playlists into one by:
 * 1. Moving all videos from the source playlist to the target playlist
 * 2. Updating channel associations
 * 3. Deleting the source playlist
 * 
 * Usage: node merge-playlists.js <source_playlist_id> <target_playlist_id>
 */

const { Client } = require('pg');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

async function mergePlaylists(sourceId, targetId) {
  console.log(`\n🔄 Merging playlists: ${sourceId} → ${targetId}\n`);

  if (!process.env.DATABASE_URL) {
    console.error('❌ ERROR: DATABASE_URL not found in .env file');
    process.exit(1);
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  try {
    await client.connect();
    console.log('✅ Connected to database\n');

    // Begin transaction
    await client.query('BEGIN');

    // Get playlist details
    const sourceResult = await client.query(
      'SELECT id, name, description FROM playlists WHERE id = $1',
      [sourceId]
    );
    const targetResult = await client.query(
      'SELECT id, name, description FROM playlists WHERE id = $1',
      [targetId]
    );

    if (sourceResult.rows.length === 0) {
      throw new Error(`Source playlist ${sourceId} not found`);
    }
    if (targetResult.rows.length === 0) {
      throw new Error(`Target playlist ${targetId} not found`);
    }

    const sourcePlaylist = sourceResult.rows[0];
    const targetPlaylist = targetResult.rows[0];

    console.log(`📋 Source Playlist: "${sourcePlaylist.name}" (ID: ${sourceId})`);
    console.log(`📋 Target Playlist: "${targetPlaylist.name}" (ID: ${targetId})\n`);

    // Get video count before merge
    const sourceVideosResult = await client.query(
      'SELECT COUNT(*) as count FROM playlist_videos WHERE playlist_id = $1',
      [sourceId]
    );
    const targetVideosResult = await client.query(
      'SELECT COUNT(*) as count FROM playlist_videos WHERE playlist_id = $1',
      [targetId]
    );

    const sourceVideoCount = parseInt(sourceVideosResult.rows[0].count);
    const targetVideoCount = parseInt(targetVideosResult.rows[0].count);

    console.log(`📊 Source playlist has ${sourceVideoCount} videos`);
    console.log(`📊 Target playlist has ${targetVideoCount} videos\n`);

    // Move videos from source to target (avoiding duplicates)
    console.log('🔄 Moving videos from source to target...');
    const moveResult = await client.query(`
      INSERT INTO playlist_videos (playlist_id, video_id, position, created_at)
      SELECT $1, video_id, position, created_at
      FROM playlist_videos
      WHERE playlist_id = $2
      AND video_id NOT IN (
        SELECT video_id FROM playlist_videos WHERE playlist_id = $1
      )
    `, [targetId, sourceId]);

    const movedVideos = moveResult.rowCount;
    console.log(`✅ Moved ${movedVideos} unique videos to target playlist`);

    // Get duplicate count
    const duplicateCount = sourceVideoCount - movedVideos;
    if (duplicateCount > 0) {
      console.log(`ℹ️  Skipped ${duplicateCount} duplicate videos\n`);
    } else {
      console.log('');
    }

    // Move channel associations (avoiding duplicates)
    console.log('🔄 Moving channel associations...');
    const channelResult = await client.query(`
      INSERT INTO channel_playlists (channel_id, playlist_id, created_at)
      SELECT channel_id, $1, created_at
      FROM channel_playlists
      WHERE playlist_id = $2
      AND channel_id NOT IN (
        SELECT channel_id FROM channel_playlists WHERE playlist_id = $1
      )
    `, [targetId, sourceId]);

    console.log(`✅ Moved ${channelResult.rowCount} channel associations\n`);

    // Delete the source playlist (CASCADE will delete related records)
    console.log('🗑️  Deleting source playlist...');
    await client.query('DELETE FROM playlists WHERE id = $1', [sourceId]);
    console.log(`✅ Deleted playlist ${sourceId}\n`);

    // Get final video count
    const finalCountResult = await client.query(
      'SELECT COUNT(*) as count FROM playlist_videos WHERE playlist_id = $1',
      [targetId]
    );
    const finalCount = parseInt(finalCountResult.rows[0].count);

    // Commit transaction
    await client.query('COMMIT');

    console.log('=' .repeat(60));
    console.log('✅ Merge completed successfully!');
    console.log(`   Target playlist now has ${finalCount} videos`);
    console.log(`   Original: ${targetVideoCount} → Final: ${finalCount}`);
    console.log('=' .repeat(60) + '\n');

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('\n❌ Merge failed:', error.message);
    process.exit(1);
  } finally {
    await client.end();
    console.log('📊 Database connection closed\n');
  }
}

// Parse command line arguments
const args = process.argv.slice(2);

if (args.length < 2) {
  console.error('\n❌ Usage: node merge-playlists.js <source_playlist_id> <target_playlist_id>');
  console.error('   Example: node merge-playlists.js 26 25\n');
  process.exit(1);
}

const sourceId = parseInt(args[0]);
const targetId = parseInt(args[1]);

if (isNaN(sourceId) || isNaN(targetId)) {
  console.error('\n❌ ERROR: Playlist IDs must be numbers\n');
  process.exit(1);
}

if (sourceId === targetId) {
  console.error('\n❌ ERROR: Source and target playlist IDs must be different\n');
  process.exit(1);
}

// Run the merge
mergePlaylists(sourceId, targetId);
