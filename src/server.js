// src/server.js
import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import * as dbModule from "./db.js";
import nodemailer from "nodemailer";
import { generalLimiter, writeLimiter, sensitiveLimiter, adminLimiter } from "./middlewares/rateLimit.js";
import { validateBody, validateQuery } from "./middlewares/validate.js";
import { linkCreateSchema, linksListQuerySchema, currentReadingQuerySchema, tanachLinksQuerySchema } from "./validation/schemas.js";
import { buildSessionMiddleware } from "./auth/session.js";
import { requireAdmin, attachAdminFlag } from "./middlewares/adminAuth.js";
// add import
import TANACH_FALLBACK from "./data/tanachFallback.js";
const {
  findSongByTitleUrl,
  insertSong,
  insertLink,
  getLinksByParasha,
  deleteLink,
  deleteSong,
} = dbModule;
// try to find the DB object on common export names
const db = dbModule.default || dbModule.db || dbModule;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.set("trust proxy", 1);
app.use(await buildSessionMiddleware(dbModule.usePg, db));
app.use(attachAdminFlag);

// middleware to track visits (MOVE THIS HERE - before routes)
app.use(async (req, res, next) => {
  // only track GET requests to main page
  if (req.method === "GET" && req.path === "/") {
    try {
      const ip = req.headers["x-forwarded-for"]?.split(",")[0] || 
                 req.headers["x-real-ip"] || 
                 req.socket.remoteAddress || 
                 "unknown";
      const userAgent = req.headers["user-agent"] || "";
      await dbModule.recordVisit(ip, userAgent);
    } catch (err) {
      console.error("Failed to record visit:", err);
    }
  }
  next();
});

// serve static frontend (don't let static serve index.html so our GET / can inject token)
app.use(
  express.static(path.join(__dirname, "..", "public"), {
    index: false,
  })
);

app.get("/", async (req, res) => {
  const html = await fs.readFile("public/index.html", "utf8");
  res.type("html").send(html);
});


// helper to load our static file
async function loadParshiot() {
  const txt = await fs.readFile(
    path.join(__dirname, "..", "data", "parshiot.json"),
    "utf8"
  );
  return JSON.parse(txt).parshiot;
}

// add safe fetch polyfill (Node < 18)
const fetch = globalThis.fetch ?? (await import("node-fetch")).default;

// NEW: Sefaria Tanach books cache and helpers
let tanachCache = { data: null, fetchedAt: 0 };
const TANACH_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function normalizeId(title) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

async function getBookChapterCount(englishTitle) {
  const idxUrl = `https://www.sefaria.org/api/index/${encodeURIComponent(englishTitle)}`;
  const r = await fetch(idxUrl, { headers: { "Accept": "application/json" } });
  if (!r.ok) throw new Error(`Index fetch failed for ${englishTitle}: ${r.status}`);
  const data = await r.json();

  // Prefer schema.lengths[0]; fallbacks for odd schemas
  let chapters = null;
  const lengths = data?.schema?.lengths || data?.lengths || null;
  if (Array.isArray(lengths) && lengths.length) chapters = lengths[0];

  if (!chapters && Array.isArray(data?.schema?.nodes)) {
    // Some books store lengths on first node
    const nodeLengths = data.schema.nodes[0]?.lengths;
    if (Array.isArray(nodeLengths) && nodeLengths.length) chapters = nodeLengths[0];
  }

  if (!chapters || typeof chapters !== "number") {
    throw new Error(`No chapter count for ${englishTitle}`);
  }
  return chapters;
}

// REMOVE remote Sefaria calls; always serve the static fallback.
async function fetchTanachBooks() {
  return TANACH_FALLBACK;
}

// 1) GET /api/parshiot
app.get("/api/parshiot", async (req, res) => {
  const parshiot = await loadParshiot();
  res.json(parshiot);
});

// apply a general limiter to read-only API routes
app.use("/api", generalLimiter);

// NEW: GET /api/tanach/books -> list books with chapter counts
app.get("/api/tanach/books", async (req, res) => {
  try {
    const books = await fetchTanachBooks();
    res.json(books);
  } catch (err) {
    console.error("tanach/books failed:", err);
    res.status(500).json({ error: "tanach-load-failed" });
  }
});

// NEW: GET /api/links-tanach?book_id=&chapter=
app.get("/api/links-tanach", validateQuery(tanachLinksQuerySchema), async (req, res) => {
  try {
    const { book_id, chapter } = res.locals.validatedQuery;
    const rows = await dbModule.getLinksByTanach(book_id, chapter);
    res.json(rows);
  } catch (err) {
    console.error("links-tanach failed:", err);
    res.status(500).json({ ok: false, error: "tanach-links-failed" });
  }
});

