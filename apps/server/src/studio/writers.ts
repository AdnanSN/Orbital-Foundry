import fs from "node:fs";
import path from "node:path";
import type { Approval, Lane } from "@orbital/shared";
import type Database from "better-sqlite3";
import { z } from "zod";
import type { ModelRouter } from "../llm/router";
import type { WorkDirector } from "../work/director";
import type { WorkStore } from "../work/store";
import type { WebClient } from "../work/web";
import {
  bannedIn,
  CHANNELS_DIR,
  type Channel,
  channelSchema,
  loadChannels,
  saveChannel,
} from "./channel";
import type { Signal, SignalService } from "./signals";
import { CAMERA_MOVES } from "./timeline";

/**
 * The Writers' Room (Stage 15): the niche study, ideas from real signals, research briefs with
 * sources, scripts with shot lists, and Lens's checks (facts against the brief, banned phrases,
 * length, sameness with earlier scripts). A pipeline in code like the factories (D-029); the owner
 * approves each script at the Owner's Desk (D-053).
 */

export const SHOT_KINDS = [
  "stock-video",
  "stock-image",
  "ai-still",
  "ai-video",
  "title",
  "list",
  "quote",
  "stat",
  "code",
] as const;
export type ShotKind = (typeof SHOT_KINDS)[number];

export const beatSchema = z.object({
  narration: z.string().min(1).max(900),
  visual: z.object({
    kind: z.enum(SHOT_KINDS),
    query: z.string().max(90).optional(),
    prompt: z.string().max(320).optional(),
    text: z.string().max(140).optional(),
    detail: z.string().max(180).optional(),
    value: z.number().optional(),
    prefix: z.string().max(4).optional(),
    suffix: z.string().max(14).optional(),
    label: z.string().max(110).optional(),
    by: z.string().max(80).optional(),
    move: z.enum(CAMERA_MOVES).optional(),
  }),
});
export type Beat = z.infer<typeof beatSchema>;

const packagingShape = {
  titles: z.array(z.string().min(5).max(100)).min(2).max(4),
  hooks: z.array(z.string().min(5).max(220)).min(2).max(4),
  description: z.string().min(20).max(1500),
  tags: z.array(z.string().max(30)).max(15),
  thumbnails: z
    .array(z.object({ text: z.string().max(40), idea: z.string().max(220) }))
    .min(1)
    .max(3),
};
const shortDraftSchema = z.object({ ...packagingShape, beats: z.array(beatSchema).min(3).max(14) });
const outlineSchema = z.object({
  ...packagingShape,
  sections: z
    .array(
      z.object({
        heading: z.string().max(90),
        points: z.array(z.string().max(240)).min(1).max(6),
        words: z.number().int().min(80).max(420),
        /** The facts this section uses ("F3" or 3), each fact in one section only. */
        facts: z
          .array(z.union([z.number().int(), z.string().max(8)]))
          .max(30)
          .optional(),
      }),
    )
    .min(4)
    .max(9),
});
const sectionSchema = z.object({ beats: z.array(beatSchema).min(2).max(14) });
/** Lens's fixes and the repeat pass: the flagged beats back, rewritten, in the same order. */
const rewriteSchema = z.object({ beats: z.array(beatSchema).min(1).max(24) });

/** "F12", "12" or 12 as a fact's index into the brief (null when it isn't one). */
function factIndex(x: number | string, count: number): number | null {
  const n = typeof x === "number" ? x : Number(String(x).replace(/^F/i, ""));
  return Number.isInteger(n) && n >= 0 && n < count ? n : null;
}

/** The hook pass: five openings, the strongest one, and the first beat rewritten around it. */
const hookSchema = z.object({
  hooks: z
    .array(
      z.object({
        line: z.string().min(5).max(200),
        screen: z.string().min(2).max(40),
      }),
    )
    .min(3)
    .max(6),
  best: z.number().int().min(0).max(5),
  opening: z.string().min(10).max(900),
  /** Packaging built on the chosen hook: the draft's titles came out flat ("Why So Slow"). */
  titles: z.array(z.string().min(5).max(100)).max(5).optional(),
  thumbnails: z
    .array(z.object({ text: z.string().max(40), idea: z.string().max(220) }))
    .max(3)
    .optional(),
});
const hookLineSchema = z.object({
  line: z.string().min(5).max(200),
  screen: z.string().min(2).max(40),
});
/** Lens's fix when it rewrites the opening beat: the hook comes back too, kept or corrected. */
const reviseOpeningSchema = z.object({
  beats: z.array(beatSchema).min(1).max(24),
  hook: hookLineSchema,
});

/**
 * What makes a first line hold a scroller, given to every hook pass. The examples are shapes from
 * other topics; only the video's own facts may be used.
 */
export function hookRules(maxWords: number): string {
  return `Hook rules. The first line decides whether a viewer stays, so:
- At most ${maxWords} words, spoken in under five seconds.
- Lead with the most surprising true thing in the facts: a contradiction, an impossible-sounding number, a vivid concrete image, or a question the viewer can't answer yet.
- Open a loop: the line raises a question the video answers later.
- Never open with a definition ("X is a…", "X are…"), a greeting, "In this video", "Today", "Have you ever wondered", "Did you know", "Imagine", or the channel's name.
- Only claims the facts support; specific beats vague. Keep each fact's exact meaning: say a technical fact plainly, but don't bend it (one rotation is not a sunrise-to-sunrise day).
Shapes from other topics: "There is a lake in Tanzania that turns animals to stone." "Somewhere above Venezuela, lightning strikes the same spot almost every night." "This frog freezes solid all winter, and its heart stops. Then it thaws."
"screen" is 2 to 5 punchy words shown big while the hook is spoken, never just the title (e.g. "TURNS ANIMALS TO STONE").`;
}

/** Openings that lose a scroller before the point (Lens flags them). */
export function weakOpening(narration: string, format: "short" | "long"): string | null {
  const first = narration.trim().split(/(?<=[.!?])\s+/)[0] ?? "";
  const n = first.split(/\s+/).filter(Boolean).length;
  if (
    /^(in this video|in today's|today\b|welcome|hi\b|hello|hey\b|have you ever|did you know|imagine\b|let's\b|so,?\s)/i.test(
      first,
    )
  ) {
    return `The video opens with "${first.split(/\s+/).slice(0, 3).join(" ")}…"; open on the surprise instead.`;
  }
  if (
    /^[\p{L}\p{N}\s,()'’-]{1,60}\b(is|are|was|were)\s+(a|an|the|one|brief|short|small|large|huge|tiny|rare|bright)\b/iu.test(
      first,
    )
  ) {
    return "The first line is a definition; open on the most surprising fact instead.";
  }
  if (n > (format === "short" ? 20 : 28)) {
    return `The first line runs ${n} words; a hook lands in about 15.`;
  }
  const vague = narration.match(
    /\b(reveal|uncover|explore|unravel)\s+(the\s+)?(mystery|mysteries|secrets?|truth)\b[^.!?]*/i,
  );
  if (vague) {
    return `The promise is vague ("${vague[0].slice(0, 60)}"); name the payoff the viewer will see.`;
  }
  return null;
}
const factsSchema = z.object({
  facts: z
    .array(z.object({ fact: z.string().max(320), source: z.number().int().min(0) }))
    .min(3)
    .max(30),
});
const reviewSchema = z.object({
  unsupported: z
    .array(
      z.object({
        beat: z.number().int().min(0),
        claim: z.string().max(320),
        why: z.string().max(320),
      }),
    )
    .max(20),
});
const ideasSchema = z.object({
  ideas: z
    .array(
      z.object({
        title: z.string().min(5).max(110),
        angle: z.string().min(5).max(300),
        format: z.enum(["short", "long", "both"]),
        hook: z.string().max(220),
        demand: z.number().min(1).max(10),
        originality: z.number().min(1).max(10),
        fit: z.number().min(1).max(10),
        risk: z.number().min(1).max(10),
        why: z.string().max(300),
        wikipedia: z.array(z.string().max(90)).min(1).max(3),
      }),
    )
    .min(1)
    .max(12),
});
const nicheSchema = z.object({
  niches: z
    .array(
      z.object({
        name: z.string().max(80),
        pitch: z.string().max(300),
        audience: z.string().max(300),
        demand: z.number().min(1).max(10),
        competition: z.number().min(1).max(10),
        adRates: z.number().min(1).max(10),
        policyRisk: z.number().min(1).max(10),
        freeStackFit: z.number().min(1).max(10),
        why: z.string().max(500),
        exampleIdeas: z.array(z.string().max(120)).min(3).max(5),
        wikipediaSeeds: z.array(z.string().max(80)).min(2).max(6),
      }),
    )
    .length(3),
});
const bibleSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{2,40}$/),
  name: z.string().max(60),
  niche: z.string().max(200),
  audience: z.string().max(300),
  persona: z.string().max(400),
  tone: z.string().max(400),
  rules: z.array(z.string().max(200)).min(3).max(10),
  avoid: z.array(z.string().max(120)).min(3).max(12),
  mood: z.enum(["calm", "space", "uplifting", "tense"]),
  prefer: z.array(z.enum(["nasa", "pixabay", "openverse"])).min(1),
});

