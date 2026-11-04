/** Colours and floor patterns for the room themes named in station.map.json. */

export type FloorPattern = "plate" | "grate" | "carpet" | "wood" | "check" | "hazard";

export interface Theme {
  floor: FloorPattern;
  base: string;
  seam: string;
  light: string;
  /** The room's signature colour: wall trim, floor paint, screens. */
  accent: string;
}

export const THEMES: Record<string, Theme> = {
  lab: { floor: "plate", base: "#24474f", seam: "#1a363d", light: "#2f5a63", accent: "#5ff2d0" },
  carpet: {
    floor: "carpet",
    base: "#3d2b4f",
    seam: "#312340",
    light: "#4a3660",
    accent: "#f0b8ff",
  },
  grate: { floor: "grate", base: "#1c2130", seam: "#141824", light: "#2a3246", accent: "#6fa8ff" },
  industrial: {
    floor: "plate",
    base: "#3e3a33",
    seam: "#2f2c27",
    light: "#4c473f",
    accent: "#ff9f43",
  },
  bridge: { floor: "plate", base: "#1f2a4b", seam: "#172039", light: "#2a375c", accent: "#ffd166" },
  studio: { floor: "plate", base: "#392342", seam: "#2c1a33", light: "#472d51", accent: "#ff5fa2" },
  clinic: { floor: "check", base: "#4a6863", seam: "#3d5753", light: "#56766f", accent: "#8affc1" },
  vault: { floor: "plate", base: "#2f2a1e", seam: "#242016", light: "#3c3627", accent: "#f5c542" },
  forge: { floor: "plate", base: "#3f2a24", seam: "#31201b", light: "#4d342c", accent: "#ff6b35" },
  wood: { floor: "wood", base: "#5b3f2c", seam: "#462f20", light: "#6c4b35", accent: "#ffcf8a" },
  hazard: {
    floor: "hazard",
    base: "#343840",
    seam: "#292c33",
    light: "#40444d",
    accent: "#ffd23f",
  },
};

export const CORRIDOR_THEME: Theme = {
  floor: "plate",
  base: "#2a2f3a",
  seam: "#20242d",
  light: "#343a47",
  accent: "#7fd3ff",
};

export const FALLBACK_THEME: Theme = THEMES.lab as Theme;

export function themeFor(id: string | undefined): Theme {
  return (id && THEMES[id]) || FALLBACK_THEME;
}

/** Shared material colours for walls and furniture. */
export const MAT = {
  outline: "#11131b",
  cap: "#1a1e2a",
  capEdge: "#2c3243",
  hull: "#394158",
  face: "#4a5369",
  faceLight: "#5d6883",
  faceDark: "#363d50",
  base: "#272c3a",
  metalDark: "#2a2f3e",
  metal: "#3e4559",
  metalLight: "#58627c",
  steel: "#7d8aa6",
  screen: "#0d1822",
  woodDark: "#4a3222",
  wood: "#6b4a32",
  woodLight: "#8a613f",
  glass: "rgba(120, 180, 255, 0.16)",
  glassShine: "rgba(220, 240, 255, 0.28)",
  leaf: "#3fa34d",
  leafDark: "#2b7637",
  leafLight: "#69cf74",
  pot: "#8a5a3c",
  potDark: "#5e3b27",
  gold: "#f5c542",
  goldDark: "#b88a1e",
  white: "#e9edf5",
} as const;
