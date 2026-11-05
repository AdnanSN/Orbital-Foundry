/**
 * Browse Printify with your token, to map Factory 1's products to the catalog
 * (config/products.yaml → printify: blueprintId, printProviderId, variantIds).
 *
 *   npm run printify -- shops
 *   npm run printify -- blueprints mug
 *   npm run printify -- providers <blueprintId>
 *   npm run printify -- variants <blueprintId> <printProviderId> [filter]
 *
 * Read-only: it never creates or publishes anything. Needs PRINTIFY_API_TOKEN in .env.
 */
import { loadEnv } from "../env";
import { PrintifyClient } from "../printify/client";
import { parseArgs } from "./cli";

loadEnv();
const [command, a, b, c] = parseArgs(process.argv.slice(2)).positionals;
const client = new PrintifyClient({ mode: "dry-run", token: process.env.PRINTIFY_API_TOKEN });

const usage = `Usage:
  npm run printify -- shops
  npm run printify -- blueprints [filter]
  npm run printify -- providers <blueprintId>
  npm run printify -- variants <blueprintId> <printProviderId> [filter]`;

if (!client.hasToken) {
  console.log(`PRINTIFY_API_TOKEN is not set in .env.\n\n${usage}`);
  process.exit(command ? 1 : 0);
}

try {
  if (command === "shops") {
    for (const s of await client.shops())
      console.log(`${s.id}\t${s.title}\t${s.sales_channel ?? ""}`);
  } else if (command === "blueprints") {
    const needle = a?.toLowerCase();
    const list = (await client.blueprints()).filter(
      (bp) => !needle || `${bp.title} ${bp.brand ?? ""}`.toLowerCase().includes(needle),
    );
    for (const bp of list) console.log(`${bp.id}\t${bp.title}${bp.brand ? ` (${bp.brand})` : ""}`);
    console.log(`\n${list.length} blueprints`);
  } else if (command === "providers" && a) {
    for (const p of await client.printProviders(Number(a))) console.log(`${p.id}\t${p.title}`);
  } else if (command === "variants" && a && b) {
    const needle = c?.toLowerCase();
    const list = (await client.variants(Number(a), Number(b))).filter(
      (v) => !needle || v.title.toLowerCase().includes(needle),
    );
    for (const v of list) {
      const areas = v.placeholders.map((p) => `${p.position} ${p.width}x${p.height}`).join(", ");
      console.log(`${v.id}\t${v.title}\t${areas}`);
    }
    console.log(`\n${list.length} variants`);
  } else {
    console.log(usage);
    process.exit(1);
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
