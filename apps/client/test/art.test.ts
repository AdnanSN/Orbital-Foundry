import { STARTING_CREW } from "@orbital/shared";
import { describe, expect, it } from "vitest";
import {
  composeFrame,
  crewPalette,
  expandRow,
  frameName,
  frameSpecs,
  SPRITE_SIZE,
} from "../src/art/crew";
import { glyphFor, hasGlyph, measureText, normalizeText, wrapText } from "../src/art/font";

describe("crew sprites", () => {
  const specs = frameSpecs();

  it("expands run-length rows and rejects bad widths", () => {
    expect(expandRow("3. o 8h o 3.")).toBe("...ohhhhhhhho...");
    expect(() => expandRow("3. o 3.")).toThrow(/7 wide/);
  });

  it("composes every frame of every crew member at 16x16 with known colours", () => {
    for (const crew of STARTING_CREW) {
      const palette = crewPalette(crew.look);
      for (const spec of specs) {
        const rows = composeFrame(crew.look, spec);
        expect(rows).toHaveLength(SPRITE_SIZE);
        for (const row of rows) {
          expect(row).toHaveLength(SPRITE_SIZE);
          for (const key of row)
            if (key !== ".")
              expect(palette[key], `${crew.id} ${frameName(spec)} ${key}`).toBeDefined();
        }
      }
    }
  });

  it("gives each frame a unique name", () => {
    const names = specs.map(frameName);
    expect(new Set(names).size).toBe(names.length);
  });

  it("animates: walk and typing frames differ, right mirrors left", () => {
    const look = STARTING_CREW[1]?.look;
    if (!look) throw new Error("no crew");
    const walk = [0, 1, 2, 3].map((index) =>
      composeFrame(look, { facing: "down", anim: "walk", index }).join("\n"),
    );
    expect(new Set(walk).size).toBeGreaterThanOrEqual(3);
    const type = [0, 1].map((index) =>
      composeFrame(look, { facing: "up", anim: "type", index }).join("\n"),
    );
    expect(type[0]).not.toBe(type[1]);
    const left = composeFrame(look, { facing: "left", anim: "idle", index: 0 });
    const right = composeFrame(look, { facing: "right", anim: "idle", index: 0 });
    expect(right).toEqual(left.map((r) => [...r].reverse().join("")));
  });

  it("swaps palettes per crew member", () => {
    const [a, b] = STARTING_CREW;
    if (!a || !b) throw new Error("no crew");
    expect(crewPalette(a.look).c).not.toBe(crewPalette(b.look).c);
  });
});

describe("pixel font", () => {
  it("covers every character the mock crew says", async () => {
    const { ROLE_LINES, WARDEN_LINES, CREW_REPLIES, LENS_LINES } = await import("@orbital/shared");
    const all = [
      ...Object.values(ROLE_LINES).flatMap((r) => [...r.work, ...r.tasks, ...r.subjects]),
      ...Object.values(WARDEN_LINES).flat(),
      ...Object.values(CREW_REPLIES).flat(),
      ...Object.values(LENS_LINES).flat(),
      ...STARTING_CREW.map((c) => c.name),
    ];
    const missing = new Set<string>();
    for (const line of all)
      for (const ch of normalizeText(line))
        if (!hasGlyph(ch) && ch !== "{" && ch !== "}") missing.add(ch);
    expect([...missing]).toEqual([]);
  });

  it("measures and wraps text", () => {
    expect(measureText("A")).toBe(glyphFor("A").width);
    expect(measureText("AB")).toBe(glyphFor("A").width + 1 + glyphFor("B").width);
    const lines = wrapText("Reconciling the fees for today", 50);
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) expect(measureText(l)).toBeLessThanOrEqual(50);
    expect(wrapText("SUPERCALIFRAGILISTIC", 20).every((l) => measureText(l) <= 20)).toBe(true);
  });
});
