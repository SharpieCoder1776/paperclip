import type { AdapterModel } from "@paperclipai/adapter-utils";
import { asString } from "@paperclipai/adapter-utils/server-utils";
import { DEFAULT_MUSE_LOCAL_MODEL, isValidMuseModelId, models } from "../index.js";

function dedupeModels(entries: AdapterModel[]): AdapterModel[] {
  const seen = new Set<string>();
  const deduped: AdapterModel[] = [];
  for (const entry of entries) {
    const id = entry.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    deduped.push({ id, label: entry.label.trim() || id });
  }
  return deduped;
}

export function requireMuseModelId(input: unknown): string {
  const model = asString(input, "").trim();
  if (!isValidMuseModelId(model)) {
    throw new Error("Muse requires `adapterConfig.model` to be a non-empty model id.");
  }
  return model;
}

export function resolveMuseModelId(input: unknown): string {
  const model = asString(input, "").trim();
  return model.length > 0 ? model : DEFAULT_MUSE_LOCAL_MODEL;
}

// The Muse CLI exposes no model-enumeration subcommand, so discovery serves
// the static provider catalog. Unknown-but-plausible ids are never rejected
// here: the server-side catalog may know models this static list predates,
// and the real `muse exec` invocation is authoritative.
export async function discoverMuseModels(): Promise<AdapterModel[]> {
  return dedupeModels(models);
}

export async function ensureMuseModelConfiguredAndAvailable(input: {
  model?: unknown;
}): Promise<AdapterModel[]> {
  const model = resolveMuseModelId(input.model);
  const catalog = await discoverMuseModels();
  if (!catalog.some((entry) => entry.id === model)) {
    console.warn(
      `[muse-local] Configured model "${model}" is not in the static catalog; proceeding anyway. ` +
        "The muse exec invocation is authoritative.",
    );
    return [...catalog, { id: model, label: model }];
  }
  return catalog;
}

export async function listMuseModels(): Promise<AdapterModel[]> {
  try {
    return await discoverMuseModels();
  } catch {
    return [];
  }
}

export function resetMuseModelsCacheForTests() {
  // No cache: discovery is a static catalog. Kept for adapter API parity.
}