// 2) GET /api/current-reading  --> find the next shabbat parasha in the coming 7 days
app.get("/api/current-reading", validateQuery(currentReadingQuerySchema), async (req, res) => {
  // CHANGE THIS LINE:
  const loc = res.locals.validatedQuery?.loc || "diaspora";

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
app.post("/api/links", writeLimiter, validateBody(linkCreateSchema), async (req, res) => {
  const { parasha_id, target_kind, target_id, song, verse_ref, added_by, book_id, chapter } = req.body;

  if (!parasha_id || !target_kind || !song?.title) {
    return res.status(400).json({ error: "missing-fields" });
  }

  // For parasha/haftarah we still validate parasha exists; skip for tanach
  if (target_kind !== "tanach") {
    const parshiot = await loadParshiot();
    const parasha = parshiot.find((p) => p.id === parasha_id);
    if (!parasha) {
      return res.status(400).json({ error: "unknown-parasha" });
    }

    if (target_kind === "haftarah") {
      const haftarot = parasha.haftarot?.diaspora || [];
      const ok = haftarot.some((h) => h.id === target_id);
      if (!ok) {
        return res.status(400).json({ error: "haftarah-not-under-this-parasha" });
      }
    }
  }

  // values already sanitized by zod transforms
  const cleanTitle = song.title;
  const cleanUrl = song.external_url || null;

  // find or create song
  // Deduplicate by (title, external_url) so same title with different links are separate songs
  let existing = await findSongByTitleUrl(cleanTitle, cleanUrl || null);
  let songId;
  if (existing) {
    songId = existing.id;
  } else {
    songId = crypto.randomUUID();
    // version is not used anymore; store null
    await insertSong(songId, cleanTitle, null, cleanUrl || null);
  }

  // Compute target fields
  let finalTargetKind = target_kind;
  let finalTargetId = null;
  let finalParashaId = parasha_id;

  if (target_kind === "tanach") {
    // Use normalized book_id as parasha_id placeholder to satisfy schema/DB not null
    finalParashaId = book_id;
    finalTargetId = `${book_id}:${chapter}`;
  } else if (target_kind === "haftarah") {
    finalTargetId = target_id || null;
  }

  const newId = await insertLink({
    parasha_id: finalParashaId,
    target_kind: finalTargetKind,
    target_id: finalTargetId,
    song_id: songId,
    verse_ref: verse_ref || null,
    added_by: added_by || null,
  });

  // only notify if NOT admin session
  const isAdmin = !!req.session?.isAdmin;
  if (!isAdmin) {
    notifyNewLink({
      link_id: newId,
      parasha_id: finalParashaId,
      target_kind: finalTargetKind,
      target_id: finalTargetId,
      song_title: cleanTitle,
      song_url: cleanUrl,
      verse_ref: verse_ref || null,
      added_by: added_by || null,
      timestamp: new Date().toISOString(),
    }).catch(() => {});
  }

  res.json({ ok: true, link_id: newId });
});

// create mail transporter if SMTP env provided
let mailTransporter = null;
if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
  mailTransporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === "1" || process.env.SMTP_SECURE === "true",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  // verify and log result
  mailTransporter.verify()
    .then(() => {
      console.log("SMTP transporter verified");
    })
    .catch((err) => {
      console.error("SMTP transporter verify failed:", err && err.message ? err.message : err);
    });
}

// replace the notifyNewLink function with this API-based version:
async function notifyNewLink(payload) {
  const webhook = process.env.NOTIFY_WEBHOOK;
  const notifyEmail = process.env.NOTIFY_EMAIL;
  const brevoApiKey = process.env.BREVO_API_KEY; // add this env var

  // 1) webhook if configured
  if (webhook) {
    try {
      await fetch(webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      return;
    } catch (err) {
      console.error("webhook notify failed:", err?.message || err);
    }
  }

  // 2) Brevo API (no SMTP port needed)
  if (brevoApiKey && notifyEmail) {
    try {
      const subject = `New song added: ${payload.song_title || "(no title)"}`;
      const textLines = [
        `Parasha: ${payload.parasha_id}`,
        `Target: ${payload.target_kind}${payload.target_id ? " / " + payload.target_id : ""}`,
        `Title: ${payload.song_title || ""}`,
        `URL: ${payload.song_url || ""}`,
        `Verse: ${payload.verse_ref || ""}`,
        `Added by: ${payload.added_by || ""}`,
        `ID: ${payload.link_id}`,
        `Time: ${payload.timestamp}`,
      ];
      
      const response = await fetch("https://api.brevo.com/v3/smtp/email", {
        method: "POST",
        headers: {
          "accept": "application/json",
          "api-key": brevoApiKey,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          sender: { 
            email: process.env.NOTIFY_FROM || "noreply@example.com",
            name: "Parsha Songs"
          },
          to: [{ email: notifyEmail }],
          subject: subject,
          textContent: textLines.join("\n"),
          htmlContent: `<pre style="font-family:inherit">${textLines.join("\n")}</pre>`
        })
      });
      
      if (!response.ok) {
        const err = await response.text();
        throw new Error(`Brevo API error: ${err}`);
      }
      return;
    } catch (err) {
      console.error("Brevo API notify failed:", err?.message || err);
    }
  }

  // 3) fallback: SMTP (will timeout on Render free tier)
  if (mailTransporter && notifyEmail) {
    try {
      const subject = `New song added: ${payload.song_title || "(no title)"}`;
      const textLines = [
        `Parasha: ${payload.parasha_id}`,
        `Target: ${payload.target_kind}${payload.target_id ? " / " + payload.target_id : ""}`,
        `Title: ${payload.song_title || ""}`,
        `URL: ${payload.song_url || ""}`,
        `Verse: ${payload.verse_ref || ""}`,
        `Added by: ${payload.added_by || ""}`,
        `ID: ${payload.link_id}`,
        `Time: ${payload.timestamp}`,
      ];
      await mailTransporter.sendMail({
        from: process.env.NOTIFY_FROM || process.env.SMTP_USER,
        to: notifyEmail,
        subject,
        text: textLines.join("\n"),
        html: `<pre style="font-family:inherit">${textLines.join("\n")}</pre>`,
      });
      return;
    } catch (err) {
      console.error("email notify failed:", err?.message || err);
    }
  }

  // fallback
  console.log("New link added:", payload);
}

// 4) GET /api/links
app.get("/api/links", validateQuery(linksListQuerySchema), async (req, res) => {
  // CHANGE THESE LINES:
  const { parasha_id, target_kind } = res.locals.validatedQuery;
  const rows = await getLinksByParasha(parasha_id, target_kind || null);
  res.json(rows);
});

// 5) DELETE /api/links/:id
app.delete("/api/links/:id", sensitiveLimiter, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const deleted = await deleteLink(id);
  res.json({ ok: true, deleted });
});

