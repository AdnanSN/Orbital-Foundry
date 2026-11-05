import fs from "node:fs";
import path from "node:path";
import {
  type CrewMember,
  type CrewRole,
  crewRoleSchema,
  type Tier,
  tierSchema,
} from "@orbital/shared";
import YAML from "yaml";
import { z } from "zod";
import { CONFIG_DIR } from "../paths";

/** A role template from config/roles/*.yaml: how an agent of that role thinks and works. */
export const roleConfigSchema = z.object({
  role: crewRoleSchema,
  title: z.string().min(1),
  tier: tierSchema,
  maxSteps: z.number().int().min(1).max(20).default(8),
  tools: z.array(z.string()).default([]),
  kpis: z.array(z.string()).default([]),
  schedule: z.record(z.string(), z.unknown()).default({}),
  system: z.string().min(1),
});
export type RoleConfig = z.infer<typeof roleConfigSchema>;

export function loadRoles(dir: string = path.join(CONFIG_DIR, "roles")): Map<CrewRole, RoleConfig> {
  const roles = new Map<CrewRole, RoleConfig>();
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".yaml"))) {
    const raw = YAML.parse(fs.readFileSync(path.join(dir, file), "utf8")) as unknown;
    const parsed = roleConfigSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        `config/roles/${file}: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
      );
    }
    roles.set(parsed.data.role, parsed.data);
  }
  return roles;
}

/** The role's system prompt, personalised for one crew member. */
export function systemPrompt(role: RoleConfig, crew: CrewMember): string {
  return role.system
    .replaceAll("{name}", crew.name)
    .replaceAll("{business}", crew.business ?? "the station")
    .trim();
}

export function tierFor(role: RoleConfig | undefined, fallback: Tier = "reasoning"): Tier {
  return role?.tier ?? fallback;
}
