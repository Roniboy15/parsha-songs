import { z } from "zod";

const idPattern = /^[a-z0-9-]{2,50}$/;

export const currentReadingQuerySchema = z.object({
  loc: z.enum(["israel", "diaspora"]).optional().default("diaspora"),
});

export const linksListQuerySchema = z.object({
  parasha_id: z.string().trim().regex(idPattern, "invalid parasha_id"),
  target_kind: z.enum(["parasha", "haftarah"]).optional(),
});

// NEW: schema for tanach links listing
export const tanachLinksQuerySchema = z.object({
  book_id: z.string().trim().regex(idPattern, "invalid book_id"),
  chapter: z.preprocess(
    (v) => (typeof v === "string" ? parseInt(v, 10) : v),
    z.number().int().min(1).max(300)
  ),
});

export const searchSongsQuerySchema = z.object({
  q: z.string().trim().min(2, "query too short").max(100, "query too long"),
});

export const linkCreateSchema = z
  .object({
    parasha_id: z.string().trim().regex(idPattern, "invalid parasha_id"),
    target_kind: z.enum(["parasha", "haftarah", "tanach"]),
    target_id: z.string().trim().regex(idPattern).nullable().optional(),

    // NEW: fields for tanach links
    book_id: z.string().trim().regex(idPattern).optional(),
    chapter: z
      .preprocess(
        (v) => (v === null || v === undefined ? undefined : typeof v === "string" ? parseInt(v, 10) : v),
        z.number().int().min(1).max(300).optional()
      ),

    song: z.object({
      title: z
        .string()
        .trim()
        .min(1, "title required")
        .max(200, "title too long")
        .transform((s) => s.replace(/[<>]/g, "")),
      version: z.string().trim().max(60).optional().nullable(),
      external_url: z
        .string()
        .trim()
        .url("invalid url")
        .refine((u) => /^https?:\/\//i.test(u), "must be http(s)")
        .max(2048)
        .optional()
        .nullable(),
    }),
    verse_ref: z.string().trim().max(60).optional().nullable(),
    added_by: z.string().trim().max(80).optional().nullable(),
  })
  .superRefine((val, ctx) => {
    // haftarah requires target_id
    if (val.target_kind === "haftarah" && !val.target_id) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["target_id"], message: "target_id required for haftarah" });
    }
    // tanach requires book_id + chapter
    if (val.target_kind === "tanach") {
      if (!val.book_id) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["book_id"], message: "book_id required for tanach" });
      }
      if (!val.chapter) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["chapter"], message: "chapter required for tanach" });
      }
    }
  });