import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import {
  asBoolean,
  asNumber,
  asString,
  asStringArray,
  parseObject,
  ensurePathInEnv,
} from "@paperclipai/adapter-utils/server-utils";
import {
  ensureAdapterExecutionTargetCommandResolvable,
  maybeRunSandboxInstallCommand,
  ensureAdapterExecutionTargetDirectory,
  runAdapterExecutionTargetProcess,
  runAdapterExecutionTargetShellCommand,
  describeAdapterExecutionTarget,
  resolveAdapterExecutionTargetCwd,
  prepareAdapterExecutionTargetRuntime,
  overrideAdapterExecutionTargetRemoteCwd,
} from "@paperclipai/adapter-utils/execution-target";
import { discoverMuseModels, ensureMuseModelConfiguredAndAvailable, resolveMuseModelId } from "./models.js";
import { parseMuseJsonl } from "./parse.js";
import { SANDBOX_INSTALL_COMMAND } from "../index.js";
import { prepareMuseRuntimeConfig, prepareManagedMuseRemoteHomes } from "./runtime-config.js";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function summarizeProbeDetail(stdout: string, stderr: string, parsedError: string | null): string | null {
  const raw = parsedError?.trim() || firstNonEmptyLine(stderr) || firstNonEmptyLine(stdout);
  if (!raw) return null;
  const clean = raw.replace(/\s+/g, " ").trim();
  const max = 240;
  return clean.length > max ? `${clean.slice(0, max - 1)}...` : clean;
}

function normalizeEnv(input: unknown): Record<string, string> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return {};
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (typeof value === "string") env[key] = value;
  }
  return env;
}

const MUSE_AUTH_REQUIRED_RE =
  /(?:not\s+logged\s+in|login\s+required|no\s+valid\s+auth|unauthorized|authentication\s+(?:required|failed|expired)|`?muse\s+login`?|META_API_KEY)/i;

