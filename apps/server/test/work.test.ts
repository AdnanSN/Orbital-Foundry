import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getStationMap, type StationEvent, type StationEventOf } from "@orbital/shared";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { openDb } from "../src/db";
import { type Fixture, FixtureTransport } from "../src/llm/fixtures";
import { SimServer } from "../src/sim/simServer";
import { SimStore } from "../src/sim/store";
import { WorkDirector } from "../src/work/director";
import { loadRoles } from "../src/work/roles";
import { WorkStore } from "../src/work/store";
import { defineTool, parseToolArgs, ToolRegistry, toolSpec } from "../src/work/tools";
import { WebClient } from "../src/work/web";
import { makeRouter, provider, tiersWith } from "./helpers";

const map = getStationMap();
const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

const REPORT = `# Winter candle niches, ranked

1. Cabin-cozy pine and cedar candles: strong seasonal search interest, gift-friendly.
2. Hygge reading-nook candles: evergreen in winter, pairs with book lovers.
3. Snowy-morning vanilla candles: broad appeal, crowded but steady.
(estimates; no live marketplace data)`;

function fixtures(): Fixture[] {
  return [
    {
      when: { system: "Plan the owner's objective" },
      reply: {
        content: JSON.stringify({
          summary: "One research task.",
          tasks: [
            {
              title: "Find and rank 10 winter candle niches",
              role: "researcher",
              brief:
                "Find 10 winter candle niches for the Etsy candle store and rank them with a reason each.",
            },
          ],
        }),
      },
      once: true,
    },
    // Scout's first attempt: check memory, look something up, take a note, submit.
    {
      when: { system: "You are Scout", user: "Task W-0001" },
      reply: {
        content: "Checking memory for earlier candle research.",
        toolCalls: [{ name: "memory_search", arguments: { query: "winter candle niches" } }],
      },
      once: true,
    },
    {
      when: { system: "You are Scout", tool: "Memory is empty" },
      reply: {
        content: "Looking up candle background.",
        toolCalls: [{ name: "web_research", arguments: { query: "scented candle" } }],
      },
      once: true,
    },
    {
      when: { system: "You are Scout", tool: "untrusted" },
      reply: {
        content: "Noting the top themes.",
        toolCalls: [{ name: "notes_write", arguments: { text: "Pine, hygge and vanilla lead." } }],
      },
      once: true,
    },
    {
      when: { system: "You are Scout", tool: "Saved." },
      reply: {
        content: "Submitting the ranking.",
        toolCalls: [
          {
            name: "submit_for_review",
            arguments: { title: "Winter candle niches", content: REPORT },
          },
        ],
      },
      once: true,
    },
    // The first review sends it back; the rework goes straight to a resubmission.
    {
      when: { system: "Review the deliverable", user: "Rework round: 0" },
      reply: {
        content: JSON.stringify({
          verdict: "rework",
          score: 6,
          feedback: "Add a reason for every rank.",
        }),
      },
      once: true,
    },
    {
      when: { system: "You are Scout", user: "Reviewer feedback" },
      reply: {
        content: "Adding reasons.",
        toolCalls: [
          {
            name: "submit_for_review",
            arguments: {
              title: "Winter candle niches (v2)",
              content: `${REPORT}\n\nEvery rank now has a reason.`,
            },
          },
        ],
      },
      once: true,
    },
    {
      when: { system: "Review the deliverable", user: "Rework round: 1" },
      reply: { content: JSON.stringify({ verdict: "pass", score: 8, feedback: "Good." }) },
      once: true,
    },
    {
      when: { system: "Write the final deliverable" },
      reply: {
        content: `Summary: three strong winter niches.\n\n${REPORT}\n\n## Next steps\n- Concepts.`,
      },
      once: true,
    },
  ];
}

const wikipedia = async (url: string): Promise<Response> => {
  if (url.includes("list=search")) {
    return new Response(JSON.stringify({ query: { search: [{ title: "Candle" }] } }));
  }
  return new Response(
    JSON.stringify({
      extract: "A candle is an ignitable wick embedded in wax.",
      content_urls: { desktop: { page: "https://en.wikipedia.org/wiki/Candle" } },
    }),
  );
};

