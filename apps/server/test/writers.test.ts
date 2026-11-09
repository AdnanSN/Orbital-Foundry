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
  type ScriptDoc,
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
function fakeRouter(opts: { unsupportedFirst?: boolean; flagHook?: boolean } = {}) {
  const calls: GenerateOptions[] = [];
  let reviews = 0;
  let factCalls = 0;
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
    } else if (/List \d+ to \d+ facts/.test(p)) {
      factCalls++;
      data = {
        facts: [0, 1, 2].map((i) => ({ fact: `Fact ${i} about rings (${factCalls})`, source: 0 })),
      };
    } else if (p.includes("strict fact-checker")) {
      reviews++;
      data = {
        unsupported:
          opts.unsupportedFirst && reviews === 1
            ? [{ beat: 3, claim: "younger than the dinosaurs", why: "not in the facts" }]
            : opts.flagHook && reviews === 1
              ? [
                  {
                    beat: 0,
                    claim: "thinner than a house is tall",
                    why: "the facts say ten metres",
                  },
                ]
              : [],
      };
    } else if (p.includes("Rewrite these beats")) {
      // One beat back per beat asked for, in the order the prompt lists them.
      const order = [...(p.match(/in this order: ([B\d, ]+)/)?.[1] ?? "B3").matchAll(/B(\d+)/g)];
      data = {
        beats: order.map((m) =>
          m[1] === "3"
            ? beat("Their age is still debated.", "ai-still", { prompt: "icy ring particles" })
            : opts.flagHook
              ? beat("In places they are only about ten metres thick, mostly water ice.")
              : beat(
                  "Saturn's rings are thinner than a house is tall: mostly water ice, about ten metres thick in places.",
                ),
        ),
        // Asked for when the opening beat is rewritten: the hook kept, or corrected.
        ...(p.includes('Return it as "hook"')
          ? {
              hook: opts.flagHook
                ? { line: "Saturn's rings are only ten metres thick.", screen: "only ten metres" }
                : { line: "Saturn's rings are thinner than a house is tall.", screen: "THIN" },
            }
          : {}),
      };
    } else if (p.includes("Hook rules.")) {
      data = {
        hooks: [
          {
            line: "Saturn's rings are thinner than a house is tall.",
            screen: "Thinner than a house",
          },
          { line: "Rings wider than Earth, yet barely there.", screen: "BARELY THERE" },
          { line: "In this video we look at rings.", screen: "RINGS" },
        ],
        best: 0,
        opening:
          "Saturn's rings are thinner than a house is tall: mostly water ice, about ten metres thick in places, which is a mind-blowing thing.",
        titles: [
          "Saturn's rings are thinner than a house is tall",
          "Thin rings",
          "The giant rings you could almost step over",
        ],
        thumbnails: [
          { text: "THINNER THAN A HOUSE", idea: "Saturn edge-on" },
          { text: "BARELY THERE", idea: "The rings vanishing edge-on" },
          { text: "RINGS", idea: "One word is too few" },
        ],
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
    // The banned phrase sat in the opening beat, so that beat was rewritten along with beat 3.
    expect(doc?.checks.banned).toEqual([]);
    expect(doc?.beats[0]?.narration).not.toContain("mind-blowing");
    expect(doc?.brief.sources[0]?.url).toContain("wikipedia.org");
    // The hook pass: the strongest opening leads the first beat, with its words for the screen.
    expect(doc?.hook).toEqual({
      line: "Saturn's rings are thinner than a house is tall.",
      text: "THINNER THAN A HOUSE",
    });
    expect(doc?.beats[0]?.narration).toMatch(/^Saturn's rings are thinner than a house is tall/);
    expect(doc?.hooks[0]).toBe(doc?.hook?.line);
    // The hook pass packages the video too: titles of 25-75 characters, 2-5 thumbnail words.
    expect(doc?.titles).toEqual([
      "Saturn's rings are thinner than a house is tall",
      "The giant rings you could almost step over",
    ]);
    expect(doc?.thumbnails.map((t) => t.text)).toEqual(["THINNER THAN A HOUSE", "BARELY THERE"]);
    expect(desk[0]?.title).toMatch(/^\[Draft channel\] Script ready: Saturn's rings/);
    const art = store.artifact(doc?.artifactId ?? "");
    expect(art?.content).toContain("## Lens's checks");
    expect(art?.content).toContain("**Opening hook:**");
    expect(writers.ideas("space-explainers", "scripted")).toHaveLength(1);
  });

  it("keeps a hook through Lens's fixes, or takes the corrected one", async () => {
    const fake = fakeRouter({ flagHook: true });
    const { writers } = setup(fake.router);
    await writers.proposeIdeas("space-explainers", 2);
    const doc = await writers.settled(writers.start("space-explainers", { format: "short" }).id);
    const fix = fake.calls.find((c) => c.prompt?.includes("Rewrite these beats"));
    expect(fix?.prompt).toContain(
      `B0 opens the video with the hook "Saturn's rings are thinner than a house is tall."`,
    );
    // The fact-checker flagged the hook, so the fix wrote a new one; it leads the beat again.
    expect(doc?.hook).toEqual({
      line: "Saturn's rings are only ten metres thick.",
      text: "ONLY TEN METRES",
    });
    expect(doc?.beats[0]?.narration).toBe(
      "Saturn's rings are only ten metres thick. In places they are only about ten metres thick, mostly water ice.",
    );
    expect(doc?.hooks[0]).toBe("Saturn's rings are only ten metres thick.");
    expect(doc?.checks.unsupported).toEqual([]);
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

  /** The fake router, answering some prompts differently. */
  function overriding(over: (prompt: string) => unknown) {
    const base = fakeRouter();
    const inner = base.router as unknown as { generate: (o: GenerateOptions) => Promise<unknown> };
    const generate = async (o: GenerateOptions) => {
      const data = over(`${o.system ?? ""}\n${o.prompt ?? ""}`);
      if (data === undefined) return inner.generate(o);
      base.calls.push(o);
      return { data, text: "", provider: "fake", model: "m", lane: o.lane } as never;
    };
    return { calls: base.calls, router: { generate } as unknown as ModelRouter };
  }

  it("gives each long-form section its own facts, the beats before it and a scaled budget", async () => {
    const fake = overriding((p) =>
      p.includes("Outline an 8-12 minute")
        ? {
            ...SHORT,
            sections: [["F0"], [1], [], ["F2", 9]].map((facts, n) => ({
              heading: `Part ${n + 1}`,
              points: ["point"],
              words: 120,
              facts,
            })),
          }
        : undefined,
    );
    const { writers } = setup(fake.router);
    await writers.proposeIdeas("space-explainers", 2);
    await writers.settled(writers.start("space-explainers", { format: "long" }).id);
    const sections = fake.calls
      .map((c) => c.prompt ?? "")
      .filter((p) => p.includes("Write section"));
    expect(sections).toHaveLength(4);
    const [one, two, three, four] = sections as [string, string, string, string];
    // 4 x 120 planned words is short of the channel's 1,100-1,700, so each section gets 350.
    expect(one).toContain("About 350 words of narration (never more than 402)");
    expect(one).toContain("F0: Fact 0");
    expect(one).not.toContain("F1: ");
    expect(one).toMatch(/The payoff the video builds to[\s\S]*F2: Fact 2/);
    expect(one).not.toContain("Already said earlier");
    expect(two).toContain("Already said earlier in the video");
    expect(two).toContain("- A section line about rings.");
    expect(two).toContain("F1: Fact 1");
    expect(two).not.toContain("F0: ");
    // A section the outline gave no facts gets the whole brief.
    expect(three).toMatch(/F0: [\s\S]*F1: [\s\S]*F2: /);
    expect(four).toContain("F2: Fact 2");
    expect(four).not.toContain("F1: ");
    expect(four).toContain("End on the idea itself");
  });

  it("rewrites beats that repeat earlier ones, and cuts word-for-word copies", async () => {
    const lines = [
      "Saturn's rings stretch wider than the distance between Earth and the Moon.",
      "Most of their mass is water ice, bright enough to reflect sunlight like snow.",
      "Gaps in the rings are carved by small moons that orbit inside them.",
      "Some ring particles are as small as dust, others as big as houses.",
    ];
    const echo = "Cassini dove between the rings and the planet in 2017, a daring final plunge.";
    let section = 0;
    const sectionBeats = () => ({
      beats: [beat(lines[section++ % 4] as string), beat(echo, "stock-video")],
    });
    const fresh = [
      "Cassini's last images showed ripples raised by the moon Daphnis.",
      "The rings may be raining down on Saturn, a little more every year.",
      "Seen edge-on from Earth, the rings almost vanish.",
    ];
    const rewriting = overriding((p) =>
      p.includes("Write section")
        ? sectionBeats()
        : p.includes("say again what an earlier beat")
          ? { beats: fresh.map((f) => beat(f, "stock-video")) }
          : undefined,
    );
    const first = setup(rewriting.router);
    await first.writers.proposeIdeas("space-explainers", 2);
    const doc = await first.writers.settled(
      first.writers.start("space-explainers", { format: "long" }).id,
    );
    const ask = rewriting.calls.find((c) => c.prompt?.includes("say again what an earlier beat"));
    expect(ask?.prompt).toContain("B3 repeats B1");
    expect(ask?.prompt).toContain("in this order: B3, B5, B7");
    expect(doc?.beats.map((b) => b.narration).slice(3)).toEqual([
      fresh[0],
      lines[2],
      fresh[1],
      lines[3],
      fresh[2],
    ]);
    expect(repeatedBeats(doc?.beats ?? [])).toEqual([]);

    // When the rewrite fails, the word-for-word copies go and the rest stays.
    section = 0;
    const failing = overriding((p) =>
      p.includes("Write section")
        ? sectionBeats()
        : p.includes("say again what an earlier beat")
          ? { beats: [] }
          : undefined,
    );
    const second = setup(failing.router);
    await second.writers.proposeIdeas("space-explainers", 2);
    const cut = await second.writers.settled(
      second.writers.start("space-explainers", { format: "long" }).id,
    );
    expect(cut?.beats.map((b) => b.narration).slice(1)).toEqual([echo, ...lines.slice(1)]);
  });

  it("rewrites with corrected facts, or with fresh research and a corrected angle", async () => {
    const fake = fakeRouter();
    const { writers } = setup(fake.router);
    await writers.proposeIdeas("space-explainers", 2);
    const first = (await writers.settled(
      writers.start("space-explainers", { format: "long" }).id,
    )) as ScriptDoc;
    // Corrected facts replace the old brief's, and its sources stay.
    const fixedFacts = [{ fact: "One rotation of Venus takes about 243 Earth days.", source: 0 }];
    const fixed = writers.start("space-explainers", {
      format: "long",
      from: first,
      facts: fixedFacts,
    });
    expect(fixed.brief).toEqual({ sources: first.brief.sources, facts: fixedFacts });
    await writers.settled(fixed.id);
    // Fresh research: one facts call per source for a long-form, merged into one brief.
    const before = fake.calls.length;
    const fresh = await writers.settled(
      writers.start("space-explainers", {
        format: "long",
        from: first,
        note: "Cut the repeats.",
        wikipedia: ["Rings of Saturn", "Cassini–Huygens", "Saturn"],
        angle: "How Cassini's last dives measured the rings' mass and age.",
      }).id,
    );
    expect(fresh?.version).toBe(2);
    expect(fresh?.idea.angle).toBe("How Cassini's last dives measured the rings' mass and age.");
    expect(fresh?.brief.sources.map((s) => s.title)).toEqual([
      "Rings of Saturn",
      "Cassini–Huygens",
      "Saturn",
    ]);
    const research = fake.calls
      .slice(before)
      .filter((c) => /List 10 to 20 facts/.test(c.prompt ?? ""));
    expect(research).toHaveLength(3);
    expect(research[0]?.prompt).toContain("Angle: How Cassini's last dives");
    expect(fresh?.brief.facts).toHaveLength(9);
    expect(new Set(fresh?.brief.facts.map((f) => f.source))).toEqual(new Set([0, 1, 2]));
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

  it("finds a beat that says an earlier one again in other words", () => {
    const beats = [
      line(
        "A single day on Venus lasts longer than its whole year. Venus spins so slowly, and backwards, that one rotation takes about 243 Earth days, while it orbits the Sun in 224.7 days.",
      ),
      line("Because Venus spins backwards, the Sun rises in the west and sets in the east."),
      line(
        "On Venus, the planet rotates so slowly and in reverse that a full rotation lasts roughly 243 Earth days, longer than the 224.7 days its orbit takes.",
      ),
      line("No spacecraft has survived on its surface for more than about two hours."),
    ];
    expect(repeatedBeats(beats)).toEqual([[0, 2]]);
  });
});

describe("hooks", () => {
  it("flags openings that lose a scroller", async () => {
    const { weakOpening, hookRules } = await import("../src/studio/writers");
    expect(
      weakOpening(
        "Fast Radio Bursts, or FRBs, are brief, lasting only a few milliseconds. This short duration is what makes them fascinating.",
        "long",
      ),
    ).toMatch(/definition/);
    expect(weakOpening("In this video we look at Venus.", "short")).toMatch(/opens with/);
    expect(
      weakOpening(
        "Fast radio bursts outshine the Sun for a millisecond. This video will reveal the mystery behind them.",
        "long",
      ),
    ).toMatch(/promise is vague/);
    expect(weakOpening("Have you ever wondered why Venus spins backwards?", "short")).toMatch(
      /opens with/,
    );
    expect(
      weakOpening("Venus spins so slowly that a day there lasts longer than its year.", "short"),
    ).toBeNull();
    expect(weakOpening(`${"word ".repeat(24)}end.`, "short")).toMatch(/runs 25 words/);
    expect(hookRules(15)).toContain("At most 15 words");
  });
});
