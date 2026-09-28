-- The account a payment or an expense says it moved through, and the account
-- the statement line that explains it actually belongs to, are the same account.
--
-- S12 deliberately kept `bank_account_id` off these tables, on the grounds that
-- the match already says which account and a second copy with nothing holding
-- the two equal is how they drift. The column exists now because there is a
-- real fact to record that the match cannot hold: at the moment someone records
-- a payment, no statement has arrived and there is no line to match. What
-- follows is the constraint that answers the original objection -- the two
-- cannot come to disagree, whichever is written first.
--
-- Note what this does NOT do: recording a payment against an account does not
-- create a bank transaction. The register mirrors what the bank reported, and
-- nothing else; inventing a line here would collide with the real one when the
-- statement is imported.
--> statement-breakpoint
-- A line can only ever explain money recorded against its own account.
CREATE FUNCTION workloom_match_account_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  line_account uuid;
  recorded_account uuid;
  target text;
BEGIN
  IF NEW.payment_id IS NOT NULL THEN
    SELECT bank_account_id INTO recorded_account FROM payments WHERE id = NEW.payment_id;
    target := 'payment';
  ELSIF NEW.expense_id IS NOT NULL THEN
    SELECT bank_account_id INTO recorded_account FROM expenses WHERE id = NEW.expense_id;
    target := 'expense';
  ELSE
    -- A transfer's two legs are each already in a known account.
    RETURN NEW;
  END IF;
  -- Nothing was claimed about the account, so nothing can contradict it.
  IF recorded_account IS NULL THEN RETURN NEW; END IF;

  SELECT bank_account_id INTO line_account FROM bank_transactions WHERE id = NEW.bank_transaction_id;
  IF line_account IS DISTINCT FROM recorded_account THEN
    RAISE EXCEPTION 'that % was recorded against a different account', target
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER bank_transaction_matches_account_guard BEFORE INSERT OR UPDATE ON "bank_transaction_matches"
  FOR EACH ROW EXECUTE FUNCTION workloom_match_account_guard();
--> statement-breakpoint
-- And the same rule from the other side: the account cannot be moved out from
-- under a line that already explains the money.
CREATE OR REPLACE FUNCTION workloom_payment_banked_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.amount_minor IS DISTINCT FROM OLD.amount_minor THEN
    PERFORM workloom_check_payment_banked(NEW.id);
  END IF;
  IF NEW.bank_account_id IS DISTINCT FROM OLD.bank_account_id AND NEW.bank_account_id IS NOT NULL THEN
    IF EXISTS (
      SELECT 1
        FROM bank_transaction_matches m
        JOIN bank_transactions t ON t.id = m.bank_transaction_id
       WHERE m.payment_id = NEW.id AND t.bank_account_id <> NEW.bank_account_id
    ) THEN
      RAISE EXCEPTION 'payment % is already explained by a statement line in another account', NEW.id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION workloom_expense_banked_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.amount_minor IS DISTINCT FROM OLD.amount_minor OR NEW.tax_minor IS DISTINCT FROM OLD.tax_minor THEN
    PERFORM workloom_check_expense_banked(NEW.id);
  END IF;
  IF NEW.bank_account_id IS DISTINCT FROM OLD.bank_account_id AND NEW.bank_account_id IS NOT NULL THEN
    IF EXISTS (
      SELECT 1
        FROM bank_transaction_matches m
        JOIN bank_transactions t ON t.id = m.bank_transaction_id
       WHERE m.expense_id = NEW.id AND t.bank_account_id <> NEW.bank_account_id
    ) THEN
      RAISE EXCEPTION 'expense % is already explained by a statement line in another account', NEW.id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
