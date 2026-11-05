import type {
  Approval,
  ArtifactMeta,
  CrewMember,
  CrewRole,
  Lane,
  Objective,
  Task,
} from "@orbital/shared";
import { parseModelRef } from "@orbital/shared";
import { z } from "zod";
import type { CreativeStudio } from "../creative/studio";
import type { ProviderGate } from "../llm/rateLimiter";
import type { ModelRouter, RouterEvent } from "../llm/router";
import type { SimServer } from "../sim/simServer";
import { type RoleConfig, systemPrompt } from "./roles";
import { AgentRuntime, firstSentence, type RunOutcome } from "./runtime";
import type { WorkStore } from "./store";
import type { ToolRegistry } from "./tools";
import type { WebClient } from "./web";

/**
 * The Overseer loop and the work scheduler (ROADMAP §6):
 *   objective → plan (WARDEN) → tasks assigned by role and load → agent runs → review (Lens for
 *   factory work, WARDEN for research and reports) → rework (at most twice) → WARDEN writes the
 *   result → the owner accepts it at the Owner's Desk.
 * Failed work is escalated to the owner. Every step shows on the station: who walks where, who
 * types, who waits at the Owner's Desk with a ❗.
 */

const PLANNABLE_ROLES = ["researcher", "operator", "thumbnailer", "forger", "bookkeeper"] as const;
const FACTORY_ROLES = new Set<CrewRole>(["operator", "thumbnailer", "forger"]);
const MAX_REWORKS = 2;
const MAX_TASKS_PER_OBJECTIVE = 6;

const planSchema = z.object({
  summary: z.string().max(600),
  tasks: z
    .array(
      z.object({
        title: z.string().min(3).max(90),
        role: z.enum(PLANNABLE_ROLES),
        brief: z.string().min(10).max(1_600),
      }),
    )
    .min(1)
    .max(4),
});

const reviewSchema = z.object({
  verdict: z.enum(["pass", "rework"]),
  score: z.number().min(0).max(10),
  feedback: z.string().max(1_000),
});

export interface WorkDeps {
  router: ModelRouter;
  store: WorkStore;
  world: SimServer;
  roles: Map<CrewRole, RoleConfig>;
  tools: ToolRegistry;
  web: WebClient;
  lane?: Lane;
  gates?: Map<string, ProviderGate>;
  /** Agent runs and Overseer calls in flight at once (free tiers are scarce). */
  maxConcurrent?: number;
  tickMs?: number;
  /** Post a standup once a day (default true; tests turn it off). */
  dailyStandup?: boolean;
  /** A run taking longer than this (real ms) gets a visit from WARDEN. */
  stuckAfterMs?: number;
  /** Provider waits longer than this send the crew member to the café first (ms). */
  cafeAfterMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
  /** The creative toolchain (Stage 5): image tools for the crew. */
  studio?: CreativeStudio;
}

interface Hold {
  agentId: string;
  /** Sim time after which the crew member goes back to autopilot. */
  until: number;
  /** Released early when the crew member has arrived (delivery done). */
  untilArrived?: boolean;
}

