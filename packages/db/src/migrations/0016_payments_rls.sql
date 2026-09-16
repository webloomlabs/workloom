-- Row-level security for payments, allocations, and expenses, and the rule
-- that an invoice's `amount_paid_minor` follows its allocations.
--
-- The invariant `amount_due = total - sum(allocations)` is the one a client
-- disputes, so it is held by the database rather than by the service: the
-- trigger below recomputes the column on every change to an allocation, and a
-- second trigger refuses anyone setting it by hand.
--> statement-breakpoint
ALTER TABLE "payments" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "payments" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "payments"
  USING      ("organization_id" = nullif(current_setting('workloom.org_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('workloom.org_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "payment_allocations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "payment_allocations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "payment_allocations"
  USING      ("organization_id" = nullif(current_setting('workloom.org_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('workloom.org_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "expenses" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "expenses" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "expenses"
  USING      ("organization_id" = nullif(current_setting('workloom.org_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('workloom.org_id', true), '')::uuid);
--> statement-breakpoint
-- Recomputes one invoice's settled amount from its allocations, and refuses
-- the two ways that sum can be wrong. A refund's allocations subtract.
--
-- Called from a trigger, so the UPDATE below runs at trigger depth 2, which is
-- what `workloom_invoice_paid_guard` allows and a direct UPDATE is not.
CREATE FUNCTION workloom_settle_invoice(invoice uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  settled bigint;
  owed bigint;
BEGIN
  -- Locked before the sum is taken, so two allocations landing on one invoice
  -- at the same moment queue up instead of each reading a total the other is
  -- about to change.
  SELECT total_minor INTO owed FROM invoices WHERE id = invoice FOR UPDATE;
  -- The invoice is on its way out; its allocations went with it.
  IF NOT FOUND THEN RETURN; END IF;

  SELECT coalesce(sum(CASE WHEN p.kind = 'refund' THEN -a.amount_minor ELSE a.amount_minor END), 0)
    INTO settled
    FROM payment_allocations a
    JOIN payments p ON p.id = a.payment_id
   WHERE a.invoice_id = invoice;

  IF settled < 0 THEN
    RAISE EXCEPTION 'invoice % would be refunded more than it was paid', invoice
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF settled > owed THEN
    RAISE EXCEPTION 'invoice % would be allocated % against a total of %', invoice, settled, owed
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  UPDATE invoices SET amount_paid_minor = settled
   WHERE id = invoice AND amount_paid_minor IS DISTINCT FROM settled;
END $$;
--> statement-breakpoint
-- A payment cannot be allocated further than it is worth.
CREATE FUNCTION workloom_check_payment_allocated(payment uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  received bigint;
  allocated bigint;
BEGIN
  SELECT amount_minor INTO received FROM payments WHERE id = payment FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT coalesce(sum(amount_minor), 0) INTO allocated FROM payment_allocations WHERE payment_id = payment;
  IF allocated > received THEN
    RAISE EXCEPTION 'payment % would be allocated % of %', payment, allocated, received
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
END $$;
--> statement-breakpoint
CREATE FUNCTION workloom_allocation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    PERFORM workloom_settle_invoice(OLD.invoice_id);
    PERFORM workloom_check_payment_allocated(OLD.payment_id);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    PERFORM workloom_settle_invoice(NEW.invoice_id);
    PERFORM workloom_check_payment_allocated(NEW.payment_id);
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER payment_allocations_guard AFTER INSERT OR UPDATE OR DELETE ON "payment_allocations"
  FOR EACH ROW EXECUTE FUNCTION workloom_allocation_guard();
--> statement-breakpoint
-- Correcting a payment's amount, or turning it into a refund, changes what its
-- invoices have been settled by, so the same checks run again.
CREATE FUNCTION workloom_payment_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  allocated record;
BEGIN
  IF NEW.amount_minor IS DISTINCT FROM OLD.amount_minor OR NEW.kind IS DISTINCT FROM OLD.kind THEN
    PERFORM workloom_check_payment_allocated(NEW.id);
    FOR allocated IN SELECT DISTINCT invoice_id FROM payment_allocations WHERE payment_id = NEW.id LOOP
      PERFORM workloom_settle_invoice(allocated.invoice_id);
    END LOOP;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER payments_guard AFTER UPDATE ON "payments"
  FOR EACH ROW EXECUTE FUNCTION workloom_payment_guard();
--> statement-breakpoint
-- `amount_paid_minor` is derived, and the only writer is the trigger above.
-- A cascade or a trigger runs deeper than 1; a hand-written UPDATE does not.
CREATE FUNCTION workloom_invoice_paid_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.amount_paid_minor IS DISTINCT FROM OLD.amount_paid_minor AND pg_trigger_depth() = 1 THEN
    RAISE EXCEPTION 'invoice %: amount_paid_minor follows its payment allocations and is not set directly', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER invoices_paid_guard BEFORE UPDATE ON "invoices"
  FOR EACH ROW EXECUTE FUNCTION workloom_invoice_paid_guard();
--> statement-breakpoint
-- A rebilled expense is frozen, as billed time is: the invoice line that bills
-- it is what holds it, and removing the line releases it.
CREATE FUNCTION workloom_expense_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  billed constant text[] := ARRAY['invoice_line_id', 'updated_at'];
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.invoice_line_id IS NOT NULL THEN
      RAISE EXCEPTION 'expense % has been rebilled: remove the invoice line first', OLD.id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.invoice_line_id IS NOT NULL AND (to_jsonb(NEW) - billed) IS DISTINCT FROM (to_jsonb(OLD) - billed) THEN
    RAISE EXCEPTION 'expense % has been rebilled and can no longer change', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER expenses_guard BEFORE UPDATE OR DELETE ON "expenses"
  FOR EACH ROW EXECUTE FUNCTION workloom_expense_guard();
