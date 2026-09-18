-- Row-level security for the banking tables, and the three rules that keep a
-- bank register honest without trusting the service to remember them.
--
-- 1. An account's balance follows its transactions. Nobody sets it by hand.
-- 2. A line is never explained by more than it is worth, and a payment or an
--    expense is never claimed by more bank evidence than it is worth either.
-- 3. A reconciled line does not change. It is a statement to an accountant that
--    the books balanced on a date, and editing it afterwards makes that a lie
--    with nothing to surface it.
--
-- All three are held here rather than in core, because the invariant an
-- accountant disputes is the one the database should be enforcing.
--> statement-breakpoint
ALTER TABLE "bank_accounts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "bank_accounts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "bank_accounts"
  USING      ("organization_id" = nullif(current_setting('workloom.org_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('workloom.org_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "bank_statement_imports" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "bank_statement_imports" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "bank_statement_imports"
  USING      ("organization_id" = nullif(current_setting('workloom.org_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('workloom.org_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "bank_reconciliations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "bank_reconciliations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "bank_reconciliations"
  USING      ("organization_id" = nullif(current_setting('workloom.org_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('workloom.org_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "bank_transactions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "bank_transactions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "bank_transactions"
  USING      ("organization_id" = nullif(current_setting('workloom.org_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('workloom.org_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "bank_transaction_matches" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "bank_transaction_matches" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "bank_transaction_matches"
  USING      ("organization_id" = nullif(current_setting('workloom.org_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('workloom.org_id', true), '')::uuid);
--> statement-breakpoint
-- Recomputes one account's balance from its opening anchor and every line.
--
-- Called from a trigger, so the UPDATE below runs at depth 2, which is what
-- `workloom_bank_account_balance_guard` allows and a direct UPDATE is not.
CREATE FUNCTION workloom_bank_balance(account uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  anchor bigint;
  balance bigint;
BEGIN
  -- Locked before the sum is taken, so a two-thousand-line import and a hand
  -- entry landing at the same moment queue up instead of each reading a total
  -- the other is about to change.
  SELECT opening_balance_minor INTO anchor FROM bank_accounts WHERE id = account FOR UPDATE;
  -- The account is on its way out; its transactions went with it.
  IF NOT FOUND THEN RETURN; END IF;

  SELECT anchor + coalesce(sum(amount_minor), 0) INTO balance
    FROM bank_transactions WHERE bank_account_id = account;

  UPDATE bank_accounts SET current_balance_minor = balance
   WHERE id = account AND current_balance_minor IS DISTINCT FROM balance;
END $$;
--> statement-breakpoint
CREATE FUNCTION workloom_bank_transaction_balance_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    PERFORM workloom_bank_balance(OLD.bank_account_id);
  END IF;
  IF TG_OP <> 'DELETE' AND (TG_OP = 'INSERT' OR NEW.bank_account_id IS DISTINCT FROM OLD.bank_account_id) THEN
    PERFORM workloom_bank_balance(NEW.bank_account_id);
  ELSIF TG_OP = 'UPDATE' AND NEW.amount_minor IS DISTINCT FROM OLD.amount_minor THEN
    PERFORM workloom_bank_balance(NEW.bank_account_id);
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER bank_transactions_balance_guard AFTER INSERT OR UPDATE OR DELETE ON "bank_transactions"
  FOR EACH ROW EXECUTE FUNCTION workloom_bank_transaction_balance_guard();
--> statement-breakpoint
-- Moving the opening anchor moves every balance measured from it.
CREATE FUNCTION workloom_bank_account_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- `current_balance_minor` is derived, and the only writer is the function
  -- above. A trigger runs deeper than 1; a hand-written UPDATE does not.
  IF NEW.current_balance_minor IS DISTINCT FROM OLD.current_balance_minor AND pg_trigger_depth() = 1 THEN
    RAISE EXCEPTION 'bank account %: current_balance_minor follows its transactions and is not set directly', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  -- The currency is in the foreign key of every transaction and match below it.
  IF NEW.currency IS DISTINCT FROM OLD.currency THEN
    RAISE EXCEPTION 'bank account %: an account in another currency is another account', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.opening_balance_minor IS DISTINCT FROM OLD.opening_balance_minor
     AND EXISTS (SELECT 1 FROM bank_transactions WHERE bank_account_id = OLD.id) THEN
    RAISE EXCEPTION 'bank account % has transactions: moving the opening balance rewrites every reconciliation measured from it', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER bank_accounts_guard BEFORE UPDATE ON "bank_accounts"
  FOR EACH ROW EXECUTE FUNCTION workloom_bank_account_guard();
--> statement-breakpoint
-- Recomputes how much of one statement line its matches explain, and refuses
-- the two ways that sum can be wrong: past the line, or against its direction.
CREATE FUNCTION workloom_explain_transaction(txn uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  line bigint;
  matched bigint;
BEGIN
  SELECT amount_minor INTO line FROM bank_transactions WHERE id = txn FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT coalesce(sum(amount_minor), 0) INTO matched
    FROM bank_transaction_matches WHERE bank_transaction_id = txn;

  IF sign(matched) NOT IN (0, sign(line)) THEN
    RAISE EXCEPTION 'bank transaction % would be explained by % against a line of %', txn, matched, line
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF abs(matched) > abs(line) THEN
    RAISE EXCEPTION 'bank transaction % would be explained by % of %', txn, matched, line
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  UPDATE bank_transactions SET matched_minor = matched
   WHERE id = txn AND matched_minor IS DISTINCT FROM matched;
END $$;
--> statement-breakpoint
-- A payment cannot be evidenced by more bank movement than it was worth.
CREATE FUNCTION workloom_check_payment_banked(payment uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  received bigint;
  banked bigint;
BEGIN
  SELECT amount_minor INTO received FROM payments WHERE id = payment FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT coalesce(sum(abs(amount_minor)), 0) INTO banked
    FROM bank_transaction_matches WHERE payment_id = payment;
  IF banked > received THEN
    RAISE EXCEPTION 'payment % would be matched to % of bank movement against %', payment, banked, received
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
END $$;
--> statement-breakpoint
-- An expense likewise, measured gross: what left the bank includes the tax.
CREATE FUNCTION workloom_check_expense_banked(expense uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  cost bigint;
  banked bigint;
BEGIN
  SELECT amount_minor + tax_minor INTO cost FROM expenses WHERE id = expense FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT coalesce(sum(abs(amount_minor)), 0) INTO banked
    FROM bank_transaction_matches WHERE expense_id = expense;
  IF banked > cost THEN
    RAISE EXCEPTION 'expense % would be matched to % of bank movement against %', expense, banked, cost
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
END $$;
--> statement-breakpoint
CREATE FUNCTION workloom_bank_match_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    PERFORM workloom_explain_transaction(OLD.bank_transaction_id);
    IF OLD.payment_id IS NOT NULL THEN PERFORM workloom_check_payment_banked(OLD.payment_id); END IF;
    IF OLD.expense_id IS NOT NULL THEN PERFORM workloom_check_expense_banked(OLD.expense_id); END IF;
    IF OLD.counterpart_transaction_id IS NOT NULL THEN PERFORM workloom_explain_transaction(OLD.counterpart_transaction_id); END IF;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    PERFORM workloom_explain_transaction(NEW.bank_transaction_id);
    IF NEW.payment_id IS NOT NULL THEN PERFORM workloom_check_payment_banked(NEW.payment_id); END IF;
    IF NEW.expense_id IS NOT NULL THEN PERFORM workloom_check_expense_banked(NEW.expense_id); END IF;
    IF NEW.counterpart_transaction_id IS NOT NULL THEN PERFORM workloom_explain_transaction(NEW.counterpart_transaction_id); END IF;
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER bank_transaction_matches_guard AFTER INSERT OR UPDATE OR DELETE ON "bank_transaction_matches"
  FOR EACH ROW EXECUTE FUNCTION workloom_bank_match_guard();
--> statement-breakpoint
-- Correcting a payment's amount changes whether its bank evidence still fits.
CREATE FUNCTION workloom_payment_banked_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.amount_minor IS DISTINCT FROM OLD.amount_minor THEN
    PERFORM workloom_check_payment_banked(NEW.id);
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER payments_banked_guard AFTER UPDATE ON "payments"
  FOR EACH ROW EXECUTE FUNCTION workloom_payment_banked_guard();
--> statement-breakpoint
CREATE FUNCTION workloom_expense_banked_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.amount_minor IS DISTINCT FROM OLD.amount_minor OR NEW.tax_minor IS DISTINCT FROM OLD.tax_minor THEN
    PERFORM workloom_check_expense_banked(NEW.id);
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER expenses_banked_guard AFTER UPDATE ON "expenses"
  FOR EACH ROW EXECUTE FUNCTION workloom_expense_banked_guard();
--> statement-breakpoint
-- A reconciled line is frozen, as a rebilled expense is: the reconciliation
-- that closed the period is what holds it, and undoing that releases it.
--
-- The columns left mutable are the reconciliation stamp itself -- so a period
-- can be closed and re-opened -- plus the notes a person writes about the line.
-- Everything the statement asserted is fixed.
CREATE FUNCTION workloom_bank_transaction_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  mutable constant text[] := ARRAY['reconciliation_id', 'reconciled_at', 'status', 'notes', 'updated_at'];
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.reconciliation_id IS NOT NULL THEN
      RAISE EXCEPTION 'bank transaction % has been reconciled: undo the reconciliation first', OLD.id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF OLD.matched_minor <> 0 THEN
      RAISE EXCEPTION 'bank transaction % explains a payment or an expense: unmatch it first', OLD.id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.reconciliation_id IS NOT NULL AND (to_jsonb(NEW) - mutable) IS DISTINCT FROM (to_jsonb(OLD) - mutable) THEN
    RAISE EXCEPTION 'bank transaction % has been reconciled and can no longer change', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  -- `matched_minor` is derived, and the only writer is `workloom_explain_transaction`.
  IF NEW.matched_minor IS DISTINCT FROM OLD.matched_minor THEN
    RAISE EXCEPTION 'bank transaction %: matched_minor follows its matches and is not set directly', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER bank_transactions_guard BEFORE UPDATE OR DELETE ON "bank_transactions"
  FOR EACH ROW EXECUTE FUNCTION workloom_bank_transaction_guard();