function setup(fx: Fixture[] = fixtures(), cafeAfterMs?: number) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orbital-work-"));
  const db = openDb(path.join(dir, "station.db"));
  cleanups.push(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const world = new SimServer({ map, store: new SimStore(db), seed: 3, mockProviders: false });
  const transport = new FixtureTransport(fx);
  const { router, gates } = makeRouter({
    providers: { fake: provider("fake", ["sandbox"]) },
    tiers: tiersWith({
      reasoning: { sandbox: ["fake:big"] },
      creative: { sandbox: ["fake:big"] },
      fast: { sandbox: ["fake:big"] },
      embed: { sandbox: ["fake:embed"] },
    }),
    transport,
  });
  const store = new WorkStore(db);
  const events: StationEvent[] = [];
  world.subscribe((batch) => events.push(...batch));
  const deps: ConstructorParameters<typeof WorkDirector>[0] = {
    router,
    store,
    world,
    roles: loadRoles(),
    tools: new ToolRegistry(),
    web: new WebClient(
      { allow: ["en.wikipedia.org"], userAgent: "test", maxBytes: 100_000 },
      wikipedia,
    ),
    gates,
    dailyStandup: false,
    // Waiting lets the station move on, as real time would.
    sleep: async (ms: number) => {
      for (let t = 0; t < Math.min(ms, 60_000); t += 250) world.tick(250);
    },
    ...(cafeAfterMs !== undefined ? { cafeAfterMs } : {}),
  };
  const director = new WorkDirector(deps);
  return { world, director, store, events, transport, gates, deps };
}

async function runUntil(
  s: ReturnType<typeof setup>,
  done: () => boolean,
  limit = 400,
): Promise<void> {
  for (let i = 0; i < limit && !done(); i++) {
    s.director.tick();
    await s.director.settle(5_000);
    s.world.tick(500);
  }
}

