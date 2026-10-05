import type { TranscriptEntry } from "@paperclipai/adapter-utils";

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
  const msg =
    asString(rec.message) ||
    asString(rec.reason) ||
    asString(data?.message) ||
    asString(rec.name) ||
    "";
  if (msg) return msg;
  try {
    return JSON.stringify(rec);
  } catch {
    return "";
  }
}

export function parseMuseStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const parsed = asRecord(safeJsonParse(line));
  if (!parsed) {
    return [{ kind: "stdout", ts, text: line }];
  }

  const payloadType = asString(parsed.payload_type);
  const payload = asRecord(parsed.payload);
  const stream = asRecord(parsed.stream);
  const sessionId = asString(stream?.id);

  if (payloadType === "run.output.delta") {
    const text = asString(payload?.text).trim();
    if (!text) return [];
    return [{ kind: "assistant", ts, text }];
  }

  if (payloadType === "run.terminal.completed" || asString(payload?.kind) === "run_terminal") {
    const terminal = asString(payload?.terminal, "completed");
    const text = asString(payload?.text).trim();
    const reason = asString(payload?.reason).trim();
    if (terminal !== "completed") {
      return [{ kind: "stderr", ts, text: reason || text || `muse run ended: ${terminal}` }];
    }
    return [
      {
        kind: "result",
        ts,
        text: text || "done",
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        costUsd: 0,
        subtype: sessionId ? `session ${sessionId}` : "completed",
        isError: false,
        errors: [],
      },
    ];
  }

  if (payloadType.startsWith("task.lifecycle.")) {
    const event = asRecord(payload?.event);
    const kind = asString(event?.kind);
    if (kind === "failed") {
      const text = errorText(event?.reason ?? event?.error ?? event?.message);
      return [{ kind: "system", ts, text: text ? `task failed: ${text}` : "task failed" }];
    }
    return [];
  }

  if (payloadType === "run.lifecycle.error" || payloadType === "run.error") {
    const text = errorText(payload?.error ?? payload?.message ?? payload?.reason);
    return [{ kind: "stderr", ts, text: text || line }];
  }

  return [{ kind: "stdout", ts, text: line }];
}
