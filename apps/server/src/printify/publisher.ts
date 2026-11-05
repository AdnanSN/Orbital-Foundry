import type { ArtifactMeta, Lane } from "@orbital/shared";
import type { CreativeStudio } from "../creative/studio";
import type { Business, EtsyRules, Product } from "../pod/config";
import type { SimServer } from "../sim/simServer";
import type { Ledger, Outbox } from "../vault/ledger";
import type { WorkStore } from "../work/store";
import type { PrintifyCall, PrintifyClient } from "./client";

/**
 * Publishing an approved listing package through Printify to the Etsy shop (ROADMAP §7.1 step 6
 * and Stage 7). It runs only after the owner approves the "Publish" item at the Owner's Desk, and
 * only when every guard passes:
 *
 * - the station kill switch is off and the store is not paused;
 * - the store is under its daily publish cap;
 * - the package was accepted by the owner and has not been published;
 * - in live mode: a token and shop id are set, the station runs the live lane, the product is
 *   mapped to a Printify blueprint, and the design was made by a live-lane (production-licensed)
 *   provider. Sandbox images are never sold (D-001).
 *
 * Each external step runs once per approval (the outbox), so a retry never makes a second product.
 */

export interface PublisherDeps {
  client: PrintifyClient;
  store: WorkStore;
  studio: CreativeStudio;
  world: SimServer;
  ledger: Ledger;
  outbox: Outbox;
  businesses: Business[];
  products: Record<string, Product>;
  rules: EtsyRules;
  /** The station's lane (live publishing needs "live"). */
  lane: Lane;
  /** Printify shop id (PRINTIFY_SHOP_ID); required in live mode. */
  shopId: number | null;
  /** Publishes per store per day. */
  dailyCap: number;
  storePaused(businessId: string): boolean;
  clock?: () => Date;
  log?: (m: string) => void;
}

export interface PublishResult {
  packageId: string;
  mode: "dry-run" | "live";
  productId: string;
  imageId: string;
  calls: PrintifyCall[];
}

