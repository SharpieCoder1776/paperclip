import { buildAgentOnboardingPrompt } from "@/lib/agent-onboarding-prompt";
import { buildDotSetupPrompt } from "@/lib/dot-setup-prompt";

// Deliberately non-routable fixture URLs/codes; never store real invitations in stories.
export const externalInvitePrompt = buildAgentOnboardingPrompt({
  onboardingTextUrl: "https://paperclip.example/invite/storybook/onboarding.txt",
});

export function dotInvitePrompt(generation = 1) {
  const current = buildDotSetupPrompt({
    companyId: "company-storybook", agentId: "dot-storybook",
    resourceUrl: "https://paperclip.example/mcp/runner/dot",
    pairingCode: `STORYBOOK-NOT-A-REAL-CODE-${generation}`,
    expiresAt: "15 minutes after this invitation is created",
  });
  // The proposed invite controller will automatically issue the test. The live
  // self-hosted runtime still uses its existing manual Test event delivery action.
  return current.replace(
    'Once the event subscription is verified, tell me to click "Test event delivery" in Paperclip. Confirm that challenge when it arrives so the connection becomes ready.',
    "Once the event subscription is verified, Paperclip will send a test event automatically. Confirm its readiness challenge when it arrives so the connection becomes ready. Tell me when the connection works in both directions.",
  );
}
