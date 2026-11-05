import { z } from "zod";

/**
 * A small Printify API v1 client (ROADMAP Stage 7): shops, the catalog (blueprints, print
 * providers, variants), image upload, product creation and publishing, and orders.
 *
 * Two modes:
 * - "dry-run" (the default): read calls go to Printify only when a token is set; every write is
 *   recorded instead of sent and answered with a stable fake id, so the whole publish flow can be
 *   exercised without an account.
 * - "live": writes are sent. The publisher only allows this with a token, a shop id, the live
 *   lane and an owner's approval for each product (CLAUDE.md rule 3).
 *
 * Endpoint shapes follow Printify's public API docs (https://developers.printify.com/); verify
 * them against the live API with the owner's token before the first real product (D-033).
 */

export const PRINTIFY_BASE = "https://api.printify.com/v1";

export type PrintifyMode = "dry-run" | "live";

export interface PrintifyCall {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  /** Request body with large fields (base64 images) shortened. */
  body?: unknown;
  /** True when the call was recorded, not sent. */
  dryRun: boolean;
  at: string;
}

export interface PrintifyOptions {
  mode: PrintifyMode;
  token?: string | undefined;
  fetchImpl?: typeof fetch;
  userAgent?: string;
  /** Every call, sent or recorded (for logs and tests). */
  onCall?: (call: PrintifyCall) => void;
}

export const shopSchema = z.object({
  id: z.number(),
  title: z.string(),
  sales_channel: z.string().optional(),
});
export type PrintifyShop = z.infer<typeof shopSchema>;

export const variantSchema = z.object({
  id: z.number(),
  title: z.string(),
  options: z.record(z.string(), z.unknown()).optional(),
  placeholders: z
    .array(z.object({ position: z.string(), width: z.number(), height: z.number() }))
    .default([]),
});
export type PrintifyVariant = z.infer<typeof variantSchema>;

export const uploadSchema = z.object({
  id: z.string(),
  file_name: z.string().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  preview_url: z.string().optional(),
});

export const productSchema = z.object({ id: z.string() }).passthrough();

export const orderSchema = z
  .object({
    id: z.string(),
    status: z.string(),
    created_at: z.string().optional(),
    total_price: z.number().default(0),
    total_shipping: z.number().default(0),
    total_tax: z.number().default(0),
    line_items: z
      .array(
        z
          .object({
            product_id: z.string(),
            variant_id: z.number().optional(),
            quantity: z.number().default(1),
            cost: z.number().default(0),
            shipping_cost: z.number().default(0),
            metadata: z
              .object({ title: z.string().optional(), price: z.number().optional() })
              .partial()
              .optional(),
          })
          .passthrough(),
      )
      .default([]),
  })
  .passthrough();
export type PrintifyOrder = z.infer<typeof orderSchema>;

export interface NewProduct {
  title: string;
  description: string;
  blueprintId: number;
  printProviderId: number;
  /** Prices are in cents. */
  variants: { id: number; price: number; enabled: boolean }[];
  imageId: string;
  /** Placement on the print area: centre (0.5, 0.5) and scale 1 fill it. */
  placement?: { x: number; y: number; scale: number; angle: number };
  tags: string[];
}

export class PrintifyError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "PrintifyError";
  }
}

function shorten(body: unknown): unknown {
  if (!body || typeof body !== "object") return body;
  return JSON.parse(
    JSON.stringify(body, (_k, v) =>
      typeof v === "string" && v.length > 200 ? `${v.slice(0, 40)}… (${v.length} chars)` : v,
    ),
  );
}

/** A stable fake id for a recorded write, so retries of the same request get the same id. */
function fakeId(prefix: string, seed: string): string {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return `dry-${prefix}-${(h >>> 0).toString(16).padStart(8, "0")}`;
}