describe("WorkDirector end to end (fixture LLM)", () => {
  it("plans an objective, works it, reviews it with one rework, and delivers it to the owner", async () => {
    const s = setup();
    const objective = s.director.createObjective("Find 10 winter candle niches and rank them");
    await runUntil(s, () => s.store.objective(objective.id)?.status === "awaiting_owner");

    const o = s.store.objective(objective.id);
    expect(o?.status).toBe("awaiting_owner");
    expect(o?.taskIds).toEqual(["W-0001"]);
    const task = s.world.sim.task("W-0001");
    expect(task).toMatchObject({ assignee: "scout", status: "done", reworks: 1 });
    expect(task?.feedback).toBe("Good.");

    // The deliverable and the Owner's Desk item.
    const pending = s.store.approvals("pending");
    expect(pending).toHaveLength(1);
    expect(pending[0]?.kind).toBe("deliverable");
    const final = s.store.artifact(o?.artifactId ?? "");
    expect(final?.content).toContain("Next steps");

    // What showed on the station along the way.
    const of = <T extends StationEvent["type"]>(type: T) =>
      s.events.filter((e): e is StationEventOf<T> => e.type === type);
    const scoutWork = of("agent.activity").filter((e) => e.id === "scout" && e.activity === "work");
    expect(scoutWork.length).toBeGreaterThan(0);
    const said = of("agent.say").map((e) => `${e.id}: ${e.text}`);
    expect(said.some((t) => t.startsWith("scout: Researching"))).toBe(true);
    expect(said.some((t) => t.startsWith("warden: Plan ready"))).toBe(true);
    expect(said.some((t) => t.includes("PASS W-0001"))).toBe(true);
    const statuses = of("task.updated")
      .filter((e) => e.task.id === "W-0001")
      .map((e) => e.task.status);
    expect(statuses).toEqual(
      expect.arrayContaining(["assigned", "in_progress", "review", "rework", "done"]),
    );
    // WARDEN waits at the Owner's Desk with a ❗ for the decision.
    expect(of("agent.activity").some((e) => e.id === "warden" && e.activity === "await")).toBe(
      true,
    );
    expect(of("objective.updated").at(-1)?.objective.status).toBe("awaiting_owner");
    expect(of("artifact.created").length).toBeGreaterThanOrEqual(3);

    // The notes and memory tools ran against the store.
    expect(s.store.notes("W-0001").map((n) => n.text)).toContain("Pine, hygge and vanilla lead.");

    // The owner accepts.
    const decided = await s.director.decide(pending[0]?.id ?? "", "approve");
    expect(decided.status).toBe("approved");
    expect(s.store.objective(objective.id)?.status).toBe("done");
    // Snapshot carries the work records for clients that connect later.
    const snap = s.world.snapshot() as StationEventOf<"snapshot">;
    expect(snap.objectives?.some((x) => x.id === objective.id && x.status === "done")).toBe(true);
  });

  it("revises when the owner sends the result back", async () => {
    const fx = fixtures();
    fx.push(
      {
        when: { system: "You are Scout", user: "The owner sent the result back" },
        reply: {
          toolCalls: [
            {
              name: "submit_for_review",
              arguments: { title: "Revised", content: `${REPORT}\nAdded prices.` },
            },
          ],
        },
        once: true,
      },
      {
        when: { system: "Review the deliverable" },
        reply: { content: JSON.stringify({ verdict: "pass", score: 9, feedback: "Better." }) },
      },
      {
        when: { system: "Write the final deliverable" },
        reply: { content: "Revised summary.\n\n## Next steps\n- Ship." },
      },
    );
    const s = setup(fx);
    const objective = s.director.createObjective("Find 10 winter candle niches and rank them");
    await runUntil(s, () => s.store.objective(objective.id)?.status === "awaiting_owner");
    const first = s.store.approvals("pending")[0];
    await s.director.decide(first?.id ?? "", "reject", "Add price ranges.");
    expect(s.store.objective(objective.id)?.status).toBe("active");
    await runUntil(s, () => s.store.objective(objective.id)?.status === "awaiting_owner");
    expect(s.store.objective(objective.id)?.taskIds).toHaveLength(2);
    expect(s.store.approvals("pending")).toHaveLength(1);
  });

  it("escalates to the owner when a task keeps failing, and shows the crew member as blocked", async () => {
    const fx: Fixture[] = [
      fixtures()[0] as Fixture,
      // Scout never submits: every step just talks.
      { when: { system: "You are Scout" }, reply: { content: "Thinking." } },
    ];
    const s = setup(fx);
    const objective = s.director.createObjective("Find 10 winter candle niches and rank them");
    await runUntil(s, () => s.store.approvals("pending").some((a) => a.kind === "escalation"));
    const escalation = s.store.approvals("pending").find((a) => a.kind === "escalation");
    expect(escalation?.taskId).toBe("W-0001");
    expect(s.world.sim.task("W-0001")?.status).toBe("failed");
    for (let i = 0; i < 80; i++) s.world.tick(500);
    expect(s.world.sim.agentState("scout").activity).toBe("blocked");
    // Retry from the Owner's Desk puts the task back in the queue.
    await s.director.decide(escalation?.id ?? "", "approve", "Try once more, keep it short.");
    expect(s.world.sim.task("W-0001")?.status).toBe("assigned");
    expect(s.store.objective(objective.id)?.status).toBe("active");
  });

  it("withdraws a stale write-up when a task of a finished objective is retried", async () => {
    const fx: Fixture[] = [
      fixtures()[0] as Fixture,
      { when: { system: "You are Scout" }, reply: { content: "Thinking." } },
    ];
    const s = setup(fx);
    const objective = s.director.createObjective("Find 10 winter candle niches and rank them");
    await runUntil(s, () => s.store.approvals("pending").some((a) => a.kind === "escalation"));
    const escalation = s.store.approvals("pending").find((a) => a.kind === "escalation");
    // Suppose WARDEN already wrote the objective up while the task was failed.
    const current = s.store.objective(objective.id);
    if (!current || !escalation) throw new Error("setup");
    s.store.saveObjective({ ...current, status: "awaiting_owner" });
    s.store.saveApproval({
      ...escalation,
      id: "A-0099",
      kind: "deliverable",
      title: "Objective done",
      taskId: null,
      objectiveId: objective.id,
    });
    await s.director.decide(escalation.id, "approve");
    expect(s.store.objective(objective.id)?.status).toBe("active");
    const stale = s.store.approval("A-0099");
    expect(stale?.status).toBe("rejected");
    expect(stale?.note).toContain("W-0001 was retried");
  });

  it("cuts off repeated tool calls and makes the last step a submission", async () => {
    const fx: Fixture[] = [
      fixtures()[0] as Fixture,
      // Scout keeps searching memory with the same query while searching is on offer...
      {
        when: { system: "You are Scout", offers: "memory_search" },
        reply: {
          content: "Checking memory.",
          toolCalls: [{ name: "memory_search", arguments: { query: "winter candles" } }],
        },
      },
      // ...and submits once the last step offers only the ways out.
      {
        when: { system: "You are Scout" },
        reply: {
          content: "Submitting.",
          toolCalls: [
            { name: "submit_for_review", arguments: { title: "Winter niches", content: REPORT } },
          ],
        },
      },
      {
        when: { system: "Review the deliverable" },
        reply: { content: JSON.stringify({ verdict: "pass", score: 8, feedback: "Good." }) },
      },
      { when: { system: "Write the final deliverable" }, reply: { content: REPORT } },
    ];
    const s = setup(fx);
    s.director.createObjective("Find 10 winter candle niches and rank them");
    await runUntil(s, () => s.store.approvals("pending").some((a) => a.kind === "deliverable"));
    expect(s.world.sim.task("W-0001")?.status).toBe("done");
    const scoutCalls = s.transport.calls.filter((c) =>
      JSON.stringify(c.messages[0]).includes("You are Scout"),
    );
    const last = scoutCalls.at(-1);
    expect(last?.tools?.map((t) => t.name).sort()).toEqual(["escalate", "submit_for_review"]);
    expect(JSON.stringify(last?.messages)).toContain("You already ran memory_search");
  });

  it("puts in-progress work back in the queue after a restart", async () => {
    const s = setup();
    s.director.createObjective("Find 10 winter candle niches and rank them");
    await runUntil(s, () => !!s.world.sim.task("W-0001"));
    const task = s.world.sim.task("W-0001");
    if (!task) throw new Error("no task");
    // A crash mid-run leaves the task in progress and the avatar under control.
    s.world.mutate((w) => {
      w.upsertTask({ ...task, status: "in_progress" });
      w.control(task.assignee, true);
    });
    const fresh = new WorkDirector(s.deps);
    expect(fresh.recover()).toBe(1);
    expect(s.world.sim.task("W-0001")?.status).toBe("assigned");
    expect(s.world.sim.isControlled(task.assignee)).toBe(false);
  });
});

