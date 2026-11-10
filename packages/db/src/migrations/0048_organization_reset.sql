-- An owner may reset their organization: every record goes, the organization,
-- its members and its audit log stay (see packages/db/src/wipe.ts).
--
-- The guard triggers exist to stop exactly that -- an issued invoice is never
-- deleted, a locked period never changes -- and they are right to, for every
-- write but this one. Deleting the organization row already gets past them,
-- because its cascades run below trigger depth 1; a reset keeps the row and
-- deletes table by table, so it needs its own way through.
--
-- That way is narrow. Each trigger gains `WHEN (NOT workloom_wiping())`, and
-- workloom_wiping() is true only when the transaction has named an
-- organization to wipe AND is scoped to that same organization. Row-level
-- security confines the transaction to that organization's rows, so the guards
-- stand down for its rows alone, for the length of one transaction, and only
-- for a caller that asked by name. Every other write sees the guards as before.
--
-- The loop below rewrites every trigger present, rather than a list, so none
-- is missed; packages/db/test/wipe.test.ts fails for any trigger added later
-- without the condition.
--> statement-breakpoint
CREATE FUNCTION workloom_wiping() RETURNS boolean
  LANGUAGE sql STABLE AS $$
    SELECT coalesce(
      nullif(current_setting('workloom.wipe_org', true), '')
        = nullif(current_setting('workloom.org_id', true), ''),
      false
    )
  $$;
--> statement-breakpoint
DO $$
DECLARE
  t record;
  guarded text;
BEGIN
  FOR t IN
    SELECT tg.tgname AS name, tg.tgrelid::regclass AS tbl, pg_get_triggerdef(tg.oid) AS def
    FROM pg_trigger tg
      JOIN pg_class c ON c.oid = tg.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE NOT tg.tgisinternal AND n.nspname = 'public'
  LOOP
    -- Every trigger today is a plain row trigger. Anything else is refused
    -- rather than rewritten by a pattern that was not written for it.
    IF position(' WHEN (' IN t.def) > 0 THEN
      RAISE EXCEPTION 'trigger % on % already has a WHEN condition: add NOT workloom_wiping() to it by hand', t.name, t.tbl;
    END IF;
    guarded := replace(t.def, ' FOR EACH ROW EXECUTE FUNCTION ', ' FOR EACH ROW WHEN (NOT workloom_wiping()) EXECUTE FUNCTION ');
    IF guarded = t.def THEN
      RAISE EXCEPTION 'trigger % on % is not a plain row trigger: %', t.name, t.tbl, t.def;
    END IF;
    -- Same name, so the firing order (alphabetical, per table) is unchanged.
    EXECUTE format('DROP TRIGGER %I ON %s', t.name, t.tbl);
    EXECUTE guarded;
  END LOOP;
END $$;
