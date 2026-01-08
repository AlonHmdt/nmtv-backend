# Location-Restricted Video Handling System

## Overview

This system intelligently handles videos that fail due to location/region restrictions, preventing them from being permanently removed for all users worldwide.

## Problem Solved

Previously, when a video failed to play for any reason, it was marked as `is_available = false` and excluded for **all users globally**. This was problematic because some videos fail only due to location restrictions and work fine for users in other regions.

## Solution

### Two-Tier Video Flagging System

1. **Permanently Unavailable** (`is_available = false`)
   - Videos that are deleted, private, or have copyright strikes
   - These are filtered out globally

2. **Location-Restricted** (`is_limited = true`)
   - Videos that may work in some regions but not others
   - These are still sent to clients but gracefully skipped if playback fails
   - No database update occurs when these fail (prevents false negatives)

## Database Schema

```sql
CREATE TABLE videos (
  -- ... existing columns ...
  is_available BOOLEAN DEFAULT TRUE,      -- Global availability
  is_limited BOOLEAN DEFAULT FALSE,       -- Location-restricted flag
  flag_reason TEXT,                       -- Stores YouTube error codes
  -- ... other columns ...
);
```

## How It Works

### 1. Initial Video Failure

When a video fails to play on the client:

```typescript
// Frontend captures YouTube error code
onPlayerError(event: any) {
  const errorCode = event.data; // e.g., 150 for region restriction
  this.handleUnavailableVideo(errorCode);
}
```

### 2. Error Code Storage

The error code is sent to the backend and stored:

```javascript
// Backend stores error in flag_reason
await markVideoUnavailable(videoId, errorCode);
// SQL: UPDATE videos SET is_available = false, flag_reason = 'YouTube Error Code: 150'
```

### 3. Manual Review Process

Periodically review flagged videos in Supabase:

1. Open your Supabase dashboard
2. Navigate to the `videos` table
3. Filter by `is_available = false` to see unavailable videos
4. Check the `flag_reason` column to see error codes
5. For videos with error code 150, verify if they're location-restricted
6. If confirmed, update:
   - `is_limited = true`
   - `is_available = true`

**Important:** Error code 150 doesn't always mean location restrictions - it can indicate other playback issues. Always verify before marking.

### 4. Client-Side Handling

When a video with `isLimited = true` fails to play:

```typescript
if (currentVideo.isLimited) {
  // Just skip to next video - don't mark as unavailable
  this.skipToNext();
  return;
}

// Otherwise, mark as unavailable
this.markVideoAsUnavailable(videoId, errorCode);
```

## YouTube Error Codes

| Code | Meaning | Action |
|------|---------|--------|
| 2 | Invalid video ID | Mark unavailable |
| 5 | HTML5 player error | Retry, then mark unavailable |
| 100 | Video not found/private | Mark unavailable |
| 101 | Embedding disabled | Mark unavailable |
| **150** | **Region restriction** | **Mark unavailable initially, then review** |

## Workflow Diagram

```
Video Fails
    │
    ├─→ is_limited = true?
    │       │
    │       ├─→ YES: Skip silently (don't update DB)
    │       │
    │       └─→ NO: Mark as unavailable + save error code
    │               │
    │               └─→ Admin reviews error codes
    │                       │
    │                       ├─→ Error 150? Mark as is_limited = true
    │                       │
    │                       └─→ Other error? Keep unavailable
```

## Migration

Run the migration in Supabase SQL Editor:

```sql
ALTER TABLE videos ADD COLUMN IF NOT EXISTS is_limited BOOLEAN DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS idx_videos_limited ON videos(is_limited);
```

## API Changes

### Backend API

**Endpoint:** `POST /api/videos/:videoId/unavailable`

**Request Body:**
```json
{
  "errorCode": 150
}
```

**Response:**
```json
{
  "success": true,
  "message": "Video marked as unavailable",
  "videoId": "abc123",
  "errorCode": 150
}
```

### Frontend Model

```typescript
interface Video {
  id: string;
  title?: string;
  artist?: string;
  song?: string;
  isLimited?: boolean; // NEW: Location-restricted flag
  // ... other fields
}
```

## Benefits

1. ✅ **Better User Experience** - Videos work for users in supported regions
2. ✅ **Accurate Data** - Database reflects true video availability, not location bias
3. ✅ **Debugging** - Error codes help identify patterns and issues
4. ✅ **Flexibility** - Manual review ensures accuracy before re-enabling videos
5. ✅ **Performance** - Graceful client-side skipping without unnecessary API calls

## Best Practices

1. **Regular Reviews** - Check flagged videos weekly to identify new location-restricted content
2. **Error Analysis** - Review `flag_reason` patterns to improve detection
3. **Testing** - Test from different regions to verify location restrictions
4. **Monitoring** - Track how many videos are marked `is_limited` over time

## Future Enhancements

Consider implementing:
- Auto-detection of error code 150 → automatic `is_limited = true`
- Store client IP/region when flagging to identify geographic patterns
- Track flag count per video to identify systematic issues
- API endpoint for admins to manually toggle `is_limited` status

## Questions?

See [PROJECT_ARCHITECTURE.md](../PROJECT_ARCHITECTURE.md) for overall system architecture.
