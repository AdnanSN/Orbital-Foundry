import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { CONFIG_DIR } from "../paths";

/** Factory 1 configuration: the stores, the products and the marketplace rules (Stage 6). */

export const MOCKUP_KINDS = ["candle", "mug", "tote", "tshirt", "frame"] as const;
export type MockupKind = (typeof MOCKUP_KINDS)[number];

export const businessSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  /** The crew member who operates the store. */
  crew: z.string(),
  niche: z.string(),
  audience: z.string(),
  voice: z.string(),
  products: z.array(z.string()).min(1),
  seedTags: z.array(z.string()).default([]),
  avoidThemes: z.array(z.string()).default([]),
  listingsPerDay: z.number().int().min(0).max(20).default(1),
  price: z.object({
    targetMargin: z.number().min(0).max(0.85),
    minPrice: z.number().min(0),
    ending: z.number().min(0).max(0.99).default(0.99),
  }),
  personalization: z.boolean().default(false),
});
export type Business = z.infer<typeof businessSchema>;

export const productSchema = z.object({
  title: z.string(),
  printArea: z.tuple([z.number().int().min(64), z.number().int().min(64)]),
  dpi: z.number().int().min(72).max(600),
  fit: z.enum(["contain", "cover"]),
  style: z.string(),
  mockup: z.enum(MOCKUP_KINDS),
  baseCost: z.number().min(0),
  shipping: z.number().min(0),
  attributes: z.record(z.string(), z.union([z.string(), z.number()])).default({}),
  /** Printify catalog ids; null until mapped with `npm run printify` (needs a token). */
  printify: z
    .object({
      blueprintId: z.number().int().nullable().default(null),
      printProviderId: z.number().int().nullable().default(null),
      variantIds: z.array(z.number().int()).default([]),
    })
    .default({ blueprintId: null, printProviderId: null, variantIds: [] }),
});
export type Product = z.infer<typeof productSchema>;

export const etsyRulesSchema = z.object({
  title: z.object({ maxChars: z.number().int().default(140) }),
  tags: z.object({ count: z.number().int().default(13), maxChars: z.number().int().default(20) }),
  fees: z.object({
    listing: z.number(),
    transactionPct: z.number(),
    processingPct: z.number(),
    processingFixed: z.number(),
  }),
  disclosures: z.object({ ai: z.string(), productionPartner: z.string() }),
});
export type EtsyRules = z.infer<typeof etsyRulesSchema>;

export function loadBusinesses(dir = path.join(CONFIG_DIR, "businesses")): Business[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".yaml"))
    .sort()
    .map((f) => {
      const parsed = businessSchema.safeParse(
        YAML.parse(fs.readFileSync(path.join(dir, f), "utf8")),
      );
      if (!parsed.success) {
        throw new Error(`config/businesses/${f}: ${z.prettifyError(parsed.error)}`);
      }
      return parsed.data;
    });
}

export function loadProducts(
  file = path.join(CONFIG_DIR, "products.yaml"),
): Record<string, Product> {
  if (!fs.existsSync(file)) return {};
  const raw = YAML.parse(fs.readFileSync(file, "utf8")) as { products?: unknown };
  return z.record(z.string(), productSchema).parse(raw?.products ?? {});
}

export function loadEtsyRules(file = path.join(CONFIG_DIR, "marketplaces.yaml")): EtsyRules {
  const raw = YAML.parse(fs.readFileSync(file, "utf8")) as { etsy?: unknown };
  return etsyRulesSchema.parse(raw?.etsy ?? {});
}

/** Every product a store sells must exist in products.yaml. */
export function checkCatalog(businesses: Business[], products: Record<string, Product>): string[] {
  const errors: string[] = [];
  for (const b of businesses) {
    for (const p of b.products) {
      if (!products[p]) errors.push(`${b.id} sells "${p}", which is not in config/products.yaml`);
    }
  }
  return errors;
}
