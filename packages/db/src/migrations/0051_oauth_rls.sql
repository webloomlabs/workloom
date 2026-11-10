-- Row-level security for OAuth grants and tokens. oauth_clients has no
-- organization and is not under RLS, like rate_limits.
--> statement-breakpoint
ALTER TABLE "oauth_grants" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "oauth_grants" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "oauth_grants"
  USING      ("organization_id" = nullif(current_setting('workloom.org_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('workloom.org_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "oauth_tokens" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "oauth_tokens" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "oauth_tokens"
  USING      ("organization_id" = nullif(current_setting('workloom.org_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('workloom.org_id', true), '')::uuid);

-- A presented token must be looked up before its organization is known, as
-- an API key is. The same transaction-local flag widens SELECT -- and only
-- SELECT -- on these two tables for the length of that lookup. See
-- api_key_authentication in 0001_rls_policies.sql and docs/architecture.md.
--> statement-breakpoint
CREATE POLICY "oauth_token_authentication" ON "oauth_tokens"
  FOR SELECT
  USING (current_setting('workloom.auth_lookup', true) = 'on');
--> statement-breakpoint
CREATE POLICY "oauth_grant_authentication" ON "oauth_grants"
  FOR SELECT
  USING (current_setting('workloom.auth_lookup', true) = 'on');
