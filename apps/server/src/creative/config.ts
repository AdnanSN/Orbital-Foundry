import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { CONFIG_DIR } from "../paths";

/** config/creative.yaml, config/prompts.yaml and config/ip-blocklist.yaml (Stage 5). */

const sizeSchema = z.tuple([
  z.number().int().min(16).max(4096),
  z.number().int().min(16).max(4096),
]);

export const creativeConfigSchema = z.object({
  aspects: z.record(z.string(), sizeSchema).default({ "1:1": [1024, 1024] }),
  upscale: z
    .object({
      realesrgan: z.string().default(""),
      model: z.string().default("realesrgan-x4plus"),
      maxSide: z.number().int().min(256).max(16_384).default(8192),
    })
    .default({ realesrgan: "", model: "realesrgan-x4plus", maxSide: 8192 }),
  background: z
    .object({
      rembg: z.string().default(""),
      tolerance: z.number().min(0).max(441).default(48),
      feather: z.number().min(0).max(200).default(24),
    })
    .default({ rembg: "", tolerance: 48, feather: 24 }),
  fonts: z
    .object({
      display: z.array(z.string()).default(["Impact", "Arial"]),
      body: z.array(z.string()).default(["Arial"]),
      mono: z.array(z.string()).default(["Courier New"]),
    })
    .default({ display: ["Impact", "Arial"], body: ["Arial"], mono: ["Courier New"] }),
  qa: z
    .object({
      maxSide: z.number().int().min(128).max(2048).default(768),
      passScore: z.number().min(0).max(10).default(7),
    })
    .default({ maxSide: 768, passScore: 7 }),
});
export type CreativeConfig = z.infer<typeof creativeConfigSchema>;

export const CUTOUTS = ["none", "edges", "chroma", "rembg"] as const;
export type Cutout = (typeof CUTOUTS)[number];

export const styleSchema = z.object({
  description: z.string(),
  prefix: z.string().default(""),
  suffix: z.string().default(""),
  avoid: z.array(z.string()).default([]),
  aspect: z.string().default("1:1"),
  cutout: z.enum(CUTOUTS).default("none"),
});
export type Style = z.infer<typeof styleSchema>;

const promptsSchema = z.object({ styles: z.record(z.string(), styleSchema) });

export type Blocklist = Record<string, string[]>;

export function loadCreativeConfig(dir = CONFIG_DIR): CreativeConfig {
  const file = path.join(dir, "creative.yaml");
  const raw = fs.existsSync(file) ? YAML.parse(fs.readFileSync(file, "utf8")) : {};
  return creativeConfigSchema.parse(raw ?? {});
}

export function loadStyles(dir = CONFIG_DIR): Record<string, Style> {
  const file = path.join(dir, "prompts.yaml");
  if (!fs.existsSync(file)) return {};
  return promptsSchema.parse(YAML.parse(fs.readFileSync(file, "utf8"))).styles;
}

export function loadBlocklist(dir = CONFIG_DIR): Blocklist {
  const file = path.join(dir, "ip-blocklist.yaml");
  if (!fs.existsSync(file)) return {};
  const parsed = z
    .record(z.string(), z.array(z.union([z.string(), z.number()])))
    .parse(YAML.parse(fs.readFileSync(file, "utf8")) ?? {});
  return Object.fromEntries(
    Object.entries(parsed).map(([k, v]) => [k, v.map((term) => String(term))]),
  );
}

/** Wrap a subject in a style: "<prefix> <subject>, <suffix>. Avoid: …". */
export function styledPrompt(subject: string, style: Style | undefined): string {
  const clean = subject.trim().replace(/\s+/g, " ");
  if (!style) return clean;
  const body = [style.prefix, clean].filter(Boolean).join(" ");
  const parts = [body, style.suffix].filter(Boolean).join(", ");
  return style.avoid.length > 0 ? `${parts}. Avoid: ${style.avoid.join(", ")}.` : parts;
}