describe("tools", () => {
  it("builds JSON Schema specs and coerces numbers sent as strings", () => {
    const tool = defineTool({
      name: "count",
      description: "Count",
      sideEffect: "none",
      lane: "any",
      approval: "never",
      input: z.object({ n: z.number().int(), label: z.string() }),
      run: async ({ n }) => String(n),
    });
    const spec = toolSpec(tool as never);
    expect(spec.parameters).toMatchObject({ type: "object", required: ["n", "label"] });
    expect(parseToolArgs(tool, '{"n":"17","label":"x"}')).toEqual({
      ok: true,
      input: { n: 17, label: "x" },
    });
    const bad = parseToolArgs(tool, '{"n":"many"}');
    expect(bad.ok).toBe(false);
    expect(parseToolArgs(tool, "not json").ok).toBe(false);
  });

  it("never runs external tools directly: the owner approves, and the tool runs once", async () => {
    let runs = 0;
    const publish = defineTool({
      name: "publish_listing",
      description: "Publish a listing (external).",
      sideEffect: "external",
      lane: "any",
      approval: "always",
      input: z.object({ listing: z.string() }),
      status: ({ listing }) => `Publish ${listing}`,
      run: async ({ listing }, ctx) => {
        runs += 1;
        return `published ${listing} (${ctx.idempotencyKey})`;
      },
    });
    const fx: Fixture[] = [
      fixtures()[0] as Fixture,
      {
        when: { system: "You are Scout", user: "Task W-0001" },
        reply: { toolCalls: [{ name: "publish_listing", arguments: { listing: "Pine candle" } }] },
        once: true,
      },
      {
        when: { system: "You are Scout", tool: "Sent to the owner for approval" },
        reply: {
          toolCalls: [{ name: "submit_for_review", arguments: { title: "Done", content: REPORT } }],
        },
        once: true,
      },
    ];
    const s = setup(fx);
    const tools = new ToolRegistry();
    tools.add(publish as never);
    // Give the researcher the external tool for this test.
    const roles = loadRoles();
    const researcher = roles.get("researcher");
    if (researcher) researcher.tools = [...researcher.tools, "publish_listing"];
    const director = new WorkDirector({
      router: (s.director as unknown as { deps: { router: never } }).deps.router,
      store: s.store,
      world: s.world,
      roles,
      tools,
      web: new WebClient({ allow: [], userAgent: "t", maxBytes: 1 }),
      sleep: async () => {},
      dailyStandup: false,
    });
    director.createObjective("Publish the pine candle listing");
    for (let i = 0; i < 50 && !s.store.approvals("pending").some((a) => a.kind === "action"); i++) {
      director.tick();
      await director.settle();
      s.world.tick(500);
    }
    const action = s.store.approvals("pending").find((a) => a.kind === "action");
    expect(action?.action?.tool).toBe("publish_listing");
    expect(runs).toBe(0);
    await director.decide(action?.id ?? "", "approve");
    expect(runs).toBe(1);
    // Deciding again is refused; the tool never runs twice.
    await expect(director.decide(action?.id ?? "", "approve")).rejects.toThrow(/already/);
    expect(runs).toBe(1);
    expect(s.store.notes("W-0001").some((n) => n.text.includes("published Pine candle"))).toBe(
      true,
    );
  });
});

describe("rate limits on screen", () => {
  it("sends a crew member to the café while the provider makes them wait", async () => {
    const s = setup(fixtures(), 300);
    s.director.createObjective("Find 10 winter candle niches and rank them");
    await runUntil(s, () => s.world.sim.task("W-0001") !== undefined);
    // The provider starts making callers wait just as Scout begins.
    s.gates.get("fake")?.cooldown(900);
    await runUntil(s, () =>
      s.events.some((e) => e.type === "agent.activity" && e.activity === "coffee"),
    );
    const coffee = s.events.find((e) => e.type === "agent.activity" && e.activity === "coffee");
    expect(coffee).toBeDefined();
    const limited = s.events.find(
      (e) => e.type === "provider.status" && e.status.state === "limited",
    );
    expect(limited?.type === "provider.status" && limited.status.provider).toBe("fake");
  });
});
