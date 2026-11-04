import { manhattan, type Tile } from "./geometry";
import type { StationMap } from "./map";

/**
 * Checks that go beyond the JSON schema: things a hand edit of station.map.json can break.
 * Returns a list of human-readable problems; an empty list means the layout is sound.
 */
export function layoutProblems(map: StationMap): string[] {
  const problems: string[] = [];

  for (const o of map.objects) {
    for (let y = o.y; y < o.y + o.h; y++) {
      for (let x = o.x; x < o.x + o.w; x++) {
        const kind = map.kindAt(x, y);
        if (o.wall && kind !== "wall" && kind !== "window") {
          problems.push(`wall object "${o.id}" covers ${kind} at ${x},${y}`);
        }
        if (!o.wall && kind !== "floor") {
          problems.push(`object "${o.id}" stands on ${kind} at ${x},${y}`);
        }
        if (!o.wall && map.roomAt(x, y)?.id !== o.room) {
          problems.push(`object "${o.id}" sticks out of room "${o.room}" at ${x},${y}`);
        }
      }
    }
  }

  const occupied = new Map<string, string>();
  for (const o of map.objects) {
    if (o.wall) continue;
    for (let y = o.y; y < o.y + o.h; y++) {
      for (let x = o.x; x < o.x + o.w; x++) {
        const key = `${x},${y}`;
        const other = occupied.get(key);
        if (other) problems.push(`objects "${other}" and "${o.id}" overlap at ${key}`);
        occupied.set(key, o.id);
      }
    }
  }

  const anchorAt = new Map<string, string>();
  for (const a of map.anchors) {
    const key = `${a.x},${a.y}`;
    if (!map.isWalkable(a.x, a.y)) problems.push(`anchor "${a.id}" is not on a walkable tile`);
    if (map.roomAt(a.x, a.y)?.id !== a.room) {
      problems.push(`anchor "${a.id}" is not inside room "${a.room}"`);
    }
    const other = anchorAt.get(key);
    if (other) problems.push(`anchors "${other}" and "${a.id}" share tile ${key}`);
    anchorAt.set(key, a.id);
    if (a.object) {
      const o = map.object(a.object);
      if (distanceToRect({ x: a.x, y: a.y }, o) > 1) {
        problems.push(`anchor "${a.id}" is not next to its object "${a.object}"`);
      }
    }
  }

  // Every walkable tile must belong to one connected network, so any anchor can reach any other.
  const first = map.anchors[0];
  if (first) {
    const reached = flood(map, { x: first.x, y: first.y });
    for (const a of map.anchors) {
      if (!reached.has(`${a.x},${a.y}`)) problems.push(`anchor "${a.id}" cannot be reached`);
    }
    for (let y = 0; y < map.height; y++) {
      for (let x = 0; x < map.width; x++) {
        if (map.isWalkable(x, y) && !reached.has(`${x},${y}`)) {
          problems.push(`walkable tile ${x},${y} is cut off from the station`);
        }
      }
    }
  }

  for (const door of map.doorways()) {
    // A doorway joins two different spaces: two rooms, or a room and a corridor.
    const sides =
      door.orientation === "horizontal"
        ? [
            { x: door.x, y: door.y - 1 },
            { x: door.x, y: door.y + door.h },
          ]
        : [
            { x: door.x - 1, y: door.y },
            { x: door.x + door.w, y: door.y },
          ];
    for (const s of sides) {
      if (!map.isWalkable(s.x, s.y)) {
        problems.push(`doorway at ${door.x},${door.y} is blocked on the side at ${s.x},${s.y}`);
      }
    }
  }

  return problems;
}

function distanceToRect(t: Tile, r: { x: number; y: number; w: number; h: number }): number {
  const cx = Math.min(Math.max(t.x, r.x), r.x + r.w - 1);
  const cy = Math.min(Math.max(t.y, r.y), r.y + r.h - 1);
  return manhattan(t, { x: cx, y: cy });
}

function flood(map: StationMap, start: Tile): Set<string> {
  const seen = new Set<string>([`${start.x},${start.y}`]);
  const queue: Tile[] = [start];
  while (queue.length > 0) {
    const t = queue.shift() as Tile;
    for (const n of map.walkableNeighbours(t)) {
      const key = `${n.x},${n.y}`;
      if (!seen.has(key)) {
        seen.add(key);
        queue.push(n);
      }
    }
  }
  return seen;
}
