-- Row-level security for invoices, and the rule that an issued invoice never
-- changes.
--
-- The same shape as the quote guard in migration 0012: an issued document is a
-- record of a demand for payment. Only the states that follow issuing may
-- change -- the client opening it, a cancellation, and what payments have
-- settled against it (S7c).
--> statement-breakpoint
ALTER TABLE "invoices" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "invoices" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "invoices"
  USING      ("organization_id" = nullif(current_setting('workloom.org_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('workloom.org_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "invoice_lines" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "invoice_lines" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "invoice_lines"
  USING      ("organization_id" = nullif(current_setting('workloom.org_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('workloom.org_id', true), '')::uuid);
--> statement-breakpoint
CREATE FUNCTION workloom_invoice_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  after_issue constant text[] := ARRAY[
    'status', 'viewed_at', 'paid_at', 'amount_paid_minor', 'cancelled_at', 'cancel_reason',
    'email_to', 'email_sent_at', 'updated_at'
  ];
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' AND pg_trigger_depth() = 1 THEN
      RAISE EXCEPTION 'invoice % is %: issued invoices are never deleted', OLD.id, OLD.status USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status <> 'draft' AND (
    NEW.status = 'draft'
    OR (to_jsonb(NEW) - after_issue) IS DISTINCT FROM (to_jsonb(OLD) - after_issue)
  ) THEN
    RAISE EXCEPTION 'invoice % is %: its content can no longer change', OLD.id, OLD.status USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER invoices_guard BEFORE UPDATE OR DELETE ON "invoices"
  FOR EACH ROW EXECUTE FUNCTION workloom_invoice_guard();
--> statement-breakpoint
CREATE FUNCTION workloom_invoice_line_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  parent_status text;
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  SELECT status INTO parent_status FROM invoices
    WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.invoice_id ELSE NEW.invoice_id END;
  IF parent_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'invoice lines can change only while the invoice is a draft' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.invoice_id <> OLD.invoice_id THEN
    RAISE EXCEPTION 'an invoice line cannot move to another invoice' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
--> statement-breakpoint
CREATE TRIGGER invoice_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON "invoice_lines"
  FOR EACH ROW EXECUTE FUNCTION workloom_invoice_line_guard();
