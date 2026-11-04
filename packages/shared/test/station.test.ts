import { describe, expect, it } from "vitest";
import {
  getStationMap,
  layoutProblems,
  parseStationMap,
  STARTING_CREW,
  stationMapSchema,
} from "../src";
import raw from "../src/station/station.map.json" with { type: "json" };

describe("station map", () => {
  const map = getStationMap();

  it("has every room from ROADMAP §5", () => {
    expect(map.rooms.map((r) => r.id)).toEqual([
      "research",
      "owners-desk",
      "server-room",
      "factory-1",
      "bridge",
      "factory-2",
      "qa-bay",
      "vault",
      "factory-3",
      "cafe",
      "airlock",
    ]);
  });

  it("has a sound layout: reachable anchors, furniture on floors, open doorways", () => {
    expect(layoutProblems(map)).toEqual([]);
  });

  it("gives every room at least one doorway", () => {
    const doors = map.doorways();
    for (const room of map.rooms) {
      const touches = doors.some(
        (d) => d.x >= room.x && d.x < room.x + room.w && d.y >= room.y && d.y < room.y + room.h,
      );
      expect(touches, room.id).toBe(true);
    }
  });

  it("blocks furniture and walls but not doors", () => {
    const desk = map.object("research-desk");
    expect(map.isWalkable(desk.x, desk.y)).toBe(false);
    const door = map.doorways()[0];
    expect(door && map.isWalkable(door.x, door.y)).toBe(true);
    expect(map.isWalkable(0, 0)).toBe(false);
    expect(map.kindAt(-1, 3)).toBe("void");
  });

  it("finds rooms by tile, and corridors have none", () => {
    expect(map.roomAt(5, 5)?.id).toBe("research");
    expect(map.roomAt(8, 13)).toBeUndefined();
  });

  it("rejects broken maps with readable errors", () => {
    const broken = structuredClone(raw) as { tiles: string[] };
    broken.tiles[3] = `${broken.tiles[3]}x`;
    const result = stationMapSchema.safeParse(broken);
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.message).join("\n")).toMatch(/row 3/);
    expect(() => parseStationMap({ ...raw, version: 2 })).toThrow();
  });

  it("reports an anchor moved into a wall", () => {
    const moved = structuredClone(raw) as { anchors: { id: string; x: number; y: number }[] };
    const anchor = moved.anchors.find((a) => a.id === "scout-desk");
    if (!anchor) throw new Error("the map is missing scout-desk");
    anchor.x = 2; // the west wall of the Research Lab
    expect(layoutProblems(parseStationMap(moved)).join("\n")).toMatch(/scout-desk/);
  });
});

describe("starting crew", () => {
  const map = getStationMap();

  it("is the nine agents from ROADMAP §5", () => {
    expect(STARTING_CREW.map((c) => c.name)).toEqual([
      "WARDEN",
      "Scout",
      "Wick",
      "Gift",
      "Frame",
      "Flash",
      "Forge",
      "Lens",
      "Ledger",
    ]);
  });

  it("works at workstations that exist, starting in the home room", () => {
    for (const c of STARTING_CREW) {
      expect(map.room(c.room).id).toBe(c.room);
      const home = map.anchor(c.workstations[0] as string);
      expect(home.room, c.id).toBe(c.room);
      for (const w of c.workstations) expect(map.anchor(w).use, w).toBe("work");
    }
  });

  it("does not share home workstations", () => {
    const homes = STARTING_CREW.map((c) => c.workstations[0]);
    expect(new Set(homes).size).toBe(homes.length);
  });
});
