-- Row-level security for the billing plan.
--
-- Policy only, deliberately. The rule that matters here -- that a plan cannot
-- bill more than the project is contracted for -- is NOT a trigger: a row-level
-- CHECK cannot see other rows, and the ceiling lives in two other tables
-- (`projects.contract_value_minor` plus the accepted `project_revisions`). A
-- trigger reading both on every write would hide the rule from anyone reading
-- the application, which is the argument this codebase already makes for task
-- dependency cycles. It is refused in `projectBillingStage.release`, under a
-- project row lock, which serialises the only race that matters.
--
-- What the database does guarantee is the pair of facts a person cannot talk it
-- out of: one stage per invoice (`project_billing_stages_invoice_key`), and
-- that an invoiced stage carries its invoice, its frozen amount and its
-- timestamp together or not at all (`..._released_check`).
--> statement-breakpoint
ALTER TABLE "project_billing_stages" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "project_billing_stages" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "project_billing_stages"
  USING      ("organization_id" = nullif(current_setting('workloom.org_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('workloom.org_id', true), '')::uuid);
