-- Guards for the invoice document v2 columns (S14).
--
-- 1. An invoice due "At launch" is issued without a due date, and gets one
--    later, once, when the launch has a date. Everything else about an issued
--    invoice stays frozen exactly as migration 0014 froze it -- the body below
--    is 0014's, with that single exception added.
--
-- 2. A deduction line takes an earlier invoice off this one. It must be a
--    different invoice, for the same client, in the same currency: anything
--    else would let one client's payment reduce another's bill.
--> statement-breakpoint
CREATE OR REPLACE FUNCTION workloom_invoice_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  after_issue constant text[] := ARRAY[
    'status', 'viewed_at', 'paid_at', 'amount_paid_minor', 'cancelled_at', 'cancel_reason',
    'email_to', 'email_sent_at', 'updated_at'
  ];
  frozen text[] := after_issue;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' AND pg_trigger_depth() = 1 THEN
      RAISE EXCEPTION 'invoice % is %: issued invoices are never deleted', OLD.id, OLD.status USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN OLD;
  END IF;
  -- An invoice due on an event may be given its date once, and only then.
  IF OLD.status <> 'draft' AND OLD.due_date IS NULL AND NEW.due_date IS NOT NULL AND OLD.due_label IS NOT NULL THEN
    frozen := frozen || 'due_date'::text;
  END IF;
  IF OLD.status <> 'draft' AND (
    NEW.status = 'draft'
    OR (to_jsonb(NEW) - frozen) IS DISTINCT FROM (to_jsonb(OLD) - frozen)
  ) THEN
    RAISE EXCEPTION 'invoice % is %: its content can no longer change', OLD.id, OLD.status USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE FUNCTION workloom_invoice_line_deduction_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  this_invoice invoices%ROWTYPE;
  deducted invoices%ROWTYPE;
BEGIN
  IF NEW.deducts_invoice_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.deducts_invoice_id = NEW.invoice_id THEN
    RAISE EXCEPTION 'an invoice cannot deduct itself' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  SELECT * INTO this_invoice FROM invoices WHERE id = NEW.invoice_id;
  SELECT * INTO deducted FROM invoices WHERE id = NEW.deducts_invoice_id;
  IF deducted.company_id IS DISTINCT FROM this_invoice.company_id THEN
    RAISE EXCEPTION 'a deduction must be an invoice of the same client' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF deducted.currency IS DISTINCT FROM this_invoice.currency THEN
    RAISE EXCEPTION 'a deduction must be an invoice in the same currency' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER invoice_lines_deduction_check BEFORE INSERT OR UPDATE OF deducts_invoice_id, invoice_id ON "invoice_lines"
  FOR EACH ROW EXECUTE FUNCTION workloom_invoice_line_deduction_check();
