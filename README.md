# Parsha ↔ Songs

A web application for managing connections between Torah portions (parshiot) and songs. Users can link songs to either the weekly Torah reading or its corresponding Haftarah portion.

## Features

- View current week's Torah portion (using HebCal API)
- Browse all parshiot organized by book (Bereshit through Devarim)
- Add songs with optional external links and verse references 
- Link songs to either:
  - Torah portion (parasha)
  - Haftarah reading
- View and manage existing song connections
- Delete links when needed

## Tech Stack

- Frontend: Vanilla JavaScript + HTML/CSS
- Backend: Node.js + Express
- Database: SQLite (via better-sqlite3)
- External API: HebCal for current Torah readings

## Project Structure

```
.
├── data/
│   └── parshiot.json     # Static data for all Torah portions
├── public/
│   ├── index.html        # Main web interface
│   └── styles.css        # Styling
├── scripts/
│   └── build-parshiot-from-hebcal.js    # Data builder
├── src/
│   ├── db.js            # Database setup and schema
│   └── server.js        # Express backend
└── package.json
```

## Getting Started

1. Install dependencies:
```bash
npm install
```

2. Start the development server:
```bash
npm run dev
```

3. Open http://localhost:3000 in your browser

## Database Schema

### Songs Table
- `id`: UUID primary key
- `title`: Song name
- `version`: Optional version info
- `external_url`: Optional link to song

### Links Table
- `id`: Auto-incrementing primary key
- `parasha_id`: Reference to Torah portion
- `target_kind`: Either 'parasha' or 'haftarah'
- `target_id`: Haftarah ID (if linking to haftarah)
- `song_id`: Reference to songs table
- `verse_ref`: Optional Torah/Haftarah verse reference
- `added_by`: Optional user attribution
- `status`: Link status (default 'pending')
- `added_at`: Timestamp

## API Endpoints

- `GET /api/parshiot` - List all Torah portions
- `GET /api/current-reading` - Get current/upcoming Torah reading
- `POST /api/links` - Create new song link
- `GET /api/links` - List links for a parasha
- `DELETE /api/links/:id` - Remove a link
- `DELETE /api/songs/:id` - Remove a song and its links