import { describe, expect, it } from "vitest";
import { mapLimit, parseArgs } from "../src/scripts/cli";

describe("mapLimit", () => {
  it("keeps the input order and never exceeds the limit", async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapLimit([5, 1, 3, 2, 4], 2, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, n));
      inFlight--;
      return n * 10;
    });
    expect(out).toEqual([50, 10, 30, 20, 40]);
    expect(peak).toBe(2);
  });

  it("handles an empty list", async () => {
    expect(await mapLimit([], 4, async (n: number) => n)).toEqual([]);
  });
});

describe("parseArgs", () => {
  it("reads values, key=value pairs and boolean flags", () => {
    const args = parseArgs(
      ["--provider", "nvidia", "--timeout=30000", "--discover", "extra"],
      ["discover"],
    );
    expect(args.flags.get("provider")).toBe("nvidia");
    expect(args.flags.get("timeout")).toBe("30000");
    expect(args.flags.get("discover")).toBe(true);
    expect(args.positionals).toEqual(["extra"]);
  });
});
