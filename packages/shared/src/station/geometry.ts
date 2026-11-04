import { z } from "zod";

/** A grid cell on the station map. x grows to the right, y grows downwards. */
export const tileSchema = z.object({ x: z.number().int(), y: z.number().int() });
export type Tile = z.infer<typeof tileSchema>;

export const DIRECTIONS = ["up", "down", "left", "right"] as const;
export const directionSchema = z.enum(DIRECTIONS);
export type Direction = z.infer<typeof directionSchema>;

export const DIRECTION_STEP: Record<Direction, Tile> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

export function sameTile(a: Tile, b: Tile): boolean {
  return a.x === b.x && a.y === b.y;
}

export function manhattan(a: Tile, b: Tile): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

/**
 * The direction that points from `from` towards `to`. The longer axis wins; a tie goes to the
 * horizontal axis. Returns `fallback` when the tiles are equal.
 */
export function directionTowards(from: Tile, to: Tile, fallback: Direction = "down"): Direction {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (dx === 0 && dy === 0) return fallback;
  if (Math.abs(dx) >= Math.abs(dy)) return dx > 0 ? "right" : "left";
  return dy > 0 ? "down" : "up";
}
