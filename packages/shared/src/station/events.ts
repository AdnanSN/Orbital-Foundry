import { z } from "zod";
import { crewMemberSchema } from "./crew";
import { directionSchema, tileSchema } from "./geometry";

/**
 * Station events (ROADMAP §8). Today the client's mock director emits them; from Stage 3 the
 * server sends the same shapes over WebSocket: a `snapshot` when a client connects, then
 * incremental events. Every event carries a sequence number and a time in milliseconds on the
 * simulation clock. The remaining §8 messages (artifact.created, approval.requested,
 * ledger.entry, alert) join this union in the stages that produce them.
 */

/** What a crew member is doing. Walking is not an activity: it comes from `agent.moved`. */
export const ACTIVITIES = [
  /** No task. WARDEN nudges crew who stay idle too long. */
  "idle",
  /** Working at a station: on screen, typing at a terminal. Later, a real LLM or tool call. */
  "work",
  /** Lens reviewing a deliverable at the QA Bay. */
  "review",
  /** Taking a finished deliverable somewhere (QA Bay, Bridge). */
  "deliver",
  /** A break in the café. Stands for a provider rate limit or back-off. */
  "coffee",
  /** WARDEN walking the station. */
  "patrol",
  /** WARDEN talking an idle crew member back to work. */
  "nudge",
  /** Stuck: a task failed or needs help (a red alert light on screen). */
  "blocked",
  /** Waiting at the Owner's Desk for the owner's approval (a ❗ on screen). */
  "await",
] as const;
export const activitySchema = z.enum(ACTIVITIES);
export type Activity = z.infer<typeof activitySchema>;

export const CARRY_ITEMS = ["crate", "datapad", "cup"] as const;
export const carryItemSchema = z.enum(CARRY_ITEMS);
export type CarryItem = z.infer<typeof carryItemSchema>;

export const agentStateSchema = z.object({
  id: z.string(),
  tile: tileSchema,
  facing: directionSchema,
  activity: activitySchema,
  carrying: carryItemSchema.nullable(),
  /** The anchor the agent is at or heading to, if any. */
  anchor: z.string().nullable(),
  taskId: z.string().nullable(),
  /** One-line status, e.g. "Prompting 6 label variants". Shown in the inspector. */
  status: z.string().nullable(),
  /** When the current activity started (sim ms). */
  since: z.number(),
});
export type AgentState = z.infer<typeof agentStateSchema>;

/** Task lifecycle from ROADMAP §6. */
export const TASK_STATUSES = [
  "assigned",
  "in_progress",
  "review",
  "rework",
  "awaiting_approval",
  "done",
  "failed",
] as const;
export const taskStatusSchema = z.enum(TASK_STATUSES);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

export const taskSchema = z.object({
  id: z.string(),
  title: z.string(),
  room: z.string(),
  assignee: z.string(),
  status: taskStatusSchema,
  /** How many times QA sent it back. */
  reworks: z.number().int().nonnegative(),
  createdAt: z.number(),
  updatedAt: z.number(),
  /** Ambient work invented by the sim engine, not real work. Real tasks leave this unset. */
  mock: z.boolean().optional(),
  /** The objective this task serves (real tasks). */
  objectiveId: z.string().nullable().optional(),
  /** What the Overseer asked for. */
  brief: z.string().optional(),
  /** The deliverable, once submitted. */
  artifactId: z.string().nullable().optional(),
  /** The reviewer's feedback on the last review. */
  feedback: z.string().nullable().optional(),
});
export type Task = z.infer<typeof taskSchema>;

/** Objectives: what the owner asks the station for (ROADMAP §6). */
export const OBJECTIVE_STATUSES = [
  "planning",
  "active",
  "awaiting_owner",
  "done",
  "failed",
  "cancelled",
] as const;
export const objectiveSchema = z.object({
  id: z.string(),
  text: z.string(),
  status: z.enum(OBJECTIVE_STATUSES),
  /** Task ids, in plan order. */
  taskIds: z.array(z.string()),
  /** The Overseer's summary deliverable, once written. */
  artifactId: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  note: z.string().nullable(),
});
export type Objective = z.infer<typeof objectiveSchema>;

/** Items waiting at the Owner's Desk: approvals for external actions, deliverables, escalations. */
export const APPROVAL_KINDS = ["action", "deliverable", "escalation"] as const;
export const APPROVAL_STATUSES = ["pending", "approved", "rejected"] as const;
export const approvalSchema = z.object({
  id: z.string(),
  kind: z.enum(APPROVAL_KINDS),
  status: z.enum(APPROVAL_STATUSES),
  title: z.string(),
  summary: z.string(),
  requestedBy: z.string(),
  objectiveId: z.string().nullable(),
  taskId: z.string().nullable(),
  artifactId: z.string().nullable(),
  /** For actions: the tool and its arguments, run only after approval. */
  action: z.object({ tool: z.string(), input: z.unknown() }).nullable(),
  createdAt: z.number(),
  decidedAt: z.number().nullable(),
  note: z.string().nullable(),
});
export type Approval = z.infer<typeof approvalSchema>;

