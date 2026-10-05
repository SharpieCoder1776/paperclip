import path from "node:path";

type PreparedMuseRuntimeConfig = {
  env: Record<string, string>;
  notes: string[];
  cleanup: () => Promise<void>;
};

// `muse exec` is headless by design and does not stall on approval prompts,
// so unlike the OpenCode adapter there is no permission config to inject.
// dangerouslySkipPermissions is accepted for config parity and recorded in
// the run notes; the approval posture of a run is governed by the server's
// permission profile, which is out of this adapter's scope.
export async function prepareMuseRuntimeConfig(input: {
  env: Record<string, string>;
  config: Record<string, unknown>;
  targetIsRemote?: boolean;
}): Promise<PreparedMuseRuntimeConfig> {
  void input.targetIsRemote;
  const skipPermissions = input.config.dangerouslySkipPermissions !== false;
  return {
    env: input.env,
    notes: skipPermissions
      ? ["muse exec runs headless; no runtime permission config injection required."]
      : [
          "dangerouslySkipPermissions is disabled, but muse exec has no interactive approval surface to preserve; proceeding headless.",
        ],
    cleanup: async () => {},
  };
}

/** Managed credentials must never leave host-only homes in a remote process. */
export function prepareManagedMuseRemoteHomes(input: {
  env: Record<string, string>;
  config: Record<string, unknown>;
  runtimeRootDir: string | null | undefined;
  runId: string;
  configDir?: string;
}): void {
  if (!input.config.managedAiConnection) return;
  if (!input.runtimeRootDir) throw new Error("Managed Muse authentication requires an isolated remote runtime directory.");
  const home = path.posix.join(input.runtimeRootDir, "managed-auth", input.runId);
  Object.assign(input.env, {
    HOME: home,
    XDG_CONFIG_HOME: input.configDir ?? path.posix.join(home, "config"),
    XDG_DATA_HOME: path.posix.join(home, "data"),
    XDG_CACHE_HOME: path.posix.join(home, "cache"),
    XDG_STATE_HOME: path.posix.join(home, "state"),
  });
}
