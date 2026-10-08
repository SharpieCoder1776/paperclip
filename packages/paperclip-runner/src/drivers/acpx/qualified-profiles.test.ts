import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  QUALIFIED_ACPX_PROFILES,
  resolveQualifiedAcpxProfile,
} from "./qualified-profiles.js";

describe("qualified ACPX profiles", () => {
  it("binds each agent to an immutable runtime without prescribing a model", () => {
    for (const agent of ["pi", "claude", "codex", "grok", "cursor", "copilot"] as const) {
      const profile = QUALIFIED_ACPX_PROFILES[agent];
      expect(profile.agent).toBe(agent);
      expect(profile.commandDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(Object.isFrozen(profile)).toBe(true);
      expect(profile).not.toHaveProperty("qualificationModel");
      expect(profile).not.toHaveProperty("reportedModelId");
    }
  });

  it.each(["claude", "codex", "pi", "grok", "cursor", "copilot"] as const)("lets %s verify an explicit model absent from the catalog", (agent) => {
    const model = "custom/model[context=272k,reasoning=medium]";
    expect(resolveQualifiedAcpxProfile(agent, model)).toMatchObject({
      qualificationModel: model, reportedModelId: model,
      commandDigest: QUALIFIED_ACPX_PROFILES[agent].commandDigest,
    });
  });

  it.each(["claude", "codex", "grok", "cursor", "copilot", "pi"] as const)("never selects a qualification model by default for %s", (agent) => {
    expect(() => resolveQualifiedAcpxProfile(agent, " ")).toThrow("must not be empty");
  });

  it("binds Codex ACP to the CLI runtime it launches", () => {
    expect(QUALIFIED_ACPX_PROFILES.codex).toMatchObject({
      agentRuntimePackage: "@openai/codex",
      agentRuntimeVersion: "0.160.0",
    });
  });

  it("binds Claude ACP to the SDK and native CLI runtime it launches", () => {
    expect(QUALIFIED_ACPX_PROFILES.claude).toMatchObject({
      agentRuntimePackage: "@anthropic-ai/claude-agent-sdk",
      agentRuntimeVersion: "0.3.286",
    });
  });
});

it("binds Cursor v10 to native instructions, tool identity, closures and the exact ACPX guard patch", () => {
  const identity = JSON.parse(readFileSync(new URL("../../../test/fixtures/cursor-acp/profile-v10-identity.json", import.meta.url), "utf8"));
  const distribution = JSON.parse(readFileSync(new URL("../../../cursor-distributions.json", import.meta.url), "utf8"));
  expect(identity.declaration.distribution).toEqual(distribution);
  expect(identity.declaration.sharedRuntimeContract).toBe("paperclip.acpx-runtime-contract.v1");
  expect(identity.declaration.nativePlanToolIdentity).toBe("request-item-id-bound-lifecycle-v1");
  expect(identity.declaration.nativePermissionToolIdentity).toBe("opaque-native-tool-id-sha256-v1");
  expect(identity.declaration.sessionModeAdmission).toBe("native-config-ack-recovery-bound-v1");
  expect(identity.declaration.sessionModes).toEqual(["agent", "plan", "ask"]);
  expect(identity.declaration.defaultSessionMode).toBe("agent");
  expect(identity.declaration.agentProfileVersion).toBe(QUALIFIED_ACPX_PROFILES.cursor.agentProfileVersion);
  expect(identity.commandDigest).toBe(QUALIFIED_ACPX_PROFILES.cursor.commandDigest);
  expect(identity.commandDigest).toBe(`sha256:${createHash("sha256").update(JSON.stringify(identity.declaration)).digest("hex")}`);
  const patch = readFileSync(new URL("../../../../../patches/acpx@0.13.1.patch", import.meta.url));
  expect(identity.declaration.acpxPatchSha256).toBe(createHash("sha256").update(patch).digest("hex"));
  for (const [path, field] of [
    ["cursor-plan-tool-identity.ts", "toolIdentitySourceSha256"],
    ["acp-permission-adapter.ts", "permissionAdapterSourceSha256"],
    ["cursor-tool-evidence.ts", "toolEvidenceSourceSha256"],
  ]) {
    expect(identity.declaration[field!]).toBe(createHash("sha256").update(readFileSync(new URL(path!, import.meta.url))).digest("hex"));
  }
});
