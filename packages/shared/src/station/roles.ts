import type { CrewLook, CrewMember, CrewRole, CrewTier } from "./crew";

/**
 * Role templates: what the Recruitment Bay offers. Stage 4 adds prompts, tools and KPIs per role
 * in config/roles/*.yaml (server side); this is the part both server and client need.
 */
export interface RoleTemplate {
  role: CrewRole;
  title: string;
  /** Default room for a new hire. */
  room: string;
  job: string;
  tiers: CrewTier[];
  /** The Overseer is unique and cannot be hired. */
  hireable: boolean;
  /** Suit colours that suit the role; a new hire gets one of them. */
  suits: string[];
}

export const ROLE_TEMPLATES: readonly RoleTemplate[] = [
  {
    role: "overseer",
    title: "Overseer",
    room: "bridge",
    job: "Sets daily objectives, assigns, reviews, nudges, escalates",
    tiers: ["reasoning"],
    hireable: false,
    suits: ["#27325a"],
  },
  {
    role: "researcher",
    title: "Researcher",
    room: "research",
    job: "Niches, keywords, seasonality, competition",
    tiers: ["reasoning"],
    hireable: true,
    suits: ["#3f8f5a", "#2f7f8f", "#5a8f3f"],
  },
  {
    role: "operator",
    title: "Store operator",
    room: "factory-1",
    job: "Designs and lists products for an Etsy store",
    tiers: ["creative", "image"],
    hireable: true,
    suits: ["#d9772b", "#c9487a", "#7a55c7", "#3fb6a8"],
  },
  {
    role: "thumbnailer",
    title: "Thumbnail artist",
    room: "factory-2",
    job: "Thumbnail concepts and compositing",
    tiers: ["creative", "image", "vision"],
    hireable: true,
    suits: ["#e8c23a", "#e85d3a", "#3a8fe8"],
  },
  {
    role: "forger",
    title: "Asset smith",
    room: "factory-3",
    job: "Game-asset packs",
    tiers: ["creative", "image"],
    hireable: true,
    suits: ["#a8452f", "#6b4a8f", "#8f6b2f"],
  },
  {
    role: "reviewer",
    title: "QA inspector",
    room: "qa-bay",
    job: "Vision QA, IP screening, policy checks",
    tiers: ["vision", "reasoning"],
    hireable: true,
    suits: ["#e6eef2", "#d8e8f0"],
  },
  {
    role: "bookkeeper",
    title: "Bookkeeper",
    room: "vault",
    job: "Revenue sync, fees, KPIs, reports",
    tiers: ["fast"],
    hireable: true,
    suits: ["#2f5d50", "#3a4f6b"],
  },
];

export function roleTemplate(role: string): RoleTemplate {
  const t = ROLE_TEMPLATES.find((r) => r.role === role);
  if (!t) throw new Error(`Unknown role "${role}"`);
  return t;
}

const SKINS = ["#f2c7a5", "#e0ac7e", "#c68a5e", "#a8704a", "#8d5a3b", "#6e432b", "#4f3122"];
const HAIRS = [
  "#1d1a22",
  "#3b2a20",
  "#6b3d1f",
  "#a13a24",
  "#f1d36b",
  "#d6d6d6",
  "#3f7df0",
  "#c9487a",
];
const ACCENTS = ["#ffd166", "#7fe0c2", "#f4e3c1", "#5ff2ff", "#ff9f43", "#f0b8ff"];
const STYLES: CrewLook["hairStyle"][] = ["short", "long", "bun", "spiky", "swept"];
const ACCESSORIES: CrewLook["accessory"][] = [
  "none",
  "none",
  "none",
  "headset",
  "glasses",
  "goggles",
];

/** A random look for a new hire; `random` returns floats in [0, 1). */
export function randomLook(role: CrewRole, random: () => number = Math.random): CrewLook {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
  return {
    skin: pick(SKINS),
    hair: pick(HAIRS),
    hairStyle: pick(STYLES),
    suit: pick(roleTemplate(role).suits),
    accent: pick(ACCENTS),
    accessory: pick(ACCESSORIES),
  };
}

/** A lowercase id from a name, unique among `taken`. */
export function crewIdFor(name: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base =
    name
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "crew";
  let id = base;
  for (let i = 2; used.has(id); i++) id = `${base}-${i}`;
  return id;
}

/** A crew member built from a role template. Workstations are filled in by the sim. */
export function crewFromTemplate(
  id: string,
  name: string,
  role: CrewRole,
  room: string,
  look: CrewLook,
): CrewMember {
  const t = roleTemplate(role);
  return {
    id,
    name,
    role,
    title: t.title,
    room,
    job: t.job,
    tiers: [...t.tiers],
    workstations: [],
    look,
  };
}