export class PrintifyClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: PrintifyOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  get mode(): PrintifyMode {
    return this.opts.mode;
  }

  get hasToken(): boolean {
    return !!this.opts.token;
  }

  // -- Reads (need a token in either mode) -------------------------------------------------------

  async shops(): Promise<PrintifyShop[]> {
    return z.array(shopSchema).parse(await this.get("/shops.json"));
  }

  async blueprints(): Promise<{ id: number; title: string; brand?: string }[]> {
    return z
      .array(
        z.object({ id: z.number(), title: z.string(), brand: z.string().optional() }).passthrough(),
      )
      .parse(await this.get("/catalog/blueprints.json"));
  }

  async printProviders(blueprintId: number): Promise<{ id: number; title: string }[]> {
    return z
      .array(z.object({ id: z.number(), title: z.string() }).passthrough())
      .parse(await this.get(`/catalog/blueprints/${blueprintId}/print_providers.json`));
  }

  async variants(blueprintId: number, printProviderId: number): Promise<PrintifyVariant[]> {
    const res = z
      .object({ variants: z.array(variantSchema) })
      .passthrough()
      .parse(
        await this.get(
          `/catalog/blueprints/${blueprintId}/print_providers/${printProviderId}/variants.json`,
        ),
      );
    return res.variants;
  }

  async orders(shopId: number, page = 1): Promise<{ orders: PrintifyOrder[]; lastPage: number }> {
    const res = z
      .object({
        current_page: z.number().default(page),
        last_page: z.number().default(page),
        data: z.array(orderSchema).default([]),
      })
      .passthrough()
      .parse(await this.get(`/shops/${shopId}/orders.json?page=${page}&limit=10`));
    return { orders: res.data, lastPage: res.last_page };
  }

  // -- Writes (recorded in dry-run mode) ----------------------------------------------------------

  async uploadImage(fileName: string, png: Buffer): Promise<{ id: string }> {
    const body = { file_name: fileName, contents: png.toString("base64") };
    if (this.opts.mode === "dry-run") {
      this.record("POST", "/uploads/images.json", body);
      return { id: fakeId("img", `${fileName}:${png.length}`) };
    }
    return uploadSchema.parse(await this.send("POST", "/uploads/images.json", body));
  }

  async createProduct(shopId: number, p: NewProduct): Promise<{ id: string }> {
    const place = p.placement ?? { x: 0.5, y: 0.5, scale: 1, angle: 0 };
    const enabled = p.variants.filter((v) => v.enabled).map((v) => v.id);
    const body = {
      title: p.title,
      description: p.description,
      blueprint_id: p.blueprintId,
      print_provider_id: p.printProviderId,
      tags: p.tags,
      variants: p.variants.map((v) => ({ id: v.id, price: v.price, is_enabled: v.enabled })),
      print_areas: [
        {
          variant_ids: enabled,
          placeholders: [{ position: "front", images: [{ id: p.imageId, ...place }] }],
        },
      ],
    };
    const path = `/shops/${shopId}/products.json`;
    if (this.opts.mode === "dry-run") {
      this.record("POST", path, body);
      return { id: fakeId("product", `${shopId}:${p.title}:${p.imageId}`) };
    }
    return productSchema.parse(await this.send("POST", path, body));
  }

  async publishProduct(shopId: number, productId: string): Promise<void> {
    const body = {
      title: true,
      description: true,
      images: true,
      variants: true,
      tags: true,
      keyFeatures: true,
      shipping_template: true,
    };
    const path = `/shops/${shopId}/products/${productId}/publish.json`;
    if (this.opts.mode === "dry-run") {
      this.record("POST", path, body);
      return;
    }
    await this.send("POST", path, body);
  }

  // -- Transport ------------------------------------------------------------------------------------

  private record(method: PrintifyCall["method"], path: string, body?: unknown): void {
    this.opts.onCall?.({
      method,
      path,
      body: shorten(body),
      dryRun: true,
      at: new Date().toISOString(),
    });
  }

  private get(path: string): Promise<unknown> {
    if (!this.opts.token) {
      throw new PrintifyError(
        "No Printify token: set PRINTIFY_API_TOKEN in .env to read the catalog.",
        401,
      );
    }
    return this.send("GET", path);
  }

  private async send(
    method: PrintifyCall["method"],
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    if (!this.opts.token) throw new PrintifyError("No Printify token (PRINTIFY_API_TOKEN).", 401);
    this.opts.onCall?.({
      method,
      path,
      body: shorten(body),
      dryRun: false,
      at: new Date().toISOString(),
    });
    const res = await this.fetchImpl(`${PRINTIFY_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.opts.token}`,
        "User-Agent": this.opts.userAgent ?? "OrbitalFoundry/0.7",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    if (!res.ok) {
      // Never echo the token; Printify's error bodies don't contain it.
      throw new PrintifyError(
        `Printify ${method} ${path.split("?")[0]} failed: HTTP ${res.status} ${text.slice(0, 300)}`,
        res.status,
      );
    }
    return text ? (JSON.parse(text) as unknown) : {};
  }
}