function today(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export class PodPublisher {
  private readonly clock: () => Date;

  constructor(private readonly deps: PublisherDeps) {
    this.clock = deps.clock ?? (() => new Date());
  }

  get mode(): "dry-run" | "live" {
    return this.deps.client.mode;
  }

  get dailyCap(): number {
    return this.deps.dailyCap;
  }

  killed(): boolean {
    return this.deps.store.getKv("station.kill") === "on";
  }

  setKill(on: boolean): void {
    this.deps.store.setKv("station.kill", on ? "on" : "off");
  }

  publishedToday(businessId: string): number {
    return Number(this.deps.store.getKv(`publish.count.${businessId}.${today(this.clock())}`) ?? 0);
  }

  published(packageId: string): { mode: string; productId: string; at: string } | null {
    const saved = this.deps.store.getKv(`publish.${packageId}`);
    return saved ? (JSON.parse(saved) as { mode: string; productId: string; at: string }) : null;
  }

  /** Everything that would stop this package from being published now, in plain words. */
  blockers(packageId: string): string[] {
    const out: string[] = [];
    const pkg = this.package(packageId);
    if (!pkg) return [`No listing package "${packageId}".`];
    const businessId = String(pkg.info?.business ?? "");
    const productId = String(pkg.info?.product ?? "");
    if (this.killed()) out.push("The station kill switch is on.");
    if (this.deps.storePaused(businessId)) out.push(`${businessId} is paused.`);
    if (pkg.review !== "approved") out.push("The owner has not accepted this package.");
    if (this.published(packageId)) out.push("It is already published.");
    if (this.publishedToday(businessId) >= this.deps.dailyCap) {
      out.push(`${businessId} reached today's publish cap (${this.deps.dailyCap}).`);
    }
    if (this.mode === "live") {
      if (!this.deps.client.hasToken) out.push("No Printify token (PRINTIFY_API_TOKEN).");
      if (!this.deps.shopId) out.push("No Printify shop (PRINTIFY_SHOP_ID).");
      if (this.deps.lane !== "live") out.push("The station is not running in the live lane.");
      const mapping = this.deps.products[productId]?.printify;
      if (!mapping?.blueprintId || !mapping.printProviderId || mapping.variantIds.length === 0) {
        out.push(`${productId} is not mapped to a Printify blueprint, provider and variants.`);
      }
      const lane = this.designLane(pkg);
      if (lane !== "live") {
        out.push(
          `The design was made in the ${lane ?? "unknown"} lane; only live-lane images may be sold. Re-make it in the live lane.`,
        );
      }
    }
    return out;
  }

  async publish(packageId: string, key: string): Promise<PublishResult> {
    const blockers = this.blockers(packageId);
    if (blockers.length > 0) throw new Error(blockers.join(" "));
    const pkg = this.package(packageId) as ArtifactMeta;
    const listing = this.listing(pkg);
    const businessId = String(pkg.info?.business);
    const productId = String(pkg.info?.product);
    const product = this.deps.products[productId] as Product;
    const mapping = product.printify;
    const calls: PrintifyCall[] = [];
    const { client, outbox } = this.deps;
    const printFile = String(pkg.info?.printFile);

    const image = await outbox.once(`${key}:upload`, () =>
      client.uploadImage(`${packageId}-print-file.png`, this.deps.studio.bytes(printFile)),
    );
    const priceCents = Math.round(Number(pkg.info?.price ?? 0) * 100);
    const created = await outbox.once(`${key}:product`, () =>
      client.createProduct(this.deps.shopId ?? 0, {
        title: listing.title,
        description: listing.description,
        blueprintId: mapping.blueprintId ?? 0,
        printProviderId: mapping.printProviderId ?? 0,
        variants: (mapping.variantIds.length > 0 ? mapping.variantIds : [0]).map((id) => ({
          id,
          price: priceCents,
          enabled: true,
        })),
        imageId: image.id,
        tags: listing.tags,
      }),
    );
    await outbox.once(`${key}:publish`, async () => {
      await client.publishProduct(this.deps.shopId ?? 0, created.id);
      return { ok: true };
    });

    const dryRun = this.mode === "dry-run";
    const record = { mode: this.mode, productId: created.id, at: new Date().toISOString() };
    this.deps.store.setKv(`publish.${packageId}`, JSON.stringify(record));
    this.deps.store.setKv(
      `publish.count.${businessId}.${today(this.clock())}`,
      String(this.publishedToday(businessId) + 1),
    );
    this.deps.ledger.add({
      business: businessId,
      source: "etsy",
      kind: "fee",
      amount: -this.deps.rules.fees.listing,
      ref: `listing:${packageId}`,
      note: `Etsy listing fee${dryRun ? " (dry run)" : ""}`,
      simulated: dryRun,
    });
    const meta = this.deps.store.updateArtifact(packageId, { info: { published: record } });
    if (meta) {
      this.deps.world.mutate((s) =>
        s.publish({ type: "artifact.updated", t: s.now, artifact: meta }),
      );
    }
    this.deps.log?.(`${packageId} published (${this.mode}) as ${created.id}`);
    return { packageId, mode: this.mode, productId: created.id, imageId: image.id, calls };
  }

  /**
   * Pull new Printify orders into the ledger: the sale at our listing price, Printify's cost and
   * shipping, and Etsy's fees (estimated from the published rates). Live mode only.
   */
  async syncOrders(): Promise<{ added: number; skipped?: string }> {
    if (this.mode !== "live" || !this.deps.client.hasToken || !this.deps.shopId) {
      return { added: 0, skipped: "Order sync runs in live mode with a token and a shop id." };
    }
    let added = 0;
    const byProduct = this.productIndex();
    for (let page = 1, last = 1; page <= last && page <= 20; page++) {
      const res = await this.deps.client.orders(this.deps.shopId, page);
      last = res.lastPage;
      for (const order of res.orders) {
        for (const [i, item] of order.line_items.entries()) {
          const known = byProduct.get(item.product_id);
          const business = known?.business ?? "unknown";
          const ref = `${order.id}:${i}`;
          const retail = ((item.metadata?.price ?? 0) / 100) * item.quantity;
          const sale = this.deps.ledger.add({
            business,
            source: "printify",
            kind: "sale",
            amount: retail,
            ref,
            note: `Order ${order.id}: ${item.metadata?.title ?? item.product_id} ×${item.quantity}`,
            at: order.created_at ?? new Date().toISOString(),
          });
          if (!sale) continue;
          added += 1;
          this.deps.ledger.add({
            business,
            source: "printify",
            kind: "cost",
            amount: -((item.cost + item.shipping_cost) / 100),
            ref,
            note: `Printify production and shipping for ${order.id}`,
            at: order.created_at ?? new Date().toISOString(),
          });
          const f = this.deps.rules.fees;
          this.deps.ledger.add({
            business,
            source: "etsy",
            kind: "fee",
            amount: -((retail * (f.transactionPct + f.processingPct)) / 100 + f.processingFixed),
            ref,
            note: "Etsy transaction and processing fees (estimated)",
            at: order.created_at ?? new Date().toISOString(),
          });
        }
      }
    }
    return { added };
  }

  // -- Helpers -----------------------------------------------------------------------------------

  private package(id: string): ArtifactMeta | null {
    const a = this.deps.store.artifact(id);
    return a && a.meta.kind === "listing-package" ? a.meta : null;
  }

  private listing(pkg: ArtifactMeta): { title: string; description: string; tags: string[] } {
    const content = this.deps.store.artifact(pkg.id)?.content ?? "";
    const section = (name: string) => {
      const m = new RegExp(`## ${name}\\n([\\s\\S]*?)(?:\\n## |$)`).exec(content);
      return (m?.[1] ?? "").trim();
    };
    return {
      title: pkg.title,
      description: section("Description"),
      tags: [...section("Tags").matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? "").filter(Boolean),
    };
  }

  /** The lane of the generated image behind the package (walks the parent chain). */
  private designLane(pkg: ArtifactMeta): string | null {
    let id: string | null | undefined = String(pkg.info?.printFile ?? "");
    for (let depth = 0; id && depth < 10; depth++) {
      const meta: ArtifactMeta | undefined = this.deps.store.artifact(id)?.meta;
      if (!meta) return null;
      if (meta.info?.op === "generate") return String(meta.info.lane ?? "");
      id = meta.parentId;
    }
    return null;
  }

  private productIndex(): Map<string, { business: string; packageId: string }> {
    const out = new Map<string, { business: string; packageId: string }>();
    for (const pkg of this.deps.store.findArtifacts({ kind: "listing-package", limit: 2_000 })) {
      const pub = this.published(pkg.id);
      if (pub) out.set(pub.productId, { business: String(pkg.info?.business), packageId: pkg.id });
    }
    return out;
  }
}
