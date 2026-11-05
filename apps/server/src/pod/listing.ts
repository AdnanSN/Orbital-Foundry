import { z } from "zod";
import type { Blocklist } from "../creative/config";
import { blocklistHits } from "../creative/qa";
import type { Business, EtsyRules, Product } from "./config";

/**
 * Listing copy and pricing (ROADMAP §7.1 step 4): Etsy's title and tag limits, the description
 * with its disclosures, and a price from cost plus a target margin after Etsy's fees.
 */

export const listingCopySchema = z.object({
  title: z.string().min(10).max(600),
  tags: z.array(z.string()).min(3).max(40),
  description: z.string().min(60).max(6_000),
});
export type ListingCopy = z.infer<typeof listingCopySchema>;

/** Rule violations, in words a model can act on. Empty means the copy is valid. */
export function copyProblems(copy: ListingCopy, rules: EtsyRules, blocklist: Blocklist): string[] {
  const out: string[] = [];
  if (copy.title.length > rules.title.maxChars) {
    out.push(`The title is ${copy.title.length} characters; the limit is ${rules.title.maxChars}.`);
  }
  if (copy.tags.length !== rules.tags.count) {
    out.push(`There are ${copy.tags.length} tags; Etsy needs exactly ${rules.tags.count}.`);
  }
  const long = copy.tags.filter((t) => t.trim().length > rules.tags.maxChars);
  if (long.length > 0) {
    out.push(`These tags are over ${rules.tags.maxChars} characters: ${long.join(", ")}.`);
  }
  const lower = copy.tags.map((t) => t.trim().toLowerCase());
  if (new Set(lower).size !== lower.length) out.push("Some tags repeat.");
  const hits = blocklistHits(
    `${copy.title}\n${copy.tags.join(", ")}\n${copy.description}`,
    blocklist,
  );
  if (hits.length > 0) {
    out.push(`Remove protected names: ${hits.map((h) => h.term).join(", ")}.`);
  }
  return out;
}

/**
 * Drop an ellipsis a model put at the end ("…Watercolor, Ceram..."): an ellipsis stuck to a word
 * means the word was cut, so it goes too, with any separator left dangling.
 */
export function dropEllipsis(title: string): string {
  const t = title.trim();
  if (/\S(\.{3}|…)$/.test(t)) {
    return t.replace(/\s*\S*(\.{3}|…)$/, "").replace(/[\s,;:|–—-]+$/, "");
  }
  return t.replace(/\s+(\.{3}|…)$/, "");
}

/** Shorten at a word boundary, without a dangling separator. */
export function clampTitle(title: string, max: number): string {
  const clean = dropEllipsis(title.replace(/\s+/g, " ").trim());
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max + 1);
  const at = cut.lastIndexOf(" ");
  return (at > max * 0.6 ? cut.slice(0, at) : clean.slice(0, max)).replace(/[\s,|:;-]+$/, "");
}

const SMALL_WORDS = new Set([
  "a",
  "an",
  "and",
  "as",
  "at",
  "but",
  "by",
  "for",
  "in",
  "of",
  "on",
  "or",
  "the",
  "to",
  "with",
]);

/**
 * Title Case for titles a model wrote in lower case (or SHOUTED). Titles that already mix cases
 * are left alone, so deliberate casing ("iPhone-free", "DIY") survives.
 */
export function titleCase(title: string): string {
  const clean = title.replace(/\s+/g, " ").trim();
  const letters = clean.replace(/[^\p{L}]/gu, "");
  const mixed = letters !== letters.toLowerCase() && letters !== letters.toUpperCase();
  if (mixed) return clean;
  return clean
    .toLowerCase()
    .split(" ")
    .map((w, i) =>
      i > 0 && SMALL_WORDS.has(w) ? w : w.replace(/^(\p{L})/u, (c) => c.toUpperCase()),
    )
    .join(" ");
}

