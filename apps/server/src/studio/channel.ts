import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { CONFIG_DIR } from "../paths";
import { MOODS } from "./sound";
import { themeSchema } from "./timeline";

/**
 * The channel bible (ROADMAP §7.3): what makes a channel recognizable, in
 * `config/channels/<id>.yaml`. A channel stays a `draft` until the owner picks its niche at the
 * Owner's Desk; drafts can make test videos, never posts (D-053).
 */

export const channelSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{2,40}$/),
  status: z.enum(["draft", "active", "paused"]),
  name: z.string().min(1).max(60),
  handle: z.string().max(40).optional(),
  niche: z.string().min(3).max(200),
  audience: z.string().min(3).max(300),
  persona: z.string().min(3).max(400),
  voice: z
    .object({
      kokoro: z.string().default("am_michael"),
      pronounce: z.record(z.string(), z.string()).default({}),
    })
    .default({ kokoro: "am_michael", pronounce: {} }),
  style: z.object({
    tone: z.string().max(400),
    rules: z.array(z.string().max(200)).max(20).default([]),
    bannedPhrases: z.array(z.string().max(60)).max(80).default([]),
  }),
  formats: z
    .object({
      long: z
        .object({
          minWords: z.number().int().default(1100),
          maxWords: z.number().int().default(1700),
        })
        .default({ minWords: 1100, maxWords: 1700 }),
      short: z
        .object({ minWords: z.number().int().default(70), maxWords: z.number().int().default(150) })
        .default({ minWords: 70, maxWords: 150 }),
    })
    .default({ long: { minWords: 1100, maxWords: 1700 }, short: { minWords: 70, maxWords: 150 } }),
  cadence: z
    .object({
      longPerWeek: z.number().min(0).max(7).default(1),
      shortsPerDay: z.number().min(0).max(5).default(1),
    })
    .default({ longPerWeek: 1, shortsPerDay: 1 }),
  theme: themeSchema.default(themeSchema.parse({})),
  music: z.object({ mood: z.enum(MOODS).default("calm") }).default({ mood: "calm" }),
  sources: z
    .object({
      prefer: z.array(z.string()).default([]),
      wikipediaSeeds: z.array(z.string()).default([]),
    })
    .default({ prefer: [], wikipediaSeeds: [] }),
  avoid: z.array(z.string().max(120)).max(30).default([]),
  disclosure: z.object({ aiNarration: z.boolean().default(true) }).default({ aiNarration: true }),
});
export type Channel = z.infer<typeof channelSchema>;

export const CHANNELS_DIR = path.join(CONFIG_DIR, "channels");

export function loadChannels(dir = CHANNELS_DIR): Channel[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".yaml"))
    .map((f) => {
      const parsed = channelSchema.safeParse(
        YAML.parse(fs.readFileSync(path.join(dir, f), "utf8")),
      );
      if (!parsed.success)
        throw new Error(
          `config/channels/${f}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
        );
      return parsed.data;
    });
}

export function saveChannel(channel: Channel, dir = CHANNELS_DIR): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${channel.id}.yaml`);
  fs.writeFileSync(
    file,
    `# Channel bible (ROADMAP §7.3). Edit freely; the studio reads it on each job.\n${YAML.stringify(channel)}`,
  );
  return file;
}

/** Phrases that mark lazy AI scripts; every channel avoids them on top of its own list. */
export const STOCK_AI_PHRASES = [
  "delve",
  "in today's video",
  "let's dive in",
  "dive deep",
  "buckle up",
  "mind-blowing",
  "without further ado",
  "smash that like",
  "don't forget to subscribe",
  "tapestry",
  "a testament to",
  "game-changer",
  "in conclusion",
  "unlock the secrets",
  "you won't believe",
  "ever wondered",
];

/** Banned phrases found in `text` (case-insensitive, whole phrases). */
export function bannedIn(text: string, channel: Channel): string[] {
  const lower = text.toLowerCase();
  return [
    ...new Set([...STOCK_AI_PHRASES, ...channel.style.bannedPhrases].map((p) => p.toLowerCase())),
  ].filter((p) => lower.includes(p));
}
