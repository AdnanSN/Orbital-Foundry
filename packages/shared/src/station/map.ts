import { z } from "zod";
import { directionSchema, type Tile } from "./geometry";

/**
 * The station map is data (packages/shared/src/station/station.map.json): a character grid for
 * walls, floors, doors and windows, plus lists of rooms, furniture, anchor points and floor labels.
 * The client draws it; the simulation (the mock director now, the server from Stage 3) walks on it.
 */

export const TILE_KINDS = ["void", "wall", "window", "floor", "corridor", "door"] as const;
export const tileKindSchema = z.enum(TILE_KINDS);
export type TileKind = z.infer<typeof tileKindSchema>;

const WALKABLE_KINDS: ReadonlySet<TileKind> = new Set(["floor", "corridor", "door"]);

/** Lowercase ids with dashes, e.g. "factory-1". */
const idSchema = z.string().regex(/^[a-z0-9-]+$/, "expected a lowercase id with dashes");
const coord = z.number().int().nonnegative();
const size = z.number().int().positive();

export const roomSchema = z.object({
  id: idSchema,
  name: z.string().min(1),
  /** Painted on the floor, uppercase. */
  label: z.string().min(1),
  sublabel: z.string().optional(),
  /** Visual theme id; the client maps it to colours and floor patterns. */
  theme: z.string().min(1),
  /** Outer rectangle, walls included. */
  x: coord,
  y: coord,
  w: size,
  h: size,
  description: z.string(),
});
export type Room = z.infer<typeof roomSchema>;

export const stationObjectSchema = z.object({
  id: idSchema,
  /** Furniture kind, e.g. "desk", "rack", "plant". The client knows how to draw each kind. */
  kind: z.string().min(1),
  room: idSchema,
  x: coord,
  y: coord,
  w: size,
  h: size,
  /** Mounted on a wall tile rather than standing on the floor. Wall objects never block floor. */
  wall: z.boolean().optional(),
  variant: z.string().optional(),
  /** For server racks: the model provider the rack stands for. */
  provider: z.string().optional(),
});
export type StationObject = z.infer<typeof stationObjectSchema>;

export const ANCHOR_USES = [
  "work",
  "deliver",
  "review",
  "report",
  "queue",
  "coffee",
  "rest",
  "patrol",
  "spawn",
] as const;
export const anchorUseSchema = z.enum(ANCHOR_USES);
export type AnchorUse = z.infer<typeof anchorUseSchema>;

/** A spot where a crew member stands to do something, facing a given way. */
export const anchorSchema = z.object({
  id: idSchema,
  room: idSchema,
  x: coord,
  y: coord,
  facing: directionSchema,
  use: anchorUseSchema,
  /** The crew member whose own workstation this is. */
  crew: z.string().optional(),
  /** The furniture this spot faces, so its screen can light up while someone works there. */
  object: idSchema.optional(),
});
export type Anchor = z.infer<typeof anchorSchema>;

/** Small floor text, centred over `w` tiles starting at x. */
export const floorLabelSchema = z.object({
  text: z.string().min(1),
  x: coord,
  y: coord,
  w: size,
});
export type FloorLabel = z.infer<typeof floorLabelSchema>;

export const stationMapSchema = z
  .object({
    version: z.literal(1),
    id: idSchema,
    tileSize: size,
    width: size,
    height: size,
    legend: z.record(z.string().length(1), tileKindSchema),
    tiles: z.array(z.string()),
    rooms: z.array(roomSchema),
    objects: z.array(stationObjectSchema),
    anchors: z.array(anchorSchema),
    labels: z.array(floorLabelSchema),
  })
  .superRefine((m, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: "custom", message });
    if (m.tiles.length !== m.height)
      issue(`tiles has ${m.tiles.length} rows, expected ${m.height}`);
    m.tiles.forEach((row, y) => {
      if (row.length !== m.width) issue(`row ${y} has ${row.length} columns, expected ${m.width}`);
      for (const ch of row)
        if (!(ch in m.legend)) issue(`row ${y} uses "${ch}", not in the legend`);
    });
    const unique = (what: string, ids: string[]) => {
      const seen = new Set<string>();
      for (const id of ids) {
        if (seen.has(id)) issue(`duplicate ${what} id "${id}"`);
        seen.add(id);
      }
    };
    unique(
      "room",
      m.rooms.map((r) => r.id),
    );
    unique(
      "object",
      m.objects.map((o) => o.id),
    );
    unique(
      "anchor",
      m.anchors.map((a) => a.id),
    );
    const roomIds = new Set(m.rooms.map((r) => r.id));
    const objectIds = new Set(m.objects.map((o) => o.id));
    for (const r of m.rooms) {
      if (r.x + r.w > m.width || r.y + r.h > m.height) issue(`room "${r.id}" is outside the map`);
    }
    for (const o of m.objects) {
      if (!roomIds.has(o.room)) issue(`object "${o.id}" names unknown room "${o.room}"`);
      if (o.x + o.w > m.width || o.y + o.h > m.height) issue(`object "${o.id}" is outside the map`);
    }
    for (const a of m.anchors) {
      if (!roomIds.has(a.room)) issue(`anchor "${a.id}" names unknown room "${a.room}"`);
      if (a.object && !objectIds.has(a.object)) {
        issue(`anchor "${a.id}" names unknown object "${a.object}"`);
      }
    }
  });
export type StationMapData = z.infer<typeof stationMapSchema>;

/** Anything A* can walk on. */
export interface WalkGrid {
  readonly width: number;
  readonly height: number;
  isWalkable(x: number, y: number): boolean;
}

