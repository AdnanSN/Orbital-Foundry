import type { ArtifactMeta } from "@orbital/shared";
import { z } from "zod";
import { defineTool, type ToolContext, type ToolDef } from "../work/tools";
import { composeSpecSchema } from "./compose";
import { CUTOUTS } from "./config";
import type { CreativeStudio, Origin } from "./studio";

/**
 * The creative tools as agent tools (ROADMAP Stage 5). Images are passed around by artifact id
 * ("I-0007"); every tool returns the new id and the size, so the agent can chain them. All of
 * them are internal: nothing leaves the station.
 */

function studioOf(ctx: ToolContext): CreativeStudio {
  if (!ctx.studio) throw new Error("The creative studio is offline on this station.");
  return ctx.studio;
}

function origin(ctx: ToolContext): Origin {
  return {
    createdBy: ctx.agent.id,
    taskId: ctx.task.id,
    objectiveId: ctx.task.objectiveId ?? null,
    room: ctx.agent.room,
  };
}

function made(meta: ArtifactMeta): string {
  const w = meta.info?.width;
  const h = meta.info?.height;
  return `${meta.id} (${w}×${h}): "${meta.title}"`;
}

const imageId = z.string().regex(/^I-\d+$/, 'an image id like "I-0007"');

export function creativeTools(styleIds: readonly string[]): ToolDef<unknown>[] {
  const styleHelp = styleIds.length > 0 ? ` Styles: ${styleIds.join(", ")}.` : "";
  return [
    defineTool({
      name: "generate_image",
      description: `Generate an image from a text prompt (describe the subject; the style adds the rest). Returns an image id.${styleHelp} Aspects: 1:1, 4:5, 3:4, 2:3, 16:9, 9:16. Never name brands, characters or real people.`,
      sideEffect: "internal",
      lane: "any",
      approval: "never",
      input: z.object({
        prompt: z.string().min(3).max(800),
        style: z.string().optional(),
        aspect: z.string().optional(),
        seed: z.coerce.number().int().optional(),
        title: z.string().max(120).optional(),
      }),
      status: (i) => `Generating: ${i.prompt.slice(0, 36)}…`,
      run: async (i, ctx) => `Made ${made(await studioOf(ctx).generate(i, origin(ctx)))}.`,
    }),
    defineTool({
      name: "upscale_image",
      description: "Upscale an image 2× or 4× (print resolution). Returns a new image id.",
      sideEffect: "internal",
      lane: "any",
      approval: "never",
      input: z.object({
        imageId,
        factor: z.coerce
          .number()
          .refine((n) => n === 2 || n === 4, "2 or 4")
          .default(4),
      }),
      status: (i) => `Upscaling ${i.imageId}…`,
      run: async (i, ctx) =>
        `Made ${made(await studioOf(ctx).upscale(i.imageId, i.factor as 2 | 4, origin(ctx)))}.`,
    }),
    defineTool({
      name: "remove_background",
      description:
        'Cut the subject out of its background (transparent PNG). method: "auto" (default), "edges" (plain backgrounds), "chroma" (flat key colours like magenta or green).',
      sideEffect: "internal",
      lane: "any",
      approval: "never",
      input: z.object({
        imageId,
        method: z.enum(["auto", ...CUTOUTS.filter((c) => c !== "none")]).default("auto"),
        tolerance: z.coerce.number().min(0).max(200).optional(),
      }),
      status: (i) => `Cutting out ${i.imageId}…`,
      run: async (i, ctx) =>
        `Made ${made(
          await studioOf(ctx).cutout(
            i.imageId,
            i.method,
            i.tolerance !== undefined ? { tolerance: i.tolerance } : {},
            origin(ctx),
          ),
        )}.`,
    }),
    defineTool({
      name: "chroma_key",
      description:
        "Make one colour transparent everywhere in the image (fast). color is #rrggbb; detected from the border when omitted.",
      sideEffect: "internal",
      lane: "any",
      approval: "never",
      input: z.object({
        imageId,
        color: z.string().optional(),
        tolerance: z.coerce.number().min(0).max(200).optional(),
      }),
      status: (i) => `Keying ${i.imageId}…`,
      run: async (i, ctx) =>
        `Made ${made(
          await studioOf(ctx).cutout(
            i.imageId,
            "chroma",
            {
              ...(i.color ? { color: i.color } : {}),
              ...(i.tolerance !== undefined ? { tolerance: i.tolerance } : {}),
            },
            origin(ctx),
          ),
        )}.`,
    }),
    defineTool({
      name: "compose_image",
      description:
        'Lay out a canvas: background (color, gradient or imageId), then layers of {type:"image",imageId,x,y,width,height,fit}, {type:"text",text,x,y,maxWidth,size,font:"display"|"body",color,stroke:{color,width},align}, {type:"rect",x,y,width,height,color}. Text shrinks to fit maxWidth. Returns an image id.',
      sideEffect: "internal",
      lane: "any",
      approval: "never",
      input: z.object({
        title: z.string().max(120).default("Composition"),
        spec: composeSpecSchema,
      }),
      status: (i) => `Composing ${i.spec.width}×${i.spec.height}…`,
      run: async (i, ctx) =>
        `Made ${made(await studioOf(ctx).compose(i.spec, i.title, origin(ctx)))}.`,
    }),
    defineTool({
      name: "pixelate_image",
      description:
        "Turn an image into pixel art: downscale so the longest side is `size` pixels and reduce it to `colors` colours. scale enlarges the result with hard pixels for previews.",
      sideEffect: "internal",
      lane: "any",
      approval: "never",
      input: z.object({
        imageId,
        size: z.coerce.number().int().min(8).max(256).default(32),
        colors: z.coerce.number().int().min(2).max(64).default(16),
        scale: z.coerce.number().int().min(1).max(32).default(1),
      }),
      status: (i) => `Pixelating ${i.imageId} to ${i.size}px…`,
      run: async (i, ctx) =>
        `Made ${made(await studioOf(ctx).pixelate(i.imageId, i, origin(ctx)))}.`,
    }),
    defineTool({
      name: "make_spritesheet",
      description: "Pack images into one sprite sheet (a grid) with an atlas. Returns an image id.",
      sideEffect: "internal",
      lane: "any",
      approval: "never",
      input: z.object({
        imageIds: z.array(imageId).min(1).max(256),
        columns: z.coerce.number().int().min(1).max(64).optional(),
        padding: z.coerce.number().int().min(0).max(64).default(0),
        title: z.string().max(120).optional(),
      }),
      status: (i) => `Packing ${i.imageIds.length} frames…`,
      run: async (i, ctx) => {
        const { meta, atlas } = await studioOf(ctx).spritesheet(
          i.imageIds,
          {
            padding: i.padding,
            ...(i.columns ? { columns: i.columns } : {}),
            ...(i.title ? { title: i.title } : {}),
          },
          origin(ctx),
        );
        return `Made ${made(meta)}: ${atlas.columns}×${atlas.rows} cells of ${atlas.cell.w}×${atlas.cell.h}.`;
      },
    }),
    defineTool({
      name: "vision_qa",
      description:
        "Score an image 0-10 for defects, garbled text, AI artifacts and legibility. purpose says what it is for; expectText is the exact text it should show (empty string: no text).",
      sideEffect: "internal",
      lane: "any",
      approval: "never",
      input: z.object({
        imageId,
        purpose: z.string().max(200).optional(),
        expectText: z.string().max(200).optional(),
      }),
      status: (i) => `QA on ${i.imageId}…`,
      run: async (i, ctx) => {
        const expect =
          i.expectText === undefined ? undefined : i.expectText === "" ? null : i.expectText;
        const r = await studioOf(ctx).qa(i.imageId, i.purpose, expect);
        const v = r.vision;
        return [
          `${i.imageId}: ${r.pass ? "PASS" : "FAIL"}${r.score !== null ? ` (${r.score}/10)` : ""}.`,
          v?.defects.length ? `Defects: ${v.defects.join("; ")}.` : "",
          v?.garbledText ? "Garbled text found." : "",
          r.note ?? "",
          `Checks: ${r.checks.width}×${r.checks.height}, coverage ${r.checks.coverage}, edge opaque ${r.checks.edgeOpaque}.`,
        ]
          .filter(Boolean)
          .join(" ");
      },
    }),
    defineTool({
      name: "ip_screen",
      description:
        "Screen text (a prompt, title, tags or description) and optionally an image for trademarks, characters, real people, lyrics and unsafe content. Verdict: clear, review or block.",
      sideEffect: "internal",
      lane: "any",
      approval: "never",
      input: z.object({ text: z.string().min(1).max(4_000), imageId: imageId.optional() }),
      status: () => "IP screen…",
      run: async (i, ctx) => {
        const r = await studioOf(ctx).screen(i.text, i.imageId);
        return [
          `Verdict: ${r.verdict.toUpperCase()}.`,
          r.hits.length ? `Blocklist: ${r.hits.map((h) => h.term).join(", ")}.` : "",
          r.llm
            ? `Model risk: ${r.llm.risk}${r.llm.issues.length ? ` (${r.llm.issues.join("; ")})` : ""}.`
            : "",
          r.note ?? "",
        ]
          .filter(Boolean)
          .join(" ");
      },
    }),
  ] as ToolDef<unknown>[];
}
