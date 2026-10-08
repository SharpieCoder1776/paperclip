ALTER TABLE "mcp_oauth_tokens" ALTER COLUMN "expires_at" DROP NOT NULL;
--> statement-breakpoint
-- Existing Dot connections keep working without another consent flow. Revoked
-- grants stay revoked, and personal assistant connections retain their expiry.
UPDATE "mcp_oauth_tokens" AS tokens
SET "expires_at" = NULL
FROM "mcp_oauth_grants" AS grants
WHERE tokens."grant_id" = grants."id"
  AND tokens."kind" = 'refresh'
  AND grants."purpose" = 'agent'
  AND grants."resource" LIKE '%/mcp/runner'
  AND grants."revoked_at" IS NULL;