/** A validated station map with lookups. Build one with `parseStationMap`. */
export class StationMap implements WalkGrid {
  readonly id: string;
  readonly tileSize: number;
  readonly width: number;
  readonly height: number;
  readonly rooms: readonly Room[];
  readonly objects: readonly StationObject[];
  readonly anchors: readonly Anchor[];
  readonly labels: readonly FloorLabel[];

  private readonly kinds: TileKind[];
  private readonly blocked: Uint8Array;
  private readonly roomIndex: Int16Array;
  private readonly roomById = new Map<string, Room>();
  private readonly objectById = new Map<string, StationObject>();
  private readonly anchorById = new Map<string, Anchor>();

  constructor(data: StationMapData) {
    this.id = data.id;
    this.tileSize = data.tileSize;
    this.width = data.width;
    this.height = data.height;
    this.rooms = data.rooms;
    this.objects = data.objects;
    this.anchors = data.anchors;
    this.labels = data.labels;

    this.kinds = [];
    for (const row of data.tiles) {
      for (const ch of row) this.kinds.push(data.legend[ch] ?? "void");
    }

    this.blocked = new Uint8Array(this.width * this.height);
    for (const o of data.objects) {
      this.objectById.set(o.id, o);
      if (o.wall) continue;
      for (let y = o.y; y < o.y + o.h; y++) {
        for (let x = o.x; x < o.x + o.w; x++) this.blocked[y * this.width + x] = 1;
      }
    }

    this.roomIndex = new Int16Array(this.width * this.height).fill(-1);
    data.rooms.forEach((r, i) => {
      this.roomById.set(r.id, r);
      for (let y = r.y; y < r.y + r.h; y++) {
        for (let x = r.x; x < r.x + r.w; x++) this.roomIndex[y * this.width + x] = i;
      }
    });
    for (const a of data.anchors) this.anchorById.set(a.id, a);
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  kindAt(x: number, y: number): TileKind {
    return this.inBounds(x, y) ? (this.kinds[y * this.width + x] ?? "void") : "void";
  }

  /** True when furniture stands on the tile. */
  isBlocked(x: number, y: number): boolean {
    return this.inBounds(x, y) && this.blocked[y * this.width + x] === 1;
  }

  isWalkable(x: number, y: number): boolean {
    return WALKABLE_KINDS.has(this.kindAt(x, y)) && !this.isBlocked(x, y);
  }

  /** The room whose outer rectangle contains the tile, walls included. Corridors have none. */
  roomAt(x: number, y: number): Room | undefined {
    if (!this.inBounds(x, y)) return undefined;
    const i = this.roomIndex[y * this.width + x] ?? -1;
    return i >= 0 ? this.rooms[i] : undefined;
  }

  room(id: string): Room {
    const r = this.roomById.get(id);
    if (!r) throw new Error(`Unknown room "${id}"`);
    return r;
  }

  object(id: string): StationObject {
    const o = this.objectById.get(id);
    if (!o) throw new Error(`Unknown object "${id}"`);
    return o;
  }

  anchor(id: string): Anchor {
    const a = this.anchorById.get(id);
    if (!a) throw new Error(`Unknown anchor "${id}"`);
    return a;
  }

  hasAnchor(id: string): boolean {
    return this.anchorById.has(id);
  }

  anchorsFor(use: Anchor["use"], room?: string): Anchor[] {
    return this.anchors.filter((a) => a.use === use && (room === undefined || a.room === room));
  }

  /** Walkable neighbours of a tile, in a fixed order (up, right, down, left). */
  walkableNeighbours(t: Tile): Tile[] {
    const out: Tile[] = [];
    for (const [dx, dy] of NEIGHBOUR_STEPS) {
      if (this.isWalkable(t.x + dx, t.y + dy)) out.push({ x: t.x + dx, y: t.y + dy });
    }
    return out;
  }

  /** Doors grouped into openings (adjacent door tiles), each with its orientation. */
  doorways(): Doorway[] {
    const seen = new Uint8Array(this.width * this.height);
    const out: Doorway[] = [];
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        if (seen[y * this.width + x] || this.kindAt(x, y) !== "door") continue;
        const tiles: Tile[] = [];
        const stack: Tile[] = [{ x, y }];
        seen[y * this.width + x] = 1;
        while (stack.length > 0) {
          const t = stack.pop() as Tile;
          tiles.push(t);
          for (const [dx, dy] of NEIGHBOUR_STEPS) {
            const nx = t.x + dx;
            const ny = t.y + dy;
            if (this.kindAt(nx, ny) === "door" && !seen[ny * this.width + nx]) {
              seen[ny * this.width + nx] = 1;
              stack.push({ x: nx, y: ny });
            }
          }
        }
        tiles.sort((a, b) => a.y - b.y || a.x - b.x);
        const xs = tiles.map((t) => t.x);
        const ys = tiles.map((t) => t.y);
        const minX = Math.min(...xs);
        const minY = Math.min(...ys);
        const w = Math.max(...xs) - minX + 1;
        const h = Math.max(...ys) - minY + 1;
        out.push({
          id: `door-${minX}-${minY}`,
          x: minX,
          y: minY,
          w,
          h,
          // A door in a horizontal wall (wider than tall) is crossed vertically.
          orientation: w >= h ? "horizontal" : "vertical",
        });
      }
    }
    return out;
  }
}

export interface Doorway {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** "horizontal": the door sits in a north or south wall; "vertical": in an east or west wall. */
  orientation: "horizontal" | "vertical";
}

const NEIGHBOUR_STEPS: ReadonlyArray<readonly [number, number]> = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

export function parseStationMap(raw: unknown): StationMap {
  return new StationMap(stationMapSchema.parse(raw));
}