export class WorkDirector {
  private readonly lane: Lane;
  private readonly runtime: AgentRuntime;
  private readonly busy = new Set<string>();
  private readonly holds = new Map<string, Hold>();
  private readonly attempts = new Map<string, number>();
  /** When each agent run started (real ms), for stuck detection. */
  private readonly started = new Map<string, number>();
  private readonly nudged = new Set<string>();
  private readonly decisionHooks: ((approval: Approval) => void | Promise<void>)[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = 0;
  private readonly log: (m: string) => void;

  constructor(private readonly deps: WorkDeps) {
    this.lane = deps.lane ?? "sandbox";
    this.log = deps.log ?? (() => {});
    this.runtime = new AgentRuntime(
      {
        router: deps.router,
        store: deps.store,
        world: deps.world,
        roles: deps.roles,
        tools: deps.tools,
        web: deps.web,
        lane: this.lane,
        ...(deps.gates ? { gates: deps.gates } : {}),
        ...(deps.sleep ? { sleep: deps.sleep } : {}),
        ...(deps.cafeAfterMs !== undefined ? { cafeAfterMs: deps.cafeAfterMs } : {}),
        ...(deps.studio ? { studio: deps.studio } : {}),
      },
      {
        askOverseer: (asker, q) => this.askOverseer(asker, q),
        createSubtask: (parent, spec) => this.createSubtask(parent, spec),
        earlierWork: (task) => this.earlierWork(task),
        requestApproval: (task, agent, tool, input, summary) =>
          this.requestAction(task, agent, tool, input, summary),
      },
    );
    deps.world.extras = () => ({
      objectives: deps.store.objectives(30),
      approvals: deps.store.approvals("pending", 50),
      artifacts: deps.store.artifacts(40),
    });
  }

  start(): void {
    if (this.timer) return;
    this.recover();
    this.timer = setInterval(() => this.tick(), this.deps.tickMs ?? 1_000);
  }

  /**
   * After a restart nothing is running yet, so work that was in flight goes back to the queue:
   * in-progress tasks are assigned again, and their crew members return to autopilot.
   */
  recover(): number {
    let count = 0;
    for (const task of this.realTasks()) {
      if (task.status !== "in_progress" || this.busy.has(task.id)) continue;
      this.updateTask({ ...task, status: "assigned" });
      this.deps.world.mutate((s) => {
        if (s.isControlled(task.assignee)) s.control(task.assignee, false);
      });
      count += 1;
    }
    if (count > 0) this.log(`recovered ${count} task(s) that were in progress`);
    return count;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** True while any planning, agent run, review or write-up is in flight. */
  get working(): boolean {
    return this.busy.size > 0;
  }

  // -- Owner commands -------------------------------------------------------------------------

  createObjective(text: string): Objective {
    const now = this.now();
    const objective: Objective = {
      id: this.deps.store.nextId("O"),
      text: text.trim(),
      status: "planning",
      taskIds: [],
      artifactId: null,
      createdAt: now,
      updatedAt: now,
      note: null,
    };
    this.saveObjective(objective);
    this.overseerSay(`New objective: ${firstSentence(objective.text, 50)}`);
    return objective;
  }

  async decide(id: string, decision: "approve" | "reject", note?: string): Promise<Approval> {
    const approval = this.deps.store.approval(id);
    if (!approval) throw new Error(`No Owner's Desk item "${id}"`);
    if (approval.status !== "pending") throw new Error(`${id} was already ${approval.status}`);
    const decided: Approval = {
      ...approval,
      status: decision === "approve" ? "approved" : "rejected",
      decidedAt: this.now(),
      note: note?.trim() || null,
    };
    this.saveApproval(decided);

    if (approval.kind === "deliverable" && approval.objectiveId) {
      const objective = this.deps.store.objective(approval.objectiveId);
      if (objective) {
        if (decision === "approve") {
          this.saveObjective({ ...objective, status: "done", note: decided.note });
          this.overseerSay("The owner accepted it. Nice work, team.");
          this.deps.store.saveMemory({
            agentId: "warden",
            scope: "station",
            text: `The owner accepted the result for "${firstSentence(objective.text, 120)}".`,
            tags: ["owner", "accepted"],
            embedding: null,
          });
        } else {
          this.reviseObjective(objective, decided.note ?? "The owner sent it back without a note.");
        }
      }
    }
    if (approval.kind === "escalation" && approval.taskId) {
      const task = this.deps.world.sim.task(approval.taskId);
      if (task) {
        this.release(task.assignee);
        if (decision === "approve") {
          this.attempts.delete(task.id);
          this.updateTask({
            ...task,
            status: "assigned",
            feedback: decided.note ?? task.feedback ?? null,
          });
          this.reopenObjective(task.objectiveId ?? null, task.id);
        } else {
          this.updateTask({ ...task, status: "failed" });
          this.checkObjective(task.objectiveId ?? null);
        }
      }
    }
    if (approval.kind === "action" && decision === "approve" && approval.action) {
      await this.runApprovedAction(decided);
    }
    for (const hook of this.decisionHooks) {
      try {
        await hook(decided);
      } catch (err) {
        this.log(`decision hook for ${decided.id} failed: ${String(err)}`);
      }
    }
    return decided;
  }

  /** The end-of-day summary for the owner: what got done, what is stuck. */
  async standup(): Promise<ArtifactMeta | null> {
    const tasks = this.realTasks();
    const objectives = this.deps.store.objectives(20);
    const facts = [
      `Objectives: ${objectives.map((o) => `${o.id} ${o.status}: ${o.text}`).join("; ") || "none"}`,
      `Tasks: ${tasks.map((t) => `${t.id} ${t.status} (${t.assignee}): ${t.title}`).join("; ") || "none"}`,
      `Waiting at the Owner's Desk: ${this.deps.store.approvals("pending").length}`,
    ].join("\n");
    const warden = this.overseer();
    if (!warden) return null;
    const text = await this.withSlot(() =>
      this.deps.router.generate({
        tier: "reasoning",
        lane: this.lane,
        system: `${this.overseerSystem()}\nWrite today's standup for the owner: done, in progress, blocked, next. Use only these facts. At most 12 lines of markdown.`,
        prompt: facts,
        maxTokens: 1_200,
        purpose: "standup",
      }),
    );
    const meta = this.saveArtifact({
      kind: "standup",
      title: `Standup ${new Date().toISOString().slice(0, 10)}`,
      content: text.text.trim() || facts,
      taskId: null,
      objectiveId: null,
      createdBy: warden.id,
    });
    this.overseerSay("Standup posted to the Owner's Desk log.");
    return meta;
  }

  onRouterEvent(e: RouterEvent): void {
    if (e.type !== "failure" || e.outcome !== "rate-limited") return;
    const provider = parseModelRef(e.ref).provider;
    this.deps.world.mutate((s) => {
      s.setProviderStatus(provider, "limited", s.now + 30_000 * s.simStatus.speed, "HTTP 429");
    });
  }

  // -- The loop -------------------------------------------------------------------------------

  tick(): void {
    this.upkeepHolds();
    this.checkStuck();
    this.maybeStandup();
    const { store } = this.deps;
    for (const o of store.openObjectives()) {
      if (o.status === "planning" && !this.busy.has(o.id)) void this.plan(o);
      else if (o.status === "active") this.checkObjective(o.id);
    }
    for (const task of this.realTasks()) {
      if (this.busy.has(task.id)) continue;
      if (task.status === "assigned" || task.status === "rework") {
        if (this.busy.has(`agent:${task.assignee}`)) continue;
        if (!this.prerequisitesDone(task)) continue;
        if (this.inFlight >= (this.deps.maxConcurrent ?? 2)) continue;
        void this.work(task);
      } else if (task.status === "review") {
        if (this.inFlight >= (this.deps.maxConcurrent ?? 2) + 1) continue;
        void this.review(task);
      }
    }
  }

  /** Finish everything in flight (for tests and shutdown). */
  async settle(timeoutMs = 60_000): Promise<void> {
    const end = Date.now() + timeoutMs;
    while (this.busy.size > 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  }

  /**
   * Tasks of one objective run in plan order: each starts once the tasks before it are done (or
   * failed), and sees their deliverables. Rework and owner revisions are never held back.
   */
  private prerequisitesDone(task: Task): boolean {
    if (!task.objectiveId || task.status === "rework") return true;
    const objective = this.deps.store.objective(task.objectiveId);
    if (!objective) return true;
    const index = objective.taskIds.indexOf(task.id);
    if (index <= 0) return true;
    return objective.taskIds.slice(0, index).every((id) => {
      const t = this.deps.world.sim.task(id);
      return !t || t.status === "done" || t.status === "failed";
    });
  }

  /** Deliverables of the earlier tasks in the same objective, for context. */
  earlierWork(task: Task): string {
    if (!task.objectiveId) return "";
    const objective = this.deps.store.objective(task.objectiveId);
    if (!objective) return "";
    const index = objective.taskIds.indexOf(task.id);
    const earlier = objective.taskIds.slice(0, Math.max(0, index));
    return earlier
      .map((id) => this.deps.world.sim.task(id))
      .filter((t): t is Task => !!t?.artifactId)
      .map((t) => {
        const content = this.deps.store.artifact(t.artifactId ?? "")?.content ?? "";
        return `### ${t.id} ${t.title} (by ${t.assignee})\n${content.slice(0, 6_000)}`;
      })
      .join("\n\n");
  }

  /** Tasks the agent runtime works: real (not ambient) and not run by a factory pipeline. */
  private realTasks(): Task[] {
    return this.deps.world.sim.taskList.filter((t) => !t.mock && !t.pipeline);
  }

  // -- Planning ---------------------------------------------------------------------------------

  private async plan(objective: Objective): Promise<void> {
    const warden = this.overseer();
    if (!warden) return;
    this.busy.add(objective.id);
    try {
      this.hold(warden.id);
      this.deps.world.mutate((s) =>
        s.command(warden.id, {
          kind: "work",
          status: `Planning ${objective.id}`,
          anchor: warden.workstations[0] ?? "warden-command",
        }),
      );
      const crewList = this.deps.world.sim.crew
        .filter((c) => c.role !== "overseer" && c.role !== "reviewer")
        .map((c) => `${c.name} (${c.role}${c.business ? `, ${c.business}` : ""})`)
        .join("; ");
      const memories = this.deps.store
        .memories("warden", 40)
        .filter((m) => m.scope === "station")
        .slice(0, 6)
        .map((m) => `- ${m.text}`)
        .join("\n");
      const res = await this.withSlot(() =>
        this.deps.router.generate({
          tier: "reasoning",
          lane: this.lane,
          schema: planSchema,
          system: `${this.overseerSystem()}
Plan the owner's objective into 1 to 4 tasks. Each task goes to one role: ${PLANNABLE_ROLES.join(", ")}.
${this.deps.studio ? "Tasks can be text work (research, ranking, concepts, listing copy, plans) or image work: the\nthumbnailer, forger and operator roles can generate, upscale, cut out, compose, pixelate and QA\nimages." : "Tasks are text work: research, ranking, concepts, prompts, listing copy, plans. Image generation\nis not available."} Publishing is not available yet. Give each task a clear title and a brief that
says exactly what to deliver.`,
          prompt: `Objective: ${objective.text}\nCrew: ${crewList}${memories ? `\nStation memory:\n${memories}` : ""}`,
          maxTokens: 2_000,
          purpose: `plan ${objective.id}`,
        }),
      );
      const plan = res.data;
      if (!plan) throw new Error("The plan was empty");
      const ids: string[] = [];
      for (const spec of plan.tasks) ids.push(this.newTask(objective.id, spec).id);
      this.saveObjective({ ...objective, status: "active", taskIds: ids, note: plan.summary });
      this.overseerSay(`Plan ready: ${ids.length} task${ids.length === 1 ? "" : "s"}.`);
    } catch (err) {
      this.log(`plan ${objective.id} failed: ${String(err)}`);
      this.saveObjective({
        ...objective,
        status: "failed",
        note: `Planning failed: ${err instanceof Error ? err.message.slice(0, 300) : String(err)}`,
      });
      this.escalate(
        null,
        warden,
        `I could not plan ${objective.id}: ${String(err).slice(0, 300)}`,
        objective.id,
      );
    } finally {
      this.release(warden.id, 4_000);
      this.busy.delete(objective.id);
    }
  }

  private newTask(
    objectiveId: string | null,
    spec: { title: string; role: CrewRole; brief: string },
  ): Task {
    const assignee = this.assignee(spec.role);
    const now = this.now();
    const task: Task = {
      id: this.deps.store.nextId("W"),
      title: spec.title,
      room: assignee.room,
      assignee: assignee.id,
      status: "assigned",
      reworks: 0,
      createdAt: now,
      updatedAt: now,
      objectiveId,
      brief: spec.brief,
      artifactId: null,
      feedback: null,
    };
    this.updateTask(task);
    return task;
  }

  /** The least-loaded crew member with the role (any non-Overseer as a last resort). */
  private assignee(role: CrewRole): CrewMember {
    const crew = this.deps.world.sim.crew;
    const open = this.realTasks().filter((t) => !["done", "failed"].includes(t.status));
    const load = (id: string) => open.filter((t) => t.assignee === id).length;
    const pool = crew.filter((c) => c.role === role);
    const candidates = pool.length > 0 ? pool : crew.filter((c) => c.role === "researcher");
    const sorted = [...(candidates.length > 0 ? candidates : crew)].sort(
      (a, b) => load(a.id) - load(b.id),
    );
    const pick = sorted[0];
    if (!pick) throw new Error("No crew aboard");
    return pick;
  }

  private createSubtask(
    parent: Task,
    spec: { title: string; role: CrewRole; brief: string },
  ): Task {
    const siblings = this.realTasks().filter((t) => t.objectiveId === parent.objectiveId);
    if (siblings.length >= MAX_TASKS_PER_OBJECTIVE) {
      throw new Error("This objective already has as many tasks as allowed");
    }
    const task = this.newTask(parent.objectiveId ?? null, spec);
    if (parent.objectiveId) {
      const o = this.deps.store.objective(parent.objectiveId);
      if (o) this.saveObjective({ ...o, taskIds: [...o.taskIds, task.id] });
    }
    return task;
  }

  // -- Working --------------------------------------------------------------------------------

  private async work(task: Task): Promise<void> {
    this.busy.add(task.id);
    this.busy.add(`agent:${task.assignee}`);
    this.started.set(task.id, Date.now());
    let outcome: RunOutcome;
    try {
      outcome = await this.withSlot(() => this.runtime.run(task));
    } catch (err) {
      outcome = { kind: "failed", error: err instanceof Error ? err.message : String(err) };
    }
    const agent = this.crew(task.assignee);
    try {
      if (outcome.kind === "submitted") {
        const meta = this.saveArtifact({
          kind: "report",
          title: outcome.title,
          content: outcome.content,
          taskId: task.id,
          objectiveId: task.objectiveId ?? null,
          createdBy: task.assignee,
        });
        const current = this.deps.world.sim.task(task.id) ?? task;
        this.updateTask({ ...current, status: "review", artifactId: meta.id });
        if (agent) {
          const toQa = FACTORY_ROLES.has(agent.role);
          this.deps.world.mutate((s) =>
            s.command(agent.id, {
              kind: "deliver",
              to: toQa ? "qa" : "bridge",
              item: toQa ? "crate" : "datapad",
              status: `Handing in ${task.id}`,
              taskId: task.id,
            }),
          );
          this.hold(agent.id, 45_000, true);
        }
      } else {
        const attempts = (this.attempts.get(task.id) ?? 0) + 1;
        this.attempts.set(task.id, attempts);
        const reason = outcome.kind === "escalated" ? outcome.reason : outcome.error;
        this.log(`${task.id} ${outcome.kind}: ${reason}`);
        if (outcome.kind === "failed" && attempts < 2) {
          this.updateTask({ ...task, status: "assigned" });
          if (agent) this.release(agent.id);
        } else {
          this.updateTask({ ...task, status: "failed", feedback: reason.slice(0, 600) });
          if (agent) {
            this.deps.world.mutate((s) =>
              s.command(agent.id, {
                kind: "blocked",
                status: `Stuck on ${task.id}`,
                taskId: task.id,
              }),
            );
            this.hold(agent.id, Number.POSITIVE_INFINITY);
            this.escalate(task, agent, reason, task.objectiveId ?? null);
          }
        }
      }
    } finally {
      this.busy.delete(task.id);
      this.busy.delete(`agent:${task.assignee}`);
    }
  }

  /**
   * Stuck detection: a run that takes far longer than usual gets a visit from WARDEN (once), and
   * the owner sees it in the log. The run itself is bounded by the step cap and request timeouts.
   */
  private checkStuck(): void {
    const limit = this.deps.stuckAfterMs ?? 8 * 60_000;
    for (const [taskId, since] of this.started) {
      if (!this.busy.has(taskId)) {
        this.started.delete(taskId);
        this.nudged.delete(taskId);
        continue;
      }
      if (Date.now() - since < limit || this.nudged.has(taskId)) continue;
      this.nudged.add(taskId);
      const task = this.deps.world.sim.task(taskId);
      const agent = task ? this.crew(task.assignee) : undefined;
      if (!task || !agent) continue;
      this.say(agent.id, "Still on it, WARDEN.");
      this.overseerSay(`${agent.name}, status on ${task.id}?`);
      this.log(`${task.id} has been running for ${Math.round((Date.now() - since) / 60_000)} min`);
    }
  }

  /** Once a day, after the standup hour in config/roles/overseer.yaml, WARDEN posts a standup. */
  private maybeStandup(): void {
    const hour = Number(this.deps.roles.get("overseer")?.schedule.standupHour ?? 18);
    const now = new Date();
    if (this.deps.dailyStandup === false) return;
    if (now.getHours() < hour || this.busy.has("standup")) return;
    const today = now.toISOString().slice(0, 10);
    if (this.deps.store.getKv("standup.lastDate") === today) return;
    if (this.realTasks().length === 0) return;
    this.deps.store.setKv("standup.lastDate", today);
    this.busy.add("standup");
    void this.standup()
      .catch((err: unknown) => this.log(`standup failed: ${String(err)}`))
      .finally(() => this.busy.delete("standup"));
  }

  // -- Reviewing ------------------------------------------------------------------------------

  private async review(task: Task): Promise<void> {
    const author = this.crew(task.assignee);
    const reviewer =
      author && FACTORY_ROLES.has(author.role)
        ? (this.deps.world.sim.crew.find((c) => c.role === "reviewer") ?? this.overseer())
        : this.overseer();
    if (!reviewer || !task.artifactId) return;
    if (this.busy.has(`agent:${reviewer.id}`)) return;
    const artifact = this.deps.store.artifact(task.artifactId);
    const content = artifact?.content;
    if (!content) return;
    this.busy.add(task.id);
    this.busy.add(`agent:${reviewer.id}`);
    try {
      this.hold(reviewer.id);
      this.deps.world.mutate((s) =>
        s.command(reviewer.id, {
          kind: "work",
          status: `Reviewing ${task.id}`,
          taskId: task.id,
          anchor:
            reviewer.role === "reviewer"
              ? "qa-scan"
              : (reviewer.workstations[0] ?? "warden-command"),
        }),
      );
      const role = this.deps.roles.get(reviewer.role);
      const res = await this.withSlot(() =>
        this.deps.router.generate({
          tier: "reasoning",
          lane: this.lane,
          schema: reviewSchema,
          system: `${role ? systemPrompt(role, reviewer) : this.overseerSystem()}
Review the deliverable against its brief. Pass it if it is good enough to act on. Send it back
("rework") only for a specific problem the author can fix, and say exactly what to change.`,
          prompt: `Task ${task.id}: ${task.title}\nBrief: ${task.brief ?? "(none)"}\nRework round: ${task.reworks}/${MAX_REWORKS}\n\nDeliverable:\n${content.slice(0, 14_000)}`,
          maxTokens: 1_200,
          purpose: `review ${task.id}`,
        }),
      );
      const verdict = res.data;
      if (!verdict) throw new Error("The review was empty");
      const current = this.deps.world.sim.task(task.id) ?? task;
      if (verdict.verdict === "rework" && current.reworks < MAX_REWORKS) {
        this.updateTask({
          ...current,
          status: "rework",
          reworks: current.reworks + 1,
          feedback: verdict.feedback,
        });
        this.say(reviewer.id, `Rework: ${firstSentence(verdict.feedback, 50)}`);
      } else {
        this.updateTask({ ...current, status: "done", feedback: verdict.feedback });
        this.say(reviewer.id, `PASS ${task.id} (${verdict.score}/10)`);
        this.checkObjective(task.objectiveId ?? null);
      }
    } catch (err) {
      this.log(`review ${task.id} failed: ${String(err)}`);
      // Reviews that cannot run do not block the work: pass with a note.
      const current = this.deps.world.sim.task(task.id) ?? task;
      this.updateTask({
        ...current,
        status: "done",
        feedback: "Not reviewed: the reviewer's model was unavailable.",
      });
      this.checkObjective(task.objectiveId ?? null);
    } finally {
      this.release(reviewer.id, 3_000);
      this.busy.delete(task.id);
      this.busy.delete(`agent:${reviewer.id}`);
    }
  }

  // -- Finishing objectives --------------------------------------------------------------------

  /**
   * A retried task reopens its objective. If WARDEN already wrote it up without that task, the
   * write-up waiting at the Owner's Desk is withdrawn: a new one follows when the task is done.
   */
  private reopenObjective(id: string | null, taskId: string): void {
    const objective = id ? this.deps.store.objective(id) : null;
    if (!objective || objective.status === "active" || objective.status === "planning") return;
    for (const pending of this.deps.store.approvals("pending")) {
      if (pending.kind !== "deliverable" || pending.objectiveId !== objective.id) continue;
      this.saveApproval({
        ...pending,
        status: "rejected",
        decidedAt: this.now(),
        note: `Withdrawn: ${taskId} was retried, so a new write-up will follow.`,
      });
    }
    this.saveObjective({ ...objective, status: "active" });
  }

  private checkObjective(id: string | null): void {
    if (!id) return;
    const objective = this.deps.store.objective(id);
    if (objective?.status !== "active" || this.busy.has(objective.id)) return;
    const tasks = objective.taskIds
      .map((t) => this.deps.world.sim.task(t))
      .filter((t): t is Task => !!t);
    if (tasks.length === 0) return;
    if (tasks.some((t) => !["done", "failed"].includes(t.status))) return;
    if (tasks.every((t) => t.status === "failed")) {
      this.saveObjective({ ...objective, status: "failed", note: "Every task failed." });
      return;
    }
    void this.synthesize(objective, tasks);
  }

  private async synthesize(objective: Objective, tasks: Task[]): Promise<void> {
    const warden = this.overseer();
    if (!warden) return;
    this.busy.add(objective.id);
    try {
      this.hold(warden.id);
      this.deps.world.mutate((s) =>
        s.command(warden.id, {
          kind: "work",
          status: `Writing up ${objective.id}`,
          anchor: warden.workstations[0] ?? "warden-command",
        }),
      );
      const parts = tasks
        .map((t) => {
          const a = t.artifactId ? this.deps.store.artifact(t.artifactId) : null;
          return `## ${t.id} ${t.title} (${t.status}, by ${t.assignee})\n${a?.content?.slice(0, 8_000) ?? "(no deliverable)"}`;
        })
        .join("\n\n");
      const res = await this.withSlot(() =>
        this.deps.router.generate({
          tier: "reasoning",
          lane: this.lane,
          system: `${this.overseerSystem()}
Write the final deliverable for the owner from the crew's work below. Start with a three-line
summary, then the result itself (keep rankings, tables and specifics), then "Next steps".
Markdown. Do not invent facts that are not in the crew's work.`,
          prompt: `Objective: ${objective.text}\n\n${parts}`,
          maxTokens: 3_000,
          purpose: `synthesize ${objective.id}`,
        }),
      );
      const content = res.text.trim() || parts;
      const meta = this.saveArtifact({
        kind: "deliverable",
        title: `${objective.id}: ${firstSentence(objective.text, 60)}`,
        content,
        taskId: null,
        objectiveId: objective.id,
        createdBy: warden.id,
      });
      const approval = this.newApproval({
        kind: "deliverable",
        title: `Objective done: ${firstSentence(objective.text, 70)}`,
        summary: firstSentence(content.replace(/^#.*$/gm, ""), 220),
        requestedBy: warden.id,
        objectiveId: objective.id,
        taskId: null,
        artifactId: meta.id,
        action: null,
      });
      this.saveObjective({ ...objective, status: "awaiting_owner", artifactId: meta.id });
      this.say(warden.id, `${objective.id} is ready for you at the Owner's Desk.`);
      this.deps.world.mutate((s) =>
        s.command(warden.id, {
          kind: "await",
          status: `Waiting for your decision on ${approval.id}`,
        }),
      );
      this.hold(warden.id, 120_000);
    } catch (err) {
      this.log(`synthesize ${objective.id} failed: ${String(err)}`);
      this.release(warden.id);
    } finally {
      this.busy.delete(objective.id);
    }
  }

  private reviseObjective(objective: Objective, note: string): void {
    const first = objective.taskIds.map((t) => this.deps.world.sim.task(t)).find((t) => !!t);
    const author = first ? this.crew(first.assignee) : undefined;
    const role = (author?.role ?? "researcher") as CrewRole;
    const task = this.newTask(objective.id, {
      title: `Revise: ${firstSentence(objective.text, 60)}`,
      role: PLANNABLE_ROLES.includes(role as (typeof PLANNABLE_ROLES)[number])
        ? role
        : "researcher",
      brief: `The owner sent the result back with this note: "${note}". Address it and deliver an improved, complete result for the objective: ${objective.text}`,
    });
    this.saveObjective({
      ...objective,
      status: "active",
      taskIds: [...objective.taskIds, task.id],
      artifactId: null,
      note,
    });
    this.overseerSay("Understood. Revising.");
  }

  // -- Overseer helpers ----------------------------------------------------------------------

  private async askOverseer(asker: CrewMember, question: string): Promise<string> {
    const warden = this.overseer();
    if (warden) this.say(warden.id, `${asker.name} asks: ${firstSentence(question, 40)}`);
    try {
      const res = await this.deps.router.generate({
        tier: "fast",
        lane: this.lane,
        system: `${this.overseerSystem()}\nAnswer a crew member's question in at most four sentences.`,
        prompt: `${asker.name} (${asker.role}) asks: ${question}`,
        maxTokens: 600,
        purpose: "ask overseer",
      });
      return res.text.trim() || "Use your best judgement and note your assumptions.";
    } catch {
      return "WARDEN is unavailable. Use your best judgement and note your assumptions.";
    }
  }

  private escalate(
    task: Task | null,
    agent: CrewMember,
    reason: string,
    objectiveId: string | null,
  ): void {
    this.newApproval({
      kind: "escalation",
      title: task ? `${agent.name} is stuck on ${task.id}` : `${agent.name} needs help`,
      summary: reason.slice(0, 600),
      requestedBy: agent.id,
      objectiveId,
      taskId: task?.id ?? null,
      artifactId: null,
      action: null,
    });
  }

  private requestAction(
    task: Task,
    agent: CrewMember,
    tool: string,
    input: unknown,
    summary: string,
  ): string {
    const approval = this.newApproval({
      kind: "action",
      title: `${agent.name} wants to run ${tool}`,
      summary,
      requestedBy: agent.id,
      objectiveId: task.objectiveId ?? null,
      taskId: task.id,
      artifactId: null,
      action: { tool, input },
    });
    return approval.id;
  }

  private async runApprovedAction(approval: Approval): Promise<void> {
    if (!approval.action) return;
    const key = `action.${approval.id}`;
    if (this.deps.store.getKv(key)) return; // Already ran: idempotent by approval id.
    const def = this.deps.tools.get(approval.action.tool);
    const task = approval.taskId ? this.deps.world.sim.task(approval.taskId) : undefined;
    const agent = this.crew(approval.requestedBy);
    if (!def || !task || !agent) return;
    this.deps.store.setKv(key, "running");
    const result = await def.run(approval.action.input, {
      agent,
      task,
      objective: task.objectiveId ? this.deps.store.objective(task.objectiveId) : null,
      lane: this.lane,
      store: this.deps.store,
      web: this.deps.web,
      now: () => this.now(),
      say: (t) => this.say(agent.id, t),
      embed: async () => null,
      askOverseer: (q) => this.askOverseer(agent, q),
      createSubtask: (spec) => this.createSubtask(task, spec),
      submit: () => {},
      escalate: (reason) => this.escalate(task, agent, reason, task.objectiveId ?? null),
      idempotencyKey: approval.id,
    });
    this.deps.store.setKv(key, "done");
    this.deps.store.addNote(
      task.id,
      agent.id,
      `Approved ${approval.action.tool}: ${result.slice(0, 500)}`,
    );
  }

  // -- Records and events -----------------------------------------------------------------------

  private now(): number {
    return this.deps.world.sim.now;
  }

  private crew(id: string): CrewMember | undefined {
    return this.deps.world.sim.crew.find((c) => c.id === id);
  }

  private overseer(): CrewMember | undefined {
    return this.deps.world.sim.crew.find((c) => c.role === "overseer");
  }

  private overseerSystem(): string {
    const warden = this.overseer();
    const role = this.deps.roles.get("overseer");
    return role && warden ? systemPrompt(role, warden) : "You are WARDEN, the station's Overseer.";
  }

  private updateTask(task: Task): void {
    this.deps.world.mutate((s) => s.upsertTask(task));
  }

  private saveObjective(o: Objective): void {
    const updated = { ...o, updatedAt: this.now() };
    this.deps.store.saveObjective(updated);
    this.deps.world.mutate((s) =>
      s.publish({ type: "objective.updated", t: s.now, objective: updated }),
    );
  }

  /** File an item at the Owner's Desk for another part of the station (factories). */
  fileDeskItem(
    fields: Omit<Approval, "id" | "status" | "createdAt" | "decidedAt" | "note">,
  ): Approval {
    return this.newApproval(fields);
  }

  /** Run `hook` after every owner decision (factories react to their own Desk items). */
  onDecision(hook: (approval: Approval) => void | Promise<void>): void {
    this.decisionHooks.push(hook);
  }

  private newApproval(
    fields: Omit<Approval, "id" | "status" | "createdAt" | "decidedAt" | "note">,
  ): Approval {
    const approval: Approval = {
      ...fields,
      id: this.deps.store.nextId("A"),
      status: "pending",
      createdAt: this.now(),
      decidedAt: null,
      note: null,
    };
    this.saveApproval(approval);
    return approval;
  }

  private saveApproval(a: Approval): void {
    this.deps.store.saveApproval(a);
    this.deps.world.mutate((s) => s.publish({ type: "approval.updated", t: s.now, approval: a }));
  }

  private saveArtifact(fields: {
    kind: string;
    title: string;
    content: string;
    taskId: string | null;
    objectiveId: string | null;
    createdBy: string;
  }): ArtifactMeta {
    const meta: ArtifactMeta = {
      id: this.deps.store.nextId("F"),
      kind: fields.kind,
      title: fields.title.slice(0, 140),
      mime: "text/markdown",
      taskId: fields.taskId,
      objectiveId: fields.objectiveId,
      createdBy: fields.createdBy,
      createdAt: this.now(),
      size: fields.content.length,
    };
    this.deps.store.saveArtifact(meta, fields.content);
    this.deps.world.mutate((s) =>
      s.publish({ type: "artifact.created", t: s.now, artifact: meta }),
    );
    return meta;
  }

  private say(id: string, text: string): void {
    this.deps.world.mutate((s) => s.sayNow(id, text));
  }

  private overseerSay(text: string): void {
    const warden = this.overseer();
    if (warden) this.say(warden.id, text);
  }

  // -- Avatars -----------------------------------------------------------------------------------

  /** Keep a crew member under the runtime's control for a while (sim ms from now). */
  private hold(id: string, forMs = Number.POSITIVE_INFINITY, untilArrived = false): void {
    this.deps.world.mutate((s) => {
      if (!s.isControlled(id)) s.control(id, true);
    });
    this.holds.set(id, { agentId: id, until: this.now() + forMs, untilArrived });
  }

  /** Hand a crew member back to autopilot, now or after a short pause (sim ms). */
  private release(id: string, afterMs = 0): void {
    if (afterMs > 0) {
      this.holds.set(id, { agentId: id, until: this.now() + afterMs });
      return;
    }
    this.holds.delete(id);
    if (this.busy.has(`agent:${id}`)) return;
    this.deps.world.mutate((s) => {
      if (s.isControlled(id)) s.control(id, false);
    });
  }

  private upkeepHolds(): void {
    const now = this.now();
    for (const hold of [...this.holds.values()]) {
      if (this.busy.has(`agent:${hold.agentId}`)) continue;
      let done = now >= hold.until;
      if (hold.untilArrived) {
        const s = this.deps.world.sim.agentState(hold.agentId);
        if (s.activity === "deliver" && s.carrying === null) {
          hold.untilArrived = false;
          hold.until = Math.min(hold.until, now + 2_500);
        }
      }
      // Whoever waits at the Owner's Desk stays there while a decision is pending.
      const awaiting = this.deps.world.sim.agentState(hold.agentId).activity === "await";
      if (awaiting && this.deps.store.openObjectives().some((o) => o.status === "awaiting_owner"))
        done = false;
      if (done) this.release(hold.agentId);
    }
  }

  private async withSlot<T>(fn: () => Promise<T>): Promise<T> {
    while (this.inFlight >= (this.deps.maxConcurrent ?? 2) + 1) {
      await (this.deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms))))(200);
    }
    this.inFlight += 1;
    try {
      return await fn();
    } finally {
      this.inFlight -= 1;
    }
  }
}
