import { describe, expect, it } from "vitest";
import { creativeTools } from "../src/creative/tools";
import { BUILTIN_TOOLS, portableSchema, toolSpec } from "../src/work/tools";

/** Groq validates tool schemas against JSON Schema 2020-12, which has no array form of items. */
function tuples(node: unknown, path = "$"): string[] {
  if (Array.isArray(node)) return node.flatMap((n, i) => tuples(n, `${path}[${i}]`));
  if (!node || typeof node !== "object") return [];
  const o = node as Record<string, unknown>;
  const here = Array.isArray(o.items) || "additionalItems" in o ? [path] : [];
  return [...here, ...Object.entries(o).flatMap(([k, v]) => tuples(v, `${path}.${k}`))];
}

describe("tool schemas", () => {
  it("never use draft-7 tuples, so 2020-12 validators accept them", () => {
    for (const tool of [...BUILTIN_TOOLS, ...creativeTools(["pixel"])]) {
      expect(tuples(toolSpec(tool as never).parameters), tool.name).toEqual([]);
    }
  });

  it("turn a tuple into one item schema and keep its length", () => {
    const hex = { type: "string", pattern: "^#[0-9a-f]{6}$" };
    expect(
      portableSchema({
        type: "object",
        properties: {
          items: {
            type: "array",
            items: [hex, hex],
            additionalItems: false,
            minItems: 2,
            maxItems: 2,
          },
          pair: { type: "array", items: [hex, { type: "number" }], minItems: 2, maxItems: 2 },
        },
      }),
    ).toEqual({
      type: "object",
      properties: {
        items: { type: "array", items: hex, minItems: 2, maxItems: 2 },
        pair: {
          type: "array",
          items: { anyOf: [hex, { type: "number" }] },
          minItems: 2,
          maxItems: 2,
        },
      },
    });
  });
});
