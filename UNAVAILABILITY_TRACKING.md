# Unavailability Tracking System

## Overview
This system tracks video unavailability with a **time-windowed counter** that prevents infinite growth while identifying consistently problematic videos.

## How It Works

### Database Columns
- `unavailable_count` (INT): Number of times video was reported unavailable
- `last_unavailable_at` (TIMESTAMP): Most recent unavailability report
- `is_flagged` (BOOLEAN): Auto-flagged when counter reaches threshold

### Logic

#### When a video is reported unavailable:
1. Check `last_unavailable_at`
2. **If > 30 days ago (or never)**: Reset counter to 1 (fresh start)
3. **If ≤ 30 days**: Increment counter
4. **If counter ≥ 5**: Auto-flag video (`is_flagged = true`)
5. Update `last_unavailable_at` to now

#### Benefits:
- ✅ **No infinite growth** - counter resets after 30 days of no reports
- ✅ **Identifies persistent issues** - videos with recurring problems get flagged
- ✅ **No successful play tracking** - only tracks failures
- ✅ **Automatic flagging** - no manual intervention needed

### Auto-Flagging

When `unavailable_count >= 5`:
- `is_flagged` is set to `true`
- `flag_reason` is set to: `Auto-flagged: {count} unavailable reports (Error: {code})`
- Video is **excluded from playback** (queries filter `WHERE is_flagged = false`)

### Example Scenarios

#### Scenario 1: Temporarily unavailable video
- Day 1: Report → count = 1
- Day 2: Report → count = 2
- Day 35: Report → count = 1 (reset, >30 days passed)
- Result: Never flagged ✅

#### Scenario 2: Persistently broken video
- Day 1: Report → count = 1
- Day 2: Report → count = 2
- Day 3: Report → count = 3
- Day 5: Report → count = 4
- Day 7: Report → count = 5 → **AUTO-FLAGGED** ⚠️
- Result: Removed from playback

#### Scenario 3: Intermittently problematic video
- Day 1: Report → count = 1
- Day 10: Report → count = 2
- Day 20: Report → count = 3
- Day 60: Report → count = 1 (reset)
- Day 65: Report → count = 2
- Result: Never flagged (spread out over time) ✅

## Migration

To apply this system to an existing database:

```bash
cd backend
psql $DATABASE_URL -f migrations/add_unavailable_tracking.sql
```

This will:
1. Add `unavailable_count` and `last_unavailable_at` columns
2. Migrate existing `is_available = false` videos to `unavailable_count = 5` (flagged)
3. Drop the old `is_available` column
4. Add performance indexes

## API Endpoint

### POST `/api/videos/:videoId/unavailable`

**Request Body:**
```json
{
  "errorCode": 150  // Optional YouTube error code
}
```

**Response:**
```json
{
  "success": true,
  "message": "Video unavailability tracked",
  "videoId": "abc123",
  "errorCode": 150
}
```

## Monitoring

### Query flagged videos:
```sql
SELECT 
  youtube_video_id, 
  title, 
  unavailable_count, 
  last_unavailable_at,
  flag_reason
FROM videos 
WHERE is_flagged = true
ORDER BY unavailable_count DESC;
```

### Query videos with recent issues:
```sql
SELECT 
  youtube_video_id, 
  title, 
  unavailable_count, 
  last_unavailable_at
FROM videos 
WHERE unavailable_count > 0 
  AND last_unavailable_at > NOW() - INTERVAL '30 days'
ORDER BY unavailable_count DESC;
```

### Reset a video's counter (if fixed):
```sql
UPDATE videos 
SET 
  unavailable_count = 0,
  last_unavailable_at = NULL,
  is_flagged = false,
  flag_reason = NULL
WHERE youtube_video_id = 'VIDEO_ID';
```

## Configuration

- **Reset window**: 30 days (hardcoded in `db-service.js`)
- **Flag threshold**: 5 reports (hardcoded in `db-service.js`)

To change these values, edit the `markVideoUnavailable` function in [db-service.js](db-service.js).
