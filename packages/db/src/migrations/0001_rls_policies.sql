-- Row-level security: the boundary between organizations.
--
-- Written by hand rather than generated. This is the security boundary, and it
-- should not silently change shape because a code generator was upgraded.
--
-- Every policy follows the same form. `current_setting('workloom.org_id', true)`
-- reads the transaction-local setting established by withTenant(); the second
-- argument makes a missing setting return NULL rather than raising.
--
-- The nullif() is not decoration. Once a transaction-local set_config has run
-- on a connection, the setting does not disappear when that transaction ends --
-- it reverts to an EMPTY STRING. Casting '' to uuid raises 22P02, so without
-- nullif() a query issued outside a tenant transaction would error on any
-- connection that had previously served one: intermittent, pool-dependent, and
-- maddening to diagnose. With it, such a query compares against NULL and
-- matches nothing, which is the intended fail-closed behaviour.
--
-- FORCE is as important as ENABLE: without it the table owner bypasses the
-- policy, and the application owns its tables.

--> statement-breakpoint
ALTER TABLE "audit_logs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "audit_logs" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "audit_logs"
  USING      ("organization_id" = nullif(current_setting('workloom.org_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('workloom.org_id', true), '')::uuid);

--> statement-breakpoint
ALTER TABLE "api_keys" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "api_keys" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "api_keys"
  USING      ("organization_id" = nullif(current_setting('workloom.org_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('workloom.org_id', true), '')::uuid);

-- API key authentication is the one lookup that cannot know its organization
-- yet: the request presents a secret, and the organization is what we are
-- trying to discover.
--
-- A SECURITY DEFINER function does NOT solve this. FORCE ROW LEVEL SECURITY
-- subjects the table owner to the policy too, and the function owner is the
-- application role -- so it would run into exactly the same policy it was
-- meant to step around.
--
-- Instead, a second policy widens SELECT only while a transaction-local flag
-- is set. Permissive policies are OR'd, so this adds one narrow path without
-- weakening tenant_isolation for any ordinary query. The flag is set in
-- exactly one function (verifyApiKey), lives for the length of that
-- transaction, and is greppable.
--> statement-breakpoint
CREATE POLICY "api_key_authentication" ON "api_keys"
  FOR SELECT
  USING (current_setting('workloom.auth_lookup', true) = 'on');

-- The audit log is append-only. Revoking these is what makes it evidence
-- rather than merely a table that usually contains the truth.
--> statement-breakpoint
REVOKE UPDATE, DELETE ON "audit_logs" FROM PUBLIC;
--> statement-breakpoint
REVOKE UPDATE, DELETE ON "audit_logs" FROM CURRENT_USER;
