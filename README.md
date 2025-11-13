# Parsha ↔ Songs

A web application for discovering and sharing songs that connect to the Torah reading. You can now link songs not only to Parshiot and Haftarot, but also to any book and chapter in Tanach.

## Features

- View current week's Torah portion (via HebCal)
- Browse all Parshiot (organized by the 5 books of the Torah)
- NEW: Pick any Tanach book and chapter, and link songs to that chapter
- Add songs with optional external links and verse references
- Link songs to one of:
  - Torah portion (parasha)
  - Haftarah reading
  - Tanach chapter (any book + chapter)
- Smooth scrolling and loading indicator for better UX
- Admin mode: delete links, moderate pending submissions, and view visit stats

## Tech Stack

- Frontend: Vanilla JavaScript + HTML/CSS (no framework)
- Backend: Node.js + Express
- Database: SQLite locally, Postgres on Render (automatically selected)
- External API: HebCal (current reading). Sefaria is not required at runtime; a static fallback list is used for Tanach books.

## Project Structure

```
.
├── data/
│   └── parshiot.json           # Static data for all Torah portions
├── src/
│   ├── auth/
│   │   └── session.js          # Session middleware
│   ├── data/
│   │   └── tanachFallback.js   # Static Tanach book list + chapter counts (no runtime API call)
│   ├── middlewares/
│   │   ├── adminAuth.js        # Admin guard
│   │   ├── rateLimit.js        # Basic rate limiting
│   │   └── validate.js         # Zod-based validators hook
│   ├── validation/
│   │   └── schemas.js          # Zod schemas (links, queries)
│   ├── db.js                   # Database setup and helpers (SQLite / Postgres)
│   └── server.js               # Express backend
├── public/
│   ├── index.html        # Main web interface
│   └── styles.css        # Styling
├── scripts/
│   └── build-parshiot-from-hebcal.js    # Data builder
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

Environment variables (optional):
- ADMIN_TOKEN: string used for admin login
- DATABASE_URL: Postgres connection string (set on Render); if absent, SQLite is used
- APPROVAL_BASE_URL: optional; absolute base URL used when generating approval links in notification emails (falls back to PUBLIC_BASE_URL or request host)
- SMTP_HOST/SMTP_USER/SMTP_PASS (optional): email notifications; otherwise a webhook or console log is used

## Data Model

### songs
- `id` (uuid / text): primary key
- `title` (text): song title (user-provided)
- `version` (text, optional): not required by the UI; may exist for legacy data
- `external_url` (text, optional): a single canonical URL for this song

### links
- `id` (serial / integer): primary key
- `parasha_id` (text, not null):
  - For parasha/haftarah targets: the parasha id
  - For tanach targets: the book id (placeholder to satisfy NOT NULL)
- `target_kind` (text): 'parasha' | 'haftarah' | 'tanach'
- `target_id` (text, optional):
  - For haftarah: the haftarah id
  - For tanach: book-and-chapter key `"<book_id>:<chapter>"`
- `song_id` (uuid / text): FK to `songs`
- `verse_ref` (text, optional): freeform user input
- `added_by` (text, optional)
- `status` (text, default 'pending')
- `added_at` (timestamp)

Notes on song identity and links:
- A song’s URL is stored on the `songs` table. If you add a link to an existing title and provide a URL, the stored song URL is updated and reused in all lists where that song appears.
- The “total songs” counter shows COUNT of distinct songs linked (not total links).

## API Endpoints

Public
- `GET /api/parshiot` — list all parshiot
- `GET /api/current-reading?loc=diaspora|israel` — next Shabbat’s reading (via HebCal)
- `GET /api/tanach/books` — list Tanach books with chapter counts (served from static fallback)
- `GET /api/links?parasha_id=<id>&target_kind=parasha|haftarah` — list links for a parasha/haftarah
- `GET /api/links-tanach?book_id=<id>&chapter=<n>` — list links for a Tanach chapter
- `GET /api/total-songs` — total number of distinct songs linked

Writes
- `POST /api/links` — create a link to a song
  - body: `{ parasha_id, target_kind, [target_id], [book_id], [chapter], song: { title, [external_url] }, [verse_ref], [added_by] }`

Admin
- `POST /api/admin/login` — body: `{ token }` (compares to `ADMIN_TOKEN`)
- `POST /api/admin/logout`
- `GET /api/admin/verify`
- `GET /api/admin/links/pending` — list submissions waiting for approval
- `POST /api/admin/links/:id/approve` — publish a pending submission
- `POST /api/admin/links/:id/reject` — decline a pending submission (keeps record hidden)
- `DELETE /api/links/:id` — delete a link
- `DELETE /api/songs/:id` — delete a song (and its links)
- `GET /api/stats` — basic visit stats

Public approval flow
- `GET /api/links/approve/:token` — approve a pending submission via emailed token (useful when moderating from email)

## UX Notes

- You can link songs by:
  - Loading this week’s parasha
  - Picking from the parsha list (parasha/haftarah)
  - Picking a Tanach book and chapter
- The page scrolls down automatically to the results table after loading.
- The three orange dots indicate a load is in progress.

## Tanach Books

At runtime the app serves a static fallback list of Tanach books and chapter counts from `src/data/tanachFallback.js`. No Sefaria API calls are needed.