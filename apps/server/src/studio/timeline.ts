import { z } from "zod";

/**
 * A video as data (Stage 13): scenes on a timeline, the voice, music and effects, captions and
 * overlays. The pipeline writes it; `compose.ts` turns it into a HyperFrames composition. Every
 * media `src` is an absolute file path; nothing in it is random, so renders repeat exactly.
 */

export const CAMERA_MOVES = [
  "push-in",
  "pull-out",
  "pan-left",
  "pan-right",
  "tilt-up",
  "tilt-down",
  "drift",
] as const;
export type CameraMove = (typeof CAMERA_MOVES)[number];

export const FORMATS = {
  short: { width: 1080, height: 1920 },
  long: { width: 1920, height: 1080 },
} as const;
export type VideoFormat = keyof typeof FORMATS;

export const visualSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("title"),
    title: z.string().min(1).max(140),
    kicker: z.string().max(60).optional(),
    subtitle: z.string().max(160).optional(),
  }),
  z.object({
    type: z.literal("list"),
    index: z.number().int().min(0).max(999).optional(),
    heading: z.string().max(80).optional(),
    item: z.string().min(1).max(120),
    detail: z.string().max(200).optional(),
  }),
  z.object({
    type: z.literal("quote"),
    text: z.string().min(1).max(280),
    by: z.string().max(80).optional(),
  }),
  z.object({
    type: z.literal("stat"),
    value: z.number(),
    decimals: z.number().int().min(0).max(3).default(0),
    prefix: z.string().max(4).optional(),
    suffix: z.string().max(12).optional(),
    label: z.string().min(1).max(120),
  }),
  z.object({
    type: z.literal("still"),
    src: z.string().min(1),
    move: z.enum(CAMERA_MOVES).default("push-in"),
    label: z.string().max(120).optional(),
    credit: z.string().max(160).optional(),
  }),
  z.object({
    type: z.literal("video"),
    src: z.string().min(1),
    mediaStart: z.number().min(0).default(0),
    label: z.string().max(120).optional(),
    credit: z.string().max(160).optional(),
  }),
  z.object({
    type: z.literal("color"),
    text: z.string().max(140).optional(),
  }),
]);
export type Visual = z.infer<typeof visualSchema>;

export const sceneSchema = z.object({
  id: z.string().max(40).optional(),
  start: z.number().min(0),
  duration: z.number().positive(),
  visual: visualSchema,
  lowerThird: z.object({ text: z.string().max(60), sub: z.string().max(80).optional() }).optional(),
  transition: z.enum(["fade", "cut"]).default("fade"),
});
export type Scene = z.infer<typeof sceneSchema>;

const wordSchema = z.object({ text: z.string(), start: z.number(), end: z.number() });

export const themeSchema = z.object({
  bg: z.string().default("#0b1020"),
  bg2: z.string().default("#1b2550"),
  ink: z.string().default("#ffffff"),
  accent: z.string().default("#ffd23f"),
  display: z.string().default("Montserrat"),
  body: z.string().default("Inter"),
});
export type Theme = z.infer<typeof themeSchema>;

export const timelineSchema = z.object({
  format: z.enum(["short", "long"]),
  fps: z.number().int().min(12).max(60).default(30),
  duration: z.number().positive(),
  theme: themeSchema.default(themeSchema.parse({})),
  voice: z
    .object({ src: z.string().min(1), volume: z.number().min(0).max(3).default(1) })
    .optional(),
  music: z
    .object({
      src: z.string().min(1),
      volume: z.number().min(0).max(1).default(0.12),
      fadeIn: z.number().min(0).default(1.5),
      fadeOut: z.number().min(0).default(2.5),
    })
    .optional(),
  sfx: z
    .array(
      z.object({
        src: z.string().min(1),
        start: z.number().min(0),
        duration: z.number().positive(),
        volume: z.number().min(0).max(3).default(0.6),
      }),
    )
    .default([]),
  scenes: z.array(sceneSchema).min(1),
  captions: z
    .object({
      chunks: z.array(z.object({ start: z.number(), end: z.number(), words: z.array(wordSchema) })),
      style: z.enum(["karaoke", "plain"]).default("karaoke"),
    })
    .optional(),
  progressBar: z.boolean().default(false),
  watermark: z.string().max(40).optional(),
});
export type Timeline = z.infer<typeof timelineSchema>;
export type TimelineInput = z.input<typeof timelineSchema>;

/** Checks that scenes cover the whole video in order, without gaps or overlaps. */
export function timelineProblems(t: Timeline): string[] {
  const problems: string[] = [];
  const scenes = [...t.scenes].sort((a, b) => a.start - b.start);
  let at = 0;
  for (const s of scenes) {
    if (s.start > at + 0.05) problems.push(`gap before scene at ${s.start.toFixed(2)}s`);
    if (s.start < at - 0.05)
      problems.push(`scene at ${s.start.toFixed(2)}s overlaps the one before`);
    at = s.start + s.duration;
  }
  if (Math.abs(at - t.duration) > 0.1) {
    problems.push(`scenes end at ${at.toFixed(2)}s but the video is ${t.duration.toFixed(2)}s`);
  }
  return problems;
}
