import { describe, expect, it } from "vitest";
import {
  discoverMuseModels,
  ensureMuseModelConfiguredAndAvailable,
  listMuseModels,
  requireMuseModelId,
  resolveMuseModelId,
} from "./models.js";
import { DEFAULT_MUSE_LOCAL_MODEL } from "../index.js";

describe("muse-local models", () => {
  it("defaults an empty model to the catalog default", () => {
    expect(resolveMuseModelId("")).toBe(DEFAULT_MUSE_LOCAL_MODEL);
    expect(resolveMuseModelId(undefined)).toBe(DEFAULT_MUSE_LOCAL_MODEL);
    expect(resolveMuseModelId("  ")).toBe(DEFAULT_MUSE_LOCAL_MODEL);
    expect(resolveMuseModelId("muse-spark-1.2")).toBe("muse-spark-1.2");
  });

  it("rejects blank model ids on require", () => {
    expect(() => requireMuseModelId("")).toThrow(/non-empty model id/);
    expect(() => requireMuseModelId(undefined)).toThrow(/non-empty model id/);
    expect(requireMuseModelId("muse-spark-1.3")).toBe("muse-spark-1.3");
  });

  it("discovers the static catalog including the default", async () => {
    const discovered = await discoverMuseModels();
    expect(discovered.length).toBeGreaterThan(0);
    expect(discovered.map((entry) => entry.id)).toContain(DEFAULT_MUSE_LOCAL_MODEL);
    expect(await listMuseModels()).toEqual(discovered);
  });

  it("proceeds with unknown ids instead of rejecting them", async () => {
    const models = await ensureMuseModelConfiguredAndAvailable({ model: "muse-future-9" });
    expect(models.map((entry) => entry.id)).toContain("muse-future-9");
  });
});
