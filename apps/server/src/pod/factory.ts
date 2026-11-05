import fs from "node:fs";
import path from "node:path";
import type { Approval, ArtifactMeta, Lane, Task } from "@orbital/shared";
import { zipSync } from "fflate";
import { z } from "zod";
import type { Blocklist } from "../creative/config";
import type { IpScreenResult } from "../creative/qa";
import type { CreativeStudio, Origin, QaResult } from "../creative/studio";
import type { ModelRouter } from "../llm/router";
import type { PodPublisher } from "../printify/publisher";
import type { SimServer } from "../sim/simServer";
import type { WorkDirector } from "../work/director";
import type { WorkStore } from "../work/store";
import type { Business, EtsyRules, Product } from "./config";
import {
  copyProblems,
  fixCopy,
  fullDescription,
  type ListingCopy,
  listingCopySchema,
  type PriceBreakdown,
  priceFor,
} from "./listing";
import { detailMockup, productMockup } from "./mockups";

/**
 * Factory 1, the Etsy print-on-demand studio (ROADMAP §7.1), in the sandbox: Scout picks a
 * concept, the store's operator writes prompts and generates candidates, Lens picks the best by
 * vision QA, production fits it to the product's print area, the operator writes the listing,
 * Lens runs compliance, and the package (print file, mockups, copy, compliance report) goes to
 * the Owner's Desk. Nothing is published: approving a package only marks it ready for Stage 7.
 *
 * The pipeline is code, not an agent loop: each step is a fixed tool or one structured model
 * call, so a listing costs a predictable number of free-tier calls. Every step is a speech
 * bubble, a task update or an artifact in the event log, and the package carries a trace.
 */

export interface PodDeps {
  router: ModelRouter;
  studio: CreativeStudio;
  store: WorkStore;
  world: SimServer;
  director: Pick<WorkDirector, "fileDeskItem" | "onDecision">;
  businesses: Business[];
  products: Record<string, Product>;
  rules: EtsyRules;
  blocklist: Blocklist;
  /** Where listing packages are written. */
  dir: string;
  lane: Lane;
  /** Image candidates per concept (default 4). */
  candidates?: number;
  /** Start each store's daily listings on its own (default off; the server turns it on). */
  autopilot?: boolean;
  /** Local hours [start, end) when the autopilot may start work. */
  workingHours?: [number, number];
  /**
   * When images can next be made in this lane (ms; 0 for now). Every listing needs images, so the
   * autopilot waits while the lane's daily image budget is spent instead of failing listings.
   */
  imagesReadyAt?: () => number;
  /** Real time (daily counts, working hours). */
  clock?: () => Date;
  log?: (message: string) => void;
}

export interface StoreSettings {
  listingsPerDay: number;
  paused: boolean;
}

export interface TraceStep {
  step: string;
  actor: string;
  at: string;
  note: string;
  ids: string[];
}

export interface Compliance {
  ok: boolean;
  blockers: string[];
  warnings: string[];
  ip: { verdict: IpScreenResult["verdict"]; hits: string[]; risk: string | null; issues: string[] };
  qa: { score: number | null; pass: boolean; defects: string[] };
  title: { chars: number; max: number; ok: boolean };
  tags: { count: number; required: number; longest: number; max: number; ok: boolean };
  disclosures: { ai: boolean; productionPartner: boolean };
  printFile: { width: number; height: number; dpi: number; matches: boolean };
  mockupsHonest: boolean;
}

export interface ListingPackage {
  id: string;
  taskId: string;
  business: string;
  product: string;
  concept: string;
  title: string;
  tags: string[];
  description: string;
  price: PriceBreakdown;
  design: string;
  printFile: string;
  mockups: string[];
  candidates: { id: string; score: number | null; pass: boolean }[];
  compliance: Compliance;
  trace: TraceStep[];
  zip: string;
  createdAt: string;
}

const conceptSchema = z.object({
  niche: z
    .string()
    .min(3)
    .max(80)
    .describe(
      'The specific sub-niche this one design targets, in 2 to 6 words (for example "golden retriever moms" or "first christmas newlyweds"); never the store\'s general niche',
    ),
  concept: z
    .string()
    .min(10)
    .max(500)
    .describe(
      "The design itself: subject, composition, style and palette, in one or two sentences",
    ),
  product: z.string().describe("The product id this design is for"),
  keywords: z
    .array(z.string())
    .min(3)
    .max(15)
    .describe("Up to 10 phrases buyers type into Etsy search for this design"),
  why: z
    .string()
    .max(1_000)
    .default("")
    .describe("Why this sells in the coming weeks, in one sentence"),
});
type Concept = z.infer<typeof conceptSchema>;

const promptsSchema = z.object({ prompts: z.array(z.string().min(10).max(600)).min(2).max(8) });

/** The Owner's Desk action that publishes a package (handled here, not by the agent runtime). */
export const PUBLISH_TOOL = "pod.publish";

