import type { CrewMember, CrewRole, Lane, Objective, Task } from "@orbital/shared";
import { parseModelRef } from "@orbital/shared";
import { NoCandidateError, RouterError } from "../llm/errors";
import type { ProviderGate } from "../llm/rateLimiter";
import type { ModelRouter } from "../llm/router";
import type { ChatMessage, ToolCall } from "../llm/transport";
import type { SimServer } from "../sim/simServer";
import { type RoleConfig, systemPrompt } from "./roles";
import type { WorkStore } from "./store";
import { parseToolArgs, type ToolContext, type ToolRegistry, toolSpec } from "./tools";
import type { WebClient } from "./web";

/**
 * The agent work loop (ROADMAP §6): load the task, then call the model with the role's tools for
 * at most `maxSteps` steps until it submits a deliverable. The crew member's avatar follows along:
 * it types while a call runs, walks to the café while a provider makes it wait, and says each
 * step's status line in a speech bubble.
 */

export interface RuntimeDeps {
  router: ModelRouter;
  store: WorkStore;
  world: SimServer;
  roles: Map<CrewRole, RoleConfig>;
  tools: ToolRegistry;
  web: WebClient;
  lane: Lane;
  gates?: Map<string, ProviderGate>;
  /** Waits longer than this send the avatar to the café first. */
  cafeAfterMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface RuntimeHooks {
  askOverseer(asker: CrewMember, question: string): Promise<string>;
  createSubtask(parent: Task, spec: { title: string; role: CrewRole; brief: string }): Task;
  /** Deliverables of earlier tasks in the same objective (markdown), or an empty string. */
  earlierWork?(task: Task): string;
  requestApproval(
    task: Task,
    agent: CrewMember,
    tool: string,
    input: unknown,
    summary: string,
  ): string;
}

export type RunOutcome =
  | { kind: "submitted"; title: string; content: string; steps: number }
  | { kind: "escalated"; reason: string }
  | { kind: "failed"; error: string };

const RUNTIME_RULES = `
How you work on this station:
- Use your tools. Every tool result comes back to you; continue until the work is done.
- Keep each reply short: one line about what you are doing next, then the tool call.
- When the deliverable is complete, call submit_for_review with the whole result in markdown.
- If you are truly blocked, call escalate with the reason.`;

export function firstSentence(text: string, max = 70): string {
  const clean = text
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/[#*_`>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const sentence = clean.split(/(?<=[.!?])\s/)[0] ?? clean;
  return sentence.length > max ? `${sentence.slice(0, max - 1)}…` : sentence;
}

const FINAL_TOOLS = new Set(["submit_for_review", "escalate"]);

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n…(truncated)` : text;
}

export class AgentRuntime {
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly deps: RuntimeDeps,
    private readonly hooks: RuntimeHooks,
  ) {
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async run(task: Task): Promise<RunOutcome> {
    const { world, store, roles, lane } = this.deps;
    const agent = world.sim.crew.find((c) => c.id === task.assignee);
    if (!agent) return { kind: "failed", error: `No crew member "${task.assignee}"` };
    const role = roles.get(agent.role);
    if (!role) return { kind: "failed", error: `No role template for "${agent.role}"` };
    const objective = task.objectiveId ? store.objective(task.objectiveId) : null;
    const tools = this.deps.tools.forRole(role.tools, lane);

    world.mutate((s) => {
      if (!s.isControlled(agent.id)) s.control(agent.id, true);
      s.command(agent.id, { kind: "work", status: task.title, taskId: task.id });
      s.upsertTask({ ...task, status: "in_progress" });
    });

    let submitted = null as { title: string; content: string } | null;
    let escalated = null as string | null;
    const ctx: ToolContext = {
      agent,
      task,
      objective,
      lane,
      store,
      web: this.deps.web,
      now: () => world.sim.now,
      say: (text) => this.say(agent.id, text),
      embed: (texts) => this.embed(texts),
      askOverseer: (q) => this.hooks.askOverseer(agent, q),
      createSubtask: (spec) => this.hooks.createSubtask(task, spec),
      submit: (title, content) => {
        submitted = { title, content };
      },
      escalate: (reason) => {
        escalated = reason;
      },
    };

    const messages: ChatMessage[] = [
      { role: "system", content: `${systemPrompt(role, agent)}\n${RUNTIME_RULES}` },
      { role: "user", content: this.brief(task, objective, agent) },
    ];
    const specs = tools.map(toolSpec);
    // The last step offers only the ways out, so a run always ends with a deliverable or a reason.
    const finalSpecs = specs.filter((t) => FINAL_TOOLS.has(t.name));
    const seen = new Map<string, number>();
    let failures = 0;
    let steps = 0;
    for (; steps < role.maxSteps && !submitted && !escalated; steps++) {
      await this.waitForProvider(agent, task, role);
      const last = steps === role.maxSteps - 1;
      if (last) {
        messages.push({
          role: "user",
          content:
            "This is your last step. Call submit_for_review now with your best complete deliverable.",
        });
      }
      let res: Awaited<ReturnType<ModelRouter["generate"]>>;
      try {
        res = await this.deps.router.generate({
          tier: role.tier,
          lane,
          messages,
          tools: last && finalSpecs.length > 0 ? finalSpecs : specs,
          maxTokens: 2_500,
          purpose: `${task.id} ${agent.id} step ${steps + 1}`,
        });
      } catch (err) {
        failures += 1;
        const message = err instanceof Error ? err.message : String(err);
        if (err instanceof NoCandidateError || failures >= 2)
          return { kind: "failed", error: message };
        if (err instanceof RouterError) {
          // Every model was busy or failing: back off once, then try again.
          await this.backOff(agent, task, 20_000);
        }
        steps -= 1;
        continue;
      }
      const line = firstSentence(res.text);
      if (line) this.say(agent.id, line);
      messages.push({ role: "assistant", content: res.text, toolCalls: res.toolCalls });
      if (res.toolCalls.length === 0) {
        if (res.text.trim().length > 300 && steps >= 1) {
          submitted = { title: task.title, content: res.text.trim() };
          break;
        }
        messages.push({
          role: "user",
          content:
            "Continue with a tool call. When the deliverable is complete, call submit_for_review.",
        });
        continue;
      }
      for (const call of res.toolCalls) {
        const key = `${call.name} ${call.arguments.replace(/\s+/g, " ").trim()}`;
        const repeats = seen.get(key) ?? 0;
        seen.set(key, repeats + 1);
        if (repeats > 0 && !FINAL_TOOLS.has(call.name)) {
          messages.push({
            role: "tool",
            toolCallId: call.id,
            content: `You already ran ${call.name} with these arguments; it will not change. Use what you have and move on${repeats > 1 ? ": submit_for_review now" : ""}.`,
          });
          continue;
        }
        const content = await this.runTool(
          call,
          role,
          tools.map((t) => t.name),
          ctx,
          task,
          agent,
        );
        messages.push({ role: "tool", toolCallId: call.id, content: clip(content, 6_000) });
        if (submitted || escalated) break;
      }
    }
    if (escalated) return { kind: "escalated", reason: escalated };
    if (submitted) return { kind: "submitted", ...submitted, steps };
    return { kind: "failed", error: `No deliverable after ${role.maxSteps} steps` };
  }

  private async runTool(
    call: ToolCall,
    role: RoleConfig,
    allowed: string[],
    ctx: ToolContext,
    task: Task,
    agent: CrewMember,
  ): Promise<string> {
    const def = this.deps.tools.get(call.name);
    if (!def || !allowed.includes(call.name)) {
      return `Unknown tool "${call.name}". Available: ${allowed.join(", ")}.`;
    }
    const parsed = parseToolArgs(def, call.arguments);
    if (!parsed.ok) return `Invalid arguments for ${def.name}: ${parsed.error}`;
    if (def.sideEffect === "external" || def.approval === "always") {
      const id = this.hooks.requestApproval(
        task,
        agent,
        def.name,
        parsed.input,
        def.status ? def.status(parsed.input) : `${role.title} wants to run ${def.name}`,
      );
      return `Sent to the owner for approval (${id}). It will run only if approved. Carry on with the rest of the task.`;
    }
    if (def.status) this.say(agent.id, def.status(parsed.input));
    try {
      return await def.run(parsed.input, ctx);
    } catch (err) {
      return `The tool failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  private brief(task: Task, objective: Objective | null, agent: CrewMember): string {
    const earlier = this.hooks.earlierWork?.(task) ?? "";
    const parts = [
      `Task ${task.id}: ${task.title}`,
      task.brief ? `Brief from WARDEN:\n${task.brief}` : "",
      objective ? `This serves the owner's objective: "${objective.text}"` : "",
      task.feedback
        ? `Your last submission was sent back. Reviewer feedback:\n${task.feedback}`
        : "",
      earlier ? `Earlier work on this objective (build on it; do not repeat it):\n${earlier}` : "",
      `You are ${agent.name}. Work in the sandbox lane: nothing you produce is published or sold.`,
    ];
    return parts.filter(Boolean).join("\n\n");
  }

  private say(id: string, text: string): void {
    this.deps.world.mutate((s) => s.sayNow(id, text));
  }

  private async embed(texts: string[]): Promise<number[][] | null> {
    try {
      const out = await this.deps.router.embed({
        lane: this.deps.lane,
        input: texts,
        purpose: "memory",
      });
      return out.vectors;
    } catch {
      return null;
    }
  }

  /** If the provider will make us wait, show it: the crew member walks to the café meanwhile. */
  private async waitForProvider(agent: CrewMember, task: Task, role: RoleConfig): Promise<void> {
    const ref = this.deps.router.plan(role.tier, this.deps.lane).refs[0];
    if (!ref || !this.deps.gates) return;
    const provider = parseModelRef(ref).provider;
    const wait = this.deps.gates.get(provider)?.estimatedWaitMs() ?? 0;
    if (wait < (this.deps.cafeAfterMs ?? 4_000)) return;
    await this.backOff(agent, task, wait, provider);
  }

  private async backOff(
    agent: CrewMember,
    task: Task,
    waitMs: number,
    provider = "a provider",
  ): Promise<void> {
    const { world } = this.deps;
    world.mutate((s) => {
      const until = s.now + waitMs * s.simStatus.speed;
      s.setProviderStatus(provider, "limited", until, `Waiting ${Math.round(waitMs / 1000)} s`);
      s.command(agent.id, { kind: "break", status: `Waiting out a ${provider} rate limit`, until });
    });
    await this.sleep(waitMs);
    world.mutate((s) => {
      s.setProviderStatus(provider, "ok", null, null);
      s.command(agent.id, { kind: "work", status: task.title, taskId: task.id });
    });
  }
}
