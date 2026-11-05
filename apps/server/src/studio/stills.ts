import { createHash } from "node:crypto";
import fs from "node:fs";
import type { Lane } from "@orbital/shared";
import type { Blocklist } from "../creative/config";
import { blocklistHits } from "../creative/qa";
import type { ImageService } from "../images/imageService";
import type { Asset, AssetLibrary } from "./library";
import { terms } from "./library";

/**
 * AI stills for shots no footage fits (Stage 14): the station's image service in the video's lane
 * (Cloudflare FLUX.1-schnell in the live lane, shared with the Thumbnail Studio's daily budget).
 * FLUX returns a square; the renderer crops it to the frame and the camera move hides the rest.
 */

export interface StillRequest {
  prompt: string;
  lane: Lane;
  orientation: "portrait" | "landscape";
  seed?: number;
}

export async function generateStill(
  images: ImageService,
  library: AssetLibrary,
  req: StillRequest,
  blocklist?: Blocklist,
): Promise<Asset> {
  if (blocklist) {
    const hits = blocklistHits(req.prompt, blocklist);
    if (hits.length > 0) {
      throw new Error(
        `The still's prompt names protected IP (${hits.map((h) => h.term).join(", ")}).`,
      );
    }
  }
  const prompt = `${req.prompt}. Cinematic, detailed, no text, no logos, no watermark.`;
  const size =
    req.orientation === "portrait" ? { width: 768, height: 1344 } : { width: 1344, height: 768 };
  const res = await images.generate(req.lane, {
    prompt,
    ...size,
    ...(req.seed !== undefined ? { seed: req.seed } : {}),
  });
  const hash = createHash("sha1")
    .update(`${prompt}|${req.seed ?? ""}|${Date.now()}`)
    .digest("hex")
    .slice(0, 12);
  const ext = res.mime === "image/jpeg" ? "jpg" : "png";
  const id = `gen-${hash}`;
  const file = library.fileFor("generated", `${id}.${ext}`);
  fs.writeFileSync(file, res.bytes);
  return library.add({
    id,
    kind: "image",
    source: "generated",
    title: req.prompt.slice(0, 120),
    tags: terms(req.prompt).slice(0, 20),
    licence: `AI-generated with ${res.endpoint} (FLUX.1-schnell, Apache-2.0), ${req.lane} lane`,
    credit: "",
    path: file,
    bytes: res.bytes.length,
  });
}
