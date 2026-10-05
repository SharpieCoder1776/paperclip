import { createProviderStoppedBoundary } from "@paperclipai/adapter-utils/provider-stopped-boundary";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type AdapterExecutionContext, type AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  adapterExecutionTargetIsRemote,
  adapterExecutionTargetRemoteCwd,
  overrideAdapterExecutionTargetRemoteCwd,
  adapterExecutionTargetSessionIdentity,
  adapterExecutionTargetSessionMatches,
  adapterExecutionTargetUsesManagedHome,
  adapterExecutionTargetUsesPaperclipBridge,
  describeAdapterExecutionTarget,
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetRuntimeCommandInstalled,
  prepareAdapterExecutionTargetRuntime,
  adapterExecutionTargetDuplexObservabilityRecorder,
  adapterExecutionTargetEnablesSandboxDuplexBridge,
  readAdapterExecutionTarget,
  readAdapterExecutionTargetHomeDir,
  resolveAdapterExecutionTargetTimeoutSec,
  resolveAdapterExecutionTargetCommandForLogs,
  runAdapterExecutionTargetProcess,
  runAdapterExecutionTargetShellCommand,
  startAdapterExecutionTargetPaperclipBridge,
} from "@paperclipai/adapter-utils/execution-target";
import {
  asString,
  asNumber,
  asStringArray,
  parseObject,
  buildPaperclipEnv,
  buildRuntimeToolsEnv,
  joinPromptSections,
  buildInvocationEnvForLogs,
  ensureAbsoluteDirectory,
  ensurePaperclipSkillSymlink,
  ensurePathInEnv,
  refreshPaperclipWorkspaceEnvForExecution,
  renderTemplate,
  hydrateFreshSessionHandoff,
  selectPaperclipPromptSections,
  selectInitialCommunicationGuidance,
  isPaperclipRecoveryWakePayload,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  DEFAULT_PAPERCLIP_CONVERSATION_PROMPT_TEMPLATE,
  isPaperclipSkillSourceMissing,
  readPaperclipRuntimeSkillEntries,
  readPaperclipIssueWorkModeFromContext,
  resolveLegacyPaperclipDesiredSkillNames,
} from "@paperclipai/adapter-utils/server-utils";
import { isMuseUnknownSessionError, parseMuseJsonl } from "./parse.js";
import {
  ensureMuseModelConfiguredAndAvailable,
  resolveMuseModelId,
} from "./models.js";
import { removeMaintainerOnlySkillSymlinks } from "@paperclipai/adapter-utils/server-utils";
import { prepareMuseRuntimeConfig, prepareManagedMuseRemoteHomes } from "./runtime-config.js";
import { SANDBOX_INSTALL_COMMAND } from "../index.js";
import { resolveMuseSkillsHome } from "./skills.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

export async function ensureRemoteMuseModelConfiguredAndAvailable(input: {
  runId: string;
  executionTarget: NonNullable<AdapterExecutionContext["executionTarget"]>;
  model: string;
}) {
  void input.runId;
  void input.executionTarget;
  // The Muse CLI exposes no model-enumeration subcommand, so there is no
  // remote availability probe to run. The static catalog check in
  // ensureMuseModelConfiguredAndAvailable already ran; the real `muse exec`
  // invocation on the target is authoritative.
  await ensureMuseModelConfiguredAndAvailable({ model: input.model });
}

