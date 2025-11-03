// src/db.js
// Use Postgres on Render (when DATABASE_URL is set)
// Use SQLite locally (when DATABASE_URL is NOT set)

import process from "node:process";

const usePg = !!process.env.DATABASE_URL;

let pgPool = null;
let sqliteDb = null;

if (usePg) {
  // ---------- POSTGRES MODE ----------
  const { Pool } = await import("pg");

  pgPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }, // Render needs this
  });

  // create tables
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS songs (
      id UUID PRIMARY KEY,
      title TEXT NOT NULL,
      version TEXT,
      external_url TEXT
    );
  `);

  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS links (
      id SERIAL PRIMARY KEY,
      parasha_id TEXT NOT NULL,
      target_kind TEXT NOT NULL,
      target_id TEXT,
      song_id UUID NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
      verse_ref TEXT,
      added_by TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      added_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
} else {
  // ---------- SQLITE MODE ----------
  const { default: Database } = await import("better-sqlite3");
  sqliteDb = new Database("parsha-songs.db");
  sqliteDb.pragma("busy_timeout = 5000");
  sqliteDb.exec(`
    CREATE TABLE IF NOT EXISTS songs (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      version TEXT,
      external_url TEXT
    );
    CREATE TABLE IF NOT EXISTS links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      parasha_id TEXT NOT NULL,
      target_kind TEXT NOT NULL,
      target_id TEXT,
      song_id TEXT NOT NULL,
      verse_ref TEXT,
      added_by TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      added_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

// ---------- helper functions (same names for both backends) ----------

// find song by (title, version)
async function findSongByTitleVersion(title, version) {
  if (usePg) {
    const { rows } = await pgPool.query(
      `SELECT * FROM songs WHERE title = $1 AND COALESCE(version,'') = COALESCE($2,'') LIMIT 1`,
      [title, version || null]
    );
    return rows[0] || null;
  } else {
    return sqliteDb
      .prepare(
        "SELECT * FROM songs WHERE title = ? AND ifnull(version,'') = ifnull(?, '') LIMIT 1"
      )
      .get(title, version || null);
  }
}

// insert song
async function insertSong(id, title, version, external_url) {
  if (usePg) {
    await pgPool.query(
      `INSERT INTO songs (id, title, version, external_url) VALUES ($1, $2, $3, $4)`,
      [id, title, version || null, external_url || null]
    );
  } else {
    sqliteDb
      .prepare(
        "INSERT INTO songs (id, title, version, external_url) VALUES (?, ?, ?, ?)"
      )
      .run(id, title, version || null, external_url || null);
  }
}

// insert link
async function insertLink({
  parasha_id,
  target_kind,
  target_id,
  song_id,
  verse_ref,
  added_by,
}) {
  if (usePg) {
    const { rows } = await pgPool.query(
      `INSERT INTO links
        (parasha_id, target_kind, target_id, song_id, verse_ref, added_by, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending')
       RETURNING id`,
      [
        parasha_id,
        target_kind,
        target_id || null,
        song_id,
        verse_ref || null,
        added_by || null,
      ]
    );
    return rows[0].id;
  } else {
    const info = sqliteDb
      .prepare(
        `INSERT INTO links
          (parasha_id, target_kind, target_id, song_id, verse_ref, added_by, status)
         VALUES (?, ?, ?, ?, ?, ?, 'pending')`
      )
      .run(
        parasha_id,
        target_kind,
        target_id || null,
        song_id,
        verse_ref || null,
        added_by || null
      );
    return info.lastInsertRowid;
  }
}

// get all links for a parasha (optionally filter by kind)
async function getLinksByParasha(parasha_id, target_kind = null) {
  if (usePg) {
    const params = [parasha_id];
    let sql = `
      SELECT l.id,
             l.parasha_id,
             l.target_kind,
             l.target_id,
             l.verse_ref,
             l.added_at,
             s.title AS song_title,
             s.external_url AS song_url
      FROM links l
      JOIN songs s ON l.song_id = s.id
      WHERE l.parasha_id = $1
    `;
    if (target_kind) {
      sql += " AND l.target_kind = $2";
      params.push(target_kind);
    }
    sql += " ORDER BY l.added_at DESC";
    const { rows } = await pgPool.query(sql, params);
    return rows;
  } else {
    const params = [parasha_id];
    let sql = `
      SELECT l.id,
             l.parasha_id,
             l.target_kind,
             l.target_id,
             l.verse_ref,
             l.added_at,
             s.title AS song_title,
             s.external_url AS song_url
      FROM links l
      JOIN songs s ON l.song_id = s.id
      WHERE l.parasha_id = ?
    `;
    if (target_kind) {
      sql += " AND l.target_kind = ?";
      params.push(target_kind);
    }
    sql += " ORDER BY l.added_at DESC";
    return sqliteDb.prepare(sql).all(...params);
  }
}

// delete one link
async function deleteLink(id) {
  if (usePg) {
    const { rowCount } = await pgPool.query(
      `DELETE FROM links WHERE id = $1`,
      [id]
    );
    return rowCount;
  } else {
    const info = sqliteDb.prepare(`DELETE FROM links WHERE id = ?`).run(id);
    return info.changes;
  }
}

// delete a song (and links, PG will cascade)
async function deleteSong(id) {
  if (usePg) {
    // will cascade due to FK
    const { rowCount } = await pgPool.query(
      `DELETE FROM songs WHERE id = $1`,
      [id]
    );
    return rowCount;
  } else {
    sqliteDb.prepare("DELETE FROM links WHERE song_id = ?").run(id);
    const info = sqliteDb.prepare("DELETE FROM songs WHERE id = ?").run(id);
    return info.changes;
  }
}

// if your connection is `pool`:
const db = usePg ? pgPool : sqliteDb;
export default db;

// helper to get total distinct songs across links
export async function getTotalSongs() {
  if (usePg) {
    const { rows } = await pgPool.query(
      `SELECT COUNT(DISTINCT song_id) as total FROM links`
    );
    return rows[0]?.total || 0;
  } else {
    const row = sqliteDb
      .prepare(`SELECT COUNT(DISTINCT song_id) as total FROM links`)
      .get();
    return row?.total || 0;
  }
}

export {
  usePg,
  findSongByTitleVersion,
  insertSong,
  insertLink,
  getLinksByParasha,
  deleteLink,
  deleteSong,
};
