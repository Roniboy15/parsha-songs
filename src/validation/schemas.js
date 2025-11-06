import { z } from "zod";

const idPattern = /^[a-z0-9-]{2,50}$/;

export const currentReadingQuerySchema = z.object({
  loc: z.enum(["israel", "diaspora"]).optional().default("diaspora"),
});

export const linksListQuerySchema = z.object({
  parasha_id: z.string().trim().regex(idPattern, "invalid parasha_id"),
  target_kind: z.enum(["parasha", "haftarah"]).optional(),
});

export const linkCreateSchema = z.object({
  parasha_id: z.string().trim().regex(idPattern, "invalid parasha_id"),
  target_kind: z.enum(["parasha", "haftarah"]),
  target_id: z.string().trim().regex(idPattern).nullable().optional(),
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
});