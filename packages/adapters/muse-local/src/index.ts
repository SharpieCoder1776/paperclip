export const type = "muse_local";
export const label = "Muse";

// Install the Muse CLI (Meta) directly from the release manifest CDN.
// Unlike the npm-distributed CLIs, Muse ships as a single self-contained
// binary per platform, so there is no registry indirection: fetch the pinned
// build for the sandbox arch, verify its SHA-256 against the manifest, and
// link it onto the non-login `sh -c` PATH (`/usr/local/bin` when root or
// passwordless sudo is available, otherwise `$HOME/.local/bin`).
//
// Pinned to the qualified release; bump MUSE_VERSION plus both checksums
// together from a fresh manifest:
//   https://lookaside.facebook.com/lookaside/muse/download/?channel=muse&version=<v>&file=manifest.json
// Auth is deliberately NOT handled here: `muse login` (Meta account,
// browser code) or META_API_KEY must already be provisioned on the target.
// The hello probe in testEnvironment() fails closed with a login hint when
// neither is present.
export const MUSE_LOCAL_CLI_VERSION = "1.4.2-R4684.1";
export const MUSE_LOCAL_CLI_SHA256_X86_64 =
  "dfb3096c91f4767c4d98006460800b7ba906a0b1a408280a926a8dc19a1af64f";
export const MUSE_LOCAL_CLI_SHA256_AARCH64 =
  "fa6974c23307a0d5db91367549e41505a5e7b55dcd66c672eb2dd89c1a125ad6";

export const SANDBOX_INSTALL_COMMAND =
  'set -e && ' +
  `MUSE_VERSION="${MUSE_LOCAL_CLI_VERSION}" && ` +
  'ARCH="$(uname -m)" && ' +
  'case "$ARCH" in ' +
  `x86_64) MUSE_FILE="muse-x86-linux"; MUSE_SHA256="${MUSE_LOCAL_CLI_SHA256_X86_64}";; ` +
  `aarch64|arm64) MUSE_FILE="muse-aarch64-linux"; MUSE_SHA256="${MUSE_LOCAL_CLI_SHA256_AARCH64}";; ` +
  '*) echo "muse-local: unsupported architecture: $ARCH" >&2; exit 1;; ' +
  'esac && ' +
  'TMP_BIN="$(mktemp)" && ' +
  'curl -fsSL -o "$TMP_BIN" "https://lookaside.facebook.com/lookaside/muse/download/?channel=muse&version=$MUSE_VERSION&file=$MUSE_FILE" && ' +
  'echo "$MUSE_SHA256  $TMP_BIN" | sha256sum -c - && ' +
  'chmod +x "$TMP_BIN" && ' +
  'if [ "$(id -u)" -eq 0 ]; then ' +
  'mv -f "$TMP_BIN" /usr/local/bin/muse; ' +
  'elif command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then ' +
  'sudo mv -f "$TMP_BIN" /usr/local/bin/muse; ' +
  'else ' +
  'mkdir -p "$HOME/.local/bin" && mv -f "$TMP_BIN" "$HOME/.local/bin/muse"; ' +
  'fi';

export const DEFAULT_MUSE_LOCAL_MODEL = "muse-spark-1.3-contributor";

export function isValidMuseModelId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  return value.trim().length > 0;
}

// Static catalog: `muse` exposes no model-enumeration subcommand, so this
// mirrors the provider catalog (visible text models only; the hidden image
// model is excluded). `discoverMuseModels()` serves this list.
export const models: Array<{ id: string; label: string }> = [
  { id: "muse-spark-1.3-contributor", label: "muse-spark-1.3-contributor" },
  { id: "muse-spark-1.3", label: "muse-spark-1.3" },
  { id: "muse-spark-1.2-contributor", label: "muse-spark-1.2-contributor" },
  { id: "muse-spark-1.2", label: "muse-spark-1.2" },
];

export const MUSE_LOCAL_REASONING_EFFORT_TIERS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export const agentConfigurationDoc = `# muse_local agent configuration

Adapter: muse_local

Use when:
- You want Paperclip to run Muse (Meta) locally as the agent runtime
- You want the operator's own OAuth login (Meta account) instead of a third-party provider key
- You want session resume across heartbeats via --session-id

Don't use when:
- You need webhook-style external invocation (use openclaw_gateway or http)
- You only need one-shot shell commands (use process)
- The Muse CLI is not installed on the machine (see SANDBOX_INSTALL_COMMAND)

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process (created if missing when possible)
- instructionsFilePath (string, optional): absolute path to a markdown instructions file prepended to the run prompt
- model (string, optional): Muse model id (for example muse-spark-1.3-contributor). Defaults to muse-spark-1.3-contributor when empty.
- variant (string, optional): reasoning-effort tier passed as --reasoning-effort (minimal|low|medium|high|xhigh|max)
- dangerouslySkipPermissions (boolean, optional): accepted for config parity; muse exec already runs headless and does not stall on approval prompts
- promptTemplate (string, optional): run prompt template
- command (string, optional): defaults to "muse"
- extraArgs (string[], optional): additional CLI args
- env (object, optional): KEY=VALUE environment variables

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- Muse authenticates via ~/.config/muse/auth.json (MUSE_AUTH_PATH override) or META_API_KEY, which takes priority.
- Local runs default to --trust-workspace --disable-sandbox (the container is the boundary; muse's inner sandbox cannot enforce there). Remote runs keep muse's defaults unless extraArgs says otherwise.
- Runs are executed with: muse exec --json --prompt-file <tmp> ...
- Sessions are resumed with --session-id when the stored session cwd matches current cwd.
- The prompt is delivered via a temp --prompt-file (removed after the run), never argv, so long prompts cannot overflow the command line.
`;