function resolveMuseAuthPath(env: Record<string, string>): string {
  const override = env.MUSE_AUTH_PATH?.trim() || process.env.MUSE_AUTH_PATH?.trim();
  if (override) return override;
  const xdg = env.XDG_CONFIG_HOME?.trim() || process.env.XDG_CONFIG_HOME?.trim();
  const base = xdg || path.join(env.HOME?.trim() || process.env.HOME?.trim() || os.homedir(), ".config");
  return path.join(base, "muse", "auth.json");
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const command = asString(config.command, "muse");
  const target = ctx.executionTarget ?? null;
  const targetIsRemote = target?.kind === "remote";
  const targetIsSandbox = target?.kind === "remote" && target.transport === "sandbox";
  const cwd = resolveAdapterExecutionTargetCwd(target, asString(config.cwd, ""), process.cwd());
  const targetLabel = targetIsRemote
    ? ctx.environmentName ?? describeAdapterExecutionTarget(target)
    : null;
  const runId = `muse-envtest-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  if (targetLabel) {
    checks.push({
      code: "muse_environment_target",
      level: "info",
      message: `Probing inside environment: ${targetLabel}`,
    });
  }

  try {
    await ensureAdapterExecutionTargetDirectory(runId, target, cwd, {
      cwd,
      env: {},
      createIfMissing: false,
    });
    checks.push({
      code: "muse_cwd_valid",
      level: "info",
      message: `Working directory is valid: ${cwd}`,
    });
  } catch (err) {
    checks.push({
      code: "muse_cwd_invalid",
      level: "error",
      message: err instanceof Error ? err.message : "Invalid working directory",
      detail: cwd,
    });
  }

  const envConfig = parseObject(config.env);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }

  // Auth presence: META_API_KEY wins; otherwise the OAuth login lives at
  // MUSE_AUTH_PATH or $XDG_CONFIG_HOME/muse/auth.json (~/.config/muse/auth.json).
  // Remote targets cannot be inspected from here; the hello probe validates them.
  if (targetIsRemote) {
    checks.push({
      code: "muse_auth_remote_deferred",
      level: "info",
      message: `Muse authentication will be validated by the hello probe inside ${targetLabel}.`,
    });
  } else if ((env.META_API_KEY ?? process.env.META_API_KEY ?? "").trim()) {
    checks.push({
      code: "muse_auth_api_key_present",
      level: "info",
      message: "META_API_KEY is set and takes priority over the account login.",
    });
  } else {
    const authPath = resolveMuseAuthPath(env);
    try {
      await fs.access(authPath);
      checks.push({
        code: "muse_auth_login_present",
        level: "info",
        message: `Muse account login found: ${authPath}`,
      });
    } catch {
      checks.push({
        code: "muse_auth_missing",
        level: "warn",
        message: "No Muse authentication found (no META_API_KEY, no login file).",
        detail: authPath,
        hint: "Run `muse login` (Meta account, browser code) or set META_API_KEY, then retry the probe.",
      });
    }
  }

  const preparedRuntimeConfig = await prepareMuseRuntimeConfig({ env, config });
  if (asBoolean(config.dangerouslySkipPermissions, true)) {
    checks.push({
      code: "muse_headless_permissions_enabled",
      level: "info",
      message: "Muse runs headless via `muse exec` and does not stall on approval prompts.",
    });
  }
  let restoreWorkspace: (() => Promise<void>) | null = null;
  // Declared outside `try` so a failure inside `prepareAdapterExecutionTargetRuntime`
  // still has the path available for cleanup in `finally` — otherwise the
  // `fs.mkdtemp` directory leaks on the early-throw path.
  let preparedRuntimeWorkspaceLocalDir: string | null = null;
  try {
    let runtimeTarget: AdapterExecutionTarget | null = target ?? null;
    let runtimeCwd = cwd;
    if (targetIsRemote) {
      preparedRuntimeWorkspaceLocalDir = await fs.mkdtemp(path.join(os.tmpdir(), `paperclip-muse-envtest-${runId}-`));
      const preparedExecutionTargetRuntime = await prepareAdapterExecutionTargetRuntime({
        runId,
        target,
        adapterKey: "muse",
        workspaceLocalDir: preparedRuntimeWorkspaceLocalDir,
        workspaceRemoteDir: cwd,
        installCommand: SANDBOX_INSTALL_COMMAND,
        detectCommand: command,
        assets: [],
      });
      restoreWorkspace = async () => {
        await preparedExecutionTargetRuntime.restoreWorkspace().catch(() => {});
        if (preparedRuntimeWorkspaceLocalDir) {
          await fs.rm(preparedRuntimeWorkspaceLocalDir, { recursive: true, force: true }).catch(() => {});
        }
      };
      runtimeCwd = preparedExecutionTargetRuntime.workspaceRemoteDir ?? runtimeCwd;
      runtimeTarget = overrideAdapterExecutionTargetRemoteCwd(target ?? null, runtimeCwd) ?? null;
      prepareManagedMuseRemoteHomes({
        env: preparedRuntimeConfig.env,
        config,
        runtimeRootDir: preparedExecutionTargetRuntime.runtimeRootDir,
        runId,
      });
    }
    const runtimeEnv = normalizeEnv(ensurePathInEnv({ ...process.env, ...preparedRuntimeConfig.env }));

    const cwdInvalid = checks.some((check) => check.code === "muse_cwd_invalid");
    if (cwdInvalid) {
      checks.push({
        code: "muse_command_skipped",
        level: "warn",
        message: "Skipped command check because working directory validation failed.",
        detail: command,
      });
    } else {
      const installCheck = await maybeRunSandboxInstallCommand({
        runId,
        target,
        adapterKey: "muse",
        installCommand: SANDBOX_INSTALL_COMMAND,
        detectCommand: command,
        env,
      });
      if (installCheck) checks.push(installCheck);
      try {
        await ensureAdapterExecutionTargetCommandResolvable(command, runtimeTarget, runtimeCwd, runtimeEnv);
        checks.push({
          code: "muse_command_resolvable",
          level: "info",
          message: `Command is executable: ${command}`,
        });
      } catch (err) {
        checks.push({
          code: "muse_command_unresolvable",
          level: "error",
          message: err instanceof Error ? err.message : "Command is not executable",
          detail: command,
        });
      }
    }

    const canRunProbe =
      checks.every((check) => check.code !== "muse_cwd_invalid" && check.code !== "muse_command_unresolvable");

    const configuredModel = resolveMuseModelId(config.model);

    if (canRunProbe) {
      try {
        const discovered = await discoverMuseModels();
        if (discovered.length > 0) {
          checks.push({
            code: "muse_models_discovered",
            level: "info",
            message: `Resolved ${discovered.length} model(s) from the Muse catalog.`,
          });
        } else {
          checks.push({
            code: "muse_models_empty",
            level: "error",
            message: "Muse model catalog is empty.",
          });
        }
      } catch (err) {
        checks.push({
          code: "muse_models_discovery_failed",
          level: "error",
          message: err instanceof Error ? err.message : "Muse model discovery failed.",
        });
      }
    }

    let modelValidationPassed = false;
    if (canRunProbe) {
      try {
        await ensureMuseModelConfiguredAndAvailable({ model: configuredModel });
        checks.push({
          code: "muse_model_configured",
          level: "info",
          message: `Configured model: ${configuredModel}`,
        });
        modelValidationPassed = true;
      } catch (err) {
        checks.push({
          code: "muse_model_invalid",
          level: "error",
          message: err instanceof Error ? err.message : "Configured model is invalid.",
        });
      }
    }

    if (canRunProbe && modelValidationPassed) {
      const extraArgs = (() => {
        const fromExtraArgs = asStringArray(config.extraArgs);
        if (fromExtraArgs.length > 0) return fromExtraArgs;
        return asStringArray(config.args);
      })();
      const variant = asString(config.variant, "").trim();

      const helloProbeTimeoutSec = Math.max(
        1,
        asNumber(config.helloProbeTimeoutSec, targetIsSandbox ? 90 : 60),
      );

      let promptFile = "";
      let cleanupPromptFile: (() => Promise<void>) | null = null;
      try {
        if (targetIsRemote) {
          promptFile = `/tmp/paperclip-muse-helloprobe-${runId}.md`;
          const encoded = Buffer.from("Respond with hello.", "utf8").toString("base64");
          await runAdapterExecutionTargetShellCommand(
            runId,
            runtimeTarget,
            `echo ${JSON.stringify(encoded)} | base64 -d > ${JSON.stringify(promptFile)}`,
            { cwd: runtimeCwd, env: runtimeEnv, timeoutSec: 30, graceSec: 5, onLog: async () => {} },
          );
          cleanupPromptFile = async () => {
            await runAdapterExecutionTargetShellCommand(
              runId,
              runtimeTarget,
              `rm -f ${JSON.stringify(promptFile)}`,
              { cwd: runtimeCwd, env: runtimeEnv, timeoutSec: 15, graceSec: 5, onLog: async () => {} },
            ).catch(() => undefined);
          };
        } else {
          const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-muse-helloprobe-"));
          promptFile = path.join(dir, "prompt.md");
          await fs.writeFile(promptFile, "Respond with hello.", "utf8");
          cleanupPromptFile = async () => {
            await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
          };
        }

        const args = ["exec", "--json", "--prompt-file", promptFile, "--model", configuredModel];
        if (variant) args.push("--reasoning-effort", variant);
        if (extraArgs.length > 0) args.push(...extraArgs);

        const probe = await runAdapterExecutionTargetProcess(
          runId,
          runtimeTarget,
          command,
          args,
          {
            cwd: runtimeCwd,
            env: runtimeEnv,
            timeoutSec: helloProbeTimeoutSec,
            graceSec: 5,
            onLog: async () => {},
          },
        );

        const parsed = parseMuseJsonl(probe.stdout);
        const detail = summarizeProbeDetail(probe.stdout, probe.stderr, parsed.errorMessage);
        const authEvidence = `${parsed.errorMessage ?? ""}\n${probe.stdout}\n${probe.stderr}`.trim();

        if (probe.timedOut) {
          checks.push({
            code: "muse_hello_probe_timed_out",
            level: "warn",
            message: "Muse hello probe timed out.",
            hint: "Retry the probe. If this persists, run `muse exec` manually in this working directory.",
          });
        } else if ((probe.exitCode ?? 1) === 0 && !parsed.errorMessage) {
          const summary = parsed.summary.trim();
          const hasHello = /\bhello\b/i.test(summary);
          checks.push({
            code: hasHello ? "muse_hello_probe_passed" : "muse_hello_probe_unexpected_output",
            level: hasHello ? "info" : "warn",
            message: hasHello
              ? "Muse hello probe succeeded."
              : "Muse probe ran but did not return `hello` as expected.",
            ...(summary ? { detail: summary.replace(/\s+/g, " ").trim().slice(0, 240) } : {}),
            ...(hasHello
              ? {}
              : {
                  hint: "Run `muse exec --json --prompt-file <file>` manually and prompt `Respond with hello` to inspect output.",
                }),
          });
        } else if (MUSE_AUTH_REQUIRED_RE.test(authEvidence)) {
          checks.push({
            code: "muse_hello_probe_auth_required",
            level: "warn",
            message: "Muse is installed, but authentication is not ready.",
            ...(detail ? { detail } : {}),
            hint: "Run `muse login` (Meta account, browser code) or set META_API_KEY, then retry the probe.",
          });
        } else {
          checks.push({
            code: "muse_hello_probe_failed",
            level: "error",
            message: "Muse hello probe failed.",
            ...(detail ? { detail } : {}),
            hint: "Run `muse exec --json --prompt-file <file>` manually in this working directory to debug.",
          });
        }
      } catch (err) {
        checks.push({
          code: "muse_hello_probe_failed",
          level: "error",
          message: "Muse hello probe failed.",
          detail: err instanceof Error ? err.message : String(err),
          hint: "Run `muse exec --json --prompt-file <file>` manually in this working directory to debug.",
        });
      } finally {
        await cleanupPromptFile?.();
      }
    }
  } finally {
    await restoreWorkspace?.();
    if (!restoreWorkspace && preparedRuntimeWorkspaceLocalDir) {
      // Reached when `prepareAdapterExecutionTargetRuntime` threw before
      // assigning `restoreWorkspace`: clean up the temp dir directly.
      await fs.rm(preparedRuntimeWorkspaceLocalDir, { recursive: true, force: true }).catch(() => {});
    }
    await preparedRuntimeConfig.cleanup();
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
