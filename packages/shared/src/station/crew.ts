import { z } from "zod";
import { TIERS } from "../llm";

/**
 * The starting crew from ROADMAP §5. Stage 3 moves hired agents into the database and Stage 4
 * adds role templates (config/roles/*.yaml); until then this list is the crew.
 */

export const CREW_TIERS = [...TIERS, "image"] as const;
export const crewTierSchema = z.enum(CREW_TIERS);
export type CrewTier = z.infer<typeof crewTierSchema>;

export const HAIR_STYLES = ["short", "long", "bun", "spiky", "swept"] as const;
export const ACCESSORIES = ["none", "cap", "headset", "goggles", "glasses", "visor"] as const;

const hex = z.string().regex(/^#[0-9a-f]{6}$/i, "expected a #rrggbb colour");

/** Palette tokens for the code-drawn 16×16 sprite; the client derives shades from them. */
export const crewLookSchema = z.object({
  skin: hex,
  hair: hex,
  hairStyle: z.enum(HAIR_STYLES),
  suit: hex,
  accent: hex,
  eyes: hex.optional(),
  accessory: z.enum(ACCESSORIES),
});
export type CrewLook = z.infer<typeof crewLookSchema>;

export const crewMemberSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1).max(8),
  title: z.string().min(1),
  /** Home room id from the station map. */
  room: z.string(),
  job: z.string(),
  tiers: z.array(crewTierSchema).min(1),
  /** Anchor ids this crew member works at; the first one is home. */
  workstations: z.array(z.string()).min(1),
  /** The business line, for the factory crews. */
  business: z.string().optional(),
  look: crewLookSchema,
});
export type CrewMember = z.infer<typeof crewMemberSchema>;

export const OVERSEER_ID = "warden";

export const STARTING_CREW: readonly CrewMember[] = z.array(crewMemberSchema).parse([
  {
    id: "warden",
    name: "WARDEN",
    title: "Overseer",
    room: "bridge",
    job: "Sets daily objectives, assigns, reviews, nudges, escalates",
    tiers: ["reasoning"],
    workstations: ["warden-command"],
    look: {
      skin: "#c8d3e6",
      hair: "#7f8aa8",
      hairStyle: "short",
      suit: "#27325a",
      accent: "#e3b341",
      eyes: "#3ee8ff",
      accessory: "cap",
    },
  },
  {
    id: "scout",
    name: "Scout",
    title: "Researcher",
    room: "research",
    job: "Niches, keywords, seasonality, competition",
    tiers: ["reasoning"],
    workstations: ["scout-desk", "research-scope", "research-holo"],
    look: {
      skin: "#d9a066",
      hair: "#6b3d1f",
      hairStyle: "short",
      suit: "#3f8f5a",
      accent: "#d7c690",
      accessory: "headset",
    },
  },
  {
    id: "wick",
    name: "Wick",
    title: "Store operator",
    room: "factory-1",
    job: "Runs the candle store: designs and listings",
    tiers: ["creative", "image"],
    workstations: ["wick-desk", "f1-press"],
    business: "Etsy POD · Store A (candles)",
    look: {
      skin: "#f2c7a5",
      hair: "#a13a24",
      hairStyle: "bun",
      suit: "#d9772b",
      accent: "#f4e3c1",
      accessory: "none",
    },
  },
  {
    id: "gift",
    name: "Gift",
    title: "Store operator",
    room: "factory-1",
    job: "Runs the personalized-gifts store: designs and listings",
    tiers: ["creative", "image"],
    workstations: ["gift-desk", "f1-packing"],
    business: "Etsy POD · Store B (personalized gifts)",
    look: {
      skin: "#8d5a3b",
      hair: "#1d1a22",
      hairStyle: "long",
      suit: "#c9487a",
      accent: "#7fe0c2",
      accessory: "none",
    },
  },
  {
    id: "frame",
    name: "Frame",
    title: "Store operator",
    room: "factory-1",
    job: "Runs the wall-art store: designs and listings",
    tiers: ["creative", "image"],
    workstations: ["frame-desk", "f1-press"],
    business: "Etsy POD · Store C (wall art)",
    look: {
      skin: "#e0ac7e",
      hair: "#f1d36b",
      hairStyle: "spiky",
      suit: "#7a55c7",
      accent: "#f0c44c",
      accessory: "none",
    },
  },
  {
    id: "flash",
    name: "Flash",
    title: "Thumbnail artist",
    room: "factory-2",
    job: "Thumbnail concepts and compositing",
    tiers: ["creative", "image", "vision"],
    workstations: ["flash-edit", "flash-composite"],
    business: "Thumbnail Studio",
    look: {
      skin: "#b87850",
      hair: "#3f7df0",
      hairStyle: "swept",
      suit: "#e8c23a",
      accent: "#26232e",
      accessory: "headset",
    },
  },
  {
    id: "forge",
    name: "Forge",
    title: "Asset smith",
    room: "factory-3",
    job: "Game-asset packs",
    tiers: ["creative", "image"],
    workstations: ["forge-bench", "forge-furnace"],
    business: "Asset Forge",
    look: {
      skin: "#6e432b",
      hair: "#d6d6d6",
      hairStyle: "short",
      suit: "#a8452f",
      accent: "#4a4a55",
      accessory: "goggles",
    },
  },
  {
    id: "lens",
    name: "Lens",
    title: "QA inspector",
    room: "qa-bay",
    job: "Vision QA, IP screening, policy checks",
    tiers: ["vision", "reasoning"],
    workstations: ["lens-console"],
    look: {
      skin: "#f0c09a",
      hair: "#2b2440",
      hairStyle: "long",
      suit: "#e6eef2",
      accent: "#38c6d9",
      accessory: "glasses",
    },
  },
  {
    id: "ledger",
    name: "Ledger",
    title: "Bookkeeper",
    room: "vault",
    job: "Revenue sync, fees, KPIs, reports",
    tiers: ["fast"],
    workstations: ["ledger-desk", "ledger-count"],
    look: {
      skin: "#4f3122",
      hair: "#9a9aa3",
      hairStyle: "short",
      suit: "#2f5d50",
      accent: "#e3b341",
      accessory: "visor",
    },
  },
]);

export function crewMember(id: string): CrewMember {
  const c = STARTING_CREW.find((m) => m.id === id);
  if (!c) throw new Error(`Unknown crew member "${id}"`);
  return c;
}
