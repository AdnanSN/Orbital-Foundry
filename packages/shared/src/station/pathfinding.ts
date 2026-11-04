import type { Direction, Tile } from "./geometry";
import type { WalkGrid } from "./map";

/**
 * Deterministic grid pathfinding shared by the simulation and the client (ROADMAP §8: the server
 * owns logical positions; clients run the same pathfinding and animate locally).
 *
 * A* on a 4-connected grid. Every step costs 1, and changing direction costs `turnCost` more, so
 * among paths of equal length the one with the fewest turns wins. That keeps walks looking
 * deliberate (straight down a corridor, one turn into a room) instead of zig-zagging. Ties are broken
 * by a fixed rule, so the same grid always yields the same path on every machine.
 */

/** Crew walking speed in tiles per simulated second. */
export const WALK_SPEED = 3.2;
export const DEFAULT_TURN_COST = 0.2;

export interface PathOptions {
  /** Extra cost for each change of direction. Defaults to DEFAULT_TURN_COST. */
  turnCost?: number;
}

// Direction index: 0 up, 1 right, 2 down, 3 left. 4 means "no direction yet" (the start).
const DX = [0, 1, 0, -1] as const;
const DY = [-1, 0, 1, 0] as const;
const DIRS = 5;

/** Returns the tiles from `from` to `to` inclusive, or null when there is no route. */
export function findPath(
  grid: WalkGrid,
  from: Tile,
  to: Tile,
  options: PathOptions = {},
): Tile[] | null {
  const { width, height } = grid;
  const inside = (t: Tile) => t.x >= 0 && t.y >= 0 && t.x < width && t.y < height;
  if (!inside(from) || !inside(to)) return null;
  if (!grid.isWalkable(from.x, from.y) || !grid.isWalkable(to.x, to.y)) return null;
  if (from.x === to.x && from.y === to.y) return [{ x: from.x, y: from.y }];

  const turnCost = options.turnCost ?? DEFAULT_TURN_COST;
  const count = width * height * DIRS;
  const g = new Float64Array(count).fill(Number.POSITIVE_INFINITY);
  const parent = new Int32Array(count).fill(-1);
  const closed = new Uint8Array(count);
  const heap = new StateHeap();
  const h = (x: number, y: number) => Math.abs(x - to.x) + Math.abs(y - to.y);

  const start = (from.y * width + from.x) * DIRS + 4;
  g[start] = 0;
  heap.push(start, h(from.x, from.y), h(from.x, from.y));

  while (heap.size > 0) {
    const s = heap.pop();
    if (closed[s]) continue;
    closed[s] = 1;
    const cell = Math.floor(s / DIRS);
    const dir = s % DIRS;
    const x = cell % width;
    const y = Math.floor(cell / width);
    if (x === to.x && y === to.y) return rebuild(parent, s, width);

    const gs = g[s] ?? Number.POSITIVE_INFINITY;
    for (let d = 0; d < 4; d++) {
      const nx = x + (DX[d] ?? 0);
      const ny = y + (DY[d] ?? 0);
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      if (!grid.isWalkable(nx, ny)) continue;
      const ns = (ny * width + nx) * DIRS + d;
      if (closed[ns]) continue;
      const cost = gs + 1 + (dir !== 4 && dir !== d ? turnCost : 0);
      if (cost < (g[ns] ?? Number.POSITIVE_INFINITY)) {
        g[ns] = cost;
        parent[ns] = s;
        const hn = h(nx, ny);
        heap.push(ns, cost + hn, hn);
      }
    }
  }
  return null;
}

function rebuild(parent: Int32Array, end: number, width: number): Tile[] {
  const out: Tile[] = [];
  for (let s = end; s !== -1; s = parent[s] ?? -1) {
    const cell = Math.floor(s / DIRS);
    out.push({ x: cell % width, y: Math.floor(cell / width) });
  }
  return out.reverse();
}

/** How long walking a path takes, in milliseconds. */
export function pathDurationMs(path: readonly Tile[], speed = WALK_SPEED): number {
  return path.length <= 1 ? 0 : ((path.length - 1) / speed) * 1000;
}

export interface PathSample {
  /** Position in tile units; fractional while between tiles. */
  x: number;
  y: number;
  /** The direction of travel, or null for a one-tile path. */
  facing: Direction | null;
  /** True once the walker has reached the last tile. */
  done: boolean;
}

/** Where a walker that started at the first tile `elapsedMs` ago is now. */
export function samplePath(
  path: readonly Tile[],
  elapsedMs: number,
  speed = WALK_SPEED,
): PathSample {
  const first = path[0];
  if (!first) throw new Error("samplePath needs at least one tile");
  const last = path[path.length - 1] ?? first;
  if (path.length === 1) return { x: first.x, y: first.y, facing: null, done: true };

  const travelled = (Math.max(0, elapsedMs) / 1000) * speed;
  const segments = path.length - 1;
  if (travelled >= segments) {
    const before = path[path.length - 2] ?? first;
    return { x: last.x, y: last.y, facing: stepDirection(before, last), done: true };
  }
  const i = Math.floor(travelled);
  const f = travelled - i;
  const a = path[i] ?? first;
  const b = path[i + 1] ?? last;
  return {
    x: a.x + (b.x - a.x) * f,
    y: a.y + (b.y - a.y) * f,
    facing: stepDirection(a, b),
    done: false,
  };
}

function stepDirection(a: Tile, b: Tile): Direction {
  if (b.x > a.x) return "right";
  if (b.x < a.x) return "left";
  if (b.y > a.y) return "down";
  return "up";
}

/**
 * A small binary min-heap of A* states. Orders by f, then by h (closer to the goal first), then by
 * insertion order, which makes the search fully deterministic.
 */
class StateHeap {
  private items: number[] = [];
  private f: number[] = [];
  private h: number[] = [];
  private order: number[] = [];
  private counter = 0;

  get size(): number {
    return this.items.length;
  }

  push(state: number, f: number, h: number): void {
    this.items.push(state);
    this.f.push(f);
    this.h.push(h);
    this.order.push(this.counter++);
    this.up(this.items.length - 1);
  }

  pop(): number {
    const top = this.items[0] as number;
    const last = this.items.length - 1;
    this.swap(0, last);
    this.items.pop();
    this.f.pop();
    this.h.pop();
    this.order.pop();
    if (this.items.length > 0) this.down(0);
    return top;
  }

  private less(i: number, j: number): boolean {
    const fi = this.f[i] as number;
    const fj = this.f[j] as number;
    if (fi !== fj) return fi < fj;
    const hi = this.h[i] as number;
    const hj = this.h[j] as number;
    if (hi !== hj) return hi < hj;
    return (this.order[i] as number) < (this.order[j] as number);
  }

  private swap(i: number, j: number): void {
    for (const arr of [this.items, this.f, this.h, this.order]) {
      const t = arr[i] as number;
      arr[i] = arr[j] as number;
      arr[j] = t;
    }
  }

  private up(i: number): void {
    let c = i;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (!this.less(c, p)) break;
      this.swap(c, p);
      c = p;
    }
  }

  private down(i: number): void {
    const n = this.items.length;
    let c = i;
    for (;;) {
      const l = 2 * c + 1;
      const r = l + 1;
      let m = c;
      if (l < n && this.less(l, m)) m = l;
      if (r < n && this.less(r, m)) m = r;
      if (m === c) break;
      this.swap(c, m);
      c = m;
    }
  }
}
