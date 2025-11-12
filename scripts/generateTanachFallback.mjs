/* Run: node scripts/generateTanachFallback.mjs
   Writes a fresh src/data/tanachFallback.js from Sefaria API. */
import fs from "node:fs/promises";

const fetchFn = globalThis.fetch ?? (await import("node-fetch")).default;
const norm = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

async function getChapters(title) {
  const r = await fetchFn(`https://www.sefaria.org/api/index/${encodeURIComponent(title)}`, { headers: { Accept: "application/json" } });
  const data = await r.json();
  let chapters = data?.schema?.lengths?.[0] ?? data?.lengths?.[0] ?? data?.schema?.nodes?.[0]?.lengths?.[0];
  if (!Number.isInteger(chapters)) throw new Error(`No chapters for ${title}`);
  return chapters;
}

async function main() {
  const r = await fetchFn("https://www.sefaria.org/api/category/Tanakh", { headers: { Accept: "application/json" } });
  const cat = await r.json();
  const queue = [...(cat.contents || [])];
  const titles = [];
  while (queue.length) {
    const n = queue.shift();
    if (!n) continue;
    if (n.category && Array.isArray(n.contents)) { queue.push(...n.contents); continue; }
    if (n.title) titles.push({ en: n.title, he: n.heTitle || n.title });
  }
  const seen = new Set();
  const books = titles.filter(b => !seen.has(b.en.toLowerCase()) && seen.add(b.en.toLowerCase()));
  const result = [];
  for (const b of books) {
    try {
      const chapters = await getChapters(b.en);
      result.push({ id: norm(b.en), title_en: b.en, title_he: b.he, chapters });
    } catch (e) {
      // skip
    }
  }
  const content =
`// filepath: /Users/jarontreyer/parsha-songs/src/data/tanachFallback.js
// Generated from Sefaria Index API
export default ${JSON.stringify(result, null, 2)};
`;
  await fs.writeFile("src/data/tanachFallback.js", content, "utf8");
  console.log(`Wrote ${result.length} books to src/data/tanachFallback.js`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});