function today(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function short(text: string, max = 60): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export class PodFactory {
  private readonly running = new Set<string>();
  private readonly controlled = new Set<string>();
  private readonly backoff = new Map<string, number>();
  private readonly log: (m: string) => void;
  private readonly clock: () => Date;

  constructor(private readonly deps: PodDeps) {
    this.log = deps.log ?? (() => {});
    this.clock = deps.clock ?? (() => new Date());
    deps.director.onDecision((a) => this.onDecision(a));
  }

  get businesses(): Business[] {
    return this.deps.businesses;
  }

  isRunning(businessId: string): boolean {
    return this.running.has(businessId);
  }

  settings(businessId: string): StoreSettings {
    const b = this.business(businessId);
    const saved = this.deps.store.getKv(`pod.settings.${businessId}`);
    const parsed = saved ? (JSON.parse(saved) as Partial<StoreSettings>) : {};
    return {
      listingsPerDay: parsed.listingsPerDay ?? b.listingsPerDay,
      paused: parsed.paused ?? false,
    };
  }

  updateSettings(businessId: string, patch: Partial<StoreSettings>): StoreSettings {
    const next = { ...this.settings(businessId), ...patch };
    this.deps.store.setKv(`pod.settings.${businessId}`, JSON.stringify(next));
    return next;
  }

  countToday(businessId: string): number {
    return Number(this.deps.store.getKv(`pod.count.${businessId}.${today(this.clock())}`) ?? 0);
  }

  /** Recent listing packages, newest first. */
  packages(businessId?: string, limit = 20): ArtifactMeta[] {
    return this.deps.store
      .findArtifacts({ kind: "listing-package", limit: 200 })
      .filter((a) => !businessId || a.info?.business === businessId)
      .slice(0, limit);
  }

  /** The autopilot: each store's daily listings, one at a time, in working hours. */
  tick(): void {
    if (!this.deps.autopilot || this.running.size > 0) return;
    if (this.deps.store.getKv("station.kill") === "on") return;
    const now = this.clock();
    const [start, end] = this.deps.workingHours ?? [9, 21];
    if (now.getHours() < start || now.getHours() >= end) return;
    if ((this.deps.imagesReadyAt?.() ?? 0) > Date.now()) return;
    for (const b of this.deps.businesses) {
      const s = this.settings(b.id);
      if (s.paused || this.countToday(b.id) >= s.listingsPerDay) continue;
      if ((this.backoff.get(b.id) ?? 0) > Date.now()) continue;
      this.start(b.id);
      return;
    }
  }

  /** After a restart nothing is running: interrupted listings are marked failed. */
  recover(): number {
    let count = 0;
    for (const t of this.deps.world.sim.taskList) {
      if (t.pipeline !== "pod" || t.status !== "in_progress") continue;
      this.updateTask({ ...t, status: "failed", feedback: "Interrupted by a restart." });
      count += 1;
    }
    return count;
  }

  /** Publishing (Stage 7), wired in after construction. */
  publisher: PodPublisher | null = null;

  /** This week's experiments (Stage 10), wired in after construction. */
  experiments: {
    priceFactor(store: string): number;
    hints(store: string): { title: string | null; niche: string | null };
  } | null = null;

  /** Start a listing in the background; returns its task at once. */
  start(businessId: string, opts: { note?: string } = {}): Task {
    const business = this.business(businessId);
    if (this.deps.store.getKv("station.kill") === "on") {
      throw new Error("The station kill switch is on: no new listings.");
    }
    if (this.running.has(businessId))
      throw new Error(`${business.name} is already making a listing.`);
    const task = this.newTask(business, opts.note);
    this.running.add(businessId);
    void this.run(business, task, opts.note)
      .catch((err: unknown) => {
        this.backoff.set(businessId, Date.now() + 30 * 60_000);
        this.log(`${task.id} failed: ${String(err)}`);
      })
      .finally(() => this.running.delete(businessId));
    return task;
  }

  /** Run one listing to the end (tests await this directly). */
  async runListing(businessId: string, opts: { note?: string } = {}): Promise<ListingPackage> {
    const business = this.business(businessId);
    if (this.running.has(businessId))
      throw new Error(`${business.name} is already making a listing.`);
    const task = this.newTask(business, opts.note);
    this.running.add(businessId);
    try {
      return await this.run(business, task, opts.note);
    } finally {
      this.running.delete(businessId);
    }
  }

  // -- The pipeline --------------------------------------------------------------------------------

  private async run(business: Business, task: Task, note?: string): Promise<ListingPackage> {
    const trace: TraceStep[] = [];
    const operator = business.crew;
    const origin: Origin = {
      createdBy: operator,
      taskId: task.id,
      objectiveId: null,
      room: "factory-1",
    };
    const step = (name: string, actor: string, text: string, ids: string[] = []) => {
      trace.push({ step: name, actor, at: new Date().toISOString(), note: text, ids });
      this.say(actor, short(text, 70));
    };
    try {
      // 1. Scout: a concept for one of the store's products.
      this.act("scout", `Scouting for ${business.name}`);
      const concept = await this.scout(business, note);
      const product = this.deps.products[concept.product] as Product;
      step("concept", "scout", `${concept.niche}: ${concept.concept}`);
      this.updateTask({
        ...task,
        title: `Listing: ${short(concept.niche, 40)} (${product.title.split(",")[0]})`,
        brief: concept.concept,
      });
      this.free("scout");

      // 2. Operator: prompts and candidates.
      this.act(operator, "Writing image prompts");
      const prompts = await this.prompts(business, concept, product, note);
      step("prompts", operator, `${prompts.length} prompts for ${product.title}`);
      const candidates: ArtifactMeta[] = [];
      for (const [i, prompt] of prompts.entries()) {
        this.act(operator, `Generating ${i + 1}/${prompts.length}`);
        try {
          candidates.push(
            await this.deps.studio.generate(
              { prompt, style: product.style, title: `${short(concept.niche, 40)} ${i + 1}` },
              origin,
            ),
          );
        } catch (err) {
          step("generate", operator, `Candidate ${i + 1} failed: ${short(String(err), 120)}`);
        }
      }
      if (candidates.length === 0) throw new Error("No image could be generated.");
      step(
        "generate",
        operator,
        `${candidates.length} candidates`,
        candidates.map((c) => c.id),
      );
      this.free(operator);

      // 3. Lens: QA every candidate, keep the best; one extra round if none pass.
      this.act("lens", `QA: ${candidates.length} candidates`);
      const purpose = `${product.title} design (${business.niche})`;
      let scored = await this.qaAll(candidates, purpose);
      if (!scored.some((s) => s.qa.pass)) {
        const defects = [...new Set(scored.flatMap((s) => s.qa.vision?.defects ?? []))].slice(0, 6);
        step("qa", "lens", `None passed (${defects.join("; ") || "low scores"}); one more round`);
        const retry: ArtifactMeta[] = [];
        for (const [i, prompt] of prompts.slice(0, 2).entries()) {
          try {
            retry.push(
              await this.deps.studio.generate(
                {
                  prompt: `${prompt}. Clean and simple; avoid: ${defects.join(", ") || "artifacts"}`,
                  style: product.style,
                  title: `${short(concept.niche, 40)} retry ${i + 1}`,
                },
                origin,
              ),
            );
          } catch {
            // Counted below: a round with no images still ends the listing cleanly.
          }
        }
        scored = [...scored, ...(await this.qaAll(retry, purpose))];
      }
      const ranked = [...scored].sort(
        (a, b) => Number(b.qa.pass) - Number(a.qa.pass) || (b.qa.score ?? 0) - (a.qa.score ?? 0),
      );
      const best = ranked[0];
      if (!best?.qa.pass) {
        throw new Error(
          `No candidate passed QA (best ${best?.qa.score ?? "none"}/10: ${best?.qa.vision?.defects.join("; ") ?? best?.qa.note ?? ""}).`,
        );
      }
      step("pick", "lens", `Picked ${best.meta.id} (QA ${best.qa.score}/10)`, [best.meta.id]);
      this.free("lens");

      // 4. Production: cutout, upscale, fit to the print area.
      this.act(operator, "Preparing the print file");
      const printFile = await this.produce(best.meta, product, origin, concept.product);
      step(
        "production",
        operator,
        `Print file ${printFile.id} (${product.printArea.join("×")} at ${product.dpi} dpi)`,
        [printFile.id],
      );

      // 5. Listing copy and price.
      this.act(operator, "Writing the listing");
      const copy = await this.copy(business, concept, product);
      const description = fullDescription(copy, business, product, this.deps.rules);
      const price = priceFor(
        product,
        business,
        this.deps.rules,
        this.experiments?.priceFactor(business.id) ?? 1,
      );
      step("listing", operator, `"${short(copy.title, 50)}" at $${price.price.toFixed(2)}`);

      // 6. Mockups (the real print file on the product).
      const design = await this.deps.studio.canvas(printFile.id);
      const mock1 = await this.deps.studio.saveCanvas(
        productMockup(product.mockup, design),
        {
          title: `Mockup: ${short(copy.title, 50)}`,
          parentId: printFile.id,
          info: { op: "mockup", kind: product.mockup },
        },
        origin,
      );
      const mock2 = await this.deps.studio.saveCanvas(
        detailMockup(design, product, short(copy.title, 70)),
        {
          title: `Design detail: ${short(copy.title, 44)}`,
          parentId: printFile.id,
          info: { op: "mockup", kind: "detail" },
        },
        origin,
      );
      step("mockups", operator, "Two honest mockups", [mock1.id, mock2.id]);
      this.free(operator);

      // 7. Compliance.
      this.act("lens", "Compliance check");
      const ip = await this.deps.studio.screen(
        `${copy.title}\nTags: ${copy.tags.join(", ")}\n${copy.description}\nImage prompt: ${concept.concept}`,
        printFile.id,
      );
      // The print file itself, after cutout and fitting: leftover background, halos, cut edges.
      const printQa = await this.deps.studio.qa(
        printFile.id,
        `the print file for a ${product.title}: the design alone, cleanly separated from its background, with no leftover background shapes, halos or cut-off parts`,
        null,
      );
      const compliance = this.compliance(
        copy,
        description,
        best.qa,
        ip,
        printFile,
        product,
        printQa,
      );
      step(
        "compliance",
        "lens",
        compliance.ok
          ? `Compliance OK (IP ${ip.verdict}${compliance.warnings.length ? `, ${compliance.warnings.length} warning(s)` : ""})`
          : `Blocked: ${compliance.blockers.join("; ")}`,
      );
      this.free("lens");
      if (!compliance.ok)
        throw new Error(`Compliance blocked the listing: ${compliance.blockers.join("; ")}`);

      // 8. The package, and the Owner's Desk.
      const pkg = this.writePackage({
        task,
        business,
        productId: concept.product,
        product,
        concept,
        copy,
        description,
        price,
        best: best.meta,
        printFile,
        mockups: [mock1, mock2],
        scored,
        compliance,
        trace,
      });
      this.say(operator, `Package ${pkg.id} sent to the Owner's Desk`);
      this.deps.store.setKv(
        `pod.count.${business.id}.${today(this.clock())}`,
        String(this.countToday(business.id) + 1),
      );
      this.deps.store.saveMemory({
        agentId: "scout",
        scope: "agent",
        text: `Listed (sandbox) for ${business.name}: ${concept.niche}: ${concept.concept}`,
        tags: ["listing", business.id, concept.product],
        embedding: null,
      });
      this.updateTask({
        ...(this.deps.world.sim.task(task.id) ?? task),
        status: "done",
        artifactId: pkg.id,
      });
      return pkg;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      step("failed", operator, short(reason, 200));
      this.updateTask({
        ...(this.deps.world.sim.task(task.id) ?? task),
        status: "failed",
        feedback: reason.slice(0, 600),
      });
      this.escalateOnce(business, task, reason);
      throw err;
    } finally {
      for (const id of [...this.controlled]) this.free(id);
    }
  }

  private async scout(business: Business, note?: string): Promise<Concept> {
    const recent = this.deps.store
      .memories("scout", 60)
      .filter((m) => m.tags.includes(business.id))
      .slice(0, 8)
      .map((m) => `- ${m.text}`)
      .join("\n");
    const products = business.products
      .map((p) => `${p}: ${this.deps.products[p]?.title ?? p}`)
      .join("; ");
    const res = await this.deps.router.generate({
      tier: "creative",
      lane: this.deps.lane,
      schema: conceptSchema,
      system: [
        `You are Scout, the market researcher for an Etsy print-on-demand store: ${business.name}.`,
        `Niche: ${business.niche}. Audience: ${business.audience}.`,
        `Propose ONE fresh, specific design concept for one of these products (use the id): ${products}.`,
        `Today is ${this.clock().toDateString()}. Target what buyers will search for in the next 2 to 8 weeks (seasons, holidays, gifting moments).`,
        `Avoid: ${[...business.avoidThemes, "brands", "characters", "celebrities", "sports teams", "song lyrics", "text-heavy designs"].join(", ")}.`,
        "The design is an image without lettering. Keywords are phrases buyers type into Etsy search.",
        recent ? `Do not repeat these recent listings:\n${recent}` : "",
        note ? `The owner's feedback on the last attempt (follow it): ${note}` : "",
        this.experiments?.hints(business.id).niche
          ? `This week's niche experiment (follow it): ${this.experiments.hints(business.id).niche}`
          : "",
        "Reply with the JSON object alone. Do not explain your reasoning or list alternatives.",
      ]
        .filter(Boolean)
        .join("\n"),
      prompt: "Give the concept.",
      maxTokens: 4_000,
      purpose: `pod scout ${business.id}`,
    });
    const concept = res.data as Concept | undefined;
    if (!concept) throw new Error("Scout returned no concept.");
    if (!business.products.includes(concept.product)) {
      concept.product = business.products[0] as string;
    }
    return concept;
  }

  private async prompts(
    business: Business,
    concept: Concept,
    product: Product,
    note?: string,
  ): Promise<string[]> {
    const n = this.deps.candidates ?? 4;
    const res = await this.deps.router.generate({
      tier: "creative",
      lane: this.deps.lane,
      schema: promptsSchema,
      system: [
        `You are the operator of ${business.name}. Turn the design concept into ${n} distinct prompts for an AI image model.`,
        "Describe only the subject, composition, motifs and colours; the house style adds the rest.",
        "No words, letters or numbers in the image. No brands, logos, characters or real people.",
        "Vary the composition and motif across the prompts. Each prompt is one or two sentences.",
        note ? `The owner's feedback (follow it): ${note}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
      prompt: `Product: ${product.title}\nConcept: ${concept.concept}\nNiche: ${concept.niche}\nKeywords: ${concept.keywords.join(", ")}`,
      maxTokens: 4_000,
      purpose: `pod prompts ${business.id}`,
    });
    const prompts = (res.data as z.infer<typeof promptsSchema> | undefined)?.prompts ?? [];
    if (prompts.length === 0) throw new Error("No image prompts.");
    return prompts.slice(0, n);
  }

  private async qaAll(
    images: ArtifactMeta[],
    purpose: string,
  ): Promise<{ meta: ArtifactMeta; qa: QaResult }[]> {
    const out: { meta: ArtifactMeta; qa: QaResult }[] = [];
    for (const meta of images) {
      out.push({ meta, qa: await this.deps.studio.qa(meta.id, purpose, null) });
    }
    return out;
  }

  private async produce(
    design: ArtifactMeta,
    product: Product,
    origin: Origin,
    productId: string,
  ): Promise<ArtifactMeta> {
    const { studio } = this.deps;
    let current = design;
    const style = studio.styles().find((s) => s.id === product.style);
    if (product.fit === "contain" && style && style.cutout !== "none") {
      current = await studio.cutout(current.id, "auto", {}, origin);
      // The subject, not the generated canvas, should fill the print area.
      current = await studio.trim(current.id, origin);
    }
    const [W, H] = product.printArea;
    const w = Number(current.info?.width ?? 1024);
    const h = Number(current.info?.height ?? 1024);
    const needed = product.fit === "contain" ? Math.min(W / w, H / h) : Math.max(W / w, H / h);
    const maxSide = studio.config.upscale.maxSide;
    const factor = needed <= 1 ? 0 : needed <= 2 || Math.max(w, h) * 4 > maxSide ? 2 : 4;
    if (factor > 0) current = await studio.upscale(current.id, factor as 2 | 4, origin);
    return studio.fit(
      current.id,
      {
        width: W,
        height: H,
        fit: product.fit,
        title: `Print file: ${product.title}`,
        info: { printFile: true, product: productId, dpi: product.dpi },
      },
      origin,
    );
  }

  private async copy(business: Business, concept: Concept, product: Product): Promise<ListingCopy> {
    const { rules } = this.deps;
    const system = [
      `You write Etsy listings for ${business.name}. Voice: ${business.voice}`,
      `Title: a readable product name in Title Case, 50 to ${Math.min(110, rules.title.maxChars)} characters: the main search phrase first, then what the product is, joined with commas or a dash. Not a list of loose keywords; no ALL CAPS, no emoji.`,
      `Tags: exactly ${rules.tags.count}, each at most ${rules.tags.maxChars} characters, lowercase phrases buyers type, no repeats.`,
      "Description: two short paragraphs about the design and who it is for, then 3 to 5 bullet points.",
      "Never: brand, character or celebrity names; 'handmade'; health claims; promises about shipping times.",
      "Do not mention AI, the print partner or product specs; they are added automatically.",
      this.experiments?.hints(business.id).title
        ? `This week's title experiment (follow it): ${this.experiments.hints(business.id).title}`
        : "",
    ].join("\n");
    const prompt = `Product: ${product.title}\nConcept: ${concept.concept}\nNiche: ${concept.niche}\nKeywords: ${concept.keywords.join(", ")}\nAudience: ${business.audience}`;
    const res = await this.deps.router.generate({
      tier: "creative",
      lane: this.deps.lane,
      schema: listingCopySchema,
      system,
      prompt,
      maxTokens: 4_000,
      purpose: `pod copy ${business.id}`,
    });
    let copy = res.data as ListingCopy | undefined;
    if (!copy) throw new Error("No listing copy.");
    const problems = copyProblems(copy, rules, this.deps.blocklist);
    if (problems.length > 0) {
      try {
        const fixed = await this.deps.router.generate({
          tier: "creative",
          lane: this.deps.lane,
          schema: listingCopySchema,
          system,
          prompt: `${prompt}\n\nYour draft:\n${JSON.stringify(copy)}\n\nFix these problems and return the whole listing:\n- ${problems.join("\n- ")}`,
          maxTokens: 4_000,
          purpose: `pod copy fix ${business.id}`,
        });
        if (fixed.data) copy = fixed.data as ListingCopy;
      } catch {
        // The deterministic fix below still applies.
      }
    }
    return fixCopy(copy, rules, business.seedTags);
  }

  private compliance(
    copy: ListingCopy,
    description: string,
    qa: QaResult,
    ip: IpScreenResult,
    printFile: ArtifactMeta,
    product: Product,
    printQa?: QaResult,
  ): Compliance {
    const { rules } = this.deps;
    const blockers: string[] = [];
    const warnings: string[] = [];
    const longest = Math.max(0, ...copy.tags.map((t) => t.length));
    const titleOk = copy.title.length <= rules.title.maxChars;
    const tagsOk = copy.tags.length === rules.tags.count && longest <= rules.tags.maxChars;
    if (!titleOk) blockers.push("Title too long");
    if (!tagsOk)
      blockers.push(`Tags: ${copy.tags.length} of ${rules.tags.count}, longest ${longest}`);
    if (ip.verdict === "block") {
      blockers.push(
        `IP screen: ${[...ip.hits.map((h) => h.term), ...(ip.llm?.issues ?? [])].join(", ") || "high risk"}`,
      );
    } else if (ip.verdict === "review") {
      warnings.push(
        `IP screen asks for a human look: ${ip.llm?.issues.join("; ") || ip.note || "medium risk"}`,
      );
    }
    if (!qa.pass) blockers.push(`QA ${qa.score ?? "?"}/10`);
    if (printQa && !printQa.pass) {
      blockers.push(
        `Print file QA ${printQa.score ?? "?"}/10: ${printQa.vision?.defects.join("; ") || printQa.note || "failed"}`,
      );
    }
    const width = Number(printFile.info?.width);
    const height = Number(printFile.info?.height);
    const matches = width === product.printArea[0] && height === product.printArea[1];
    if (!matches) blockers.push("The print file does not match the print area");
    const ai = description.includes(rules.disclosures.ai);
    const partner = description.includes(rules.disclosures.productionPartner);
    if (!ai || !partner) blockers.push("A disclosure is missing");
    warnings.push(
      "Print areas and costs are defaults until Printify's catalog is connected (Stage 7).",
    );
    return {
      ok: blockers.length === 0,
      blockers,
      warnings,
      ip: {
        verdict: ip.verdict,
        hits: ip.hits.map((h) => h.term),
        risk: ip.llm?.risk ?? null,
        issues: ip.llm?.issues ?? [],
      },
      qa: { score: qa.score, pass: qa.pass, defects: qa.vision?.defects ?? [] },
      title: { chars: copy.title.length, max: rules.title.maxChars, ok: titleOk },
      tags: {
        count: copy.tags.length,
        required: rules.tags.count,
        longest,
        max: rules.tags.maxChars,
        ok: tagsOk,
      },
      disclosures: { ai, productionPartner: partner },
      printFile: { width, height, dpi: product.dpi, matches },
      mockupsHonest: true,
    };
  }

  private writePackage(p: {
    task: Task;
    business: Business;
    productId: string;
    product: Product;
    concept: Concept;
    copy: ListingCopy;
    description: string;
    price: PriceBreakdown;
    best: ArtifactMeta;
    printFile: ArtifactMeta;
    mockups: ArtifactMeta[];
    scored: { meta: ArtifactMeta; qa: QaResult }[];
    compliance: Compliance;
    trace: TraceStep[];
  }): ListingPackage {
    const { studio, store, world } = this.deps;
    const id = store.nextId("F");
    const dir = path.join(this.deps.dir, id);
    fs.mkdirSync(dir, { recursive: true });
    const zipPath = path.join(dir, `${id}.zip`);
    const pkg: ListingPackage = {
      id,
      taskId: p.task.id,
      business: p.business.id,
      product: p.productId,
      concept: p.concept.concept,
      title: p.copy.title,
      tags: p.copy.tags,
      description: p.description,
      price: p.price,
      design: p.best.id,
      printFile: p.printFile.id,
      mockups: p.mockups.map((m) => m.id),
      candidates: p.scored.map((s) => ({ id: s.meta.id, score: s.qa.score, pass: s.qa.pass })),
      compliance: p.compliance,
      trace: p.trace,
      zip: zipPath,
      createdAt: new Date().toISOString(),
    };
    pkg.trace.push({
      step: "package",
      actor: p.business.crew,
      at: new Date().toISOString(),
      note: `Package ${id} to the Owner's Desk`,
      ids: [id],
    });
    const report = complianceReport(pkg, p.product);
    const listingJson = JSON.stringify(
      {
        sandbox: true,
        store: { id: p.business.id, name: p.business.name },
        product: { id: p.productId, ...p.product },
        title: pkg.title,
        tags: pkg.tags,
        description: pkg.description,
        price: pkg.price,
        // Etsy's Creativity Standards: the seller's design, produced by a partner (D-034).
        creativity: "designed_by_seller",
        whoMade: "i_did",
        whenMade: "made_to_order",
        isSupply: false,
        aiDisclosure: this.deps.rules.disclosures.ai,
        productionPartner: this.deps.rules.disclosures.productionPartner,
        files: {
          printFile: "print-file.png",
          mockups: ["mockup-product.png", "mockup-detail.png"],
          design: "design.png",
        },
        compliance: pkg.compliance,
        trace: pkg.trace,
      },
      null,
      2,
    );
    const enc = (s: string) => new TextEncoder().encode(s);
    const files: Record<string, [Uint8Array, { level: 0 | 6 }]> = {
      "listing.json": [enc(listingJson), { level: 6 }],
      "compliance.md": [enc(report), { level: 6 }],
      "README.txt": [
        enc(
          `Listing package ${id} for ${p.business.name} (sandbox).\n\nprint-file.png      the file the print partner prints (${p.product.printArea.join("x")} px at ${p.product.dpi} dpi)\nmockup-product.png  the design on the product (code-drawn, honest)\nmockup-detail.png   the design alone, with the print area\ndesign.png          the chosen design before production\nlisting.json        title, tags, description, price, disclosures, trace\ncompliance.md       the checks this listing passed\n\nNothing here has been published. Images made in the sandbox lane are for review only;\nthe live lane re-makes them with production-licensed providers (Stage 7).\n`,
        ),
        { level: 6 },
      ],
      "print-file.png": [studio.bytes(p.printFile.id), { level: 0 }],
      "design.png": [studio.bytes(p.best.id), { level: 0 }],
      "mockup-product.png": [studio.bytes(p.mockups[0]?.id ?? p.printFile.id), { level: 0 }],
      "mockup-detail.png": [studio.bytes(p.mockups[1]?.id ?? p.printFile.id), { level: 0 }],
    };
    fs.writeFileSync(path.join(dir, "listing.json"), listingJson);
    fs.writeFileSync(path.join(dir, "compliance.md"), report);
    const zip = zipSync(files);
    fs.writeFileSync(zipPath, zip);

    const markdown = packageMarkdown(pkg, p.business.name, p.product);
    const meta: ArtifactMeta = {
      id,
      kind: "listing-package",
      title: short(pkg.title, 140),
      mime: "text/markdown",
      taskId: p.task.id,
      objectiveId: null,
      createdBy: p.business.crew,
      createdAt: world.sim.now,
      size: zip.length,
      room: "factory-1",
      review: "pending",
      parentId: p.printFile.id,
      info: {
        business: p.business.id,
        product: p.productId,
        price: pkg.price.price,
        profit: pkg.price.profit,
        qa: pkg.compliance.qa.score,
        ip: pkg.compliance.ip.verdict,
        printFile: pkg.printFile,
        mockups: pkg.mockups,
        warnings: pkg.compliance.warnings.length,
        zipBytes: zip.length,
      },
    };
    store.saveArtifact(meta, markdown, zipPath);
    world.mutate((s) => s.publish({ type: "artifact.created", t: s.now, artifact: meta }));
    this.deps.director.fileDeskItem({
      kind: "deliverable",
      title: `Listing ready: ${short(pkg.title, 80)}`,
      summary: `${p.business.name} · ${p.product.title} · $${pkg.price.price.toFixed(2)} (profit $${pkg.price.profit.toFixed(2)}) · QA ${pkg.compliance.qa.score}/10 · IP ${pkg.compliance.ip.verdict}. Accepting marks it ready for Stage 7; nothing is published.`,
      requestedBy: p.business.crew,
      objectiveId: null,
      taskId: p.task.id,
      artifactId: id,
      action: null,
    });
    return pkg;
  }

  /** The zip of a package, if it is inside the packages folder. */
  zipPath(id: string): string | null {
    const a = this.deps.store.artifact(id);
    if (!a?.path || a.meta.kind !== "listing-package") return null;
    const resolved = path.resolve(a.path);
    const root = path.resolve(this.deps.dir);
    return resolved.startsWith(root + path.sep) && fs.existsSync(resolved) ? resolved : null;
  }

  // -- Owner decisions -------------------------------------------------------------------------------

  private async onDecision(a: Approval): Promise<void> {
    // The task may have rotated out of memory: the package and the requester also identify it.
    const task = a.taskId ? this.deps.world.sim.task(a.taskId) : null;
    const pkg = a.artifactId ? this.deps.store.artifact(a.artifactId)?.meta : undefined;
    const ours =
      task?.pipeline === "pod" || pkg?.kind === "listing-package" || !!a.taskId?.startsWith("P-");
    if (!ours) return;
    const businessId =
      (typeof pkg?.info?.business === "string" ? pkg.info.business : undefined) ??
      this.deps.businesses.find((b) => b.crew === (task?.assignee ?? a.requestedBy))?.id;
    if (!businessId) return;
    const crew = this.business(businessId).crew;
    if (a.kind === "deliverable" && a.artifactId) {
      const meta = this.deps.store.updateArtifact(a.artifactId, {
        review: a.status === "approved" ? "approved" : "rejected",
        info: { decision: a.note ?? null },
      });
      if (meta) {
        this.deps.world.mutate((s) =>
          s.publish({ type: "artifact.updated", t: s.now, artifact: meta }),
        );
      }
      if (a.status === "approved") {
        this.say(crew, "Package approved.");
        this.offerPublish(a, businessId, crew);
        this.deps.store.saveMemory({
          agentId: "scout",
          scope: "agent",
          text: `The owner approved "${meta?.title ?? a.title}"${a.note ? ` (${a.note})` : ""}.`,
          tags: ["owner", "approved", businessId],
          embedding: null,
        });
      } else if (!this.running.has(businessId)) {
        this.say(crew, "Sent back. Starting over with the note.");
        this.start(businessId, { note: a.note ?? "The owner sent the last listing back." });
      }
    } else if (a.kind === "action" && a.action?.tool === PUBLISH_TOOL) {
      if (a.status !== "approved" || !this.publisher) return;
      const input = a.action.input as { packageId?: string };
      const packageId = input.packageId ?? a.artifactId ?? "";
      this.say(crew, `Publishing ${packageId}…`);
      try {
        const res = await this.publisher.publish(packageId, a.id);
        this.say(
          crew,
          res.mode === "dry-run"
            ? `Dry run done: ${res.productId} (nothing sent)`
            : `Published to Etsy: ${res.productId}`,
        );
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        this.say(crew, "Publishing stopped.");
        this.deps.director.fileDeskItem({
          kind: "escalation",
          title: `Publishing ${packageId} stopped`,
          summary: reason.slice(0, 600),
          requestedBy: crew,
          objectiveId: null,
          taskId: null,
          artifactId: packageId,
          action: null,
        });
      }
    } else if (a.kind === "escalation") {
      // The director reopened the task; a retry is a fresh run instead.
      if (task) this.updateTask({ ...task, status: "failed" });
      if (a.status === "approved" && !this.running.has(businessId)) {
        this.backoff.delete(businessId);
        this.start(businessId, a.note ? { note: a.note } : {});
      }
    }
  }

  /** After the owner accepts a package, ask once more before anything leaves the station. */
  private offerPublish(a: Approval, businessId: string, crew: string): void {
    const pub = this.publisher;
    if (!pub || !a.artifactId) return;
    const pkg = this.deps.store.artifact(a.artifactId)?.meta;
    if (!pkg) return;
    const blockers = pub.blockers(pkg.id);
    const dry = pub.mode === "dry-run";
    this.deps.director.fileDeskItem({
      kind: "action",
      title: `${dry ? "Publish (dry run)" : "Publish to Etsy"}: ${short(pkg.title, 70)}`,
      summary: [
        dry
          ? "Dry run: records the Printify calls (upload, create product, publish) without sending them."
          : `Uploads the print file to Printify, creates the product at ${Number(pkg.info?.price ?? 0).toFixed(2)} and publishes it to your Etsy shop.`,
        `${businessId}: ${pub.publishedToday(businessId)}/${pub.dailyCap} published today.`,
        blockers.filter((b) => !b.includes("not accepted")).length > 0
          ? `Blocked right now: ${blockers.filter((b) => !b.includes("not accepted")).join(" ")}`
          : "",
      ]
        .filter(Boolean)
        .join(" "),
      requestedBy: crew,
      objectiveId: null,
      taskId: a.taskId,
      artifactId: pkg.id,
      action: { tool: PUBLISH_TOOL, input: { packageId: pkg.id } },
    });
  }

  // -- Helpers ---------------------------------------------------------------------------------------

  private business(id: string): Business {
    const b = this.deps.businesses.find((x) => x.id === id);
    if (!b) throw new Error(`No store "${id}"`);
    return b;
  }

  private newTask(business: Business, note?: string): Task {
    const now = this.deps.world.sim.now;
    const task: Task = {
      id: this.deps.store.nextId("P"),
      title: `Listing: ${business.name}`,
      room: "factory-1",
      assignee: business.crew,
      status: "in_progress",
      reworks: 0,
      createdAt: now,
      updatedAt: now,
      objectiveId: null,
      ...(note ? { brief: `Owner's note: ${note}` } : {}),
      artifactId: null,
      feedback: null,
      pipeline: "pod",
    };
    this.updateTask(task);
    return task;
  }

  private updateTask(task: Task): void {
    this.deps.world.mutate((s) => s.upsertTask({ ...task, updatedAt: s.now }));
  }

  private escalateOnce(business: Business, task: Task, reason: string): void {
    const key = `pod.escalated.${business.id}.${today(this.clock())}`;
    if (this.deps.store.getKv(key)) return;
    this.deps.store.setKv(key, task.id);
    this.deps.director.fileDeskItem({
      kind: "escalation",
      title: `${business.name}: a listing failed`,
      summary: `${task.id}: ${reason.slice(0, 500)}. Retry starts a fresh listing.`,
      requestedBy: business.crew,
      objectiveId: null,
      taskId: task.id,
      artifactId: null,
      action: null,
    });
  }

  private say(id: string, text: string): void {
    if (!this.deps.world.sim.crew.some((c) => c.id === id)) return;
    this.deps.world.mutate((s) => s.sayNow(id, text));
  }

  /** Put a crew member to work on screen, unless WARDEN's runtime has them busy. */
  private act(id: string, status: string): void {
    const member = this.deps.world.sim.crew.find((c) => c.id === id);
    if (!member) return;
    this.deps.world.mutate((s) => {
      if (s.isControlled(id) && !this.controlled.has(id)) return;
      if (!s.isControlled(id)) s.control(id, true);
      this.controlled.add(id);
      const anchor = member.workstations[0];
      s.command(id, { kind: "work", status, ...(anchor ? { anchor } : {}) });
    });
    this.say(id, status);
  }

  private free(id: string): void {
    if (!this.controlled.delete(id)) return;
    this.deps.world.mutate((s) => {
      if (s.isControlled(id)) s.control(id, false);
    });
  }
}

function complianceReport(pkg: ListingPackage, product: Product): string {
  const c = pkg.compliance;
  const tick = (ok: boolean) => (ok ? "✅" : "❌");
  return `# Compliance report: ${pkg.id}

| Check | Result |
|---|---|
| Title length | ${tick(c.title.ok)} ${c.title.chars} of ${c.title.max} characters |
| Tags | ${tick(c.tags.ok)} ${c.tags.count} of ${c.tags.required}, longest ${c.tags.longest} of ${c.tags.max} |
| IP and trademark screen | ${c.ip.verdict === "clear" ? "✅" : c.ip.verdict === "review" ? "⚠️" : "❌"} ${c.ip.verdict}${c.ip.risk ? ` (model risk: ${c.ip.risk})` : ""}${c.ip.hits.length ? `; blocklist: ${c.ip.hits.join(", ")}` : ""} |
| Vision QA | ${tick(c.qa.pass)} ${c.qa.score ?? "?"}/10${c.qa.defects.length ? `; notes: ${c.qa.defects.join("; ")}` : ""} |
| AI disclosure | ${tick(c.disclosures.ai)} in the description |
| Production partner | ${tick(c.disclosures.productionPartner)} in the description |
| Print file | ${tick(c.printFile.matches)} ${c.printFile.width}×${c.printFile.height} px at ${c.printFile.dpi} dpi (${product.title}) |
| Honest mockups | ${tick(c.mockupsHonest)} code-drawn product shapes with the real print file |

${c.warnings.length ? `**Warnings**\n${c.warnings.map((w) => `- ${w}`).join("\n")}\n` : ""}${c.blockers.length ? `\n**Blockers**\n${c.blockers.map((b) => `- ${b}`).join("\n")}\n` : ""}`;
}

function packageMarkdown(pkg: ListingPackage, storeName: string, product: Product): string {
  const lines = [
    `**${storeName}** · ${product.title} · **$${pkg.price.price.toFixed(2)}** (cost $${pkg.price.cost.toFixed(2)}, Etsy fees $${pkg.price.fees.toFixed(2)}, profit $${pkg.price.profit.toFixed(2)}, ${Math.round(pkg.price.margin * 100)}%)`,
    "",
    `![Product mockup](${pkg.mockups[0] ?? pkg.printFile}) ![Design detail](${pkg.mockups[1] ?? pkg.printFile})`,
    "",
    "## Title",
    pkg.title,
    "",
    "## Tags",
    pkg.tags.map((t) => `\`${t}\``).join(" "),
    "",
    "## Description",
    pkg.description,
    "",
    complianceReport(pkg, product).replace(/^# /, "## "),
    "## Candidates",
    pkg.candidates
      .map(
        (c) =>
          `- ${c.id}: QA ${c.score ?? "?"}/10${c.pass ? " (pass)" : ""}${c.id === pkg.design ? " ← picked" : ""}`,
      )
      .join("\n"),
    "",
    "## Trace",
    pkg.trace
      .map((t) => `- ${t.at.slice(11, 19)} **${t.step}** (${t.actor}): ${t.note}`)
      .join("\n"),
    "",
    `Sandbox package: nothing is published. The ZIP holds the print file, mockups, listing.json and compliance.md.`,
  ];
  return lines.join("\n");
}
