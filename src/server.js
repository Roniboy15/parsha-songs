// src/server.js
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import {
  findSongByTitleVersion,
  insertSong,
  insertLink,
  getLinksByParasha,
  deleteLink,
  deleteSong,
} from "./db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

// serve static frontend (on Render we are in /src, so go one level up)
app.use(express.static(path.join(__dirname, "..", "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

// helper to load our static file
async function loadParshiot() {
  const txt = await fs.readFile(
    path.join(__dirname, "..", "data", "parshiot.json"),
    "utf8"
  );
  return JSON.parse(txt).parshiot;
}

// 1) GET /api/parshiot
app.get("/api/parshiot", async (req, res) => {
  const parshiot = await loadParshiot();
  res.json(parshiot);
});

// 2) GET /api/current-reading  --> find the next shabbat parasha in the coming 7 days
app.get("/api/current-reading", async (req, res) => {
  const loc = req.query.loc === "israel" ? "israel" : "diaspora";

  const today = new Date();
  const start = today.toISOString().slice(0, 10);
  const endDate = new Date(today);
  endDate.setDate(endDate.getDate() + 7);
  const end = endDate.toISOString().slice(0, 10);

  const url =
    `https://www.hebcal.com/hebcal?cfg=json&s=on&leyning=on&start=${start}&end=${end}` +
    (loc === "israel" ? "&i=on" : "");

  try {
    const r = await fetch(url);
    const data = await r.json();
    const items = data.items || [];
    const parshaItem = items.find((it) => it.category === "parashat");

    if (!parshaItem) {
      return res.json({ ok: false, reason: "no-parasha-in-next-7-days" });
    }

    const parshaNameEn = parshaItem.title.replace("Parashat ", "").trim();
    const parshiot = await loadParshiot();

    let match = parshiot.find((p) => p.name_en === parshaNameEn);

    if (!match && parshaNameEn.includes("-")) {
      const firstPart = parshaNameEn.split("-")[0].trim();
      match = parshiot.find((p) => p.name_en === firstPart);
    }

    if (!match) {
      return res.json({
        ok: true,
        parasha: {
          id: parshaNameEn.toLowerCase().replace(/\s+/g, "-"),
          name_en: parshaNameEn,
          name_he: parshaItem.hebrew || null,
        },
        haftarot: parshaItem.leyning?.haftara
          ? [{ id: "auto", name: parshaItem.leyning.haftara }]
          : [],
        warn: "parasha-not-in-static-list",
      });
    }

    const haftarot =
      match.haftarot?.[loc] || match.haftarot?.diaspora || [];

    res.json({
      ok: true,
      parasha: {
        id: match.id,
        name_en: match.name_en,
        name_he: match.name_he,
        book: match.book,
      },
      haftarot,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: "hebcal-failed" });
  }
});

// 3) POST /api/links
app.post("/api/links", async (req, res) => {
  const clientToken = req.headers["x-contrib-token"] || req.query.token || null;
  const expected = process.env.CONTRIB_TOKEN || null;
  if (expected && clientToken !== expected) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const {
    parasha_id,
    target_kind,
    target_id,
    song,
    verse_ref,
    added_by,
  } = req.body;

  if (!parasha_id || !target_kind || !song?.title) {
    return res.status(400).json({ error: "missing-fields" });
  }

  const parshiot = await loadParshiot();
  const parasha = parshiot.find((p) => p.id === parasha_id);
  if (!parasha) {
    return res.status(400).json({ error: "unknown-parasha" });
  }

  if (target_kind === "haftarah") {
    const haftarot = parasha.haftarot?.diaspora || [];
    const ok = haftarot.some((h) => h.id === target_id);
    if (!ok) {
      return res
        .status(400)
        .json({ error: "haftarah-not-under-this-parasha" });
    }
  }

  const cleanTitle = song.title.replace(/[<>]/g, "").slice(0, 200);
  const cleanUrl = song.external_url ? song.external_url.trim() : null;
  if (cleanUrl) {
    try {
      const u = new URL(cleanUrl);
      if (u.protocol !== "http:" && u.protocol !== "https:") {
        return res.status(400).json({ error: "invalid-url" });
      }
    } catch {
      return res.status(400).json({ error: "invalid-url" });
    }
  }

  // find or create song
  let existing = await findSongByTitleVersion(
    cleanTitle,
    song.version || null
  );
  let songId;
  if (existing) {
    songId = existing.id;
  } else {
    songId = crypto.randomUUID();
    await insertSong(songId, cleanTitle, song.version || null, cleanUrl || null);
  }

  const newId = await insertLink({
    parasha_id,
    target_kind,
    target_id: target_kind === "haftarah" ? target_id : null,
    song_id: songId,
    verse_ref: verse_ref || null,
    added_by: added_by || null,
  });

  res.json({ ok: true, link_id: newId });
});

// 4) GET /api/links
app.get("/api/links", async (req, res) => {
  const { parasha_id, target_kind } = req.query;
  if (!parasha_id) {
    return res.status(400).json({ error: "parasha_id is required" });
  }
  const rows = await getLinksByParasha(parasha_id, target_kind || null);
  res.json(rows);
});

// 5) DELETE /api/links/:id
app.delete("/api/links/:id", async (req, res) => {
  const { id } = req.params;
  const deleted = await deleteLink(id);
  res.json({ ok: true, deleted });
});

// 6) DELETE /api/songs/:id  (rarely used)
app.delete("/api/songs/:id", async (req, res) => {
  const { id } = req.params;
  const deleted = await deleteSong(id);
  res.json({ ok: true, deleted_song: deleted });
});

const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";

app.listen(PORT, HOST, () => {
  console.log(`listening on http://${HOST}:${PORT}`);
});
