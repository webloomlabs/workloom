-- Quotes and projects (S18).
--
-- 1. Option groups are tenant data like everything else.
-- 2. A sent quote may be given its project, and its group of alternatives,
--    once -- a quote accepted before the project existed is linked to it when
--    the project is created -- and never moved after. Everything else stays
--    frozen exactly as migration 0012 froze it; the body below is 0012's,
--    with that exception added.
-- 3. A group of alternatives is one client's: a quote cannot join another's.
--> statement-breakpoint
ALTER TABLE "quote_option_groups" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "quote_option_groups" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "quote_option_groups"
  USING      ("organization_id" = nullif(current_setting('workloom.org_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('workloom.org_id', true), '')::uuid);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION workloom_quote_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  answer constant text[] := ARRAY['status', 'accepted_at', 'declined_at', 'decline_reason', 'expired_at', 'updated_at'];
  frozen text[] := answer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' AND pg_trigger_depth() = 1 THEN
      RAISE EXCEPTION 'quote % is %: sent quotes are never deleted', OLD.id, OLD.status USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN OLD;
  END IF;
  -- Linked once, after the fact, and never moved.
  IF OLD.project_id IS NULL AND NEW.project_id IS NOT NULL THEN
    frozen := frozen || 'project_id'::text;
  END IF;
  IF OLD.option_group_id IS NULL AND NEW.option_group_id IS NOT NULL THEN
    frozen := frozen || 'option_group_id'::text || 'option_label'::text;
  END IF;
  IF OLD.status <> 'draft' AND (
    NEW.status = 'draft'
    OR (to_jsonb(NEW) - frozen) IS DISTINCT FROM (to_jsonb(OLD) - frozen)
  ) THEN
    RAISE EXCEPTION 'quote % is %: its content can no longer change', OLD.id, OLD.status USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE FUNCTION workloom_quote_option_group_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  group_company uuid;
BEGIN
  IF NEW.option_group_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT company_id INTO group_company FROM quote_option_groups WHERE id = NEW.option_group_id;
  IF group_company IS DISTINCT FROM NEW.company_id THEN
    RAISE EXCEPTION 'a quote can only be an option in a group for its own client' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER quotes_option_group_check BEFORE INSERT OR UPDATE OF option_group_id, company_id ON "quotes"
  FOR EACH ROW EXECUTE FUNCTION workloom_quote_option_group_check();
