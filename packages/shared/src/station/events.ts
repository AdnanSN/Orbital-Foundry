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
});
export type Task = z.infer<typeof taskSchema>;

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
