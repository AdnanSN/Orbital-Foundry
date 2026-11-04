import type { Activity, TaskStatus } from "@orbital/shared";

/** Station time: the mock day starts at 08:00. */
export function stationTime(simMs: number): string {
  const total = Math.floor(simMs / 1000) + 8 * 3600;
  const day = Math.floor(total / 86_400) + 1;
  const h = Math.floor((total % 86_400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `Day ${day} · ${pad(h)}:${pad(m)}:${pad(s)}`;
}

export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${String(s % 60).padStart(2, "0")}s`;
}

export const ACTIVITY_LABEL: Record<Activity, string> = {
  idle: "Idle",
  work: "Working",
  review: "Reviewing",
  deliver: "Delivering",
  coffee: "Coffee break",
  patrol: "Patrolling",
  nudge: "Nudging",
};

export const ACTIVITY_COLOR: Record<Activity, string> = {
  idle: "#9d98c4",
  work: "#5ff2ff",
  review: "#8affc1",
  deliver: "#ff9f43",
  coffee: "#ffcf8a",
  patrol: "#ffd166",
  nudge: "#ff5f6d",
};

export const STATUS_LABEL: Record<TaskStatus, string> = {
  assigned: "assigned",
  in_progress: "in progress",
  review: "in QA",
  rework: "rework",
  awaiting_approval: "awaiting approval",
  done: "done",
  failed: "failed",
};

export const STATUS_COLOR: Record<TaskStatus, string> = {
  assigned: "#9d98c4",
  in_progress: "#5ff2ff",
  review: "#8affc1",
  rework: "#ff9f43",
  awaiting_approval: "#ffd166",
  done: "#69e08a",
  failed: "#ff5f6d",
};
