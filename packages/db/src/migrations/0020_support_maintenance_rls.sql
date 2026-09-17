-- Row-level security for support, maintenance, infrastructure, documents, and
-- recurring billing, and the two rules those tables cannot be trusted to keep
-- on their own.
--
-- Every table here is tenant data reached only through `withTenant`, so each
-- gets the same policy as the rest of the schema: compare `organization_id`
-- against the transaction-local setting, and FORCE it so that the application's
-- own role is subject to it too.

--> statement-breakpoint
ALTER TABLE "tickets" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "tickets" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "tickets"
  USING      ("organization_id" = nullif(current_setting('workloom.org_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('workloom.org_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "ticket_messages" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "ticket_messages" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "ticket_messages"
  USING      ("organization_id" = nullif(current_setting('workloom.org_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('workloom.org_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "maintenance_plans" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "maintenance_plans" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "maintenance_plans"
  USING      ("organization_id" = nullif(current_setting('workloom.org_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('workloom.org_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "maintenance_plan_items" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "maintenance_plan_items" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "maintenance_plan_items"
  USING      ("organization_id" = nullif(current_setting('workloom.org_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('workloom.org_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "maintenance_visits" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "maintenance_visits" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "maintenance_visits"
  USING      ("organization_id" = nullif(current_setting('workloom.org_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('workloom.org_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "infrastructure_assets" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "infrastructure_assets" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "infrastructure_assets"
  USING      ("organization_id" = nullif(current_setting('workloom.org_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('workloom.org_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "client_documents" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "client_documents" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "client_documents"
  USING      ("organization_id" = nullif(current_setting('workloom.org_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('workloom.org_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "billing_schedules" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "billing_schedules" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "billing_schedules"
  USING      ("organization_id" = nullif(current_setting('workloom.org_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('workloom.org_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "billing_schedule_lines" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "billing_schedule_lines" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "billing_schedule_lines"
  USING      ("organization_id" = nullif(current_setting('workloom.org_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('workloom.org_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "billing_schedule_invoices" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "billing_schedule_invoices" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "billing_schedule_invoices"
  USING      ("organization_id" = nullif(current_setting('workloom.org_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('workloom.org_id', true), '')::uuid);
--> statement-breakpoint
-- A generated invoice belongs to the period it bills, and the link says so.
-- Deleting a draft invoice releases its period so the schedule can raise it
-- again; that is the cascade on `billing_schedule_invoices`, and it is
-- deliberate -- a deleted draft was never sent to anyone.

-- An issued invoice cannot be re-billed by moving its schedule link, and a
-- period cannot quietly change which invoice covered it.
CREATE FUNCTION workloom_billing_period_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.schedule_id IS DISTINCT FROM OLD.schedule_id
     OR NEW.invoice_id IS DISTINCT FROM OLD.invoice_id
     OR NEW.period_start IS DISTINCT FROM OLD.period_start
     OR NEW.period_end IS DISTINCT FROM OLD.period_end THEN
    RAISE EXCEPTION 'billing period % is a record of what was billed and cannot be repointed', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER billing_schedule_invoices_guard BEFORE UPDATE ON "billing_schedule_invoices"
  FOR EACH ROW EXECUTE FUNCTION workloom_billing_period_guard();
--> statement-breakpoint
-- A schedule's counter follows the invoices it has actually raised. Kept in the
-- database because the worker, the UI, and a replayed job all write here, and
-- the count is what "stop after 12 invoices" is decided from.
CREATE FUNCTION workloom_billing_generated_count() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  schedule uuid := COALESCE(NEW.schedule_id, OLD.schedule_id);
BEGIN
  UPDATE billing_schedules s
     SET generated_count = (SELECT count(*) FROM billing_schedule_invoices i WHERE i.schedule_id = schedule)
   WHERE s.id = schedule;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER billing_schedule_invoices_count AFTER INSERT OR DELETE ON "billing_schedule_invoices"
  FOR EACH ROW EXECUTE FUNCTION workloom_billing_generated_count();
--> statement-breakpoint
-- A ticket's first response is the first reply the client could see. Stamped by
-- the database so that every path that inserts a message -- the UI, the API, a
-- future inbound-email worker -- records it the same way, and so that it can
-- only ever be set once.
CREATE FUNCTION workloom_ticket_first_response() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT NEW.internal THEN
    UPDATE tickets
       SET first_responded_at = NEW.created_at
     WHERE id = NEW.ticket_id AND first_responded_at IS NULL;
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER ticket_messages_first_response AFTER INSERT ON "ticket_messages"
  FOR EACH ROW EXECUTE FUNCTION workloom_ticket_first_response();
