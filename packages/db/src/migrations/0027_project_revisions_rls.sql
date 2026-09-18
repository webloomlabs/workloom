-- Row-level security for project revisions, and the rule that a revision, once
-- sent, never changes.
--
-- A revision is an offer: "this is what the change costs, and this is the new
-- date". Once it has gone to the client, editing the amount would rewrite what
-- they agreed to, so the same freeze the quotes table has applies here, in the
-- same shape and for the same reason.
--> statement-breakpoint
ALTER TABLE "project_revisions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "project_revisions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "project_revisions"
  USING      ("organization_id" = nullif(current_setting('workloom.org_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('workloom.org_id', true), '')::uuid);
--> statement-breakpoint
-- Once a revision leaves draft, only the client's answer and the record of what
-- it moved may change, and it can never return to draft. Comparing the whole
-- row minus those columns means a column added later is frozen too, without
-- anyone remembering to list it.
--
-- pg_trigger_depth() = 1 exempts deletes cascaded from the organization:
-- removing a whole tenant must remain possible.
CREATE FUNCTION workloom_project_revision_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  answer constant text[] := ARRAY[
    'status', 'sent_at', 'accepted_at', 'accepted_by', 'declined_at', 'decline_reason', 'withdrawn_at',
    'previous_contract_value_minor', 'previous_due_date', 'applied_at', 'updated_at'
  ];
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' AND pg_trigger_depth() = 1 THEN
      RAISE EXCEPTION 'revision % is %: a revision that has left draft is never deleted', OLD.id, OLD.status
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status <> 'draft' AND (
    NEW.status = 'draft'
    OR (to_jsonb(NEW) - answer) IS DISTINCT FROM (to_jsonb(OLD) - answer)
  ) THEN
    RAISE EXCEPTION 'revision % is %: its content can no longer change', OLD.id, OLD.status
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER project_revisions_guard BEFORE UPDATE OR DELETE ON "project_revisions"
  FOR EACH ROW EXECUTE FUNCTION workloom_project_revision_guard();
