# Cloud Dot runners and external-agent invitations

Date: 2026-10-08

Status: architecture decision and interactive Storybook proposal. This change documents the cloud design and supplies shared presentation components and fixture-driven stories. It does **not** implement cloud Dot execution or replace the live invitation controller. Existing self-hosted Dot setup retains its manual event-delivery test.

## Decision: remote agents use the new Runner infrastructure

Keep Dot and future remote-agent drivers within the new Rust Runner infrastructure. A remote agent can do its thinking and computer work elsewhere while Paperclip still owns admission, assignment lifecycle, tool authorization, receipts, progress, cancellation, and completion through the same Runner contract used by other agents.

There is also a deliberate future benefit: **we may give remote agents tools that access a Paperclip workspace. Those tools require sandbox isolation.** Keeping remote agents on the Runner infrastructure gives those future tools an established execution boundary, workspace lifecycle, and authorization path. We should not need to invent a second execution system when a remote agent gains workspace capabilities.

Where the Runner runs and which tools the agent receives are independent decisions. Running a Runner in a sandbox does not itself grant Dot filesystem or shell access. The tool catalog and per-run grants determine that access.

For the first cloud implementation:

- Dot uses its own OpenAI-hosted computer. Do not expose Paperclip workspace file or command tools to it.
- Start one ordinary managed Runner execution job for an admitted assignment, using the configured cloud sandbox provider (for example, Kubernetes or Daytona). Reuse the job for that assignment's messages and tool calls.
- Do not start a new sandbox for each message or tool call. Do not require an idle, always-running sandbox just to receive Dot traffic.
- Do not run agent-provided commands on the Paperclip control-plane host. Future workspace tools execute inside the assignment's managed sandbox and require explicit capability grants.
- Keep public MCP, OAuth, subscription handling, and durable mailbox state on the control plane. These remain reachable while no Runner job is active.

```mermaid
flowchart LR
  User[Operator assigns work] --> CP[Paperclip control plane]
  CP -->|admit assignment| Job[Managed sandbox: Rust Runner]
  Job -->|offer, progress, receipts| CP
  CP -->|MCP Events notification| Dot[Dot on OpenAI's computer]
  Dot -->|MCP inbox and tool calls| CP
  CP -->|authorized assignment operations| Job
  Job -.->|future explicitly granted tools| Workspace[Isolated Paperclip workspace]
```

The control plane authenticates inbound Dot requests even when no assignment exists. Idle reads and connection checks need no sandbox. A request to start work creates a visible task and passes normal admission before launching a job. During an assignment, the control plane routes operations to its owning Runner through the durable bridge. Progress and completion return through normal Runner bookkeeping. After completion or cancellation, tear down the job according to the managed execution policy; keep the binding and mailbox.

This preserves one lifecycle without promising that every provider performs identical work. For Dot, much of the driver coordinates a remote service. For a local coding agent, the driver also supervises a local process. Workspace access can be added later without weakening the boundary between the control plane and execution.

## Invitation walkthrough

Entry: **New agent → Invite an external agent → Dot / Hermes / Other**.

The picker uses the Dot and Hermes brand marks. The Dot option is governed by the standalone Dot experimental setting and its required Assistant connections (MCP) dependency in the eventual live controller. Experimental infrastructure prerequisites belong in settings, not as a list of implementation details in this invitation.

1. Choose **Dot**. Paperclip creates a company/agent-scoped invitation and a short-lived pairing prompt.
2. Show **Copy setup prompt**, using the shared `AgentSetupPrompt` component with the Dot mark. Tell the user to send the whole prompt to their Dot in ChatGPT. The preview remains inspectable and offers selectable text if clipboard access fails.
3. Dot follows the prompt to install or reuse the private plugin, complete scoped OAuth consent using the one-use pairing code, read its inbox, and subscribe to updates. Retain the exact user-approved plugin-creation consent wording from the existing prompt. The pairing code must remain transient and must not be logged, committed, or stored in browser persistence.
4. Paperclip watches the connection and updates three checks in place:
   - **Connected to Paperclip** — the scoped OAuth/binding connection is established.
   - **Task updates enabled** — the event subscription/callback is verified.
   - **Test event confirmed** — Paperclip sent a readiness challenge through the event path and the paired Dot explicitly confirmed it through MCP.
5. Show **Your Dot is connected** and **Done** only after the round trip is confirmed. A successful copy, OAuth connection, or subscription alone is insufficient.

The future invite controller automatically issues the readiness test once the subscription is verified. It must be idempotent across refreshes/reconnects, correlate confirmation to the current binding and challenge, and never mark a replacement binding ready using an old confirmation. Use server events or bounded polling with reconnect/revalidation. UI timers are not evidence of success.

When the event test times out, preserve completed checks and offer **Retry test event**. When the pairing code expires, offer **Create a new prompt**, invalidate the old prompt, and require the new one to be copied. When watching is interrupted, state that updates are paused and offer **Reconnect updates**; do not imply Dot itself disconnected. Returning to the picker must preserve a pending invitation rather than silently create duplicate agents or codes. Closing the dialog must not revoke an established connection.

The managed invitation authorizes only the selected agent in the selected company; it does not grant operator access. OAuth scope preview and consent remain part of connecting. This flow should not require the operator to manipulate Dot's computer or manually run an event test.

## Hermes and Other

Hermes is a named choice with its existing brand mark. **No new Hermes protocol, tools, transport, authentication, or setup behavior is part of this work.** Hermes and Other use the same existing `buildAgentOnboardingPrompt` output, including its Hermes Gateway guidance and existing board approval/key-claim sequence. They do not show Dot's MCP event checks or claim readiness from a copied prompt.

## Reviewable Storybook surface

Folder: `ui/storybook/stories/external-agent-invite/`.

- **Onboarding / External agent invitation / Journeys**: entry, picker, copy handoff, individual watched states, success, timeout/retry, expiration, interrupted updates, Hermes, Other, mobile, light theme, and long company names.
- **Onboarding / External agent invitation / Components**: picker and each controlled connection-check state.
- Interaction stories exercise copy → watched progression → success and retry without discarding completed checks.

The shared presentation lives in `ui/src/components/new-agent/ExternalAgentInviteContent.tsx`. Storybook alone supplies timers and fixture credentials at `.example` URLs. It reuses the live Dot prompt with a documented fixture-only substitution for automatic readiness testing; the live runtime prompt remains unchanged. Hermes and Other reuse the production invitation builder without modifications.

Run `pnpm --filter @paperclipai/ui storybook`, then open the journey group. Copying in the interactive Dot story advances simulated checks; the fixed-state stories remain still for inspection. These stories demonstrate the proposed UX, not a successful live cloud pairing.

## Remaining implementation and qualification

Before shipping the cloud flow, implement managed Dot job dispatch, durable owner-scoped bridge routing, admission for idle-initiated work, invitation lifecycle/resume and expiry, automatic event testing, experimental feature gating, and the live watcher. Preserve company isolation, approval rules, budget stops, assignment authority, and mutation receipts. Qualify real OAuth installation, event round trip, assignment execution, unsolicited Dot work, restart/reconnect, cancellation, and expired/revoked credentials against a real sandbox provider. No cloud-ready claim follows from this Storybook pass.
