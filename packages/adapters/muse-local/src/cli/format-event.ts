import pc from "picocolors";

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function errorText(value: unknown): string {
  if (typeof value === "string") return value;
  const rec = asRecord(value);
  if (!rec) return "";
  const data = asRecord(rec.data);
  const message =
    asString(rec.message) ||
    asString(rec.reason) ||
    asString(data?.message) ||
    asString(rec.name) ||
    "";
  if (message) return message;
  try {
    return JSON.stringify(rec);
  } catch {
    return "";
  }
}

export function printMuseStreamEvent(raw: string, _debug: boolean): void {
  const line = raw.trim();
  if (!line) return;

  const parsed = asRecord(safeJsonParse(line));
  if (!parsed) {
    console.log(line);
    return;
  }

  const payloadType = asString(parsed.payload_type);
  const payload = asRecord(parsed.payload);
  const stream = asRecord(parsed.stream);
  const sessionId = asString(stream?.id);

  if (payloadType === "run.output.delta") {
    const text = asString(payload?.text).trim();
    if (text) console.log(pc.green(`assistant: ${text}`));
    return;
  }

  if (payloadType === "run.lifecycle.started") {
    console.log(pc.blue(`run started${sessionId ? ` (session: ${sessionId})` : ""}`));
    return;
  }

  if (payloadType === "run.terminal.completed" || asString(payload?.kind) === "run_terminal") {
    const terminal = asString(payload?.terminal, "completed");
    const text = asString(payload?.text).trim();
    const reason = asString(payload?.reason).trim();
    if (terminal !== "completed") {
      console.log(pc.red(`run ended (${terminal}): ${reason || text || "no detail"}`));
      return;
    }
    console.log(pc.blue(`run completed${sessionId ? ` (session: ${sessionId})` : ""}`));
    if (text) console.log(pc.green(`result: ${text.slice(0, 500)}${text.length > 500 ? "..." : ""}`));
    return;
  }

  if (payloadType.startsWith("task.lifecycle.")) {
    const event = asRecord(payload?.event);
    if (asString(event?.kind) === "failed") {
      const text = errorText(event?.reason ?? event?.error ?? event?.message);
      console.log(pc.yellow(`task failed: ${text || "no detail"}`));
    }
    return;
  }

  if (payloadType === "run.lifecycle.error" || payloadType === "run.error") {
    const message = errorText(payload?.error ?? payload?.message ?? payload?.reason);
    if (message) console.log(pc.red(`error: ${message}`));
    return;
  }

  console.log(line);
}
