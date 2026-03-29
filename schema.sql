-- NMTV Database Schema
-- PostgreSQL schema for Supabase

-- ============================================
-- 1. CHANNELS TABLE
-- ============================================
CREATE TABLE channels (
  id VARCHAR(50) PRIMARY KEY,  -- 'rock', 'hiphop', '2000s', etc.
  name VARCHAR(100) NOT NULL,
  icon VARCHAR(10),
  is_easter_egg BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);

-- ============================================
-- 2. PLAYLISTS TABLE (app-level playlists)
-- ============================================
CREATE TABLE playlists (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,  -- e.g., "Top Rock Of All Time"
  description TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- ============================================
-- 3. CHANNEL_PLAYLISTS (many-to-many junction)
-- ============================================
CREATE TABLE channel_playlists (
  channel_id VARCHAR(50) REFERENCES channels(id) ON DELETE CASCADE,
  playlist_id INTEGER REFERENCES playlists(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (channel_id, playlist_id)
);

-- ============================================
-- 4. VIDEOS TABLE
-- ============================================
CREATE TABLE videos (
  id SERIAL PRIMARY KEY,
  youtube_video_id VARCHAR(50) UNIQUE NOT NULL,
  title VARCHAR(500) NOT NULL,
  artist VARCHAR(255),
  song VARCHAR(255),
  duration_seconds INTEGER,
  year INTEGER,  -- Release year (nullable)
  is_flagged BOOLEAN DEFAULT FALSE,
  flag_reason TEXT,
  unavailable_count INT DEFAULT 0,  -- Counter for unavailability reports
  last_unavailable_at TIMESTAMP,  -- Last time video was marked unavailable
  is_limited BOOLEAN DEFAULT FALSE,  -- True for location/region-restricted videos
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- ============================================
-- 5. PLAYLIST_VIDEOS (many-to-many junction)
-- ============================================
CREATE TABLE playlist_videos (
  playlist_id INTEGER REFERENCES playlists(id) ON DELETE CASCADE,
  video_id INTEGER REFERENCES videos(id) ON DELETE CASCADE,
  position INTEGER,  -- order in playlist (nullable for shuffled playback)
  created_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (playlist_id, video_id)
);

-- ============================================
-- 6. BUMPERS TABLE (separate from videos)
-- ============================================
CREATE TABLE bumpers (
  id SERIAL PRIMARY KEY,
  youtube_video_id VARCHAR(50) UNIQUE NOT NULL,
  title VARCHAR(500) NOT NULL,
  duration_seconds INTEGER NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- ============================================
-- INDEXES for performance
-- ============================================
CREATE INDEX idx_videos_youtube_id ON videos(youtube_video_id);
CREATE INDEX idx_videos_flagged ON videos(is_flagged);
CREATE INDEX idx_videos_unavailable_tracking ON videos(unavailable_count, last_unavailable_at);
CREATE INDEX idx_videos_limited ON videos(is_limited);
CREATE INDEX idx_bumpers_youtube_id ON bumpers(youtube_video_id);
CREATE INDEX idx_playlist_videos_playlist ON playlist_videos(playlist_id);
CREATE INDEX idx_playlist_videos_video ON playlist_videos(video_id);
CREATE INDEX idx_channel_playlists_channel ON channel_playlists(channel_id);
CREATE INDEX idx_channel_playlists_playlist ON channel_playlists(playlist_id);

-- ============================================
-- 7. SPECIAL EVENTS TABLE
-- ============================================
CREATE TABLE special_events (
  id SERIAL PRIMARY KEY,
  label VARCHAR(255) NOT NULL,           -- e.g., 'Academy Awards'
  icon1 VARCHAR(10) NOT NULL DEFAULT '⭐', -- First emoji icon
  icon2 VARCHAR(10) NOT NULL DEFAULT '⭐', -- Second emoji icon
  is_enabled BOOLEAN DEFAULT FALSE,
  start_date TIMESTAMP,                  -- When the event goes live (nullable = always)
  end_date TIMESTAMP,                    -- When the event ends (nullable = no end)
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- ============================================
-- 8. SPECIAL EVENT PLAYLISTS (junction table)
-- ============================================
CREATE TABLE special_event_playlists (
  special_event_id INTEGER REFERENCES special_events(id) ON DELETE CASCADE,
  youtube_playlist_id VARCHAR(100) NOT NULL,  -- YouTube playlist ID
  label VARCHAR(255),                          -- Optional label for the playlist
  position INTEGER DEFAULT 0,                  -- Ordering
  created_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (special_event_id, youtube_playlist_id)
);

CREATE INDEX idx_special_events_enabled ON special_events(is_enabled);
CREATE INDEX idx_special_events_dates ON special_events(start_date, end_date);
CREATE INDEX idx_special_event_playlists_event ON special_event_playlists(special_event_id);

-- ============================================
-- SEED DATA: Insert channels
-- ============================================
INSERT INTO channels (id, name, icon, is_easter_egg) VALUES
  ('rock', 'Rock', '🤘🏼', FALSE),
  ('hiphop', 'Hip Hop / Rap', '🎤', FALSE),
  ('2000s', '2000s', '📀', FALSE),
  ('1990s', '1990s', '📼', FALSE),
  ('1980s', '1980s', '📺', FALSE),
  ('live', 'Live', '🎸', FALSE),
  ('shows', 'Shows', '🎬', FALSE),
  ('random', 'Random', '🎲', FALSE),
  ('noa', 'NOA', '🎵', TRUE);