export interface Idea {
  id: string;
  channel: string;
  title: string;
  angle: string;
  format: "short" | "long" | "both";
  hook: string;
  score: number;
  /** The 1-10 ratings behind the score, for the learning loop (Stage 19). */
  scores?: { demand: number; originality: number; fit: number; risk: number };
  why: string;
  wikipedia: string[];
  status: "backlog" | "scripted" | "rejected";
  createdAt: string;
}

export interface Brief {
  sources: { title: string; url: string }[];
  facts: { fact: string; source: number }[];
}

export interface ScriptChecks {
  words: number;
  unsupported: { beat: number; claim: string; why: string }[];
  banned: string[];
  sameness: number;
  problems: string[];
}

export type ScriptStatus = "writing" | "review" | "approved" | "rejected" | "produced" | "failed";

export interface ScriptDoc {
  id: string;
  channel: string;
  format: "short" | "long";
  status: ScriptStatus;
  version: number;
  ideaId: string | null;
  idea: { title: string; angle: string };
  titles: string[];
  hooks: string[];
  /** The opening chosen by the hook pass: the spoken first line and the words on screen. */
  hook?: { line: string; text: string };
  beats: Beat[];
  description: string;
  tags: string[];
  thumbnails: { text: string; idea: string }[];
  brief: Brief;
  checks: ScriptChecks;
  note?: string;
  artifactId?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WritersDeps {
  router: ModelRouter;
  lane: Lane;
  web: WebClient;
  signals: SignalService;
  store: WorkStore;
  db: Database.Database;
  director?: WorkDirector;
  /** Where script and niche reports are written (data/artifacts/studio/scripts). */
  dir: string;
  channelsDir?: string;
  /** Waits between retries (tests pass a fast one). */
  sleep?: (ms: number) => Promise<void>;
  /** What the weekly retro learned and the owner approved (Stage 19): weights and lessons. */
  learning?: {
    weights(channelId: string): IdeaWeights;
    lessons(channelId: string): string[];
  };
  /** A speech bubble for a crew role ("researcher", "operator", "reviewer"). */
  say?: (role: string, text: string) => void;
  log?: (message: string) => void;
  now?: () => number;
}

export function wordCount(beats: Beat[]): number {
  return beats.reduce((n, b) => n + b.narration.split(/\s+/).filter(Boolean).length, 0);
}

function trigrams(text: string): Set<string> {
  const w = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i + 2 < w.length; i++) out.add(`${w[i]} ${w[i + 1]} ${w[i + 2]}`);
  return out;
}

/** How much of `a`'s phrasing (word trigrams) already appears in `b`, 0 to 1. */
export function sameness(a: string, b: string): number {
  const x = trigrams(a);
  const y = trigrams(b);
  if (x.size === 0 || y.size === 0) return 0;
  let shared = 0;
  for (const t of x) if (y.has(t)) shared++;
  return shared / x.size;
}

const SUPERSCRIPT: Record<string, string> = {
  "⁰": "0",
  "¹": "1",
  "²": "2",
  "³": "3",
  "⁴": "4",
  "⁵": "5",
  "⁶": "6",
  "⁷": "7",
  "⁸": "8",
  "⁹": "9",
  "⁻": "-",
};
const SCALE: Record<string, number> = { thousand: 1e3, million: 1e6, billion: 1e9, trillion: 1e12 };

/**
 * The numbers a text states, read the way a viewer would: "3,000", "1.5 million", "10^9" and
 * "1.5 × 10⁶". A power of ten counts as one number, so "10^9" never passes for "10".
 */
export function numbersIn(text: string): number[] {
  let t = text
    .replace(
      /(10)([⁰¹²³⁴⁵⁶⁷⁸⁹⁻]+)/g,
      (_m, b: string, e: string) => `${b}^${[...e].map((c) => SUPERSCRIPT[c]).join("")}`,
    )
    .replace(/(\d),(?=\d{3}\b)/g, "$1");
  const out: number[] = [];
  t = t.replace(
    /(?:(\d+(?:\.\d+)?)\s*[×x*]\s*)?10\s*\^\s*(-?\d+)/g,
    (_m, coef: string | undefined, exp: string) => {
      out.push((coef ? Number(coef) : 1) * 10 ** Number(exp));
      return " ";
    },
  );
  for (const m of t.matchAll(/(\d+(?:\.\d+)?)(?:\s*(thousand|million|billion|trillion)\b)?/gi)) {
    out.push(Number(m[1]) * (m[2] ? (SCALE[m[2].toLowerCase()] ?? 1) : 1));
  }
  return out;
}

/** Stat cards showing a number that neither their own line nor the facts give (e.g. "10 tesla" for 10^9). */
export function statMismatches(beats: Beat[], facts: string): { beat: number; value: number }[] {
  const known = numbersIn(facts);
  const out: { beat: number; value: number }[] = [];
  beats.forEach((b, i) => {
    const v = b.visual;
    if (v.kind !== "stat" || v.value === undefined) return;
    const said = [...numbersIn(b.narration), ...known];
    const close = (n: number) =>
      n === v.value || Math.abs(n - (v.value as number)) <= Math.abs(v.value as number) * 0.02;
    if (!said.some(close)) out.push({ beat: i, value: v.value });
  });
  return out;
}

/** A beat's content words, roughly stemmed ("rises" and "rise" meet), without short words. */
function contentWords(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}.]+/u)) {
    const w = raw.replace(/'s$/, "").replace(/\.$/, "");
    if (w.length < 4 || STOP_WORDS.has(w)) continue;
    out.add(w.length > 5 ? w.replace(/(ing|ed|es|s)$/, "") : w.replace(/s$/, ""));
  }
  return out;
}
const STOP_WORDS = new Set([
  "that",
  "this",
  "with",
  "from",
  "into",
  "than",
  "then",
  "they",
  "their",
  "there",
  "these",
  "those",
  "which",
  "while",
  "where",
  "when",
  "what",
  "about",
  "after",
  "before",
  "also",
  "only",
  "just",
  "more",
  "most",
  "very",
  "even",
  "been",
  "have",
  "were",
  "will",
  "would",
  "could",
  "because",
]);

/**
 * Pairs of beats that say nearly the same thing (a fact repeated as filler): half their phrasing
 * in common, or, for paraphrases ("the Sun rises in the west" / "the Sun to rise in the west"),
 * 60% of their content words once the topic's own words (in most beats) are set aside.
 */
