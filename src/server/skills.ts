import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AdapterSkillContext,
  AdapterSkillSnapshot,
} from "@paperclipai/adapter-utils";
import {
  buildPersistentSkillSnapshot,
  ensurePaperclipSkillSymlink,
  readInstalledSkillTargets,
  readPaperclipRuntimeSkillEntries,
  resolvePaperclipDesiredSkillNames,
} from "@paperclipai/adapter-utils/server-utils";
import { resolveOmpProfile } from "./profile.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));
function configRoot(config: Record<string, unknown>): string {
  const env = typeof config.env === "object" && config.env !== null && !Array.isArray(config.env)
    ? config.env as Record<string, unknown>
    : {};
  const configured = nonEmptyString(env.PI_CONFIG_DIR) ?? nonEmptyString(process.env.PI_CONFIG_DIR) ?? ".omp";
  if (configured === "~") return os.homedir();
  if (configured.startsWith("~/") || configured.startsWith("~\\")) {
    return path.resolve(os.homedir(), configured.slice(2));
  }
  return path.resolve(os.homedir(), configured);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}


function resolveUserPath(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.resolve(os.homedir(), value.slice(2));
  }
  return path.resolve(value);
}

function resolveOmpAgentDir(config: Record<string, unknown>, override?: string): string {
  const explicitOverride = nonEmptyString(override);
  if (explicitOverride) return resolveUserPath(explicitOverride);

  const env = typeof config.env === "object" && config.env !== null && !Array.isArray(config.env)
    ? config.env as Record<string, unknown>
    : {};
  const root = configRoot(config);
  const profile = resolveOmpProfile(config).profile;
  if (profile) return path.join(root, "profiles", profile, "agent");

  const configured = [
    config.agentDir,
    env.PI_CODING_AGENT_DIR,
    process.env.PAPERCLIP_OMP_AGENT_DIR,
    process.env.PI_CODING_AGENT_DIR,
  ].map(nonEmptyString).find((value): value is string => value !== null) ?? path.join(root, "agent");
  return resolveUserPath(configured);
}

function skillsLocationLabel(skillsHome: string, config: Record<string, unknown>): string {
  const defaultSkillsHome = path.join(configRoot(config), "agent", "skills");
  return skillsHome === defaultSkillsHome ? "~/.omp/agent/skills" : skillsHome;
}

async function buildOmpSkillSnapshot(config: Record<string, unknown>): Promise<AdapterSkillSnapshot> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredSkills = resolvePaperclipDesiredSkillNames(config, availableEntries);
  const skillsHome = path.join(resolveOmpAgentDir(config), "skills");
  const installed = await readInstalledSkillTargets(skillsHome);

  return buildPersistentSkillSnapshot({
    adapterType: "omp_local",
    availableEntries,
    desiredSkills,
    installed,
    skillsHome,
    locationLabel: skillsLocationLabel(skillsHome, config),
    installedDetail: "Linked into the active OMP agent skills directory.",
    missingDetail: "Configured but not currently linked into the active OMP agent skills directory.",
    externalConflictDetail: "Skill name is occupied by an external installation; Paperclip left it unchanged.",
    externalDetail: "Installed outside Paperclip management.",
  });
}

export async function listOmpSkills(ctx: AdapterSkillContext): Promise<AdapterSkillSnapshot> {
  return buildOmpSkillSnapshot(ctx.config);
}

export async function syncOmpSkills(
  ctx: AdapterSkillContext,
  desiredSkills: string[],
): Promise<AdapterSkillSnapshot> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(ctx.config, __moduleDir);
  const desiredSet = new Set(desiredSkills);
  const skillsHome = path.join(resolveOmpAgentDir(ctx.config), "skills");
  await fs.mkdir(skillsHome, { recursive: true });
  const installed = await readInstalledSkillTargets(skillsHome);
  const availableByRuntimeName = new Map(availableEntries.map((entry) => [entry.runtimeName, entry]));

  for (const available of availableEntries) {
    if (!desiredSet.has(available.key)) continue;
    await ensurePaperclipSkillSymlink(
      available.source,
      path.join(skillsHome, available.runtimeName),
    );
  }

  for (const [name, installedEntry] of installed.entries()) {
    const available = availableByRuntimeName.get(name);
    if (!available || desiredSet.has(available.key)) continue;
    if (installedEntry.targetPath !== available.source) continue;
    await fs.unlink(path.join(skillsHome, name)).catch(() => {});
  }

  return buildOmpSkillSnapshot(ctx.config);
}

export async function ensureOmpSkills(
  config: Record<string, unknown>,
  agentDirOverride?: string,
): Promise<void> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredSet = new Set(resolvePaperclipDesiredSkillNames(config, availableEntries));
  if (desiredSet.size === 0) return;

  const skillsHome = path.join(resolveOmpAgentDir(config, agentDirOverride), "skills");
  await fs.mkdir(skillsHome, { recursive: true });
  for (const available of availableEntries) {
    if (!desiredSet.has(available.key)) continue;
    await ensurePaperclipSkillSymlink(
      available.source,
      path.join(skillsHome, available.runtimeName),
    );
  }
}
