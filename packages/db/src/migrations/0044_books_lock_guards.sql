-- Closing the books (S20): row-level security for tax packs and audit seals,
-- the seals made append-only, and the lock date enforced where the money is.
--> statement-breakpoint
ALTER TABLE "tax_packs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "tax_packs" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "tax_packs"
  USING      ("organization_id" = nullif(current_setting('workloom.org_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('workloom.org_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "audit_seals" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "audit_seals" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "audit_seals"
  USING      ("organization_id" = nullif(current_setting('workloom.org_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('workloom.org_id', true), '')::uuid);

-- Seals are evidence, like the log they seal: never rewritten, never removed.
-- TRUNCATE was the one way left to empty the log wholesale; it goes too.
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "audit_seals" FROM PUBLIC;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "audit_seals" FROM CURRENT_USER;
--> statement-breakpoint
REVOKE TRUNCATE ON "audit_logs" FROM PUBLIC;
--> statement-breakpoint
REVOKE TRUNCATE ON "audit_logs" FROM CURRENT_USER;

-- The lock date. A record dated on or before it cannot be created, changed in
-- any way that moves money, or removed -- and none can be moved into or out
-- of the locked period, which is why both the old and the new date are
-- checked. What stays possible: settling an old invoice from a payment
-- received after the lock, attaching a missing receipt to an old expense, and
-- billing an old expense on to a new invoice.
--
-- SQLSTATE WL001 lets the application say this in words.
--> statement-breakpoint
CREATE OR REPLACE FUNCTION workloom_books_locked_through(org uuid) RETURNS date
  LANGUAGE sql STABLE AS $$
    SELECT books_locked_through FROM organization WHERE id = org
  $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION workloom_books_locked(what text, day date, locked date) RETURNS void
  LANGUAGE plpgsql AS $$
  BEGIN
    RAISE EXCEPTION 'books_locked: % dated % is in the books closed through %', what, day, locked
      USING ERRCODE = 'WL001', DETAIL = locked::text;
  END
  $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION workloom_invoice_lock() RETURNS trigger
  LANGUAGE plpgsql AS $$
  DECLARE
    locked date := workloom_books_locked_through(coalesce(NEW.organization_id, OLD.organization_id));
  BEGIN
    IF locked IS NULL THEN
      RETURN coalesce(NEW, OLD);
    END IF;
    IF TG_OP = 'INSERT' THEN
      IF NEW.status <> 'draft' AND NEW.issue_date <= locked THEN
        PERFORM workloom_books_locked('an invoice', NEW.issue_date, locked);
      END IF;
      RETURN NEW;
    END IF;
    IF TG_OP = 'DELETE' THEN
      IF OLD.status <> 'draft' AND OLD.issue_date <= locked THEN
        PERFORM workloom_books_locked('an invoice', OLD.issue_date, locked);
      END IF;
      RETURN OLD;
    END IF;
    -- Issuing into the closed period.
    IF OLD.status = 'draft' AND NEW.status <> 'draft' AND NEW.issue_date <= locked THEN
      PERFORM workloom_books_locked('an invoice', NEW.issue_date, locked);
    END IF;
    -- Cancelling, or re-dating, an issued invoice of the closed period.
    IF OLD.status <> 'draft' AND OLD.issue_date <= locked
       AND ((NEW.status = 'cancelled' AND OLD.status <> 'cancelled') OR NEW.issue_date IS DISTINCT FROM OLD.issue_date) THEN
      PERFORM workloom_books_locked('an invoice', OLD.issue_date, locked);
    END IF;
    RETURN NEW;
  END
  $$;
--> statement-breakpoint
CREATE TRIGGER "workloom_invoice_lock" BEFORE INSERT OR UPDATE OR DELETE ON "invoices"
  FOR EACH ROW EXECUTE FUNCTION workloom_invoice_lock();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION workloom_payment_lock() RETURNS trigger
  LANGUAGE plpgsql AS $$
  DECLARE
    locked date := workloom_books_locked_through(coalesce(NEW.organization_id, OLD.organization_id));
  BEGIN
    IF locked IS NULL THEN
      RETURN coalesce(NEW, OLD);
    END IF;
    IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.received_on <= locked
       AND (TG_OP = 'INSERT' OR (NEW.received_on, NEW.amount_minor, NEW.currency, NEW.amount_base_minor, NEW.exchange_rate_to_base, NEW.company_id, NEW.kind)
            IS DISTINCT FROM (OLD.received_on, OLD.amount_minor, OLD.currency, OLD.amount_base_minor, OLD.exchange_rate_to_base, OLD.company_id, OLD.kind)) THEN
      PERFORM workloom_books_locked('a payment', NEW.received_on, locked);
    END IF;
    IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.received_on <= locked
       AND (TG_OP = 'DELETE' OR (NEW.received_on, NEW.amount_minor, NEW.currency, NEW.amount_base_minor, NEW.exchange_rate_to_base, NEW.company_id, NEW.kind)
            IS DISTINCT FROM (OLD.received_on, OLD.amount_minor, OLD.currency, OLD.amount_base_minor, OLD.exchange_rate_to_base, OLD.company_id, OLD.kind)) THEN
      PERFORM workloom_books_locked('a payment', OLD.received_on, locked);
    END IF;
    RETURN coalesce(NEW, OLD);
  END
  $$;
--> statement-breakpoint
CREATE TRIGGER "workloom_payment_lock" BEFORE INSERT OR UPDATE OR DELETE ON "payments"
  FOR EACH ROW EXECUTE FUNCTION workloom_payment_lock();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION workloom_allocation_lock() RETURNS trigger
  LANGUAGE plpgsql AS $$
  DECLARE
    org uuid := coalesce(NEW.organization_id, OLD.organization_id);
    locked date := workloom_books_locked_through(org);
    received date;
  BEGIN
    IF locked IS NULL THEN
      RETURN coalesce(NEW, OLD);
    END IF;
    -- An allocation belongs to its payment's day: where the payment is closed, so is how it was applied.
    SELECT received_on INTO received FROM payments WHERE id = coalesce(NEW.payment_id, OLD.payment_id) AND organization_id = org;
    IF received IS NOT NULL AND received <= locked
       AND (TG_OP <> 'UPDATE' OR (NEW.invoice_id, NEW.amount_minor) IS DISTINCT FROM (OLD.invoice_id, OLD.amount_minor)) THEN
      PERFORM workloom_books_locked('a payment', received, locked);
    END IF;
    RETURN coalesce(NEW, OLD);
  END
  $$;
--> statement-breakpoint
CREATE TRIGGER "workloom_allocation_lock" BEFORE INSERT OR UPDATE OR DELETE ON "payment_allocations"
  FOR EACH ROW EXECUTE FUNCTION workloom_allocation_lock();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION workloom_expense_lock() RETURNS trigger
  LANGUAGE plpgsql AS $$
  DECLARE
    locked date := workloom_books_locked_through(coalesce(NEW.organization_id, OLD.organization_id));
    moved boolean;
  BEGIN
    IF locked IS NULL THEN
      RETURN coalesce(NEW, OLD);
    END IF;
    -- A draft is not in the books yet; confirming one into the closed period puts it there.
    moved := TG_OP <> 'UPDATE' OR (NEW.status, NEW.incurred_on, NEW.amount_minor, NEW.tax_minor, NEW.currency, NEW.category, NEW.amount_base_minor, NEW.exchange_rate_to_base, NEW.tax_rate_id)
      IS DISTINCT FROM (OLD.status, OLD.incurred_on, OLD.amount_minor, OLD.tax_minor, OLD.currency, OLD.category, OLD.amount_base_minor, OLD.exchange_rate_to_base, OLD.tax_rate_id);
    IF NOT moved THEN
      RETURN coalesce(NEW, OLD);
    END IF;
    IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.status = 'confirmed' AND NEW.incurred_on <= locked THEN
      PERFORM workloom_books_locked('an expense', NEW.incurred_on, locked);
    END IF;
    IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.status = 'confirmed' AND OLD.incurred_on <= locked THEN
      PERFORM workloom_books_locked('an expense', OLD.incurred_on, locked);
    END IF;
    RETURN coalesce(NEW, OLD);
  END
  $$;
--> statement-breakpoint
CREATE TRIGGER "workloom_expense_lock" BEFORE INSERT OR UPDATE OR DELETE ON "expenses"
  FOR EACH ROW EXECUTE FUNCTION workloom_expense_lock();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION workloom_expense_receipt_lock() RETURNS trigger
  LANGUAGE plpgsql AS $$
  DECLARE
    locked date := workloom_books_locked_through(OLD.organization_id);
    expense record;
  BEGIN
    IF locked IS NULL THEN
      RETURN OLD;
    END IF;
    -- Adding a missing receipt to a closed year is welcome; taking evidence away is not.
    -- (When the expense itself is being deleted, its own lock has already decided.)
    SELECT status, incurred_on INTO expense FROM expenses WHERE id = OLD.expense_id AND organization_id = OLD.organization_id;
    IF FOUND AND expense.status = 'confirmed' AND expense.incurred_on <= locked THEN
      PERFORM workloom_books_locked('a receipt for an expense', expense.incurred_on, locked);
    END IF;
    RETURN OLD;
  END
  $$;
--> statement-breakpoint
CREATE TRIGGER "workloom_expense_receipt_lock" BEFORE DELETE ON "expense_receipts"
  FOR EACH ROW EXECUTE FUNCTION workloom_expense_receipt_lock();
