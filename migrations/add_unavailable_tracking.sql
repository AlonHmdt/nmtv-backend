-- Add new columns
ALTER TABLE videos 
ADD COLUMN unavailable_count INT DEFAULT 0,
ADD COLUMN last_unavailable_at TIMESTAMP;

-- Drop the old is_available column
ALTER TABLE videos DROP COLUMN is_available;

-- Add index for performance
CREATE INDEX idx_videos_unavailable_tracking ON videos(unavailable_count, last_unavailable_at);