/** A deliverable's metadata. Content is fetched separately (GET /api/artifacts/:id). */
export const artifactMetaSchema = z.object({
  id: z.string(),
  kind: z.string(),
  title: z.string(),
  mime: z.string(),
  taskId: z.string().nullable(),
  objectiveId: z.string().nullable(),
  createdBy: z.string(),
  createdAt: z.number(),
  /** Bytes, for files; characters, for text. */
  size: z.number().int().nonnegative(),
});
export type ArtifactMeta = z.infer<typeof artifactMetaSchema>;

export const PROVIDER_STATES = ["ok", "limited", "down"] as const;
export const providerStateSchema = z.object({
  provider: z.string(),
  state: z.enum(PROVIDER_STATES),
  /** When a limit or outage is expected to clear (sim ms). */
  until: z.number().nullable(),
  note: z.string().nullable(),
});
export type ProviderState = z.infer<typeof providerStateSchema>;

/** Whether the sim clock runs, and how fast (1 = real time). */
export const simStatusSchema = z.object({
  paused: z.boolean(),
  speed: z.number().positive(),
});
export type SimStatus = z.infer<typeof simStatusSchema>;

const base = { seq: z.number().int().nonnegative(), t: z.number() };

export const snapshotEventSchema = z.object({
  ...base,
  type: z.literal("snapshot"),
  /** Who is aboard: names, roles, rooms and looks. */
  crew: z.array(crewMemberSchema),
  agents: z.array(agentStateSchema),
  tasks: z.array(taskSchema),
  providers: z.array(providerStateSchema),
  sim: simStatusSchema,
  /** Real work (Stage 4): recent objectives, open approvals and recent deliverables. */
  objectives: z.array(objectiveSchema).optional(),
  approvals: z.array(approvalSchema).optional(),
  artifacts: z.array(artifactMetaSchema).optional(),
});

export const agentSpawnedEventSchema = z.object({
  ...base,
  type: z.literal("agent.spawned"),
  crew: crewMemberSchema,
  agent: agentStateSchema,
});

/** A crew member's definition changed, e.g. they were reassigned to another room. */
export const crewUpdatedEventSchema = z.object({
  ...base,
  type: z.literal("crew.updated"),
  crew: crewMemberSchema,
});

/** The sim clock was paused, resumed or sped up. */
export const simStatusEventSchema = z.object({
  ...base,
  type: z.literal("sim.status"),
  status: simStatusSchema,
});

/** The agent walks from `from` to `to`, starting at `t0`; clients path-find the route themselves. */
export const agentMovedEventSchema = z.object({
  ...base,
  type: z.literal("agent.moved"),
  id: z.string(),
  from: tileSchema,
  to: tileSchema,
  t0: z.number(),
});

/** A change to what the agent is doing. Fields left out keep their current value. */
export const agentActivityEventSchema = z.object({
  ...base,
  type: z.literal("agent.activity"),
  id: z.string(),
  activity: activitySchema,
  facing: directionSchema.optional(),
  carrying: carryItemSchema.nullable().optional(),
  anchor: z.string().nullable().optional(),
  taskId: z.string().nullable().optional(),
  status: z.string().nullable().optional(),
});

/** A speech bubble. */
export const agentSayEventSchema = z.object({
  ...base,
  type: z.literal("agent.say"),
  id: z.string(),
  text: z.string().min(1).max(80),
  /** How long the bubble stays up (sim ms). */
  ttl: z.number().positive(),
});

export const taskUpdatedEventSchema = z.object({
  ...base,
  type: z.literal("task.updated"),
  task: taskSchema,
});

export const providerStatusEventSchema = z.object({
  ...base,
  type: z.literal("provider.status"),
  status: providerStateSchema,
});

export const objectiveUpdatedEventSchema = z.object({
  ...base,
  type: z.literal("objective.updated"),
  objective: objectiveSchema,
});

export const approvalUpdatedEventSchema = z.object({
  ...base,
  type: z.literal("approval.updated"),
  approval: approvalSchema,
});

export const artifactCreatedEventSchema = z.object({
  ...base,
  type: z.literal("artifact.created"),
  artifact: artifactMetaSchema,
});

export const stationEventSchema = z.discriminatedUnion("type", [
  snapshotEventSchema,
  agentSpawnedEventSchema,
  agentMovedEventSchema,
  agentActivityEventSchema,
  agentSayEventSchema,
  taskUpdatedEventSchema,
  providerStatusEventSchema,
  crewUpdatedEventSchema,
  simStatusEventSchema,
  objectiveUpdatedEventSchema,
  approvalUpdatedEventSchema,
  artifactCreatedEventSchema,
]);
export type StationEvent = z.infer<typeof stationEventSchema>;
export type StationEventType = StationEvent["type"];
export type StationEventOf<T extends StationEventType> = Extract<StationEvent, { type: T }>;

/** An event before the source stamps its sequence number. */
export type UnsequencedEvent = StationEvent extends infer E
  ? E extends StationEvent
    ? Omit<E, "seq">
    : never
  : never;
