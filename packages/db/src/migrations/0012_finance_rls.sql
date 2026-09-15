-- Row-level security for finance tables, and the rule that a quote, once
-- sent, never changes.
--
-- Hand-written, like the other policy migrations: the standard tenant_isolation
-- policy in its nullif() form on every table.
--> statement-breakpoint
ALTER TABLE "document_sequences" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "document_sequences" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "document_sequences"
  USING      ("organization_id" = nullif(current_setting('workloom.org_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('workloom.org_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "tax_rates" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "tax_rates" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "tax_rates"
  USING      ("organization_id" = nullif(current_setting('workloom.org_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('workloom.org_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "services" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "services" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "services"
  USING      ("organization_id" = nullif(current_setting('workloom.org_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('workloom.org_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "quotes" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "quotes" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "quotes"
  USING      ("organization_id" = nullif(current_setting('workloom.org_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('workloom.org_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "quote_lines" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "quote_lines" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "quote_lines"
  USING      ("organization_id" = nullif(current_setting('workloom.org_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('workloom.org_id', true), '')::uuid);
--> statement-breakpoint
-- A sent quote is a record of what was offered. The application refuses to
-- change one; these triggers make that true whatever the application does.
--
-- Once a quote leaves draft, only its status and the timestamps and reason of
-- the client's answer may change, and it can never return to draft. Comparing
-- the whole row minus those columns means a column added later is frozen too,
-- without anyone remembering to list it.
--
-- pg_trigger_depth() = 1 exempts deletes cascaded from the organization: removing
-- a whole tenant must remain possible. A cascade runs inside a referential
-- trigger, so its depth is greater than one.
CREATE FUNCTION workloom_quote_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  answer constant text[] := ARRAY['status', 'accepted_at', 'declined_at', 'decline_reason', 'expired_at', 'updated_at'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' AND pg_trigger_depth() = 1 THEN
      RAISE EXCEPTION 'quote % is %: sent quotes are never deleted', OLD.id, OLD.status USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status <> 'draft' AND (
    NEW.status = 'draft'
    OR (to_jsonb(NEW) - answer) IS DISTINCT FROM (to_jsonb(OLD) - answer)
  ) THEN
    RAISE EXCEPTION 'quote % is %: its content can no longer change', OLD.id, OLD.status USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER quotes_guard BEFORE UPDATE OR DELETE ON "quotes"
  FOR EACH ROW EXECUTE FUNCTION workloom_quote_guard();
--> statement-breakpoint
CREATE FUNCTION workloom_quote_line_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  parent_status text;
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  SELECT status INTO parent_status FROM quotes
    WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.quote_id ELSE NEW.quote_id END;
  IF parent_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'quote lines can change only while the quote is a draft' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.quote_id <> OLD.quote_id THEN
    RAISE EXCEPTION 'a quote line cannot move to another quote' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
--> statement-breakpoint
CREATE TRIGGER quote_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON "quote_lines"
  FOR EACH ROW EXECUTE FUNCTION workloom_quote_line_guard();
