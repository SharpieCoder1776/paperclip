import { asString, parseJson, parseObject } from "@paperclipai/adapter-utils/server-utils";

function errorText(value: unknown): string {
  if (typeof value === "string") return value;
  const rec = parseObject(value);
  const message = asString(rec.message, "").trim();
  if (message) return message;
  const reason = asString(rec.reason, "").trim();
  if (reason) return reason;
  const data = parseObject(rec.data);
  const nestedMessage = asString(data.message, "").trim();
  if (nestedMessage) return nestedMessage;
  const name = asString(rec.name, "").trim();
  if (name) return name;
  const code = asString(rec.code, "").trim();
  if (code) return code;
  try {
    return JSON.stringify(rec);
  } catch {
    return "";
  }
}

function readSessionId(event: Record<string, unknown>): string {
  const stream = parseObject(event.stream);
  return (
    asString(stream.id, "").trim() ||
    asString(event.sessionId, "").trim() ||
    asString(event.session_id, "").trim()
  );
}

export function parseMuseJsonl(stdout: string) {
  let sessionId: string | null = null;
  const deltas: string[] = [];
  let terminalText: string | null = null;
  let terminalState: string | null = null;
  const errors: string[] = [];
  const toolErrors: string[] = [];
  const usage = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
  };
  const costUsd = 0;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const event = parseJson(line);
    if (!event) continue;
    const record = parseObject(event);

    const currentSessionId = readSessionId(record);
    if (currentSessionId) sessionId = currentSessionId;

    const payloadType = asString(record.payload_type, "");
    const payload = parseObject(record.payload);

    // Streaming assistant text. Deltas are best-effort progress only: the
    // terminal record below carries the authoritative final text.
    if (payloadType === "run.output.delta") {
      const text = asString(payload.text, "");
      if (text) deltas.push(text);
      continue;
    }

    // Terminal disposition of the run. This is authoritative: a completed
    // terminal record means success even when task-level failures were
    // recorded along the way (e.g. reminder children failing under the echo
    // provider while the run itself completes).
    if (payloadType === "run.terminal.completed" || payload.kind === "run_terminal") {
      const terminal = asString(payload.terminal, "completed").trim() || "completed";
      terminalState = terminal;
      const text = asString(payload.text, "").trim();
      if (text) terminalText = text;
      const reason = asString(payload.reason, "").trim();
      if (terminal !== "completed") {
        errors.push(reason || text || `muse run ended: ${terminal}`);
      }
      continue;
    }

    if (payloadType.startsWith("task.lifecycle.")) {
      const taskEvent = parseObject(payload.event);
      const kind = asString(taskEvent.kind, "");
      if (kind === "failed") {
        // Task-level failure (model call, reminder child, tool): recorded as
        // a tool error, never fatal on its own. The terminal record decides
        // the run outcome (see above).
        const text =
          errorText(taskEvent.reason ?? taskEvent.error ?? taskEvent.message).trim() ||
          `task ${asString(taskEvent.task_id, "unknown")} failed`;
        toolErrors.push(text);
      }
      continue;
    }

    if (payloadType === "run.lifecycle.error" || payloadType === "run.error") {
      const text = errorText(payload.error ?? payload.message ?? payload.reason).trim();
      if (text) errors.push(text);
      continue;
    }
  }

  return {
    sessionId,
    summary: (terminalText ?? deltas.join("")).trim(),
    usage,
    costUsd,
    terminalState,
    errorMessage: errors.length > 0 ? errors.join("\n") : null,
    toolErrors,
  };
}

export function isMuseUnknownSessionError(stdout: string, stderr: string): boolean {
  const haystack = `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");

  return /unknown\s+session|session\b.*\bnot\s+found|no\s+such\s+session|session\s+expired|invalid\s+session/i.test(
    haystack,
  );
}
