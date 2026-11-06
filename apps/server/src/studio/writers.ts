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
      }),
    )
    .min(4)
    .max(9),
});
const sectionSchema = z.object({ beats: z.array(beatSchema).min(2).max(14) });
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
  ): Promise<Brief> {
    this.say("researcher", `Researching: ${idea.title.slice(0, 40)}…`);
    const sources: { title: string; url: string; text: string }[] = [];
    for (const title of (idea.wikipedia ?? [idea.title]).slice(0, 3)) {
      try {
        let page = await this.deps.web.article(title, 4500);
        if (!page.text) {
          const hit = (await this.deps.web.search(title, 1))[0];
          if (hit) page = await this.deps.web.article(hit.title, 4500);
        }
        if (page.text && !sources.some((s) => s.url === page.url)) sources.push(page);
      } catch (err) {
        this.log(`research: ${title}: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (sources.length >= 2) break;
    }
    if (sources.length === 0) throw new Error(`No sources found for "${idea.title}".`);
    const result = await this.ask(
      "reasoning",
      "You are a careful research assistant. Extract only facts stated in the sources; never add outside knowledge.",
      `Video idea: ${idea.title}\nAngle: ${idea.angle}\n\nList 8 to 25 facts from these sources that a script on this idea could use: numbers, dates, how we know, open questions. Each fact cites its source by index.\n\n${sources.map((s, i) => `[${i}] ${s.title} (${s.url})\n${s.text}`).join("\n\n")}`,
      factsSchema,
    );
    return {
      sources: sources.map((s) => ({ title: s.title, url: s.url })),
      facts: result.facts.filter((f) => f.source < sources.length),
    };
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
    opts: { format: "short" | "long"; ideaId?: string; note?: string; from?: ScriptDoc },
  ): ScriptDoc {
    const channel = this.channel(channelId);
    const at = new Date(this.now()).toISOString();
    const idea =
      opts.from?.idea ??
      (opts.ideaId ? this.ideas(channelId).find((i) => i.id === opts.ideaId) : undefined) ??
      this.ideas(channelId, "backlog").find((i) => i.format === opts.format || i.format === "both");
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
      brief: opts.from?.brief ?? { sources: [], facts: [] },
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
    if (doc.brief.facts.length === 0) doc.brief = await this.research(channel, idea);
    const facts = doc.brief.facts
      .map((f, i) => `F${i}: ${f.fact} [${doc.brief.sources[f.source]?.title ?? "?"}]`)
      .join("\n");
    const words = channel.formats[doc.format];
    const revision = doc.note
      ? `\n\nThe owner sent the previous version back with this note; follow it:\n${doc.note}`
      : "";
    this.say("operator", `Writing a ${doc.format}: ${doc.idea.title.slice(0, 36)}…`);
    if (doc.format === "short") {
      const draft = await this.ask(
        "creative",
        channelSystem(channel, this.lessons(channel.id)),
        `Write a ${words.minWords}-${words.maxWords} word vertical short (30-60 seconds) on:\nIdea: ${doc.idea.title}\nAngle: ${doc.idea.angle}\n\nUse only these facts:\n${facts}\n\nThe first beat is the hook: the single most surprising true fact, in the first sentence. End on the idea itself, no call to action. Give 2-3 titles under 70 characters, 2-3 alternative hooks, a description (2-3 sentences, then "Narration: AI voice."), up to 12 tags and 1-3 thumbnail ideas (text of 5 words or fewer).\n\n${VISUAL_GUIDE}${revision}`,
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
      const outline = await this.ask(
        "creative",
        channelSystem(channel, this.lessons(channel.id)),
        `Outline an 8-12 minute YouTube video (${words.minWords}-${words.maxWords} words in all) on:\nIdea: ${doc.idea.title}\nAngle: ${doc.idea.angle}\n\nFacts available:\n${facts}\n\nGive 5 to 8 sections (the first is the hook and promise, the last pays it off), each with points and a word budget. Also 2-3 titles under 70 characters, 2-3 alternative opening hooks, a description (3-4 sentences, then "Narration: AI voice."), up to 15 tags and 2-3 thumbnail ideas (text of 5 words or fewer).${revision}`,
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
      for (const [i, section] of outline.sections.entries()) {
        const part = await this.ask(
          "creative",
          channelSystem(channel, this.lessons(channel.id)),
          `Write section ${i + 1} of ${outline.sections.length} ("${section.heading}") of a video titled "${outline.titles[0]}". About ${section.words} words of narration in beats.\nCover: ${section.points.join("; ")}\n${i === 0 ? "Open with the hook: the most surprising true fact first." : `It follows: "${doc.beats.at(-1)?.narration.slice(-200) ?? ""}"`}\n${i === outline.sections.length - 1 ? "End on the idea itself; no call to action." : ""}\nUse only these facts:\n${facts}\n\n${VISUAL_GUIDE}`,
          sectionSchema,
        );
        doc.beats.push(...part.beats);
        doc.updatedAt = new Date(this.now()).toISOString();
        this.saveScript(doc);
      }
    }
    await this.check(channel, doc, true);
    doc.status = "review";
    this.saveScript(doc);
    if (doc.ideaId) this.setIdeaStatus(doc.ideaId, "scripted");
    this.submit(channel, doc);
  }

  /** Lens's checks; with `revise`, one rewrite of the beats that failed. */
  async check(channel: Channel, doc: ScriptDoc, revise: boolean): Promise<ScriptChecks> {
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
    doc.checks = checks;
    if (revise && (checks.unsupported.length > 0 || checks.banned.length > 0)) {
      const targets = [...new Set(checks.unsupported.map((u) => u.beat))];
      this.say("operator", "Fixing the lines Lens flagged…");
      const fixed = await this.ask(
        "creative",
        channelSystem(channel, this.lessons(channel.id)),
        `Rewrite these beats so that every claim is supported by the facts (cut or soften what isn't), and remove these banned phrases: ${checks.banned.join(", ") || "(none)"}. Keep each beat's visual unless it no longer fits. Return the rewritten beats in the same order.\n\nFlagged:\n${checks.unsupported.map((u) => `B${u.beat}: "${u.claim}" (${u.why})`).join("\n") || "(only banned phrases)"}\n\nBeats to rewrite:\n${(targets.length > 0 ? targets : doc.beats.map((_b, i) => i)).map((i) => `B${i}: ${JSON.stringify(doc.beats[i])}`).join("\n")}\n\nFacts:\n${facts}`,
        sectionSchema,
      ).catch(() => null);
      if (fixed) {
        const indices = targets.length > 0 ? targets : doc.beats.map((_b, i) => i);
        if (fixed.beats.length === indices.length) {
          indices.forEach((bi, k) => {
            const b = fixed.beats[k];
            if (b) doc.beats[bi] = b;
          });
        }
        return this.check(channel, doc, false);
      }
    }
    return checks;
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
    "**Alternative hooks:**",
    ...doc.hooks.map((h) => `- ${h}`),
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
