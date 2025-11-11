# NMTV Music Channel - Backend

Node.js/Express backend API for the NMTV Music Channel application.

## Features

- YouTube Data API v3 integration
- IMVDb API for music video metadata
- Playlist caching system (24-hour cache)
- Bumper/ident video system
- Rate limiting and security middleware
- CORS configuration for frontend communication

## Prerequisites

- Node.js (v18 or higher)
- npm or yarn
- YouTube Data API v3 key
- IMVDb API key

## Environment Variables

Create a `.env` file in the root directory:

```env
YOUTUBE_API_KEY=your_youtube_api_key_here
IMVDB_API_KEY=your_imvdb_api_key_here
FRONTEND_URL=http://localhost:4200
PORT=3001
```

## Installation

```bash
npm install
```

## Running Locally

```bash
npm start
```

The server will start on `http://localhost:3001`

## API Endpoints

### Get Channel Videos
```
GET /api/channel/:id?custom=playlistId1,playlistId2&skipCustom=false
```

### Get Next Batch
```
POST /api/channel/:id/next
Body: { excludeIds: [], customPlaylistIds: [] }
```

### Validate Playlist
```
GET /api/validate-playlist/:playlistId
```

### Get Video Year
```
GET /api/video/year?title=Artist - Song
```

### Health Check
```
GET /health
```

## Deployment (Render)

1. Push this repo to GitHub
2. Create a new Web Service in Render
3. Connect your GitHub repository
4. Render will auto-detect the Node.js environment
5. Set environment variables in the Render dashboard:
   - `YOUTUBE_API_KEY`
   - `IMVDB_API_KEY`
   - `FRONTEND_URL` (your Vercel frontend URL)
6. Deploy!

Render will use the configuration in `render.yaml`

## Project Structure

```
backend/
├── index.js           # Main server file
├── package.json       # Dependencies
├── .env              # Environment variables (local)
├── .env.example      # Example environment file
├── render.yaml       # Render deployment config
└── README.md         # This file
```

## Tech Stack

- **Express.js** - Web framework
- **Axios** - HTTP client for API requests
- **CORS** - Cross-origin resource sharing
- **Helmet** - Security headers
- **express-rate-limit** - Rate limiting middleware
- **dotenv** - Environment variable management

## License

MIT
