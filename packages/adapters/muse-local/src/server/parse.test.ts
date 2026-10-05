import { describe, expect, it } from "vitest";
import { parseMuseJsonl, isMuseUnknownSessionError } from "./parse.js";

function museLine(payload: Record<string, unknown>, sessionId = "01a106bd-d1c5-7140-ab64-0dd6402b259c") {
  return JSON.stringify({
    schema_version: 1,
    stream: { kind: "session", id: sessionId },
    sequence: 1,
    record_type: "event",
    ...payload,
  });
}

describe("parseMuseJsonl", () => {
  it("prefers the terminal text and tolerates task-level failures", () => {
    const stdout = [
      museLine({
        payload_type: "run.output.delta",
        payload: { kind: "run_output_delta", text: "echo: Reply with exactly: OK" },
      }),
      museLine({
        payload_type: "task.lifecycle.failed",
        payload: {
          kind: "task_lifecycle",
          event: {
            kind: "failed",
            task_id: "01a106bd-d6bf-7e03-8bd8-8820fc8449e5",
            reason: "invalid run configuration: provider does not support base instructions",
          },
        },
      }),
      museLine({
        payload_type: "run.terminal.completed",
        payload: {
          kind: "run_terminal",
          terminal: "completed",
          text: "echo: Reply with exactly: OK",
          reason: null,
        },
      }),
    ].join("\n");

    const parsed = parseMuseJsonl(stdout);
    expect(parsed.sessionId).toBe("01a106bd-d1c5-7140-ab64-0dd6402b259c");
    expect(parsed.summary).toBe("echo: Reply with exactly: OK");
    expect(parsed.terminalState).toBe("completed");
    expect(parsed.errorMessage).toBeNull();
    expect(parsed.toolErrors).toEqual([
      "invalid run configuration: provider does not support base instructions",
    ]);
    expect(parsed.usage).toEqual({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 });
    expect(parsed.costUsd).toBe(0);
  });

  it("falls back to joined deltas when no terminal record exists", () => {
    const stdout = [
      museLine({
        payload_type: "run.output.delta",
        payload: { kind: "run_output_delta", text: "Hello " },
      }),
      museLine({
        payload_type: "run.output.delta",
        payload: { kind: "run_output_delta", text: "from Muse" },
      }),
    ].join("\n");

    const parsed = parseMuseJsonl(stdout);
    expect(parsed.sessionId).toBe("01a106bd-d1c5-7140-ab64-0dd6402b259c");
    expect(parsed.summary).toBe("Hello from Muse");
    expect(parsed.terminalState).toBeNull();
    expect(parsed.errorMessage).toBeNull();
  });

  it("treats a non-completed terminal record as fatal", () => {
    const stdout = museLine({
      payload_type: "run.terminal.completed",
      payload: {
        kind: "run_terminal",
        terminal: "failed",
        text: "",
        reason: "provider authentication expired",
      },
    });

    const parsed = parseMuseJsonl(stdout);
    expect(parsed.errorMessage).toContain("provider authentication expired");
    expect(parsed.terminalState).toBe("failed");
  });

  it("detects unknown session errors", () => {
    expect(isMuseUnknownSessionError("Session not found: 01abc", "")).toBe(true);
    expect(isMuseUnknownSessionError("", "unknown session id")).toBe(true);
    expect(isMuseUnknownSessionError("", "no such session")).toBe(true);
    expect(isMuseUnknownSessionError("all good", "")).toBe(false);
  });
});
