-- Row-level security for the outbox, webhooks, and idempotency keys.
--
-- Hand-written, like 0001. Every table gets the standard tenant_isolation
-- policy in its nullif() form (see 0001 for why nullif is required).
--> statement-breakpoint
ALTER TABLE "events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "events" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "events"
  USING      ("organization_id" = nullif(current_setting('workloom.org_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('workloom.org_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "webhook_endpoints" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "webhook_endpoints"
  USING      ("organization_id" = nullif(current_setting('workloom.org_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('workloom.org_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "webhook_deliveries" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "webhook_deliveries"
  USING      ("organization_id" = nullif(current_setting('workloom.org_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('workloom.org_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "idempotency_keys" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "idempotency_keys" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "idempotency_keys"
  USING      ("organization_id" = nullif(current_setting('workloom.org_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('workloom.org_id', true), '')::uuid);

-- The dispatcher.
--
-- The worker publishes every organization's events, so it has to see across
-- tenants. Enumerating organizations and scoping each in turn would be a query
-- per organization per poll, every second, forever. Instead these policies
-- widen access while a transaction-local flag is set -- the same pattern as
-- api_key_authentication in 0001.
--
-- The widening is deliberately narrow:
--   - it is set in exactly one module (apps/worker/src/outbox), which lint
--     confines the flag to;
--   - it grants only what delivery needs -- no DELETE anywhere, and nothing at
--     all on idempotency_keys;
--   - deliveries reference their endpoint and event through composite keys on
--     (organization_id, id), so even with the flag set a delivery cannot be
--     created that points across organizations.
--> statement-breakpoint
CREATE POLICY "dispatcher_select" ON "events"
  FOR SELECT USING (current_setting('workloom.dispatcher', true) = 'on');
--> statement-breakpoint
CREATE POLICY "dispatcher_update" ON "events"
  FOR UPDATE USING (current_setting('workloom.dispatcher', true) = 'on') WITH CHECK (current_setting('workloom.dispatcher', true) = 'on');
--> statement-breakpoint
CREATE POLICY "dispatcher_select" ON "webhook_endpoints"
  FOR SELECT USING (current_setting('workloom.dispatcher', true) = 'on');
--> statement-breakpoint
CREATE POLICY "dispatcher_update" ON "webhook_endpoints"
  FOR UPDATE USING (current_setting('workloom.dispatcher', true) = 'on') WITH CHECK (current_setting('workloom.dispatcher', true) = 'on');
--> statement-breakpoint
CREATE POLICY "dispatcher_select" ON "webhook_deliveries"
  FOR SELECT USING (current_setting('workloom.dispatcher', true) = 'on');
--> statement-breakpoint
CREATE POLICY "dispatcher_insert" ON "webhook_deliveries"
  FOR INSERT WITH CHECK (current_setting('workloom.dispatcher', true) = 'on');
--> statement-breakpoint
CREATE POLICY "dispatcher_update" ON "webhook_deliveries"
  FOR UPDATE USING (current_setting('workloom.dispatcher', true) = 'on') WITH CHECK (current_setting('workloom.dispatcher', true) = 'on');