export function normalizeTag(tag: string): string {
  return tag
    .toLowerCase()
    .replace(/[^\p{L}\p{N}&' -]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Make the copy valid without another model call: clamp the title, normalize and dedupe tags,
 * drop tags that are too long (or shorten two-word overflows), then fill up to the count from
 * the store's seed tags and words from the title.
 */
export function fixCopy(copy: ListingCopy, rules: EtsyRules, seedTags: string[]): ListingCopy {
  const max = rules.tags.maxChars;
  const tags: string[] = [];
  const add = (raw: string) => {
    let t = normalizeTag(raw);
    if (t.length > max) {
      // "minimal winter wall art" → "winter wall art": drop leading words (modifiers) first,
      // since the head noun comes last in an English noun phrase.
      const words = t.split(" ");
      while (words.length > 1 && words.join(" ").length > max) words.shift();
      t = words.join(" ");
    }
    if (t.length >= 2 && t.length <= max && !tags.includes(t)) tags.push(t);
  };
  for (const t of copy.tags) add(t);
  for (const t of seedTags) if (tags.length < rules.tags.count) add(t);
  const titleWords = normalizeTag(copy.title)
    .split(" ")
    .filter((w) => w.length > 3);
  for (let i = 0; i + 1 < titleWords.length && tags.length < rules.tags.count; i++) {
    add(`${titleWords[i]} ${titleWords[i + 1]}`);
  }
  return {
    title: clampTitle(titleCase(copy.title), rules.title.maxChars),
    tags: tags.slice(0, rules.tags.count),
    description: copy.description.trim(),
  };
}

/** The description buyers read: the copy, the product facts, then the disclosures. */
export function fullDescription(
  copy: ListingCopy,
  business: Business,
  product: Product,
  rules: EtsyRules,
): string {
  const facts = Object.entries(product.attributes).map(([k, v]) => `- ${capitalize(k)}: ${v}`);
  const parts = [
    copy.description.trim(),
    business.personalization
      ? "Personalization: add the name or short text you want in the personalization box at checkout. We show you a proof before printing if anything is unclear."
      : "",
    `Product details\n- ${product.title}\n${facts.join("\n")}`,
    `About this design\n- ${rules.disclosures.ai}\n- ${rules.disclosures.productionPartner}\n- Mockup images show the actual design; colours can vary slightly between screens and print.`,
  ];
  return parts.filter(Boolean).join("\n\n");
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export interface PriceBreakdown {
  price: number;
  cost: number;
  fees: number;
  profit: number;
  margin: number;
}

/** Etsy's fees on a sale at `price` (free shipping: the price includes shipping). */
export function etsyFees(price: number, rules: EtsyRules): number {
  const f = rules.fees;
  return f.listing + (price * (f.transactionPct + f.processingPct)) / 100 + f.processingFixed;
}

/**
 * The lowest price ending in `ending` that keeps `targetMargin` of the price as profit after the
 * product cost, shipping and Etsy's fees, and is at least the store's minimum.
 */
export function priceFor(
  product: Product,
  business: Business,
  rules: EtsyRules,
  /** A price experiment's multiplier (1 = none). */
  factor = 1,
): PriceBreakdown {
  const cost = product.baseCost + product.shipping;
  const pct = (rules.fees.transactionPct + rules.fees.processingPct) / 100;
  const fixed = rules.fees.listing + rules.fees.processingFixed;
  const raw = (cost + fixed) / (1 - pct - business.price.targetMargin);
  let price = Math.max(raw * factor, business.price.minPrice);
  const ending = business.price.ending;
  let rounded = Math.floor(price) + ending;
  if (rounded + 1e-9 < price) rounded += 1;
  price = Math.round(rounded * 100) / 100;
  const fees = Math.round(etsyFees(price, rules) * 100) / 100;
  const profit = Math.round((price - cost - fees) * 100) / 100;
  return { price, cost, fees, profit, margin: Math.round((profit / price) * 1000) / 1000 };
}
