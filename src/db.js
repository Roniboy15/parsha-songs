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
      approval_token TEXT,
      approved_at TIMESTAMPTZ,
      added_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS visits (
      id SERIAL PRIMARY KEY,
      ip VARCHAR(45) NOT NULL,
      user_agent TEXT,
      visited_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_visits_ip ON visits(ip);
    CREATE INDEX IF NOT EXISTS idx_visits_date ON visits(visited_at);
  `);

  // ensure new columns exist on older deployments
  await pgPool.query(`ALTER TABLE links ADD COLUMN IF NOT EXISTS approval_token TEXT;`);
  await pgPool.query(`ALTER TABLE links ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;`);
  await pgPool.query(`ALTER TABLE links ALTER COLUMN status SET DEFAULT 'pending';`);
  await pgPool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_links_approval_token
      ON links(approval_token)
      WHERE approval_token IS NOT NULL;
  `);
  await pgPool.query(`
    UPDATE links
       SET status = 'approved'
     WHERE (status IS NULL OR status = '' OR status NOT IN ('approved','pending','rejected'))
        OR (status = 'pending' AND approval_token IS NULL);
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
      approval_token TEXT,
      approved_at TEXT,
      added_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS visits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ip TEXT NOT NULL,
      user_agent TEXT,
      visited_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_visits_ip ON visits(ip);
    CREATE INDEX IF NOT EXISTS idx_visits_date ON visits(visited_at);
  `);

  // Add missing columns for existing SQLite DBs
  const linkColumns = sqliteDb
    .prepare("PRAGMA table_info(links)")
    .all()
    .map((col) => col.name);

  if (!linkColumns.includes("approval_token")) {
    sqliteDb.exec(`ALTER TABLE links ADD COLUMN approval_token TEXT;`);
  }
  if (!linkColumns.includes("approved_at")) {
    sqliteDb.exec(`ALTER TABLE links ADD COLUMN approved_at TEXT;`);
  }

  sqliteDb.exec(`
    UPDATE links
       SET status = 'approved'
     WHERE (status IS NULL OR status = '' OR status NOT IN ('approved','pending','rejected'))
        OR (status = 'pending' AND (approval_token IS NULL OR approval_token = ''));
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

// find song by (title, external_url)
async function findSongByTitleUrl(title, external_url) {
  if (usePg) {
    const { rows } = await pgPool.query(
      `SELECT * FROM songs WHERE title = $1 AND COALESCE(external_url,'') = COALESCE($2,'') LIMIT 1`,
      [title, external_url || null]
    );
    return rows[0] || null;
  } else {
    return sqliteDb
      .prepare(
        "SELECT * FROM songs WHERE title = ? AND ifnull(external_url,'') = ifnull(?, '') LIMIT 1"
      )
      .get(title, external_url || null);
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

// update song external_url (when we re-link an existing title/version with a new URL)
async function updateSongExternalUrl(id, external_url) {
  if (usePg) {
    await pgPool.query(
      `UPDATE songs SET external_url = $2 WHERE id = $1`,
      [id, external_url || null]
    );
  } else {
    sqliteDb
      .prepare(`UPDATE songs SET external_url = ? WHERE id = ?`)
      .run(external_url || null, id);
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
  status = "pending",
  approval_token = null,
  approved_at = null,
}) {
  if (usePg) {
    const { rows } = await pgPool.query(
      `INSERT INTO links
        (parasha_id, target_kind, target_id, song_id, verse_ref, added_by, status, approval_token, approved_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [
        parasha_id,
        target_kind,
        target_id || null,
        song_id,
        verse_ref || null,
        added_by || null,
        status,
        approval_token || null,
        approved_at || null,
      ]
    );
    return rows[0].id;
  } else {
    const info = sqliteDb
      .prepare(
        `INSERT INTO links
          (parasha_id, target_kind, target_id, song_id, verse_ref, added_by, status, approval_token, approved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        parasha_id,
        target_kind,
        target_id || null,
        song_id,
        verse_ref || null,
        added_by || null,
        status,
        approval_token || null,
        approved_at || null
      );
    return info.lastInsertRowid;
  }
}

// get all links for a parasha (optionally filter by kind)
async function getLinksByParasha(parasha_id, target_kind = null, options = {}) {
  const { statuses = ["approved"] } = options;
  if (usePg) {
    const params = [parasha_id];
    let sql = `
      SELECT l.id,
             l.parasha_id,
             l.target_kind,
             l.target_id,
             l.verse_ref,
             l.status,
             l.approved_at,
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
    if (Array.isArray(statuses) && statuses.length > 0) {
      params.push(statuses);
      sql += ` AND l.status = ANY($${params.length})`;
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
             l.status,
             l.approved_at,
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
    if (Array.isArray(statuses) && statuses.length > 0) {
      const placeholders = statuses.map(() => "?").join(",");
      sql += ` AND l.status IN (${placeholders})`;
      params.push(...statuses);
    }
    sql += " ORDER BY l.added_at DESC";
    return sqliteDb.prepare(sql).all(...params);
  }
}

// NEW: get all links for a Tanach book chapter
async function getLinksByTanach(book_id, chapter, options = {}) {
  const { statuses = ["approved"] } = options;
  const targetKey = `${book_id}:${chapter}`;
  if (usePg) {
    const params = [targetKey];
    let sql =
      `
      SELECT l.id,
             l.parasha_id,
             l.target_kind,
             l.target_id,
             l.verse_ref,
             l.status,
             l.approved_at,
             l.added_at,
             s.title AS song_title,
             s.external_url AS song_url
      FROM links l
      JOIN songs s ON l.song_id = s.id
      WHERE l.target_kind = 'tanach'
        AND l.target_id = $1
      `;
    if (Array.isArray(statuses) && statuses.length > 0) {
      params.push(statuses);
      sql += ` AND l.status = ANY($${params.length})`;
    }
    sql += " ORDER BY l.added_at DESC";
    const { rows } = await pgPool.query(sql, params);
    return rows;
  } else {
    let sql =
      `
      SELECT l.id,
             l.parasha_id,
             l.target_kind,
             l.target_id,
             l.verse_ref,
             l.status,
             l.approved_at,
             l.added_at,
             s.title AS song_title,
             s.external_url AS song_url
      FROM links l
      JOIN songs s ON l.song_id = s.id
      WHERE l.target_kind = 'tanach'
        AND l.target_id = ?
      `;
    const params = [targetKey];
    if (Array.isArray(statuses) && statuses.length > 0) {
      const placeholders = statuses.map(() => "?").join(",");
      sql += ` AND l.status IN (${placeholders})`;
      params.push(...statuses);
    }
    sql += " ORDER BY l.added_at DESC";
    const stmt = sqliteDb.prepare(sql);
    return stmt.all(...params);
  }
}

// Approve a link by approval token (used from email confirmation)
async function approveLinkByToken(token) {
  if (!token) return null;
  if (usePg) {
    const { rows } = await pgPool.query(
      `
      WITH updated AS (
        UPDATE links
           SET status = 'approved',
               approval_token = NULL,
               approved_at = COALESCE(approved_at, NOW())
         WHERE approval_token = $1
         RETURNING *
      )
      SELECT u.*, s.title AS song_title, s.external_url AS song_url
        FROM updated u
        JOIN songs s ON s.id = u.song_id
      `,
      [token]
    );
    return rows[0] || null;
  } else {
    const updateStmt = sqliteDb.prepare(
      `UPDATE links
          SET status = 'approved',
              approval_token = NULL,
              approved_at = COALESCE(approved_at, datetime('now'))
        WHERE approval_token = ?
        RETURNING *`
    );
    const row = updateStmt.get(token);
    if (!row) return null;
    const song = sqliteDb.prepare(`SELECT title AS song_title, external_url AS song_url FROM songs WHERE id = ?`).get(row.song_id);
    return { ...row, ...song };
  }
}

async function approveLinkById(id) {
  if (!id) return null;
  if (usePg) {
    const { rows } = await pgPool.query(
      `
      WITH updated AS (
        UPDATE links
           SET status = 'approved',
               approval_token = NULL,
               approved_at = COALESCE(approved_at, NOW())
         WHERE id = $1
         RETURNING *
      )
      SELECT u.*, s.title AS song_title, s.external_url AS song_url
        FROM updated u
        JOIN songs s ON s.id = u.song_id
      `,
      [id]
    );
    return rows[0] || null;
  } else {
    const update = sqliteDb.prepare(
      `UPDATE links
          SET status = 'approved',
              approval_token = NULL,
              approved_at = COALESCE(approved_at, datetime('now'))
        WHERE id = ?`
    );
    const info = update.run(id);
    if (!info.changes) return null;
    return sqliteDb
      .prepare(
        `SELECT l.*, s.title AS song_title, s.external_url AS song_url
           FROM links l
           JOIN songs s ON l.song_id = s.id
          WHERE l.id = ?`
      )
      .get(id);
  }
}

async function rejectLinkById(id) {
  if (!id) return null;
  if (usePg) {
    const { rows } = await pgPool.query(
      `
      WITH updated AS (
        UPDATE links
           SET status = 'rejected',
               approval_token = NULL,
               approved_at = NULL
         WHERE id = $1
         RETURNING *
      )
      SELECT u.*, s.title AS song_title, s.external_url AS song_url
        FROM updated u
        JOIN songs s ON s.id = u.song_id
      `,
      [id]
    );
    return rows[0] || null;
  } else {
    const update = sqliteDb.prepare(
      `UPDATE links
          SET status = 'rejected',
              approval_token = NULL,
              approved_at = NULL
        WHERE id = ?`
    );
    const info = update.run(id);
    if (!info.changes) return null;
    return sqliteDb
      .prepare(
        `SELECT l.*, s.title AS song_title, s.external_url AS song_url
           FROM links l
           JOIN songs s ON l.song_id = s.id
          WHERE l.id = ?`
      )
      .get(id);
  }
}

// Fetch a pending link with song data (admin)
async function getPendingLinks() {
  if (usePg) {
    const { rows } = await pgPool.query(
      `
      SELECT l.id,
             l.parasha_id,
             l.target_kind,
             l.target_id,
             l.verse_ref,
             l.status,
             l.approved_at,
             l.added_at,
             s.title AS song_title,
             s.external_url AS song_url
        FROM links l
        JOIN songs s ON l.song_id = s.id
       WHERE l.status = 'pending'
       ORDER BY l.added_at ASC
      `
    );
    return rows;
  } else {
    return sqliteDb
      .prepare(
        `
        SELECT l.id,
               l.parasha_id,
               l.target_kind,
               l.target_id,
               l.verse_ref,
               l.status,
               l.approved_at,
               l.added_at,
               s.title AS song_title,
               s.external_url AS song_url
          FROM links l
          JOIN songs s ON l.song_id = s.id
         WHERE l.status = 'pending'
         ORDER BY l.added_at ASC
        `
      )
      .all();
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
      `SELECT COUNT(DISTINCT song_id) as total FROM links WHERE status = 'approved'`
    );
    return rows[0]?.total || 0;
  } else {
    const row = sqliteDb
      .prepare(`SELECT COUNT(DISTINCT song_id) as total FROM links WHERE status = 'approved'`)
      .get();
    return row?.total || 0;
  }
}

