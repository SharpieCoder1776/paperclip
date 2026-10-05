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
  readPaperclipRuntimeSkillEntries,
  readInstalledSkillTargets,
  resolveLegacyPaperclipDesiredSkillNames,
} from "@paperclipai/adapter-utils/server-utils";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

// Muse resolves user skills under $CONFIG_DIR/skills, where CONFIG_DIR is
// $XDG_CONFIG_HOME/muse defaulting to ~/.config/muse. An explicit
// config.env.HOME re-roots ~/.config; an explicit config.env.XDG_CONFIG_HOME
// wins outright.
export function resolveMuseSkillsHome(config: Record<string, unknown>) {
  const env =
    typeof config.env === "object" && config.env !== null && !Array.isArray(config.env)
      ? (config.env as Record<string, unknown>)
      : {};
  const xdgConfigHome = asString(env.XDG_CONFIG_HOME) ?? asString(process.env.XDG_CONFIG_HOME);
  const configuredHome = asString(env.HOME);
  const base = xdgConfigHome
    ? path.resolve(xdgConfigHome)
    : path.join(configuredHome ? path.resolve(configuredHome) : os.homedir(), ".config");
  return path.join(base, "muse", "skills");
}

async function buildMuseSkillSnapshot(config: Record<string, unknown>): Promise<AdapterSkillSnapshot> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredSkills = resolveLegacyPaperclipDesiredSkillNames(config, availableEntries);
  const skillsHome = resolveMuseSkillsHome(config);
  const installed = await readInstalledSkillTargets(skillsHome);
  return buildPersistentSkillSnapshot({
    adapterType: "muse_local",
    availableEntries,
    desiredSkills,
    installed,
    skillsHome,
    locationLabel: "~/.config/muse/skills",
    installedDetail: "Installed in the Muse user skills home.",
    missingDetail: "Configured but not currently linked into the Muse user skills home.",
    externalConflictDetail: "Skill name is occupied by an external installation in the Muse skills home.",
    externalDetail: "Installed outside Paperclip management in the Muse skills home.",
    warnings: [],
  });
}

export async function listMuseSkills(ctx: AdapterSkillContext): Promise<AdapterSkillSnapshot> {
  return buildMuseSkillSnapshot(ctx.config);
}

export async function syncMuseSkills(
  ctx: AdapterSkillContext,
  desiredSkills: string[],
): Promise<AdapterSkillSnapshot> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(ctx.config, __moduleDir);
  const desiredSet = new Set([
    ...resolveLegacyPaperclipDesiredSkillNames({}, availableEntries),
    ...desiredSkills,
  ]);
  const skillsHome = resolveMuseSkillsHome(ctx.config);
  await fs.mkdir(skillsHome, { recursive: true });
  const installed = await readInstalledSkillTargets(skillsHome);
  const availableByRuntimeName = new Map(availableEntries.map((entry) => [entry.runtimeName, entry]));

  for (const available of availableEntries) {
    if (!desiredSet.has(available.key)) continue;
    const target = path.join(skillsHome, available.runtimeName);
    await ensurePaperclipSkillSymlink(available.source, target);
  }

  for (const [name, installedEntry] of installed.entries()) {
    const available = availableByRuntimeName.get(name);
    if (!available) continue;
    if (desiredSet.has(available.key)) continue;
    if (installedEntry.targetPath !== available.source) continue;
    await fs.unlink(path.join(skillsHome, name)).catch(() => {});
  }

  return buildMuseSkillSnapshot(ctx.config);
}

export function resolveMuseDesiredSkillNames(
  config: Record<string, unknown>,
  availableEntries: Array<{ key: string }>,
) {
  return resolveLegacyPaperclipDesiredSkillNames(config, availableEntries);
}
