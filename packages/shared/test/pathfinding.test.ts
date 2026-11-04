import { describe, expect, it } from "vitest";
import {
  findPath,
  getStationMap,
  pathDurationMs,
  samplePath,
  type Tile,
  WALK_SPEED,
  type WalkGrid,
} from "../src";

/** "." is walkable; anything else is a wall. */
function grid(rows: string[]): WalkGrid {
  return {
    width: rows[0]?.length ?? 0,
    height: rows.length,
    isWalkable: (x, y) => rows[y]?.[x] === ".",
  };
}

function turns(path: Tile[]): number {
  let count = 0;
  for (let i = 2; i < path.length; i++) {
    const a = path[i - 2] as Tile;
    const b = path[i - 1] as Tile;
    const c = path[i] as Tile;
    if (b.x - a.x !== c.x - b.x || b.y - a.y !== c.y - b.y) count++;
  }
  return count;
}

function expectValidSteps(g: WalkGrid, path: Tile[]): void {
  for (const t of path) expect(g.isWalkable(t.x, t.y)).toBe(true);
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1] as Tile;
    const b = path[i] as Tile;
    expect(Math.abs(a.x - b.x) + Math.abs(a.y - b.y)).toBe(1);
  }
}

describe("findPath", () => {
  it("walks a straight corridor", () => {
    const g = grid(["......"]);
    expect(findPath(g, { x: 0, y: 0 }, { x: 5, y: 0 })).toEqual(
      [0, 1, 2, 3, 4, 5].map((x) => ({ x, y: 0 })),
    );
  });

  it("returns just the start when start and goal are the same", () => {
    const g = grid(["..."]);
    expect(findPath(g, { x: 1, y: 0 }, { x: 1, y: 0 })).toEqual([{ x: 1, y: 0 }]);
  });

  it("routes around furniture and walls", () => {
    const g = grid([
      ".....", //
      ".###.",
      ".#...",
      ".#.#.",
      "...#.",
    ]);
    const path = findPath(g, { x: 2, y: 2 }, { x: 0, y: 4 });
    expect(path).not.toBeNull();
    expectValidSteps(g, path as Tile[]);
    expect(path?.[0]).toEqual({ x: 2, y: 2 });
    expect(path?.at(-1)).toEqual({ x: 0, y: 4 });
    // Down the middle column and left along the bottom: 4 steps.
    expect(path).toHaveLength(5);
  });

  it("finds the shortest route even when it is not the obvious one", () => {
    const g = grid([
      "..........",
      ".########.",
      ".#......#.",
      ".#.####.#.",
      ".#.#..#.#.",
      ".#.#..#.#.",
      ".#.##.#.#.",
      ".#....#.#.",
      ".######.#.",
      "........#.",
    ]);
    const from = { x: 4, y: 4 };
    const to = { x: 9, y: 9 };
    const path = findPath(g, from, to) as Tile[];
    expectValidSteps(g, path);
    // Breadth-first search gives the true shortest length to compare against.
    expect(path.length - 1).toBe(bfsDistance(g, from, to));
  });

  it("returns null when the goal is walled off, unwalkable or outside the grid", () => {
    const g = grid(["..#..", "..#..", "..#.."]);
    expect(findPath(g, { x: 0, y: 0 }, { x: 4, y: 0 })).toBeNull();
    expect(findPath(g, { x: 0, y: 0 }, { x: 2, y: 1 })).toBeNull();
    expect(findPath(g, { x: 0, y: 0 }, { x: 9, y: 9 })).toBeNull();
    expect(findPath(g, { x: 2, y: 0 }, { x: 0, y: 0 })).toBeNull();
  });

  it("prefers the route with the fewest turns among equally short ones", () => {
    const g = grid(["......", "......", "......", "......", "......", "......"]);
    const path = findPath(g, { x: 0, y: 0 }, { x: 5, y: 5 }) as Tile[];
    expect(path).toHaveLength(11);
    expect(turns(path)).toBe(1);
  });

  it("never takes a longer route just to save a turn", () => {
    const g = grid(["......", "......"]);
    const path = findPath(g, { x: 0, y: 0 }, { x: 5, y: 1 }) as Tile[];
    expect(path).toHaveLength(7);
  });

  it("is deterministic", () => {
    const map = getStationMap();
    const a = map.anchor("scout-desk");
    const b = map.anchor("cafe-seat-3");
    const first = findPath(map, a, b);
    for (let i = 0; i < 5; i++) expect(findPath(map, a, b)).toEqual(first);
  });

  it("connects every pair of anchors on the real station", () => {
    const map = getStationMap();
    for (const a of map.anchors) {
      for (const b of map.anchors) {
        if (a.id >= b.id) continue;
        const path = findPath(map, a, b);
        expect(path, `${a.id} -> ${b.id}`).not.toBeNull();
        expect(path?.length).toBeGreaterThan(1);
      }
    }
  });

  it("goes through doors, not walls, between rooms", () => {
    const map = getStationMap();
    const path = findPath(map, map.anchor("wick-desk"), map.anchor("qa-drop-1")) as Tile[];
    expectValidSteps(map, path);
    const kinds = new Set(path.map((t) => map.kindAt(t.x, t.y)));
    expect(kinds.has("door")).toBe(true);
    expect(kinds.has("wall")).toBe(false);
  });
});

describe("samplePath", () => {
  const path: Tile[] = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 2, y: 0 },
    { x: 2, y: 1 },
  ];

  it("interpolates between tiles at walking speed", () => {
    const s = samplePath(path, 500 / WALK_SPEED);
    expect(s.x).toBeCloseTo(0.5);
    expect(s.y).toBe(0);
    expect(s.facing).toBe("right");
    expect(s.done).toBe(false);
  });

  it("faces the direction of the current segment", () => {
    const s = samplePath(path, (2.5 / WALK_SPEED) * 1000);
    expect(s.x).toBe(2);
    expect(s.y).toBeCloseTo(0.5);
    expect(s.facing).toBe("down");
  });

  it("stops at the last tile", () => {
    expect(samplePath(path, 60_000)).toEqual({ x: 2, y: 1, facing: "down", done: true });
  });

  it("matches pathDurationMs", () => {
    const ms = pathDurationMs(path);
    expect(ms).toBeCloseTo((3 / WALK_SPEED) * 1000);
    expect(samplePath(path, ms - 1).done).toBe(false);
    expect(samplePath(path, ms).done).toBe(true);
    expect(pathDurationMs([{ x: 0, y: 0 }])).toBe(0);
  });
});

function bfsDistance(g: WalkGrid, from: Tile, to: Tile): number {
  const dist = new Map<string, number>([[`${from.x},${from.y}`, 0]]);
  const queue: Tile[] = [from];
  const steps = [
    [0, -1],
    [1, 0],
    [0, 1],
    [-1, 0],
  ] as const;
  while (queue.length > 0) {
    const t = queue.shift() as Tile;
    const d = dist.get(`${t.x},${t.y}`) as number;
    if (t.x === to.x && t.y === to.y) return d;
    for (const [dx, dy] of steps) {
      const n = { x: t.x + dx, y: t.y + dy };
      const key = `${n.x},${n.y}`;
      if (n.x < 0 || n.y < 0 || n.x >= g.width || n.y >= g.height) continue;
      if (!g.isWalkable(n.x, n.y) || dist.has(key)) continue;
      dist.set(key, d + 1);
      queue.push(n);
    }
  }
  return -1;
}
