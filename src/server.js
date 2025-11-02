// src/server.js
import express from "express";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import db from "./db.js";

const app = express();
app.use(express.json());
app.use(express.static("public")); // to serve index.html etc.

// helper to load our static file
async function loadParshiot() {
    const txt = await fs.readFile("data/parshiot.json", "utf8");
    return JSON.parse(txt).parshiot;
}

// 1) GET /api/parshiot  --> frontend will build the dropdown from this
app.get("/api/parshiot", async (req, res) => {
    const parshiot = await loadParshiot();
    res.json(parshiot);
});

// 2) GET /api/current-reading  --> find the next shabbat parasha in the coming 7 days
app.get("/api/current-reading", async (req, res) => {
    const loc = req.query.loc === "israel" ? "israel" : "diaspora";

    // today
    const today = new Date();
    const start = today.toISOString().slice(0, 10);

    // 7 days from now
    const endDate = new Date(today);
    endDate.setDate(endDate.getDate() + 7);
    const end = endDate.toISOString().slice(0, 10);

    // ask hebcal for a range, not just for today
    const url =
        `https://www.hebcal.com/hebcal?cfg=json&s=on&leyning=on&start=${start}&end=${end}` +
        (loc === "israel" ? "&i=on" : "");

    try {
        const r = await fetch(url);
        const data = await r.json();
        const items = data.items || [];

        // find the FIRST item in that range that is a weekly parasha
        const parshaItem = items.find((it) => it.category === "parashat");

        if (!parshaItem) {
            return res.json({ ok: false, reason: "no-parasha-in-next-7-days" });
        }

        const parshaNameEn = parshaItem.title.replace("Parashat ", "").trim();
        const parshiot = await loadParshiot();

        // try to find this parasha in OUR list (54 parshiot)
        let match = parshiot.find((p) => p.name_en === parshaNameEn);

        // if not found, try to match the first part of a combined parasha
        if (!match && parshaNameEn.includes("-")) {
            const firstPart = parshaNameEn.split("-")[0].trim();
            match = parshiot.find((p) => p.name_en === firstPart);
        }

        if (!match) {
            // fallback: send what hebcal said, but warn frontend
            return res.json({
                ok: true,
                parasha: {
                    id: parshaNameEn.toLowerCase().replace(/\s+/g, "-"),
                    name_en: parshaNameEn,
                    name_he: parshaItem.hebrew || null
                },
                haftarot: parshaItem.leyning?.haftara
                    ? [{ id: "auto", name: parshaItem.leyning.haftara }]
                    : [],
                warn: "parasha-not-in-static-list"
            });
        }

        const haftarot =
            match.haftarot?.[loc] ||
            match.haftarot?.diaspora ||
            [];

        res.json({
            ok: true,
            parasha: {
                id: match.id,
                name_en: match.name_en,
                name_he: match.name_he,
                book: match.book
            },
            haftarot
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ ok: false, error: "hebcal-failed" });
    }
});


// 3) POST /api/links  --> save user's contribution
app.post("/api/links", async (req, res) => {
    const {
        parasha_id,
        target_kind,
        target_id,
        song,
        verse_ref,
        added_by
    } = req.body;

    // minimal validation
    if (!parasha_id || !target_kind || !song?.title) {
        return res.status(400).json({ error: "missing-fields" });
    }

    // check that parasha exists in our static list
    const parshiot = await loadParshiot();
    const parasha = parshiot.find((p) => p.id === parasha_id);
    if (!parasha) {
        return res.status(400).json({ error: "unknown-parasha" });
    }

    // if user said "haftarah", make sure it's really under this parasha
    if (target_kind === "haftarah") {
        const haftarot =
            parasha.haftarot?.diaspora || []; // we only have diaspora for now
        const ok = haftarot.some((h) => h.id === target_id);
        if (!ok) {
            return res
                .status(400)
                .json({ error: "haftarah-not-under-this-parasha" });
        }
    }

    // find or create song
    const existingSong = db
        .prepare(
            "SELECT * FROM songs WHERE title = ? AND ifnull(version,'') = ifnull(?, '')"
        )
        .get(song.title, song.version || null);

    let songId;
    if (existingSong) {
        songId = existingSong.id;
    } else {
        songId = crypto.randomUUID();
        db.prepare(
            "INSERT INTO songs (id, title, version, external_url) VALUES (?, ?, ?, ?)"
        ).run(
            songId,
            song.title,
            song.version || null,
            song.external_url || null
        );
    }

    // insert the link
    const info = db
        .prepare(
            "INSERT INTO links (parasha_id, target_kind, target_id, song_id, verse_ref, added_by, status) VALUES (?, ?, ?, ?, ?, ?, 'pending')"
        )
        .run(
            parasha_id,
            target_kind,
            target_kind === "haftarah" ? target_id : null,
            songId,
            verse_ref || null,
            added_by || null
        );

    res.json({ ok: true, link_id: info.lastInsertRowid });
});

// 4) GET /api/links?parasha_id=bereshit[&target_kind=haftarah]
app.get("/api/links", (req, res) => {
    const { parasha_id, target_kind } = req.query;

    if (!parasha_id) {
        return res.status(400).json({ error: "parasha_id is required" });
    }

    // base query
    let sql = `
    SELECT
      l.id,
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
    const params = [parasha_id];

    // filter by parasha/haftarah if provided
    if (target_kind === "parasha" || target_kind === "haftarah") {
        sql += " AND l.target_kind = ?";
        params.push(target_kind);
    }

    sql += " ORDER BY l.added_at DESC";

    const rows = db.prepare(sql).all(...params);
    res.json(rows);
});



// DELETE one link (e.g. /api/links/123)
app.delete("/api/links/:id", (req, res) => {
    const { id } = req.params;
    const info = db.prepare("DELETE FROM links WHERE id = ?").run(id);
    res.json({ ok: true, deleted: info.changes });
});


// DELETE a song and all its links
app.delete("/api/songs/:id", (req, res) => {
    const { id } = req.params;

    // remove related links first
    db.prepare("DELETE FROM links WHERE song_id = ?").run(id);

    // then delete the song itself
    const info = db.prepare("DELETE FROM songs WHERE id = ?").run(id);

    res.json({ ok: true, deleted_song: info.changes });
});




const PORT = 3000;
app.listen(PORT, () => {
    console.log(`listening on http://localhost:${PORT}`);
});
