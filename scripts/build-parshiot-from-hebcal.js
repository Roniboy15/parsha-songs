// scripts/build-parshiot-from-hebcal.js
import fs from "node:fs/promises";

const YEARS = [2024, 2025, 2026];
const BASE = "https://www.hebcal.com/hebcal?cfg=json&s=on&leyning=on";

// canonical order, but now with book info
const CANONICAL = [
  // Bereshit
  { name: "Bereshit", book: "bereshit" },
  { name: "Noach", book: "bereshit" },
  { name: "Lech-Lecha", book: "bereshit" },
  { name: "Vayera", book: "bereshit" },
  { name: "Chayei Sara", book: "bereshit" },
  { name: "Toldot", book: "bereshit" },
  { name: "Vayetzei", book: "bereshit" },
  { name: "Vayishlach", book: "bereshit" },
  { name: "Vayeshev", book: "bereshit" },
  { name: "Miketz", book: "bereshit" },
  { name: "Vayigash", book: "bereshit" },
  { name: "Vayechi", book: "bereshit" },
  // Shemot
  { name: "Shemot", book: "shemot" },
  { name: "Vaera", book: "shemot" },
  { name: "Bo", book: "shemot" },
  { name: "Beshalach", book: "shemot" },
  { name: "Yitro", book: "shemot" },
  { name: "Mishpatim", book: "shemot" },
  { name: "Terumah", book: "shemot" },
  { name: "Tetzaveh", book: "shemot" },
  { name: "Ki Tisa", book: "shemot" },
  { name: "Vayakhel", book: "shemot" },
  { name: "Pekudei", book: "shemot" },
  // Vayikra
  { name: "Vayikra", book: "vayikra" },
  { name: "Tzav", book: "vayikra" },
  { name: "Shemini", book: "vayikra" },
  { name: "Tazria", book: "vayikra" },
  { name: "Metzora", book: "vayikra" },
  { name: "Acharei Mot", book: "vayikra" },
  { name: "Kedoshim", book: "vayikra" },
  { name: "Emor", book: "vayikra" },
  { name: "Behar", book: "vayikra" },
  { name: "Bechukotai", book: "vayikra" },
  // Bamidbar
  { name: "Bamidbar", book: "bamidbar" },
  { name: "Naso", book: "bamidbar" },
  { name: "Behaalotecha", book: "bamidbar" },
  { name: "Shelach", book: "bamidbar" },
  { name: "Korach", book: "bamidbar" },
  { name: "Chukat", book: "bamidbar" },
  { name: "Balak", book: "bamidbar" },
  { name: "Pinchas", book: "bamidbar" },
  { name: "Matot", book: "bamidbar" },
  { name: "Masei", book: "bamidbar" },
  // Devarim
  { name: "Devarim", book: "devarim" },
  { name: "Vaetchanan", book: "devarim" },
  { name: "Eikev", book: "devarim" },
  { name: "Reeh", book: "devarim" },
  { name: "Shoftim", book: "devarim" },
  { name: "Ki Tetze", book: "devarim" },
  { name: "Ki Tavo", book: "devarim" },
  { name: "Nitzavim", book: "devarim" },
  { name: "Vayelech", book: "devarim" },
  { name: "Haazinu", book: "devarim" },
  { name: "Vezot Haberachah", book: "devarim" }
];

const BOOK_LABELS = {
  bereshit: { en: "Bereshit / Genesis", he: "בראשית" },
  shemot: { en: "Shemot / Exodus", he: "שמות" },
  vayikra: { en: "Vayikra / Leviticus", he: "ויקרא" },
  bamidbar: { en: "Bamidbar / Numbers", he: "במדבר" },
  devarim: { en: "Devarim / Deuteronomy", he: "דברים" }
};

function makeId(nameEn) {
  return nameEn.trim().toLowerCase().replace(/\s+/g, "-");
}

function stripParashat(hebrew) {
  if (!hebrew) return null;
  return hebrew.replace(/^פרשת\s+/, "").trim();
}

async function fetchYear(year, { israel = false } = {}) {
  const url = `${BASE}&year=${year}${israel ? "&i=on" : ""}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function main() {
  const raw = [];
  for (const y of YEARS) {
    const data = await fetchYear(y, { israel: false });
    const items = (data.items || []).filter(
      (it) => it.category === "parashat"
    );
    raw.push(...items);
  }

  const finalParshiot = [];

  // walk canonical, fill from raw
  let index = 1;
  for (const entry of CANONICAL) {
    const nameEn = entry.name;
    const book = entry.book;

    // 1) exact
    let item = raw.find(
      (it) => it.title && it.title.replace("Parashat ", "").trim() === nameEn
    );
    // 2) or combined
    if (!item) {
      item = raw.find((it) => {
        if (!it.title) return false;
        const plain = it.title.replace("Parashat ", "").trim();
        return plain.includes(nameEn);
      });
    }

    const id = makeId(nameEn);
    const name_he = stripParashat(item?.hebrew);
    const haftFromHebcal =
      item?.leyning?.haftara || item?.leyning?.haftarah || null;

    finalParshiot.push({
      id,
      name_en: nameEn,
      name_he,
      book,
      book_en: BOOK_LABELS[book].en,
      book_he: BOOK_LABELS[book].he,
      order_index: index++,
      haftarot: {
        diaspora: haftFromHebcal
          ? [
              {
                id: `${id}-haftarah`,
                name: haftFromHebcal
              }
            ]
          : []
      }
    });
  }

  await fs.mkdir("data", { recursive: true });
  await fs.writeFile(
    "data/parshiot.json",
    JSON.stringify({ parshiot: finalParshiot }, null, 2),
    "utf8"
  );
  console.log("saved", finalParshiot.length, "parshiot to data/parshiot.json");
}

main().catch(console.error);