export function repeatedBeats(beats: Beat[], threshold = 0.5): [number, number][] {
  const grams = beats.map((b) => trigrams(b.narration));
  const words = beats.map((b) => contentWords(b.narration));
  const df = new Map<string, number>();
  for (const ws of words) for (const w of ws) df.set(w, (df.get(w) ?? 0) + 1);
  const topic = Math.max(3, Math.ceil(beats.length * 0.6));
  const own = words.map((ws) => new Set([...ws].filter((w) => (df.get(w) ?? 0) < topic)));
  const out: [number, number][] = [];
  for (let i = 0; i < grams.length; i++) {
    for (let j = i + 1; j < grams.length; j++) {
      const a = grams[i] as Set<string>;
      const b = grams[j] as Set<string>;
      const small = Math.min(a.size, b.size);
      let shared = 0;
      for (const t of a) if (b.has(t)) shared++;
      const phrasing = small >= 4 && shared / small >= threshold;
      const x = own[i] as Set<string>;
      const y = own[j] as Set<string>;
      const fewer = Math.min(x.size, y.size);
      let common = 0;
      for (const w of x) if (y.has(w)) common++;
      const paraphrase = fewer >= 5 && common / fewer >= 0.6;
      if (phrasing || paraphrase) out.push([i, j]);
    }
  }
  return out;
}

/** Beats that are mostly an earlier beat word for word: they add nothing, so the repeat pass cuts them. */
export function verbatimRepeats(beats: Beat[], threshold = 0.7): number[] {
  const grams = beats.map((b) => trigrams(b.narration));
  const out: number[] = [];
  for (let j = 1; j < grams.length; j++) {
    const later = grams[j] as Set<string>;
    if (later.size < 4) continue;
    for (let i = 0; i < j; i++) {
      if (out.includes(i)) continue;
      const earlier = grams[i] as Set<string>;
      let shared = 0;
      for (const t of later) if (earlier.has(t)) shared++;
      if (shared / later.size >= threshold) {
        out.push(j);
        break;
      }
    }
  }
  return out;
}

const VISUAL_GUIDE = `Each beat is 1 to 3 sentences of narration and one visual:
- "stock-video" with "query": 2 to 4 concrete, filmable words (e.g. "rocket launch night", "ocean waves aerial"). Real footage of real things.
- "stock-image" with "query": a photo search, same style. Prefer for specific named objects (planets, telescopes, places).
- "ai-still" with "prompt": an illustration of something no camera can film (inside a star, the far future). Never realistic people or real events.
- "ai-video" with "prompt": 5 seconds of AI-made motion for the hook or a key moment no footage shows (a glowing sphere drifting down a dark corridor). Describe one simple scene with slow motion. At most 2 in a short and 6 in a long-form. Never realistic people or real events.
- "title" with "text" (and optional "detail"): a short heading card.
- "list" with "value" (the number), "text" (the item) and optional "detail".
- "quote" with "text" and "by": only quotes that appear in the facts.
- "stat" with "value", optional "prefix"/"suffix" and "label": a number from the facts.
- "code": a calm starfield, for transitions.
Optional "move" for stills: push-in, pull-out, pan-left, pan-right, tilt-up, tilt-down, drift. Vary visuals; never the same kind three times in a row.`;

export class WritersRoom {
  private readonly now: () => number;
  private readonly running = new Set<string>();
  private learning: WritersDeps["learning"];

  constructor(private readonly deps: WritersDeps) {
    this.now = deps.now ?? Date.now;
    this.learning = deps.learning;
    fs.mkdirSync(deps.dir, { recursive: true });
    deps.director?.onDecision((a) => this.onDecision(a));
    // Scripts cut off by a restart are marked failed rather than left "writing" forever.
    deps.db
      .prepare(
        "UPDATE scripts SET status = 'failed', data = json_set(data, '$.status', 'failed', '$.error', 'The station restarted while writing.') WHERE status = 'writing'",
      )
      .run();
  }

  channels(): Channel[] {
    return loadChannels(this.deps.channelsDir ?? CHANNELS_DIR);
  }

  channel(id: string): Channel {
    const c = this.channels().find((x) => x.id === id);
    if (!c) throw new Error(`No channel "${id}" in config/channels.`);
    return c;
  }

