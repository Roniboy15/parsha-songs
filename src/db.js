// src/db.js
import Database from "better-sqlite3";

const db = new Database("parsha-songs.db");

// create the tables if they don't exist
db.exec(`
  CREATE TABLE IF NOT EXISTS songs (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    version TEXT,
    external_url TEXT
  );

  CREATE TABLE IF NOT EXISTS links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    parasha_id TEXT NOT NULL,
    target_kind TEXT NOT NULL,   -- 'parasha' or 'haftarah'
    target_id TEXT,              -- haftarah id if target_kind='haftarah'
    song_id TEXT NOT NULL,
    verse_ref TEXT,
    added_by TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    added_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

export default db;
