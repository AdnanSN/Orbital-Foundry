import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Approval } from "@orbital/shared";
import { afterAll, describe, expect, it } from "vitest";
import YAML from "yaml";
import { openDb } from "../src/db";
import type { GenerateOptions, ModelRouter } from "../src/llm/router";
import { bannedIn, channelSchema, loadChannels } from "../src/studio/channel";
import type { SignalService } from "../src/studio/signals";
import {
  type Beat,
  numbersIn,
  renderScript,
  repeatedBeats,
  type ShotKind,
  sameness,
  statMismatches,
  WritersRoom,
  wordCount,
} from "../src/studio/writers";
import type { WorkDirector } from "../src/work/director";
import { WorkStore } from "../src/work/store";
import type { WebClient } from "../src/work/web";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "orbital-writers-"));
const dbs: { close: () => void }[] = [];
afterAll(() => {
  for (const db of dbs) db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const beat = (
  narration: string,
  kind: ShotKind = "stock-image",
  extra: Record<string, unknown> = {},
) => ({
  narration,
  visual: { kind, query: "saturn rings", ...extra },
});

const SHORT = {
  titles: ["Saturn's rings are thinner than a house", "The thinnest giant thing"],
  hooks: [
    "Saturn's rings are as thin as a house is tall.",
    "A ring wider than Earth, thinner than a street.",
  ],
  description: "Saturn's rings are vast but thin. Narration: AI voice.",
  tags: ["saturn", "space"],
  thumbnails: [{ text: "THINNER THAN A HOUSE", idea: "Saturn edge-on" }],
  beats: [
    beat(
      "Saturn's rings are mostly water ice, and in places only about ten metres thick, which is a mind-blowing thing.",
    ),
    beat("They span about 282,000 kilometres.", "stat", {
      value: 282000,
      suffix: " km",
      label: "across",
    }),
    beat("Cassini dove between the rings and the planet in 2017.", "stock-video", {
      query: "spacecraft saturn",
    }),
    beat("They may be younger than the dinosaurs, though that is debated.", "ai-still", {
      prompt: "icy ring particles",
    }),
  ],
};

/** Answers by prompt, like the real models would; records every call. */
function fakeRouter(opts: { unsupportedFirst?: boolean } = {}) {
  const calls: GenerateOptions[] = [];
  let reviews = 0;
  const generate = async (o: GenerateOptions) => {
    calls.push(o);
    const p = `${o.system ?? ""}\n${o.prompt ?? ""}`;
    let data: unknown;
    if (p.includes("Propose exactly 3 distinct niches")) {
      data = {
        niches: [1, 2, 3].map((n) => ({
          name: `Niche ${n}`,
          pitch: "Explainers",
          audience: "Curious adults",
          demand: 7,
          competition: 5,
          adRates: 6,
          policyRisk: 2,
          freeStackFit: 8,
          why: "Fits",
          exampleIdeas: ["a", "b", "c"],
          wikipediaSeeds: ["Saturn", "Moon"],
        })),
      };
    } else if (p.includes("You write channel bibles")) {
      data = {
        id: "deep-oceans",
        name: "X",
        niche: "Ocean science explainers",
        audience: "Curious adults",
        persona: "A calm narrator.",
        tone: "Clear",
        rules: ["Source every number", "One idea at a time", "Say what is unknown"],
        avoid: ["health advice", "politics", "kids content"],
        mood: "calm",
        prefer: ["pixabay", "nasa"],
      };
    } else if (p.includes("video ideas for this channel")) {
      data = {
        ideas: [
          {
            title: "Why Saturn's rings are so thin",
            angle: "Scale models",
            format: "short",
            hook: "h",
            demand: 8,
            originality: 7,
            fit: 9,
            risk: 1,
            why: "w",
            wikipedia: ["Rings of Saturn"],
          },
          {
            title: "How we weigh planets",
            angle: "Kepler's laws",
            format: "long",
            hook: "h",
            demand: 6,
            originality: 6,
            fit: 8,
            risk: 1,
            why: "w",
            wikipedia: ["Planetary mass"],
          },
        ],
      };
    } else if (p.includes("List 8 to 25 facts")) {
      data = { facts: [0, 1, 2].map((i) => ({ fact: `Fact ${i} about rings`, source: 0 })) };
    } else if (p.includes("strict fact-checker")) {
      reviews++;
      data = {
        unsupported:
          opts.unsupportedFirst && reviews === 1
            ? [{ beat: 3, claim: "younger than the dinosaurs", why: "not in the facts" }]
            : [],
      };
    } else if (p.includes("Rewrite these beats")) {
      data = {
        beats: [beat("Their age is still debated.", "ai-still", { prompt: "icy ring particles" })],
      };
    } else if (p.includes("vertical short")) {
      data = SHORT;
    } else if (p.includes("Outline an 8-12 minute")) {
      data = {
        ...SHORT,
        sections: [1, 2, 3, 4].map((n) => ({
          heading: `Part ${n}`,
          points: ["point"],
          words: 120,
        })),
      };
    } else if (p.includes("Write section")) {
      data = {
        beats: [
          beat("A section line about rings.", "title", { text: "Rings" }),
          beat("Another line.", "code"),
        ],
      };
    }
    return { data, text: "", provider: "fake", model: "m", lane: o.lane } as never;
  };
  return { calls, router: { generate } as unknown as ModelRouter };
}

function setup(router: ModelRouter) {
  const dir = fs.mkdtempSync(path.join(root, "w-"));
  const db = openDb(path.join(dir, "station.db"));
  dbs.push(db);
  const store = new WorkStore(db);
  const channelsDir = path.join(dir, "channels");
  fs.mkdirSync(channelsDir);
  // A draft copy of the space channel, so Desk items carry the draft label.
  fs.writeFileSync(
    path.join(channelsDir, "space-explainers.yaml"),
    fs
      .readFileSync(
        path.join(__dirname, "..", "..", "..", "config", "channels", "space-explainers.yaml"),
        "utf8",
      )
      .replace("status: paused", "status: draft"),
  );
  const desk: Approval[] = [];
  const hooks: ((a: Approval) => void | Promise<void>)[] = [];
  const director = {
    fileDeskItem: (f: Omit<Approval, "id" | "status" | "createdAt" | "decidedAt" | "note">) => {
      const a = {
        ...f,
        id: `A-${desk.length + 1}`,
        status: "pending",
        createdAt: 0,
        decidedAt: null,
        note: null,
      } as Approval;
      desk.push(a);
      return a;
    },
    onDecision: (h: (a: Approval) => void | Promise<void>) => hooks.push(h),
  } as unknown as WorkDirector;
  const web = {
    article: async (title: string) => ({
      title,
      url: `https://en.wikipedia.org/wiki/${title}`,
      text: "Saturn's rings are mostly water ice.",
    }),
    search: async () => [],
  } as unknown as WebClient;
  const signals = {
    gather: async () => [{ source: "wikipedia", title: "Saturn", volume: 1000 }],
  } as unknown as SignalService;
  const writers = new WritersRoom({
    router,
    lane: "live",
    web,
    signals,
    store,
    db,
    director,
    dir: path.join(dir, "scripts"),
    channelsDir,
  });
  const decide = async (
    a: Approval,
    status: "approved" | "rejected",
    note: string | null = null,
  ) => {
    for (const h of hooks) await h({ ...a, status, note });
  };
  return { writers, desk, decide, store, channelsDir };
}

describe("channel bible", () => {
  it("loads the space draft and flags banned phrases", () => {
    const space = loadChannels().find((c) => c.id === "space-explainers");
    expect(space?.status).toBe("paused");
    expect(loadChannels().find((c) => c.id === "rare-scientific-phenomena")?.status).toBe("active");
    expect(bannedIn("A mind-blowing fact. Let's dive in!", channelSchema.parse(space))).toEqual([
      "let's dive in",
      "mind-blowing",
    ]);
  });

  it("measures length and repeated phrasing", () => {
    expect(wordCount([beat("one two three"), beat("four five")])).toBe(5);
    expect(
      sameness("the rings of saturn are thin", "we know the rings of saturn are thin today"),
    ).toBe(1);
    expect(sameness("a b c d", "w x y z")).toBe(0);
  });
});

describe("writers' room", () => {
  it("scores and stores ideas from the signals", async () => {
    const { writers } = setup(fakeRouter().router);
    const ideas = await writers.proposeIdeas("space-explainers", 2);
    expect(ideas[0]?.title).toBe("Why Saturn's rings are so thin");
    expect(ideas[0]?.score).toBeGreaterThan(ideas[1]?.score ?? 0);
    expect(writers.ideas("space-explainers", "backlog")).toHaveLength(2);
  });

  it("writes a short, fixes what Lens flags, and files it at the Desk", async () => {
    const fake = fakeRouter({ unsupportedFirst: true });
    const { writers, desk, store } = setup(fake.router);
    await writers.proposeIdeas("space-explainers", 2);
    const started = writers.start("space-explainers", { format: "short" });
    const doc = await writers.settled(started.id);
    expect(doc?.status).toBe("review");
    expect(doc?.beats[3]?.narration).toBe("Their age is still debated.");
    expect(doc?.checks.unsupported).toEqual([]);
    expect(doc?.checks.banned).toContain("mind-blowing");
    expect(doc?.brief.sources[0]?.url).toContain("wikipedia.org");
    expect(desk[0]?.title).toMatch(/^\[Draft channel\] Script ready: Saturn's rings/);
    const art = store.artifact(doc?.artifactId ?? "");
    expect(art?.content).toContain("## Lens's checks");
    expect(writers.ideas("space-explainers", "scripted")).toHaveLength(1);
  });

  it("approves, or rewrites with the owner's note", async () => {
    const fake = fakeRouter();
    const { writers, desk, decide } = setup(fake.router);
    await writers.proposeIdeas("space-explainers", 2);
    const first = await writers.settled(writers.start("space-explainers", { format: "short" }).id);
    await decide(desk[0] as Approval, "rejected", "Make the hook about Cassini");
    expect(writers.script(first?.id ?? "")?.status).toBe("rejected");
    const second = writers.scripts("space-explainers").find((s) => s.version === 2);
    expect(second).toBeTruthy();
    await writers.settled(second?.id ?? "");
    expect(fake.calls.some((c) => c.prompt?.includes("Make the hook about Cassini"))).toBe(true);
    await decide(desk[1] as Approval, "approved");
    expect(writers.script(second?.id ?? "")?.status).toBe("approved");
  });

  it("writes long-form section by section", async () => {
    const fake = fakeRouter();
    const { writers } = setup(fake.router);
    await writers.proposeIdeas("space-explainers", 2);
    const doc = await writers.settled(writers.start("space-explainers", { format: "long" }).id);
    expect(doc?.beats).toHaveLength(8);
    expect(fake.calls.filter((c) => c.prompt?.includes("Write section"))).toHaveLength(4);
    expect(
      renderScript(loadChannels().find((c) => c.id === "space-explainers") as never, doc as never),
    ).toContain("Long-form (8-12 min)");
  });

  it("fails cleanly without an idea for the format", async () => {
    const { writers } = setup(fakeRouter().router);
    const doc = writers.start("space-explainers", { format: "long" });
    expect(doc.status).toBe("failed");
    expect(doc.error).toMatch(/Propose ideas first/);
  });

  it("files a niche study and writes the bible for the niche the owner picks", async () => {
    const { writers, desk, decide, channelsDir } = setup(fakeRouter().router);
    await writers.nicheStudy();
    expect(desk[0]?.title).toMatch(/Pick the channel's niche/);
    await decide(desk[0] as Approval, "approved", "2");
    const saved = YAML.parse(fs.readFileSync(path.join(channelsDir, "deep-oceans.yaml"), "utf8"));
    expect(saved.status).toBe("active");
    expect(saved.sources.wikipediaSeeds).toEqual(["Saturn", "Moon"]);
    expect(saved.persona).toMatch(/AI voice/);
  });
});

describe("Lens's number and repetition checks", () => {
  const stat = (narration: string, value: number, suffix = ""): Beat => ({
    narration,
    visual: { kind: "stat", value, suffix, label: "x" },
  });
  const line = (narration: string): Beat => ({ narration, visual: { kind: "code" } });

  it("reads numbers the way a viewer would", () => {
    expect(numbersIn("roughly 10^9 to 10^11 tesla")).toEqual([1e9, 1e11]);
    expect(numbersIn("10⁹ tesla and 1.5 × 10^6 Jy")).toEqual([1e9, 1.5e6]);
    expect(numbersIn("3,000 neutron stars, 1.5 million Jy ms, 116.75 days")).toEqual([
      3000, 1.5e6, 116.75,
    ]);
  });

  it("flags stat cards whose number no fact or line gives", () => {
    const facts =
      "Magnetars have magnetic fields of 10^9 to 10^11 tesla. FRB 200428 had a fluence over 1.5 million Jy ms.";
    const beats = [
      stat("Magnetar fields reach 10^9 to 10^11 tesla.", 10, " tesla"),
      stat("Its fluence passed 1.5 million Jy ms.", 1_500_000, " Jy ms"),
      stat("The strongest are a hundred billion tesla.", 1e11, " tesla"),
      stat("In 2020 a burst came from our own galaxy.", 2020),
      stat("Its field is unimaginably strong.", 1e13, " tesla"),
    ];
    expect(statMismatches(beats, facts)).toEqual([
      { beat: 0, value: 10 },
      { beat: 4, value: 1e13 },
    ]);
  });

  it("finds beats that repeat each other", () => {
    const repeat =
      "As of January 2021, 31 confirmed magnetars have been identified out of an estimated 3,000 known neutron stars.";
    const beats = [
      line(`Magnetars are rare. ${repeat}`),
      line("Fast radio bursts last a few milliseconds and come from far beyond our galaxy."),
      line(`${repeat} This makes them a fascinating area of study.`),
    ];
    expect(repeatedBeats(beats)).toEqual([[0, 2]]);
  });
});
