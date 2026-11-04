/**
 * Smoke test: one real request per tier, a JSON reply, a tool call, a vision check, embeddings,
 * and one image per image endpoint allowed in the lane (saved to data/artifacts/smoke/).
 *
 *   npm run smoke                  sandbox lane
 *   npm run smoke -- --lane live   live lane (production-allowed providers only)
 *   npm run smoke -- --no-images   skip image generation
 */
import fs from "node:fs";
import path from "node:path";
import type { Lane } from "@orbital/shared";
import { z } from "zod";
import { MIME_EXT } from "../images/png";
import { ADD_NUMBERS_TOOL, redCircleDataUrl, snippet } from "../llm/probes";
import { ARTIFACTS_DIR, REPO_ROOT } from "../paths";
import { createStation } from "../station";
import { formatTable, keyReport, parseArgs, stringFlag } from "./cli";

const args = parseArgs(process.argv.slice(2), ["no-images"]);
const lane: Lane = stringFlag(args, "lane") === "live" ? "live" : "sandbox";
const station = createStation();
console.log(`Smoke test: ${lane} lane\n\n${keyReport(station.config.providers)}\n`);

const GREETING =
  "In one short sentence, welcome a new crew member aboard the Orbital Foundry space station.";
const IMAGE_PROMPT =
  "Pixel art interior of a cozy sci-fi space station control room, glowing crew consoles, " +
  "a large starfield window, top-down view, crisp 16-bit game style";

interface Check {
  name: string;
  run: () => Promise<string>;
}

const checks: Check[] = [];
for (const tier of ["reasoning", "creative", "fast"] as const) {
  checks.push({
    name: `${tier} chat`,
    run: async () => {
      const r = await station.router.generate({
        tier,
        lane,
        prompt: GREETING,
        maxTokens: 400,
        purpose: `smoke:${tier}`,
      });
      return `${r.ref} (${r.latencyMs} ms): ${snippet(r.text, 90)}`;
    },
  });
}
checks.push({
  name: "json reply",
  run: async () => {
    const r = await station.router.generate({
      tier: "fast",
      lane,
      schema: z.object({ station: z.string().min(1), mood: z.enum(["calm", "busy", "chaotic"]) }),
      prompt: "Name the space station and pick its mood.",
      maxTokens: 400,
      purpose: "smoke:json",
    });
    return `${r.ref}: ${JSON.stringify(r.data)}`;
  },
});
checks.push({
  name: "tool call",
  run: async () => {
    const r = await station.router.generate({
      tier: "reasoning",
      lane,
      tools: [ADD_NUMBERS_TOOL],
      prompt: "Use the add_numbers tool to add 17 and 25.",
      maxTokens: 600,
      purpose: "smoke:tools",
    });
    const call = r.toolCalls[0];
    if (!call) throw new Error(`${r.ref} answered without calling the tool: ${snippet(r.text)}`);
    return `${r.ref}: ${call.name}(${call.arguments})`;
  },
});
checks.push({
  name: "vision",
  run: async () => {
    const r = await station.router.generate({
      tier: "vision",
      lane,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "What colour is the circle in this image? Answer with one word.",
            },
            { type: "image_url", image_url: { url: redCircleDataUrl() } },
          ],
        },
      ],
      maxTokens: 400,
      purpose: "smoke:vision",
    });
    return `${r.ref}: ${snippet(r.text)}`;
  },
});
checks.push({
  name: "embeddings",
  run: async () => {
    const r = await station.router.embed({
      lane,
      input: ["orbital foundry"],
      inputType: "query",
      purpose: "smoke:embed",
    });
    return `${r.ref}: ${r.vectors[0]?.length ?? 0} dimensions`;
  },
});
if (!args.flags.has("no-images")) {
  for (const [id, endpoint] of Object.entries(station.config.images)) {
    if (!endpoint.lanes.includes(lane)) continue;
    checks.push({
      name: `image ${id}`,
      run: async () => {
        const r = await station.images.generateWith(id, lane, {
          prompt: IMAGE_PROMPT,
          width: 1024,
          height: 1024,
          purpose: "smoke:image",
        });
        const dir = path.join(ARTIFACTS_DIR, "smoke");
        fs.mkdirSync(dir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const file = path.join(dir, `${stamp}-${id}.${MIME_EXT[r.mime]}`);
        fs.writeFileSync(file, r.bytes);
        const seed = r.seed === undefined ? "" : `, seed ${r.seed}`;
        return `${r.latencyMs} ms${seed}, saved ${path.relative(REPO_ROOT, file)}`;
      },
    });
  }
}

const rows: string[][] = [];
let failed = 0;
for (const check of checks) {
  process.stdout.write(`  ${check.name} ... `);
  try {
    const detail = await check.run();
    console.log("PASS");
    rows.push([check.name, "PASS", detail]);
  } catch (err) {
    failed++;
    console.log("FAIL");
    const message = err instanceof Error ? err.message : String(err);
    const flat = message
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .join(" | ");
    rows.push([check.name, "FAIL", snippet(flat, 220)]);
  }
}
console.log(`\n${formatTable(["check", "result", "detail"], rows)}`);
console.log(
  failed === 0
    ? `\nAll ${checks.length} checks passed.`
    : `\n${failed} of ${checks.length} checks failed.`,
);
station.close();
process.exitCode = failed === 0 ? 0 : 1;