  private async ask<T>(
    tier: "reasoning" | "creative",
    system: string,
    prompt: string,
    schema: z.ZodType<T>,
  ): Promise<T> {
    // Free tiers cap tokens per minute: when every model is only rate-limited, wait and go again
    // (up to four more times, 20 s, 40 s, 60 s, 80 s) rather than failing the whole script.
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await this.deps.router.generate({
          tier,
          lane: this.deps.lane,
          system,
          prompt,
          schema,
          temperature: tier === "creative" ? 0.8 : 0.3,
        });
        if (res.data === undefined)
          throw new Error(`The ${tier} model's reply didn't fit the expected shape.`);
        return res.data;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const limited = /rate-limited|429|tokens per minute/i.test(message);
        if (!limited || attempt >= 4) throw err;
        this.log(`rate-limited; trying again in ${20 * (attempt + 1)} s`);
        await (this.deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms))))(
          20_000 * (attempt + 1),
        );
      }
    }
  }

  private say(role: string, text: string): void {
    this.deps.say?.(role, text);
  }

  private log(m: string): void {
    this.deps.log?.(m);
  }

  // ---------------------------------------------------------------- niche study

  /** Scout proposes three niches; the owner picks one at the Desk (note "1", "2" or "3"). */
  async nicheStudy(): Promise<{ artifactId: string; approvalId: string | null }> {
    this.say("researcher", "Studying niches for the channel…");
    const signals = await this.deps.signals.gather(this.deps.lane).catch(() => [] as Signal[]);
    const result = await this.ask(
      "reasoning",
      `You advise a one-person faceless YouTube, TikTok and Instagram studio. It makes explainer videos with motion graphics, stock and public-domain footage (Pixabay, NASA, Openverse), occasional AI illustrations, an AI narrator (disclosed) and no presenter. YouTube demonetizes mass-produced or repetitive AI channels ("inauthentic content"), so the niche must allow original research and a point of view in every video. Avoid sensitive topics for an AI narrator (health, finance, news, elections), made-for-kids content, and anything built on other people's clips (reaction, recap, Reddit stories).`,
      `Propose exactly 3 distinct niches for this studio. Score each 1-10: demand, competition (10 = crowded), adRates (likely ad revenue per view), policyRisk (10 = risky), freeStackFit (how well free footage and motion graphics can carry it). Give 3 to 5 example video ideas and 2 to 6 English Wikipedia article titles to research first.\n\nToday's trend signals, for context (may be irrelevant):\n${formatSignals(signals, 30)}`,
      nicheSchema,
    );
    const md = [
      "# Niche study",
      "",
      "Scout's three candidate niches for the channel. **Approve this item with a note of `1`, `2` or `3`** to pick one; the studio then writes its channel bible (`config/channels/`). Send it back to ask for three new ones.",
      "",
      ...result.niches.flatMap((n, i) => [
        `## ${i + 1}. ${n.name}`,
        "",
        n.pitch,
        "",
        `- **Audience:** ${n.audience}`,
        `- **Scores (1-10):** demand ${n.demand} · competition ${n.competition} · ad rates ${n.adRates} · policy risk ${n.policyRisk} · fits the free stack ${n.freeStackFit}`,
        `- **Why:** ${n.why}`,
        `- **Example videos:** ${n.exampleIdeas.join("; ")}`,
        "",
      ]),
    ].join("\n");
    const artifactId = this.saveText("studio.niches", "Niche study: three candidates", md, {
      niches: result.niches,
    });
    const approval = this.deps.director?.fileDeskItem({
      kind: "deliverable",
      title: "Pick the channel's niche (note 1, 2 or 3)",
      summary: result.niches.map((n, i) => `${i + 1}. ${n.name}`).join(" · "),
      requestedBy: "scout",
      objectiveId: null,
      taskId: null,
      artifactId,
      action: null,
    });
    this.say("researcher", "Three niches are waiting at the Owner's Desk.");
    return { artifactId, approvalId: approval?.id ?? null };
  }

  /** Writes the channel bible for the chosen niche. */
  private async adoptNiche(artifactId: string, note: string | null): Promise<void> {
    const art = this.deps.store.artifact(artifactId);
    const niches = (art?.meta.info?.niches ?? []) as z.infer<typeof nicheSchema>["niches"];
    const pick = Number(/[123]/.exec(note ?? "")?.[0] ?? "1") - 1;
    const niche = niches[pick];
    if (!niche) return;
    const bible = await this.ask(
      "creative",
      "You write channel bibles for a faceless explainer studio with an AI narrator (always disclosed).",
      `Write the channel bible for this niche:\n${JSON.stringify(niche, null, 2)}\nThe id is a short kebab-case slug. Rules are concrete writing rules (sourcing, structure, tone). "avoid" lists topics to stay away from, always including health or financial advice, politics and news, and content made for children. "prefer" orders the footage sources.`,
      bibleSchema,
    );
    const channel = channelSchema.parse({
      id: bible.id,
      status: "active",
      name: "Orbital Foundry Studio",
      handle: "@orbitalfoundry",
      niche: bible.niche,
      audience: bible.audience,
      persona: `${bible.persona} The narration is an AI voice, and every description says so.`,
      style: { tone: bible.tone, rules: bible.rules, bannedPhrases: [] },
      music: { mood: bible.mood },
      sources: { prefer: bible.prefer, wikipediaSeeds: niche.wikipediaSeeds },
      avoid: bible.avoid,
    });
    const file = saveChannel(channel, this.deps.channelsDir ?? CHANNELS_DIR);
    this.log(`niche ${pick + 1} adopted: ${channel.id} (${file})`);
    this.say("researcher", `Our niche: ${niche.name}. The channel bible is written.`);
  }

  // ---------------------------------------------------------------- learning

  /** The learning loop (Stage 19) plugs in after the station builds it. */
  setLearning(learning: NonNullable<WritersDeps["learning"]>): void {
    this.learning = learning;
  }

  /** Lessons the owner approved, for every prompt. */
  private lessons(channelId: string): string[] {
    try {
      return this.learning?.lessons(channelId) ?? [];
    } catch {
      return [];
    }
  }

  /** Re-scores the backlog with the current weights, so an approved retro reorders the slate. */
  rescore(channelId: string): number {
    const w = this.learning?.weights(channelId);
    let n = 0;
    for (const idea of this.ideas(channelId, "backlog")) {
      if (!idea.scores) continue;
      const score = scoreIdea(idea.scores, w);
      if (score === idea.score) continue;
      idea.score = score;
      this.deps.db
        .prepare("UPDATE ideas SET score = ?, data = ? WHERE id = ?")
        .run(score, JSON.stringify(idea), idea.id);
      n += 1;
    }
    return n;
  }

  // ---------------------------------------------------------------- ideas

  async proposeIdeas(channelId: string, count = 8): Promise<Idea[]> {
    const channel = this.channel(channelId);
    this.say("researcher", "Reading today's signals for ideas…");
    const signals = await this.deps.signals.gather(this.deps.lane).catch(() => [] as Signal[]);
    // Four ideas a call: free tiers cap a reply at about 1,500 tokens, reasoning included.
    const proposed: z.infer<typeof ideasSchema>["ideas"] = [];
    while (proposed.length < count) {
      const recent = [
        ...this.ideas(channelId)
          .slice(0, 40)
          .map((i) => i.title),
        ...proposed.map((p) => p.title),
      ]
        .map((t) => `- ${t}`)
        .join("\n");
      const batch = Math.min(4, count - proposed.length);
      const result = await this.ask(
        "reasoning",
        channelSystem(channel, this.lessons(channel.id)),
        `Propose ${batch} video ideas for this channel. Keep every field short. Each needs an original angle (what this video adds that others don't), a format (short = 30-60 s, long = 8-12 min, both), a first-line hook, scores 1-10 for demand, originality, fit with the channel and policy risk (10 = risky), and 1 to 3 English Wikipedia article titles to research. Evergreen ideas are welcome; tie to a signal only when it truly fits the niche.\n\nAvoid repeating these earlier ideas:\n${recent || "(none yet)"}\n\nSignals (searches, page views, videos):\n${formatSignals(signals, 25)}\n\nSeed topics: ${channel.sources.wikipediaSeeds.join(", ") || "(none)"}`,
        ideasSchema,
      );
      if (result.ideas.length === 0) break;
      proposed.push(...result.ideas.slice(0, batch));
    }
    const at = new Date(this.now()).toISOString();
    const ideas = proposed.map(
      (x): Idea => ({
        id: this.deps.store.nextId("I"),
        channel: channelId,
        title: x.title,
        angle: x.angle,
        format: x.format,
        hook: x.hook,
        score: scoreIdea(x, this.learning?.weights(channelId)),
        scores: { demand: x.demand, originality: x.originality, fit: x.fit, risk: x.risk },
        why: x.why,
        wikipedia: x.wikipedia,
        status: "backlog",
        createdAt: at,
      }),
    );
    const stmt = this.deps.db.prepare(
      "INSERT INTO ideas (id, channel, title, score, status, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    for (const i of ideas)
      stmt.run(i.id, i.channel, i.title, i.score, i.status, JSON.stringify(i), i.createdAt);
    this.say("researcher", `${ideas.length} ideas in the backlog.`);
    return ideas.sort((a, b) => b.score - a.score);
  }

  ideas(channelId?: string, status?: Idea["status"]): Idea[] {
    const rows = this.deps.db
      .prepare(
        `SELECT data FROM ideas WHERE (? IS NULL OR channel = ?) AND (? IS NULL OR status = ?) ORDER BY score DESC, created_at DESC LIMIT 200`,
      )
      .all(channelId ?? null, channelId ?? null, status ?? null, status ?? null) as {
      data: string;
    }[];
    return rows.map((r) => JSON.parse(r.data) as Idea);
  }

  private setIdeaStatus(id: string, status: Idea["status"]): void {
    const row = this.deps.db.prepare("SELECT data FROM ideas WHERE id = ?").get(id) as
      | { data: string }
      | undefined;
    if (!row) return;
    const idea = { ...(JSON.parse(row.data) as Idea), status };
    this.deps.db
      .prepare("UPDATE ideas SET status = ?, data = ? WHERE id = ?")
      .run(status, JSON.stringify(idea), id);
  }

  // ---------------------------------------------------------------- research

  async research(
    _channel: Channel,
    idea: Pick<Idea, "title" | "angle" | "wikipedia">,
    format: "short" | "long" = "short",
  ): Promise<Brief> {
    this.say("researcher", `Researching: ${idea.title.slice(0, 40)}…`);
    // A long-form needs far more than a short: eight facts stretched over eight minutes repeat.
    const long = format === "long";
    const chars = long ? 9000 : 4500;
    const most = long ? 3 : 2;
    const sources: { title: string; url: string; text: string }[] = [];
    for (const title of (idea.wikipedia ?? [idea.title]).slice(0, 4)) {
      try {
        let page = await this.deps.web.article(title, chars);
        if (!page.text) {
          const hit = (await this.deps.web.search(title, 1))[0];
          if (hit) page = await this.deps.web.article(hit.title, chars);
        }
        if (page.text && !sources.some((s) => s.url === page.url)) sources.push(page);
      } catch (err) {
        this.log(`research: ${title}: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (sources.length >= most) break;
    }
    if (sources.length === 0) throw new Error(`No sources found for "${idea.title}".`);
    const system =
      "You are a careful research assistant. Extract only facts stated in the sources; never add outside knowledge. Keep each fact's numbers and names exactly as the source states them.";
    let facts: Brief["facts"] = [];
    if (long) {
      // One source per call keeps each reply under the free tiers' output cap.
      for (const [i, s] of sources.entries()) {
        const res = await this.ask(
          "reasoning",
          system,
          `Video idea: ${idea.title}\nAngle: ${idea.angle}\n\nList 10 to 20 facts from this source that an 8-12 minute video on this idea could use: numbers, dates, how we know, surprises, open questions. Use source index 0 for each.\n\n[0] ${s.title} (${s.url})\n${s.text}`,
          factsSchema,
        ).catch((err: unknown) => {
          this.log(`research: facts from ${s.title}: ${String(err)}`);
          return { facts: [] };
        });
        facts.push(...res.facts.map((f) => ({ fact: f.fact, source: i })));
      }
      const seen = new Set<string>();
      facts = facts.filter((f) => {
        const key = f.fact.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      if (facts.length === 0)
        throw new Error(`No facts came out of the sources for "${idea.title}".`);
    } else {
      const result = await this.ask(
        "reasoning",
        system,
        `Video idea: ${idea.title}\nAngle: ${idea.angle}\n\nList 8 to 25 facts from these sources that a script on this idea could use: numbers, dates, how we know, open questions. Each fact cites its source by index.\n\n${sources.map((s, i) => `[${i}] ${s.title} (${s.url})\n${s.text}`).join("\n\n")}`,
        factsSchema,
      );
      facts = result.facts.filter((f) => f.source < sources.length);
    }
    return { sources: sources.map((s) => ({ title: s.title, url: s.url })), facts };
  }

  // ---------------------------------------------------------------- scripts

  scripts(channelId?: string, status?: ScriptStatus): ScriptDoc[] {
    const rows = this.deps.db
      .prepare(
        "SELECT data FROM scripts WHERE (? IS NULL OR channel = ?) AND (? IS NULL OR status = ?) ORDER BY created_at DESC LIMIT 200",
      )
      .all(channelId ?? null, channelId ?? null, status ?? null, status ?? null) as {
      data: string;
    }[];
    return rows.map((r) => JSON.parse(r.data) as ScriptDoc);
  }

  script(id: string): ScriptDoc | null {
    const row = this.deps.db.prepare("SELECT data FROM scripts WHERE id = ?").get(id) as
      | { data: string }
      | undefined;
    return row ? (JSON.parse(row.data) as ScriptDoc) : null;
  }

  saveScript(doc: ScriptDoc): void {
    doc.updatedAt = new Date(this.now()).toISOString();
    this.deps.db
      .prepare(
        `INSERT INTO scripts (id, channel, format, status, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status, data = excluded.data, updated_at = excluded.updated_at`,
      )
      .run(
        doc.id,
        doc.channel,
        doc.format,
        doc.status,
        JSON.stringify(doc),
        doc.createdAt,
        doc.updatedAt,
      );
  }

  /** Starts a script in the background; returns its record at once. */
  start(
    channelId: string,
    opts: {
      format: "short" | "long";
      ideaId?: string;
      note?: string;
      from?: ScriptDoc;
      /** Corrected facts for a rewrite, replacing the earlier brief's (sources stay). */
      facts?: Brief["facts"];
      /** Fresh research for a rewrite, from these Wikipedia articles (the old brief is dropped). */
      wikipedia?: string[];
      /** A corrected angle for the idea. */
      angle?: string;
    },
  ): ScriptDoc {
    const channel = this.channel(channelId);
    const at = new Date(this.now()).toISOString();
    const found =
      opts.from?.idea ??
      (opts.ideaId ? this.ideas(channelId).find((i) => i.id === opts.ideaId) : undefined) ??
      this.ideas(channelId, "backlog").find((i) => i.format === opts.format || i.format === "both");
    const idea =
      found && (opts.angle || opts.wikipedia)
        ? {
            ...found,
            ...(opts.angle ? { angle: opts.angle } : {}),
            ...(opts.wikipedia ? { wikipedia: opts.wikipedia } : {}),
          }
        : found;
    const doc: ScriptDoc = {
      id: this.deps.store.nextId("S"),
      channel: channel.id,
      format: opts.format,
      status: "writing",
      version: (opts.from?.version ?? 0) + 1,
      ideaId: opts.from?.ideaId ?? (idea && "id" in idea ? (idea as Idea).id : null),
      idea: { title: idea?.title ?? "", angle: idea?.angle ?? "" },
      titles: [],
      hooks: [],
      beats: [],
      description: "",
      tags: [],
      thumbnails: [],
      brief:
        opts.from && !opts.wikipedia
          ? { sources: opts.from.brief.sources, facts: opts.facts ?? opts.from.brief.facts }
          : { sources: [], facts: [] },
      checks: { words: 0, unsupported: [], banned: [], sameness: 0, problems: [] },
      ...(opts.note ? { note: opts.note } : {}),
      createdAt: at,
      updatedAt: at,
    };
    if (!idea) {
      doc.status = "failed";
      doc.error = "No idea in the backlog for this format. Propose ideas first.";
      this.saveScript(doc);
      return doc;
    }
    this.saveScript(doc);
    this.running.add(doc.id);
    // One script at a time: parallel scripts only fight over the same per-minute token budget.
    this.queue = this.queue
      .then(() => this.write(channel, doc, idea as Idea))
      .catch((err: unknown) => {
        doc.status = "failed";
        doc.error = err instanceof Error ? err.message : String(err);
        this.saveScript(doc);
        this.log(`script ${doc.id} failed: ${doc.error}`);
        this.say("operator", "The script stalled; it's marked failed.");
      })
      .finally(() => this.running.delete(doc.id));
    return doc;
  }

  private queue: Promise<void> = Promise.resolve();

  /** Waits for a background script (tests and scripts). */
  async settled(id: string, timeoutMs = 20 * 60_000): Promise<ScriptDoc | null> {
    const until = Date.now() + timeoutMs;
    while (this.running.has(id) && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
    return this.script(id);
  }

  private async write(
    channel: Channel,
    doc: ScriptDoc,
    idea: Pick<Idea, "id" | "title" | "angle" | "wikipedia">,
  ): Promise<void> {
    if (doc.brief.facts.length === 0) doc.brief = await this.research(channel, idea, doc.format);
    const lines = doc.brief.facts.map(
      (f, i) => `F${i}: ${f.fact} [${doc.brief.sources[f.source]?.title ?? "?"}]`,
    );
    const facts = lines.join("\n");
    const words = channel.formats[doc.format];
    const revision = doc.note
      ? `\n\nThe owner sent the previous version back with this note; follow it:\n${doc.note}`
      : "";
    this.say("operator", `Writing a ${doc.format}: ${doc.idea.title.slice(0, 36)}…`);
    if (doc.format === "short") {
      const draft = await this.ask(
        "creative",
        channelSystem(channel, this.lessons(channel.id)),
        `Write a ${words.minWords}-${words.maxWords} word vertical short (30-60 seconds) on:\nIdea: ${doc.idea.title}\nAngle: ${doc.idea.angle}\n\nUse only these facts:\n${facts}\n\nUse 5 to 9 beats of 1 to 3 sentences each, every beat adding something new. The first beat opens with the hook: at most 15 words, the most surprising true thing in the facts, never a definition. End on the idea itself, no call to action. Give 2-3 titles of 35 to 65 characters that make a viewer curious without lying (e.g. "Why a Day on Venus Outlasts Its Year", never just the topic), 2-3 alternative hooks, a description (2-3 sentences, then "Narration: AI voice."), up to 12 tags and 1-3 thumbnail ideas (2 to 5 words that tease the hook, not just the topic).\n\n${VISUAL_GUIDE}${revision}`,
        shortDraftSchema,
      );
      Object.assign(doc, {
        titles: draft.titles,
        hooks: draft.hooks,
        beats: draft.beats,
        description: draft.description,
        tags: draft.tags,
        thumbnails: draft.thumbnails,
      });
    } else {
      const target = Math.round((words.minWords + words.maxWords) / 2);
      const outline = await this.ask(
        "creative",
        channelSystem(channel, this.lessons(channel.id)),
        `Outline an 8-12 minute YouTube video (${words.minWords}-${words.maxWords} words in all) on:\nIdea: ${doc.idea.title}\nAngle: ${doc.idea.angle}\n\nFacts available:\n${facts}\n\nGive 5 to 8 sections (the first is the hook and promise, the last pays it off), each with points, a word budget (about ${target} words in all) and "facts": the numbers of the facts it uses (e.g. [0, 4, 7]). Give each fact to one section only, so the video never says the same thing twice, and leave out facts that don't serve the story. Also 2-3 titles of 35 to 65 characters that make a viewer curious without lying (never just the topic), 2-3 alternative opening hooks, a description (3-4 sentences, then "Narration: AI voice."), up to 15 tags and 2-3 thumbnail ideas (2 to 5 words that tease the hook, not just the topic).${revision}`,
        outlineSchema,
      );
      Object.assign(doc, {
        titles: outline.titles,
        hooks: outline.hooks,
        description: outline.description,
        tags: outline.tags,
        thumbnails: outline.thumbnails,
        beats: [],
      });
      // Each section writes from its own facts and sees what the video has already said: written
      // blind, sections each restated the brief's best facts (one script said a fact five times).
      // Budgets are scaled to land the whole script inside the channel's word range.
      const owned = outline.sections.map((s) => [
        ...new Set(
          (s.facts ?? [])
            .map((x) => factIndex(x, lines.length))
            .filter((n): n is number => n !== null),
        ),
      ]);
      const planned = outline.sections.reduce((n, s) => n + s.words, 0);
      const scale = planned > words.maxWords || planned < words.minWords ? target / planned : 1;
      const last = outline.sections.length - 1;
      for (const [i, section] of outline.sections.entries()) {
        const budget = Math.max(60, Math.round(section.words * scale));
        const own = owned[i] ?? [];
        const payoff = i === 0 && last > 0 ? (owned[last] ?? []) : [];
        const said = doc.beats.map((b) => `- ${b.narration.slice(0, 160)}`).join("\n");
        const part = await this.ask(
          "creative",
          channelSystem(channel, this.lessons(channel.id)),
          `Write section ${i + 1} of ${outline.sections.length} ("${section.heading}") of a video titled "${outline.titles[0]}". About ${budget} words of narration (never more than ${Math.round(budget * 1.15)}), in beats of 1 to 3 sentences, each adding something new.\nCover: ${section.points.join("; ")}\n${i === 0 ? "Open with the hook (at most 22 words: the most surprising true thing, never a definition), then one sentence promising the payoff the video builds to: name what the viewer will find out, never just 'this video will reveal the mystery'." : `It follows: "${doc.beats.at(-1)?.narration.slice(-200) ?? ""}"`}\n${i === last ? "End on the idea itself; no call to action." : ""}\n${said ? `Already said earlier in the video (never say any of it again):\n${said}\n\n` : ""}${own.length > 0 ? `Use only these facts (this section's own; the others belong to other sections):\n${own.map((n) => lines[n]).join("\n")}` : `Use only these facts:\n${facts}`}${payoff.length > 0 ? `\n\nThe payoff the video builds to (tease it in the promise; don't explain it yet):\n${payoff.map((n) => lines[n]).join("\n")}` : ""}\n\n${VISUAL_GUIDE}`,
          sectionSchema,
        );
        doc.beats.push(...part.beats);
        doc.updatedAt = new Date(this.now()).toISOString();
        this.saveScript(doc);
      }
    }
    await this.tighten(channel, doc, facts);
    await this.sharpenHook(channel, doc, facts);
    await this.check(channel, doc, 2);
    // Lens's fixes can say a beat again in other words; one more repeat pass, then the final word.
    if (repeatedBeats(doc.beats).length > 0) {
      await this.tighten(channel, doc, facts);
      await this.check(channel, doc, 0);
    }
    doc.status = "review";
    this.saveScript(doc);
    if (doc.ideaId) this.setIdeaStatus(doc.ideaId, "scripted");
    this.submit(channel, doc);
  }

  /**
   * The repeat pass: a beat that says again what an earlier beat said is rewritten to move the
   * video on, and one that is still an earlier beat word for word is cut. A failed rewrite only
   * leaves the cuts.
   */
  private async tighten(channel: Channel, doc: ScriptDoc, facts: string): Promise<void> {
    const echoes = new Map<number, number>();
    for (const [a, b] of repeatedBeats(doc.beats)) if (!echoes.has(b)) echoes.set(b, a);
    const targets = [...echoes.keys()].sort((x, y) => x - y).slice(0, 24);
    if (targets.length > 0) {
      this.say("operator", `Rewriting ${targets.length} beat(s) that repeat earlier ones…`);
      const fixed = await this.ask(
        "creative",
        channelSystem(channel, this.lessons(channel.id)),
        `Some beats in this script say again what an earlier beat already said:\n${targets.map((b) => `B${b} repeats B${echoes.get(b)}`).join("\n")}\n\nRewrite each of those beats so it moves the video on: a fact from the list that no other beat uses, or one short sentence that bridges to the beat after it. Keep each beat's visual unless it no longer fits. Return exactly ${targets.length} beat(s), in this order: ${targets.map((b) => `B${b}`).join(", ")}.\n\nThe script:\n${doc.beats.map((b, i) => `B${i}: ${b.narration}`).join("\n")}\n\nBeats to rewrite:\n${targets.map((i) => `B${i}: ${JSON.stringify(doc.beats[i])}`).join("\n")}\n\nFacts:\n${facts}`,
        rewriteSchema,
      ).catch((err: unknown) => {
        this.log(`repeat pass failed: ${String(err)}`);
        return null;
      });
      if (fixed && fixed.beats.length === targets.length) {
        targets.forEach((bi, k) => {
          const b = fixed.beats[k];
          if (b) doc.beats[bi] = b;
        });
      }
    }
    const copies = new Set(verbatimRepeats(doc.beats));
    if (copies.size > 0 && doc.beats.length - copies.size >= 3) {
      doc.beats = doc.beats.filter((_b, i) => !copies.has(i));
    }
    doc.updatedAt = new Date(this.now()).toISOString();
    this.saveScript(doc);
  }

  /**
   * The hook pass: the opening decides whether anyone stays. Five candidates against the hook
   * rules, the strongest one chosen, and the first beat rewritten to start with it, plus a few
   * words for the screen. A failed pass leaves the draft as it was.
   */
  private async sharpenHook(channel: Channel, doc: ScriptDoc, facts: string): Promise<void> {
    const first = doc.beats[0];
    if (!first) return;
    const max = doc.format === "short" ? 15 : 22;
    const firstWords = first.narration.split(/\s+/).filter(Boolean).length;
    this.say("operator", "Sharpening the opening line…");
    try {
      const res = await this.ask(
        "creative",
        channelSystem(channel, this.lessons(channel.id)),
        `${hookRules(max)}\n\nVideo: "${doc.titles[0] ?? doc.idea.title}", ${doc.format === "short" ? "a vertical short" : "an 8-12 minute video"}.\nIts opening beat now (${firstWords} words):\n"${first.narration}"\nThe beats after it:\n${doc.beats
          .slice(1, 4)
          .map((b) => `- ${b.narration.slice(0, 160)}`)
          .join(
            "\n",
          )}\nHook ideas so far: ${doc.hooks.join(" | ") || "(none)"}\n\nUse only these facts:\n${facts}\n\nWrite 5 hooks (each a spoken line and its screen words), then give the index of the one a scroller can't skip as "best". "opening" is only the first beat, about ${firstWords} words, rewritten to start with that hook line and flow on without repeating it or anything the later beats say${doc.format === "long" ? "; end it with one sentence promising the payoff the video builds to: name what the viewer will find out, never just 'this video will reveal the mystery'" : ""}. Never put the whole script into it.\n\nThen package the video around that hook. "titles": 3 titles of 35 to 65 characters that make a viewer curious without lying, never just the topic (shapes from other topics: "The Lake That Turns Animals to Stone", "Why Lightning Keeps Striking One Spot in Venezuela"). "thumbnails": 2 or 3 thumbnail texts of 2 to 5 words that tease the hook (not the title again), each with a one-line picture idea.`,
        hookSchema,
      );
      const best = res.hooks[res.best] ?? res.hooks[0];
      if (!best) return;
      const line = best.line.trim();
      if (line.split(/\s+/).length > max + 6 || weakOpening(line, doc.format)) return;
      const opening = res.opening.trim();
      // An opening that swallowed the script (it happened: 120 words in one beat) is dropped,
      // and the hook line simply leads the beat that was there.
      const room = Math.max(
        firstWords + line.split(/\s+/).length + 10,
        doc.format === "short" ? 30 : 45,
      );
      if (opening.split(/\s+/).length > room) {
        first.narration = `${line} ${first.narration}`;
      } else {
        first.narration = opening.toLowerCase().startsWith(line.slice(0, 24).toLowerCase())
          ? opening
          : `${line} ${opening}`;
      }
      doc.hook = { line, text: best.screen.trim().toUpperCase() };
      doc.hooks = [line, ...res.hooks.map((h) => h.line.trim()).filter((h) => h !== line)].slice(
        0,
        5,
      );
      // Titles a viewer would click (25 to 75 characters), ahead of the draft's; the draft's
      // fill in only when fewer than two came back.
      const titles = (res.titles ?? [])
        .map((t) => t.trim())
        .filter((t) => t.length >= 25 && t.length <= 75);
      if (titles.length > 0) {
        doc.titles = [...new Set([...titles, ...doc.titles])].slice(0, Math.max(2, titles.length));
      }
      const thumbs = (res.thumbnails ?? []).filter((t) => {
        const n = t.text.trim().split(/\s+/).filter(Boolean).length;
        return n >= 2 && n <= 5;
      });
      if (thumbs.length > 0) doc.thumbnails = thumbs;
    } catch (err) {
      this.log(`hook pass for ${doc.id} failed: ${String(err)}`);
    }
  }

  /** Lens's checks, then up to `rounds` rewrites of the beats that failed (checked again each time). */
  async check(channel: Channel, doc: ScriptDoc, rounds: number): Promise<ScriptChecks> {
    this.say("reviewer", "Checking every claim against the brief…");
    const facts = doc.brief.facts.map((f, i) => `F${i}: ${f.fact}`).join("\n");
    const numbered = doc.beats.map((b, i) => `B${i}: ${b.narration}`).join("\n");
    const review = await this.ask(
      "reasoning",
      "You are a strict fact-checker. A claim is supported only if the facts state it or it follows directly from them. Common knowledge that is trivially true (e.g. 'the Sun is a star') counts as supported.",
      `Facts:\n${facts}\n\nScript beats:\n${numbered}\n\nList every claim in the beats that the facts do not support, with the beat number.`,
      reviewSchema,
    ).catch((err: unknown) => {
      this.log(`fact-check failed: ${String(err)}`);
      return { unsupported: [] };
    });
    const text = doc.beats.map((b) => b.narration).join(" ");
    const others = this.scripts(channel.id).filter((s) => s.id !== doc.id && s.beats.length > 0);
    const same = others.reduce(
      (m, s) => Math.max(m, sameness(text, s.beats.map((b) => b.narration).join(" "))),
      0,
    );
    const checks: ScriptChecks = {
      words: wordCount(doc.beats),
      unsupported: review.unsupported.filter((u) => u.beat < doc.beats.length),
      banned: bannedIn(`${text} ${doc.titles.join(" ")} ${doc.description}`, channel),
      sameness: Math.round(same * 100) / 100,
      problems: [],
    };
    const range = channel.formats[doc.format];
    if (checks.words < range.minWords * 0.8)
      checks.problems.push(`Only ${checks.words} words (aim ${range.minWords}-${range.maxWords}).`);
    if (checks.words > range.maxWords * 1.2)
      checks.problems.push(
        `${checks.words} words is long (aim ${range.minWords}-${range.maxWords}).`,
      );
    if (checks.sameness > 0.3)
      checks.problems.push(
        `${Math.round(checks.sameness * 100)}% of its phrasing repeats an earlier script.`,
      );
    for (let i = 2; i < doc.beats.length; i++) {
      const k = doc.beats[i]?.visual.kind;
      if (k && k === doc.beats[i - 1]?.visual.kind && k === doc.beats[i - 2]?.visual.kind) {
        checks.problems.push(`Beats ${i - 2}-${i} all use "${k}"; vary the visuals.`);
        break;
      }
    }
    // A stat card is on screen: its number has to be one the facts or its own line give (D-061).
    // The raw facts, without their "F12:" labels (those numbers would pass a "12" stat).
    for (const m of statMismatches(doc.beats, doc.brief.facts.map((f) => f.fact).join("\n"))) {
      if (checks.unsupported.some((u) => u.beat === m.beat)) continue;
      checks.unsupported.push({
        beat: m.beat,
        claim: `the stat card shows ${m.value}${doc.beats[m.beat]?.visual.suffix ?? ""}`,
        why: "no fact or line gives that number",
      });
    }
    const weak = doc.beats[0] ? weakOpening(doc.beats[0].narration, doc.format) : null;
    if (weak) checks.problems.push(weak);
    const repeats = repeatedBeats(doc.beats);
    if (repeats.length > 0) {
      checks.problems.push(
        `${repeats
          .slice(0, 3)
          .map(([a, b]) => `Beats ${a} and ${b}`)
          .join("; ")} say nearly the same thing; cut the repeats.`,
      );
    }
    doc.checks = checks;
    // The flagged beats and those holding a banned phrase (one in a title alone needs no rewrite).
    const targets = [
      ...new Set([
        ...checks.unsupported.map((u) => u.beat),
        ...doc.beats.flatMap((b, i) => (bannedIn(b.narration, channel).length > 0 ? [i] : [])),
      ]),
    ]
      .sort((a, b) => a - b)
      .slice(0, 24);
    if (rounds > 0 && targets.length > 0) {
      this.say("operator", "Fixing the lines Lens flagged…");
      // A rewrite of the opening beat once dropped its hook (the fact-checker had flagged the hook's
      // loose "day"), so the hook comes back with it: kept word for word, or corrected.
      const max = doc.format === "short" ? 15 : 22;
      const opening = targets[0] === 0 && doc.hook ? doc.hook : null;
      const system = channelSystem(channel, this.lessons(channel.id));
      const prompt = `Rewrite these beats so that every claim is supported by the facts (cut or soften what isn't), and remove these banned phrases: ${checks.banned.join(", ") || "(none)"}. Keep each beat's visual unless it no longer fits; a stat card must show a number the facts give. Return exactly ${targets.length} beat(s), in this order: ${targets.map((i) => `B${i}`).join(", ")}.${opening ? `\n\nB0 opens the video with the hook "${opening.line}". Return it as "hook" (with 2 to 5 words for the screen) and keep B0 starting with it, word for word, unless a flagged claim is in it. If one is, write a new hook of at most ${max} words that the facts support exactly, return that as "hook" and start B0 with it.` : ""}\n\nFlagged:\n${checks.unsupported.map((u) => `B${u.beat}: "${u.claim}" (${u.why})`).join("\n") || "(only banned phrases)"}\n\nBeats to rewrite:\n${targets.map((i) => `B${i}: ${JSON.stringify(doc.beats[i])}`).join("\n")}\n\nFacts:\n${facts}`;
      let beats: Beat[] | null = null;
      let hook: { line: string; screen: string } | null = null;
      if (opening) {
        const r = await this.ask("creative", system, prompt, reviseOpeningSchema).catch(() => null);
        if (r) ({ beats, hook } = r);
      } else {
        const r = await this.ask("creative", system, prompt, rewriteSchema).catch(() => null);
        if (r) beats = r.beats;
      }
      if (beats) {
        if (beats.length === targets.length) {
          const got = beats;
          targets.forEach((bi, k) => {
            const b = got[k];
            if (b) doc.beats[bi] = b;
          });
          if (hook) this.keepHook(doc, hook, max);
        }
        return this.check(channel, doc, rounds - 1);
      }
    }
    return checks;
  }

  /** After Lens rewrote the opening beat: the hook it kept or corrected leads that beat again. */
  private keepHook(doc: ScriptDoc, given: { line: string; screen: string }, max: number): void {
    const first = doc.beats[0];
    if (!first || !doc.hook) return;
    const line = given.line.trim();
    // A kept hook keeps the hook pass's screen words; only a corrected one brings its own.
    const changed = line.toLowerCase() !== doc.hook.line.toLowerCase();
    if (changed && line.split(/\s+/).length <= max + 6 && !weakOpening(line, doc.format)) {
      doc.hook = { line, text: given.screen.trim().toUpperCase() || doc.hook.text };
    }
    const lead = doc.hook.line;
    if (!first.narration.toLowerCase().startsWith(lead.slice(0, 24).toLowerCase())) {
      first.narration = `${lead} ${first.narration}`;
    }
    doc.hooks = [lead, ...doc.hooks.filter((h) => h !== lead)].slice(0, 5);
  }

  private submit(channel: Channel, doc: ScriptDoc): void {
    const md = renderScript(channel, doc);
    doc.artifactId = this.saveText(
      "studio.script",
      `${doc.format === "long" ? "Long-form" : "Short"} script: ${doc.titles[0] ?? doc.idea.title}`,
      md,
      { scriptId: doc.id, channel: channel.id, format: doc.format },
    );
    this.saveScript(doc);
    const flags =
      doc.checks.unsupported.length + doc.checks.banned.length + doc.checks.problems.length;
    this.deps.director?.fileDeskItem({
      kind: "deliverable",
      title: `${channel.status === "draft" ? "[Draft channel] " : ""}Script ready: ${(doc.titles[0] ?? doc.idea.title).slice(0, 80)}`,
      summary: `${doc.format === "long" ? "Long-form" : "Short"}, ${doc.checks.words} words, ${doc.brief.sources.length} sources${flags > 0 ? `, ${flags} check note(s)` : ", checks clear"}. Accept to approve it for the Edit Bay; send it back with a note to rewrite.`,
      requestedBy: doc.format === "long" ? "wick" : "gift",
      objectiveId: null,
      taskId: null,
      artifactId: doc.artifactId,
      action: null,
    });
    this.say("operator", "Script's at the Owner's Desk.");
  }

  private async onDecision(a: Approval): Promise<void> {
    if (!a.artifactId) return;
    const art = this.deps.store.artifact(a.artifactId);
    if (!art) return;
    if (art.meta.kind === "studio.niches") {
      if (a.status === "approved")
        await this.adoptNiche(a.artifactId, a.note).catch((err: unknown) =>
          this.log(`niche: ${String(err)}`),
        );
      else if (a.status === "rejected")
        void this.nicheStudy().catch((err: unknown) => this.log(`niche: ${String(err)}`));
      return;
    }
    if (art.meta.kind !== "studio.script") return;
    const doc = this.scripts().find((s) => s.artifactId === a.artifactId);
    if (!doc) return;
    if (a.status === "approved") {
      doc.status = "approved";
      this.saveScript(doc);
      this.say("operator", "Approved. Off to the Edit Bay.");
    } else if (a.status === "rejected") {
      doc.status = "rejected";
      this.saveScript(doc);
      if (a.note?.trim()) this.start(doc.channel, { format: doc.format, note: a.note, from: doc });
    }
  }

  private saveText(
    kind: string,
    title: string,
    content: string,
    info: Record<string, unknown>,
  ): string {
    const id = this.deps.store.nextId("D");
    this.deps.store.saveArtifact(
      {
        id,
        kind,
        title,
        mime: "text/markdown",
        taskId: null,
        objectiveId: null,
        createdBy: kind === "studio.niches" ? "scout" : "wick",
        createdAt: this.now(),
        size: content.length,
        room: null,
        info,
      },
      content,
    );
    fs.writeFileSync(path.join(this.deps.dir, `${id}.md`), content);
    return id;
  }
}

function channelSystem(channel: Channel, lessons: string[] = []): string {
  return `You write for "${channel.name}", a faceless ${channel.niche} channel.
Audience: ${channel.audience}
Narrator: ${channel.persona}
Tone: ${channel.style.tone}
Rules:
${channel.style.rules.map((r) => `- ${r}`).join("\n")}
Avoid these topics: ${channel.avoid.join("; ")}.
Never use: ${[...channel.style.bannedPhrases].join(", ") || "clichés"}, "delve", "in today's video", "let's dive in", "buckle up", "mind-blowing", "smash that like".${lessons.length ? `\nLessons from our own numbers (approved by the owner):\n${lessons.map((l) => `- ${l}`).join("\n")}` : ""}`;
}

/** How much each of an idea's scores counts. The weekly retro moves these (D-061). */
export interface IdeaWeights {
  demand: number;
  originality: number;
  fit: number;
  risk: number;
}
export const DEFAULT_IDEA_WEIGHTS: IdeaWeights = {
  demand: 0.35,
  originality: 0.25,
  fit: 0.25,
  risk: 0.15,
};

/** An idea's score: a weighted sum of its 1-10 ratings, minus its policy risk. */
export function scoreIdea(
  s: { demand: number; originality: number; fit: number; risk: number },
  w: IdeaWeights = DEFAULT_IDEA_WEIGHTS,
): number {
  return (
    Math.round(
      (w.demand * s.demand + w.originality * s.originality + w.fit * s.fit - w.risk * s.risk) * 10,
    ) / 10
  );
}

function formatSignals(signals: Signal[], limit: number): string {
  if (signals.length === 0) return "(no signals today)";
  return signals
    .slice(0, limit)
    .map((s) => `- [${s.source}] ${s.title}${s.detail ? ` (${s.detail})` : ""}`)
    .join("\n");
}

/** The script as the owner reads it at the Desk. */
export function renderScript(channel: Channel, doc: ScriptDoc): string {
  const c = doc.checks;
  return [
    `# ${doc.titles[0] ?? doc.idea.title}`,
    "",
    `*${doc.format === "long" ? "Long-form (8-12 min)" : "Short (30-60 s)"} for ${channel.name}${channel.status === "draft" ? " (draft channel: test videos only)" : ""} · version ${doc.version} · ${c.words} words*`,
    "",
    `**Idea:** ${doc.idea.title}. ${doc.idea.angle}`,
    "",
    `**Other titles:** ${doc.titles.slice(1).join(" · ")}`,
    "",
    ...(doc.hook
      ? [`**Opening hook:** "${doc.hook.line}" (on screen: **${doc.hook.text}**)`, ""]
      : []),
    doc.hook ? "**Other hooks it beat:**" : "**Alternative hooks:**",
    ...doc.hooks.filter((h) => h !== doc.hook?.line).map((h) => `- ${h}`),
    "",
    "## Script and shots",
    "",
    ...doc.beats.flatMap((b, i) => [
      `**${i + 1}.** ${b.narration}`,
      `> 🎬 ${b.visual.kind}${b.visual.query ? `: "${b.visual.query}"` : ""}${b.visual.prompt ? `: ${b.visual.prompt}` : ""}${b.visual.text ? `: ${b.visual.text}` : ""}${b.visual.value !== undefined ? ` (${b.visual.prefix ?? ""}${b.visual.value}${b.visual.suffix ?? ""} ${b.visual.label ?? ""})` : ""}`,
      "",
    ]),
    "## Description",
    "",
    doc.description,
    "",
    `**Tags:** ${doc.tags.join(", ")}`,
    "",
    `**Thumbnail ideas:** ${doc.thumbnails.map((t) => `“${t.text}” (${t.idea})`).join("; ")}`,
    "",
    "## Lens's checks",
    "",
    c.unsupported.length === 0
      ? "- Every claim matches the brief."
      : `- Unsupported after one rewrite: ${c.unsupported.map((u) => `beat ${u.beat + 1}: "${u.claim}"`).join("; ")}`,
    c.banned.length === 0 ? "- No banned phrases." : `- Banned phrases: ${c.banned.join(", ")}`,
    `- Phrasing shared with earlier scripts: ${Math.round(c.sameness * 100)}%`,
    ...c.problems.map((p) => `- ${p}`),
    "",
    "## Sources",
    "",
    ...doc.brief.sources.map((s, i) => `${i + 1}. [${s.title}](${s.url})`),
    "",
  ].join("\n");
}