async function ensureMuseSkillsInjected(
  onLog: AdapterExecutionContext["onLog"],
  skillsEntries: Array<{ key: string; runtimeName: string; source: string }>,
  desiredSkillNames?: string[],
  skillsHome = resolveMuseSkillsHome({}),
) {
  await fs.mkdir(skillsHome, { recursive: true });
  const desiredSet = new Set(desiredSkillNames ?? skillsEntries.map((entry) => entry.key));
  const selectedEntries = skillsEntries.filter((entry) => desiredSet.has(entry.key));
  const removedSkills = await removeMaintainerOnlySkillSymlinks(
    skillsHome,
    selectedEntries.map((entry) => entry.runtimeName),
  );
  for (const skillName of removedSkills) {
    await onLog(
      "stderr",
      `[paperclip] Removed maintainer-only Muse skill "${skillName}" from ${skillsHome}\n`,
    );
  }
  for (const entry of selectedEntries) {
    const target = path.join(skillsHome, entry.runtimeName);

    try {
      const result = await ensurePaperclipSkillSymlink(entry.source, target);
      if (result === "skipped") continue;
      await onLog(
        "stderr",
        `[paperclip] ${result === "repaired" ? "Repaired" : "Injected"} Muse skill "${entry.key}" into ${skillsHome}\n`,
      );
    } catch (err) {
      await onLog(
        "stderr",
        `[paperclip] Failed to inject Muse skill "${entry.key}" into ${skillsHome}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
}

async function buildMuseSkillsDir(config: Record<string, unknown>): Promise<string> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-muse-skills-"));
  const target = path.join(tmp, "skills");
  await fs.mkdir(target, { recursive: true });
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredNames = new Set(resolveLegacyPaperclipDesiredSkillNames(config, availableEntries));
  for (const entry of availableEntries) {
    if (!desiredNames.has(entry.key)) continue;
    if (isPaperclipSkillSourceMissing(entry)) continue;
    await fs.symlink(entry.source, path.join(target, entry.runtimeName));
  }
  return target;
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const providerStop = createProviderStoppedBoundary(ctx.onProviderStopped);
  const { runId, agent, runtime, config, context, onLog, onMeta, onSpawn, authToken } = ctx;
  const executionTarget = readAdapterExecutionTarget({
    executionTarget: ctx.executionTarget,
    legacyRemoteExecution: ctx.executionTransport?.remoteExecution,
  });
  const executionTargetIsRemote = adapterExecutionTargetIsRemote(executionTarget);

  const promptTemplate = asString(
    config.promptTemplate,
    context.conversationMode === true
      ? DEFAULT_PAPERCLIP_CONVERSATION_PROMPT_TEMPLATE
      : DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  );
  const command = asString(config.command, "muse");
  const model = resolveMuseModelId(config.model);
  const variant = asString(config.variant, "").trim();

  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const workspaceSource = asString(workspaceContext.source, "");
  const workspaceId = asString(workspaceContext.workspaceId, "");
  const workspaceRepoUrl = asString(workspaceContext.repoUrl, "");
  const workspaceRepoRef = asString(workspaceContext.repoRef, "");
  const agentHome = asString(workspaceContext.agentHome, "");
  const workspaceHints = Array.isArray(context.paperclipWorkspaces)
    ? context.paperclipWorkspaces.filter(
        (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
      )
    : [];
  const configuredCwd = asString(config.cwd, "");
  const useConfiguredInsteadOfAgentHome = workspaceSource === "agent_home" && configuredCwd.length > 0;
  const effectiveWorkspaceCwd = useConfiguredInsteadOfAgentHome ? "" : workspaceCwd;
  const cwd = effectiveWorkspaceCwd || configuredCwd || process.cwd();
  let effectiveExecutionCwd = adapterExecutionTargetRemoteCwd(executionTarget, cwd);
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });
  const museSkillEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredMuseSkillNames = resolveLegacyPaperclipDesiredSkillNames(config, museSkillEntries);
  if (!executionTargetIsRemote) {
    await ensureMuseSkillsInjected(
      onLog,
      museSkillEntries,
      desiredMuseSkillNames,
      resolveMuseSkillsHome(config),
    );
  }

  const envConfig = parseObject(config.env);
  const env: Record<string, string> = {
    ...buildPaperclipEnv(agent),
    ...buildRuntimeToolsEnv(ctx.runtimeTools),
  };
  env.PAPERCLIP_RUN_ID = runId;
  const wakeTaskId =
    (typeof context.taskId === "string" && context.taskId.trim().length > 0 && context.taskId.trim()) ||
    (typeof context.issueId === "string" && context.issueId.trim().length > 0 && context.issueId.trim()) ||
    null;
  const wakeReason =
    typeof context.wakeReason === "string" && context.wakeReason.trim().length > 0
      ? context.wakeReason.trim()
      : null;
  const wakeCommentId =
    (typeof context.wakeCommentId === "string" && context.wakeCommentId.trim().length > 0 && context.wakeCommentId.trim()) ||
    (typeof context.commentId === "string" && context.commentId.trim().length > 0 && context.commentId.trim()) ||
    null;
  const approvalId =
    typeof context.approvalId === "string" && context.approvalId.trim().length > 0
      ? context.approvalId.trim()
      : null;
  const approvalStatus =
    typeof context.approvalStatus === "string" && context.approvalStatus.trim().length > 0
      ? context.approvalStatus.trim()
      : null;
  const linkedIssueIds = Array.isArray(context.issueIds)
    ? context.issueIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
  const issueWorkMode = readPaperclipIssueWorkModeFromContext(context);
  if (wakeTaskId) env.PAPERCLIP_TASK_ID = wakeTaskId;
  if (issueWorkMode) env.PAPERCLIP_ISSUE_WORK_MODE = issueWorkMode;
  if (wakeReason) env.PAPERCLIP_WAKE_REASON = wakeReason;
  if (wakeCommentId) env.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;
  if (approvalId) env.PAPERCLIP_APPROVAL_ID = approvalId;
  if (approvalStatus) env.PAPERCLIP_APPROVAL_STATUS = approvalStatus;
  if (linkedIssueIds.length > 0) env.PAPERCLIP_LINKED_ISSUE_IDS = linkedIssueIds.join(",");
  refreshPaperclipWorkspaceEnvForExecution({
    env,
    envConfig,
    workspaceCwd: effectiveWorkspaceCwd,
    workspaceSource,
    workspaceId,
    workspaceRepoUrl,
    workspaceRepoRef,
    workspaceHints,
    agentHome,
    executionTargetIsRemote,
    executionCwd: effectiveExecutionCwd,
  });
  if (authToken) {
    env.PAPERCLIP_API_KEY = authToken;
  }
  const preparedRuntimeConfig = await prepareMuseRuntimeConfig({ env, config });
  try {
    const runtimeEnv = Object.fromEntries(
      Object.entries(ensurePathInEnv({ ...process.env, ...preparedRuntimeConfig.env })).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
    const timeoutSec = resolveAdapterExecutionTargetTimeoutSec(
      executionTarget,
      asNumber(config.timeoutSec, 0),
    );
    const graceSec = asNumber(config.graceSec, 20);
    await ensureAdapterExecutionTargetRuntimeCommandInstalled({
      runId,
      target: executionTarget,
      installCommand: ctx.runtimeCommandSpec?.installCommand,
      detectCommand: ctx.runtimeCommandSpec?.detectCommand,
      cwd,
      env: runtimeEnv,
      timeoutSec,
      graceSec,
      onLog,
    });
    await ensureAdapterExecutionTargetCommandResolvable(command, executionTarget, cwd, runtimeEnv, {
      installCommand: SANDBOX_INSTALL_COMMAND,
      timeoutSec,
    });
    const resolvedCommand = await resolveAdapterExecutionTargetCommandForLogs(command, executionTarget, cwd, runtimeEnv);
    let loggedEnv = buildInvocationEnvForLogs(preparedRuntimeConfig.env, {
      runtimeEnv,
      includeRuntimeKeys: ["HOME"],
      resolvedCommand,
    });
    if (!executionTargetIsRemote) {
      await ensureMuseModelConfiguredAndAvailable({ model });
    }

    const extraArgs = (() => {
      const fromExtraArgs = asStringArray(config.extraArgs);
      if (fromExtraArgs.length > 0) return fromExtraArgs;
      return asStringArray(config.args);
    })();
    let restoreRemoteWorkspace: (() => Promise<void>) | null = null;
    let localSkillsDir: string | null = null;
    let remoteRuntimeRootDir: string | null = null;
    let paperclipBridge: Awaited<ReturnType<typeof startAdapterExecutionTargetPaperclipBridge>> = null;

    if (executionTarget?.kind === "remote") {
      localSkillsDir = await buildMuseSkillsDir(config);
      await onLog(
        "stdout",
        `[paperclip] Syncing workspace and Muse runtime assets to ${describeAdapterExecutionTarget(executionTarget)}.\n`,
      );
      const preparedExecutionTargetRuntime = await prepareAdapterExecutionTargetRuntime({
        runId,
        target: executionTarget,
        adapterKey: "muse",
        timeoutSec,
        workspaceLocalDir: cwd,
        installCommand: SANDBOX_INSTALL_COMMAND,
        detectCommand: command,
        onProgress: (line) => onLog("stdout", line),
        onRuntimeProgress: ctx.onRuntimeProgress,
        assets: [
          {
            key: "skills",
            localDir: localSkillsDir,
            followSymlinks: true,
          },
        ],
      });
      restoreRemoteWorkspace = () =>
        preparedExecutionTargetRuntime.restoreWorkspace((line) => onLog("stdout", line));
      effectiveExecutionCwd = preparedExecutionTargetRuntime.workspaceRemoteDir ?? effectiveExecutionCwd;
      refreshPaperclipWorkspaceEnvForExecution({
        env: preparedRuntimeConfig.env,
        envConfig,
        workspaceCwd: effectiveWorkspaceCwd,
        workspaceSource,
        workspaceId,
        workspaceRepoUrl,
        workspaceRepoRef,
        workspaceHints,
        agentHome,
        executionTargetIsRemote,
        executionCwd: effectiveExecutionCwd,
      });
      remoteRuntimeRootDir = preparedExecutionTargetRuntime.runtimeRootDir;
      const managedHome = adapterExecutionTargetUsesManagedHome(executionTarget);
      if (managedHome && preparedExecutionTargetRuntime.runtimeRootDir) {
        preparedRuntimeConfig.env.HOME = preparedExecutionTargetRuntime.runtimeRootDir;
      }
      prepareManagedMuseRemoteHomes({
        env: preparedRuntimeConfig.env,
        config,
        runtimeRootDir: preparedExecutionTargetRuntime.runtimeRootDir,
        runId,
      });
      const remoteHomeDir = config.managedAiConnection
        ? preparedRuntimeConfig.env.HOME
        : managedHome && preparedExecutionTargetRuntime.runtimeRootDir
          ? preparedExecutionTargetRuntime.runtimeRootDir
          : await readAdapterExecutionTargetHomeDir(runId, executionTarget, {
            cwd,
            env: preparedRuntimeConfig.env,
            timeoutSec,
            graceSec,
            onLog,
          });
      if (remoteHomeDir && preparedExecutionTargetRuntime.assetDirs.skills) {
        const remoteSkillsDir = path.posix.join(remoteHomeDir, ".config", "muse", "skills");
        await runAdapterExecutionTargetShellCommand(
          runId,
          executionTarget,
          `mkdir -p ${JSON.stringify(path.posix.dirname(remoteSkillsDir))} && rm -rf ${JSON.stringify(remoteSkillsDir)} && cp -a ${JSON.stringify(preparedExecutionTargetRuntime.assetDirs.skills)} ${JSON.stringify(remoteSkillsDir)}`,
          { cwd, env: preparedRuntimeConfig.env, timeoutSec, graceSec, onLog },
        );
      }
      await ensureRemoteMuseModelConfiguredAndAvailable({
        runId,
        executionTarget,
        model,
      });
    }
    const runtimeExecutionTarget = overrideAdapterExecutionTargetRemoteCwd(executionTarget, effectiveExecutionCwd);
    if (executionTargetIsRemote && adapterExecutionTargetUsesPaperclipBridge(runtimeExecutionTarget)) {
      paperclipBridge = await startAdapterExecutionTargetPaperclipBridge({
        runId,
        target: runtimeExecutionTarget,
        enableSandboxDuplexBridge: adapterExecutionTargetEnablesSandboxDuplexBridge(runtimeExecutionTarget),
        duplexObservabilityRecorder: adapterExecutionTargetDuplexObservabilityRecorder(runtimeExecutionTarget),
        runtimeRootDir: remoteRuntimeRootDir,
        adapterKey: "muse",
        timeoutSec,
        hostApiToken: preparedRuntimeConfig.env.PAPERCLIP_API_KEY,
        onLog,
      });
      if (paperclipBridge) {
        Object.assign(preparedRuntimeConfig.env, paperclipBridge.env);
        loggedEnv = buildInvocationEnvForLogs(preparedRuntimeConfig.env, {
          runtimeEnv: Object.fromEntries(
            Object.entries(ensurePathInEnv({ ...process.env, ...preparedRuntimeConfig.env })).filter(
              (entry): entry is [string, string] => typeof entry[1] === "string",
            ),
          ),
          includeRuntimeKeys: ["HOME"],
          resolvedCommand,
        });
      }
    }

    const runtimeSessionParams = parseObject(runtime.sessionParams);
    const runtimeSessionId = asString(runtimeSessionParams.sessionId, runtime.sessionId ?? "");
    const runtimeSessionCwd = asString(runtimeSessionParams.cwd, "");
    const runtimeRemoteExecution = parseObject(runtimeSessionParams.remoteExecution);
    const canResumeSession =
      runtimeSessionId.length > 0 &&
      (runtimeSessionCwd.length === 0 || path.resolve(runtimeSessionCwd) === path.resolve(effectiveExecutionCwd)) &&
      adapterExecutionTargetSessionMatches(runtimeRemoteExecution, runtimeExecutionTarget);
    const sessionId = canResumeSession ? runtimeSessionId : null;
    if (executionTargetIsRemote && runtimeSessionId && !canResumeSession) {
      await onLog(
        "stdout",
        `[paperclip] Muse session "${runtimeSessionId}" does not match the current remote execution identity and will not be resumed in "${effectiveExecutionCwd}". Starting a fresh remote session.\n`,
      );
    } else if (runtimeSessionId && !canResumeSession) {
      await onLog(
        "stdout",
        `[paperclip] Muse session "${runtimeSessionId}" was saved for cwd "${runtimeSessionCwd}" and will not be resumed in "${effectiveExecutionCwd}".\n`,
      );
    }
    const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
    const resolvedInstructionsFilePath = instructionsFilePath
      ? path.resolve(cwd, instructionsFilePath)
      : "";
    const instructionsDir = resolvedInstructionsFilePath ? `${path.dirname(resolvedInstructionsFilePath)}/` : "";
    let instructionsPrefix = "";
    if (resolvedInstructionsFilePath) {
      try {
        const instructionsContents = await fs.readFile(resolvedInstructionsFilePath, "utf8");
        instructionsPrefix =
          `${instructionsContents}\n\n` +
          `The above agent instructions were loaded from ${resolvedInstructionsFilePath}. ` +
          `Resolve any relative file references from ${instructionsDir}.\n\n`;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        await onLog(
          "stdout",
          `[paperclip] Warning: could not read agent instructions file "${resolvedInstructionsFilePath}": ${reason}\n`,
        );
      }
    }

    const commandNotes = (() => {
      const notes = [...preparedRuntimeConfig.notes];
      if (!resolvedInstructionsFilePath) return notes;
      if (instructionsPrefix.length > 0) {
        notes.push(`Loaded agent instructions from ${resolvedInstructionsFilePath}`);
        notes.push(
          `Prepended instructions + path directive to the prompt file (relative references from ${instructionsDir}).`,
        );
        return notes;
      }
      notes.push(
        `Configured instructionsFilePath ${resolvedInstructionsFilePath}, but file could not be read; continuing without injected instructions.`,
      );
      return notes;
    })();

    const bootstrapPromptTemplate = asString(config.bootstrapPromptTemplate, "");
    const templateData = {
      agentId: agent.id,
      companyId: agent.companyId,
      runId,
      company: { id: agent.companyId },
      agent,
      run: { id: runId, source: "on_demand" },
      context,
    };
    const buildPrompt = (resumedSession: boolean) => {
      const renderedBootstrapPrompt =
        !resumedSession && bootstrapPromptTemplate.trim().length > 0
          ? renderTemplate(bootstrapPromptTemplate, templateData).trim()
          : "";
      const { taskContextNote, wakePrompt } = selectPaperclipPromptSections(context, {
        resumedSession,
        includeCommunicationGuidance: false,
      });
      const shouldUseResumeDeltaPrompt = resumedSession && wakePrompt.length > 0;
      const renderedPrompt = shouldUseResumeDeltaPrompt || isPaperclipRecoveryWakePayload(context.paperclipWake)
        ? ""
        : renderTemplate(promptTemplate, templateData);
      const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();
      const basePrompt = joinPromptSections([
        instructionsPrefix,
        renderedBootstrapPrompt,
        wakePrompt,
        taskContextNote,
        sessionHandoffNote,
        renderedPrompt,
      ]);
      return {
        basePrompt,
        promptMetrics: {
          promptChars: basePrompt.length,
          instructionsChars: instructionsPrefix.length,
          bootstrapPromptChars: renderedBootstrapPrompt.length,
          wakePromptChars: wakePrompt.length,
          taskContextChars: taskContextNote.length,
          sessionHandoffChars: sessionHandoffNote.length,
          heartbeatPromptChars: renderedPrompt.length,
        },
      };
    };

    // The prompt travels via --prompt-file: `muse exec` documents a PROMPT
    // argv slot and --prompt-file, but no stdin contract, and argv cannot hold
    // long prompts. Local runs write a host temp file; remote runs write the
    // same bytes on the target via base64 (no shell-quoting hazard).
    const writeLocalPromptFile = async (prompt: string): Promise<{ file: string; cleanup: () => Promise<void> }> => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-muse-prompt-"));
      const file = path.join(dir, "prompt.md");
      await fs.writeFile(file, prompt, "utf8");
      return {
        file,
        cleanup: async () => {
          await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
        },
      };
    };

    const writeRemotePromptFile = async (prompt: string): Promise<{ file: string; cleanup: () => Promise<void> }> => {
      const remoteFile = `/tmp/paperclip-muse-prompt-${runId}.md`;
      const encoded = Buffer.from(prompt, "utf8").toString("base64");
      await runAdapterExecutionTargetShellCommand(
        runId,
        runtimeExecutionTarget,
        `echo ${JSON.stringify(encoded)} | base64 -d > ${JSON.stringify(remoteFile)}`,
        { cwd, env: preparedRuntimeConfig.env, timeoutSec: Math.min(timeoutSec || 60, 60), graceSec, onLog },
      );
      return {
        file: remoteFile,
        cleanup: async () => {
          await runAdapterExecutionTargetShellCommand(
            runId,
            runtimeExecutionTarget,
            `rm -f ${JSON.stringify(remoteFile)}`,
            { cwd, env: preparedRuntimeConfig.env, timeoutSec: 15, graceSec, onLog },
          ).catch(() => undefined);
        },
      };
    };

    const buildArgs = (resumeSessionId: string | null, promptFile: string) => {
      const args = ["exec", "--json", "--prompt-file", promptFile];
      if (resumeSessionId) args.push("--session-id", resumeSessionId);
      if (model) args.push("--model", model);
      if (variant) args.push("--reasoning-effort", variant);
      if (effectiveExecutionCwd) args.push("--workspace", effectiveExecutionCwd);
      if (!executionTargetIsRemote) {
        // Local runs execute inside PaperClip's own container boundary, where
        // `muse`'s inner Linux sandbox cannot enforce (no unshare under Docker's
        // default seccomp) and the workspace is PaperClip-managed. Run trusted
        // and unsandboxed by default; explicit extraArgs entries win.
        const extraSet = new Set(extraArgs);
        if (!extraSet.has("--trust-workspace")) args.push("--trust-workspace");
        if (!extraSet.has("--disable-sandbox")) args.push("--disable-sandbox");
      }
      if (extraArgs.length > 0) args.push(...extraArgs);
      return args;
    };

    const runAttempt = async (resumeSessionId: string | null) => {
      await hydrateFreshSessionHandoff(ctx, { resumedSession: Boolean(resumeSessionId) });
      const { basePrompt, promptMetrics } = buildPrompt(Boolean(resumeSessionId));
      const prompt = joinPromptSections([
        selectInitialCommunicationGuidance(context, { resumedSession: Boolean(resumeSessionId) }),
        basePrompt,
      ]);
      const promptFile = executionTargetIsRemote
        ? await writeRemotePromptFile(prompt)
        : await writeLocalPromptFile(prompt);
      try {
        const args = buildArgs(resumeSessionId, promptFile.file);
        if (onMeta) {
          await onMeta({
            adapterType: "muse_local",
            command: resolvedCommand,
            cwd: effectiveExecutionCwd,
            commandNotes,
            commandArgs: [...args.slice(0, 3), `<prompt-file ${prompt.length} chars>`, ...args.slice(4)],
            env: loggedEnv,
            prompt,
            promptMetrics: { ...promptMetrics, promptChars: prompt.length },
            context,
          });
        }

        const proc = await runAdapterExecutionTargetProcess(runId, runtimeExecutionTarget, command, args, {
          onProcessStopped: providerStop.beginInvocation(),
          cwd,
          env: preparedRuntimeConfig.env,
          timeoutSec,
          graceSec,
          onSpawn,
          onRuntimeProgress: ctx.onRuntimeProgress,
          onLog,
          runLogTail: paperclipBridge?.runLogTail,
          settleRunDisposition: paperclipBridge?.settleRunDisposition,
        });
        return {
          proc,
          rawStderr: proc.stderr,
          parsed: parseMuseJsonl(proc.stdout),
        };
      } finally {
        await promptFile.cleanup();
      }
    };

    const toResult = (
      attempt: {
        proc: { exitCode: number | null; signal: string | null; timedOut: boolean; stdout: string; stderr: string; errorCode?: string | null };
        rawStderr: string;
        parsed: ReturnType<typeof parseMuseJsonl>;
      },
      clearSessionOnMissingSession = false,
    ): AdapterExecutionResult => {
      if (attempt.proc.timedOut) {
        return {
          exitCode: attempt.proc.exitCode,
          signal: attempt.proc.signal,
          timedOut: true,
          errorMessage: `Timed out after ${timeoutSec}s`,
          clearSession: clearSessionOnMissingSession,
        };
      }

      const resolvedSessionId =
        attempt.parsed.sessionId ??
        (clearSessionOnMissingSession ? null : runtimeSessionId ?? runtime.sessionId ?? null);
      const resolvedSessionParams = resolvedSessionId
        ? ({
            sessionId: resolvedSessionId,
            cwd: effectiveExecutionCwd,
            ...(workspaceId ? { workspaceId } : {}),
            ...(workspaceRepoUrl ? { repoUrl: workspaceRepoUrl } : {}),
            ...(workspaceRepoRef ? { repoRef: workspaceRepoRef } : {}),
            ...(executionTargetIsRemote
              ? {
                  remoteExecution: adapterExecutionTargetSessionIdentity(runtimeExecutionTarget),
                }
              : {}),
          } as Record<string, unknown>)
        : null;

      const parsedError = typeof attempt.parsed.errorMessage === "string" ? attempt.parsed.errorMessage.trim() : "";
      const stderrLine = firstNonEmptyLine(attempt.proc.stderr);
      const rawExitCode = attempt.proc.exitCode;
      const synthesizedExitCode = parsedError && (rawExitCode ?? 0) === 0 ? 1 : rawExitCode;
      const fallbackErrorMessage =
        parsedError ||
        stderrLine ||
        `Muse exited with code ${synthesizedExitCode ?? -1}`;

      return {
        exitCode: synthesizedExitCode,
        signal: attempt.proc.signal,
        timedOut: false,
        errorMessage: (synthesizedExitCode ?? 0) === 0 ? null : fallbackErrorMessage,
        errorCode: attempt.proc.errorCode ?? null,
        usage: {
          inputTokens: attempt.parsed.usage.inputTokens,
          outputTokens: attempt.parsed.usage.outputTokens,
          cachedInputTokens: attempt.parsed.usage.cachedInputTokens,
        },
        sessionId: resolvedSessionId,
        sessionParams: resolvedSessionParams,
        sessionDisplayId: resolvedSessionId,
        provider: "meta",
        biller: "meta",
        model,
        billingType: "unknown",
        costUsd: attempt.parsed.costUsd,
        resultJson: {
          stdout: attempt.proc.stdout,
          stderr: attempt.proc.stderr,
        },
        summary: attempt.parsed.summary,
        clearSession: Boolean(clearSessionOnMissingSession && !attempt.parsed.sessionId),
      };
    };

    try {
      const initial = await runAttempt(sessionId);
      const initialFailed =
        !initial.proc.timedOut && ((initial.proc.exitCode ?? 0) !== 0 || Boolean(initial.parsed.errorMessage));
      if (
        sessionId &&
        initialFailed &&
        isMuseUnknownSessionError(initial.proc.stdout, initial.rawStderr)
      ) {
        await onLog(
          "stdout",
          `[paperclip] Muse session "${sessionId}" is unavailable; retrying with a fresh session.\n`,
        );
        const retry = await runAttempt(null);
        return toResult(retry, true);
      }

      return toResult(initial);
    } finally {
      try {
        await providerStop.collectBeforeRestore();
      } finally {
        await Promise.all([
          paperclipBridge?.stop(),
          restoreRemoteWorkspace?.(),
          localSkillsDir ? fs.rm(path.dirname(localSkillsDir), { recursive: true, force: true }).catch(() => undefined) : Promise.resolve(),
        ]);
      }
    }
  } finally {
    await preparedRuntimeConfig.cleanup();
  }
}