// helper to record a visit
export async function recordVisit(ip, userAgent) {
  if (usePg) {
    await pgPool.query(
      `INSERT INTO visits (ip, user_agent) VALUES ($1, $2)`,
      [ip, userAgent]
    );
  } else {
    sqliteDb.prepare(
      `INSERT INTO visits (ip, user_agent) VALUES (?, ?)`
    ).run(ip, userAgent);
  }
}

// helper to get visit stats
export async function getVisitStats() {
  if (usePg) {
    const totalRes = await pgPool.query(`SELECT COUNT(*) as total FROM visits`);
    const uniqueRes = await pgPool.query(`SELECT COUNT(DISTINCT ip) as unique FROM visits`);
    const todayRes = await pgPool.query(`
      SELECT COUNT(*) as today FROM visits 
      WHERE visited_at >= NOW() - INTERVAL '1 day'
    `);
    return {
      total: parseInt(totalRes.rows[0].total),
      unique: parseInt(uniqueRes.rows[0].unique),
      today: parseInt(todayRes.rows[0].today),
    };
  } else {
    const total = sqliteDb.prepare(`SELECT COUNT(*) as total FROM visits`).get();
    const unique = sqliteDb.prepare(`SELECT COUNT(DISTINCT ip) as unique FROM visits`).get();
    const today = sqliteDb.prepare(`
      SELECT COUNT(*) as today FROM visits 
      WHERE visited_at >= datetime('now', '-1 day')
    `).get();
    return {
      total: total.total,
      unique: unique.unique,
      today: today.today,
    };
  }
}

export {
  usePg,
  findSongByTitleVersion,
  findSongByTitleUrl,
  insertSong,
  updateSongExternalUrl,
  insertLink,
  getLinksByParasha,
  deleteLink,
  deleteSong,
  getLinksByTanach, // ensure this is exported
  approveLinkByToken,
  approveLinkById,
  rejectLinkById,
  getPendingLinks,
};