// 6) DELETE /api/songs/:id  (rarely used)
app.delete("/api/songs/:id", sensitiveLimiter, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const deleted = await deleteSong(id);
  res.json({ ok: true, deleted_song: deleted });
});

// total songs endpoint (uses db.js helper that works for both backends)
app.get("/api/total-songs", async (req, res) => {
  try {
    const total = await dbModule.getTotalSongs();
    res.json({ total });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to get total count" });
  }
});

// admin token verification endpoint (used by the client to validate token)
app.post("/api/admin/login", adminLimiter, (req, res) => {
  const { token } = req.body || {};
  const expected = process.env.ADMIN_TOKEN;
  
  if (!expected) {
    return res.status(400).json({ error: "no-admin-configured" });
  }
  
  if (token && token === expected) {
    req.session.isAdmin = true;
    return res.json({ ok: true });
  }
  
  return res.status(401).json({ error: "invalid-token" });
});

app.post("/api/admin/logout", adminLimiter, (req, res) => {
  if (req.session) {
    req.session.destroy(() => res.json({ ok: true }));
  } else {
    res.json({ ok: true });
  }
});

app.get("/api/admin/verify", adminLimiter, (req, res) => {
  if (req.session?.isAdmin) return res.json({ ok: true });
  return res.status(401).json({ ok: false, error: "not-admin" });
});

// test notification endpoint
app.post("/api/test-notify", sensitiveLimiter, async (req, res) => {
  const sample = {
    link_id: "TEST-123",
    parasha_id: "bereshit",
    target_kind: "parasha",
    target_id: null,
    song_title: "Test Song",
    song_url: "https://example.com/test",
    verse_ref: "Genesis 1:1",
    added_by: "tester",
    timestamp: new Date().toISOString(),
  };
  try {
    await notifyNewLink(sample);
    res.json({ ok: true });
  } catch (err) {
    console.error("test-notify failed:", err);
    res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

// stats endpoint (admin-only)
app.get("/api/stats", adminLimiter, requireAdmin, async (req, res) => {
  try {
    const stats = await dbModule.getVisitStats();
    res.json(stats);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "stats-error" });
  }
});

const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";

app.listen(PORT, HOST, () => {
  console.log(`listening on http://${HOST}:${PORT}`);
});
