-- The opening balance can be corrected until a period is reconciled (S20+).
--
-- 0023 froze it as soon as an account had any line, on the grounds that the
-- anchor is what every reconciliation is measured from. That reasoning holds
-- for reconciliations -- so it is kept for them -- but lines now also come from
-- payments and expenses recorded in Workloom, and a person setting up an
-- account must be able to fix a mistyped opening figure after recording the
-- first payment. Moving the anchor recomputes the balance at once.
--> statement-breakpoint
CREATE OR REPLACE FUNCTION workloom_bank_account_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- The currency is in the foreign key of every transaction and match below it.
  IF NEW.currency IS DISTINCT FROM OLD.currency THEN
    RAISE EXCEPTION 'bank account %: an account in another currency is another account', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.opening_balance_minor IS DISTINCT FROM OLD.opening_balance_minor
     OR NEW.opening_balance_on IS DISTINCT FROM OLD.opening_balance_on THEN
    IF EXISTS (SELECT 1 FROM bank_transactions WHERE bank_account_id = OLD.id AND reconciliation_id IS NOT NULL) THEN
      RAISE EXCEPTION 'bank account % has reconciled periods: moving the opening balance rewrites every reconciliation measured from it', OLD.id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    -- The balance follows the new anchor straight away.
    NEW.current_balance_minor := NEW.opening_balance_minor
      + coalesce((SELECT sum(amount_minor) FROM bank_transactions WHERE bank_account_id = OLD.id), 0);
    RETURN NEW;
  END IF;
  -- Otherwise `current_balance_minor` is derived, and the only writer is
  -- `workloom_bank_balance`. A trigger runs deeper than 1; a hand-written UPDATE does not.
  IF NEW.current_balance_minor IS DISTINCT FROM OLD.current_balance_minor AND pg_trigger_depth() = 1 THEN
    RAISE EXCEPTION 'bank account %: current_balance_minor follows its transactions and is not set directly', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
