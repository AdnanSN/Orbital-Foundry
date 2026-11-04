import { describe, expect, it } from "vitest";
import { z } from "zod";
import { extractJson, JsonExtractError, jsonInstruction, parseStructured } from "../src/llm/json";
import { stripReasoning } from "../src/llm/transport";

describe("extractJson", () => {
  it("reads fenced JSON", () => {
    expect(extractJson('Here you go:\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("skips brackets in prose before the JSON", () => {
    expect(extractJson('[note] the answer is {"name":"Vega","tags":["a","b","c"]} ok')).toEqual({
      name: "Vega",
      tags: ["a", "b", "c"],
    });
  });

  it("keeps braces that sit inside strings", () => {
    expect(extractJson('{"text":"a } tricky { string"}')).toEqual({ text: "a } tricky { string" });
  });

  it("reads top-level arrays", () => {
    expect(extractJson("[1, 2, 3]")).toEqual([1, 2, 3]);
  });

  it("throws when there is no JSON", () => {
    expect(() => extractJson("no json here")).toThrow(JsonExtractError);
  });
});

describe("parseStructured", () => {
  const schema = z.object({ mood: z.enum(["calm", "busy"]) });

  it("validates against the schema", () => {
    expect(parseStructured('{"mood":"calm"}', schema)).toEqual({
      ok: true,
      data: { mood: "calm" },
    });
  });

  it("explains schema mismatches", () => {
    const result = parseStructured('{"mood":"angry"}', schema);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("mood");
  });
});

describe("jsonInstruction", () => {
  it("embeds the JSON Schema without the $schema noise", () => {
    const text = jsonInstruction(z.object({ mood: z.string() }));
    expect(text).toContain('"mood"');
    expect(text).not.toContain("$schema");
  });
});

describe("stripReasoning", () => {
  it("drops <think> blocks", () => {
    expect(stripReasoning("<think>plan, plan</think>\n\nHello")).toBe("Hello");
  });

  it("returns nothing for a reply cut off mid-thought", () => {
    expect(stripReasoning("<think>still going")).toBe("");
  });

  it("leaves normal replies alone", () => {
    expect(stripReasoning("  Hi there ")).toBe("Hi there");
  });
});
