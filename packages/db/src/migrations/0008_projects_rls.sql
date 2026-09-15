-- Row-level security for projects, milestones, tasks, and their children.
--
-- Hand-written, like the other policy migrations: the standard tenant_isolation
-- policy in its nullif() form on every table. Nothing here needs to be read
-- across organizations.
--> statement-breakpoint
ALTER TABLE "projects" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "projects" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "projects"
  USING      ("organization_id" = nullif(current_setting('workloom.org_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('workloom.org_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "project_members" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "project_members" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "project_members"
  USING      ("organization_id" = nullif(current_setting('workloom.org_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('workloom.org_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "milestones" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "milestones" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "milestones"
  USING      ("organization_id" = nullif(current_setting('workloom.org_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('workloom.org_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "tasks" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "tasks" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "tasks"
  USING      ("organization_id" = nullif(current_setting('workloom.org_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('workloom.org_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "task_dependencies" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "task_dependencies" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "task_dependencies"
  USING      ("organization_id" = nullif(current_setting('workloom.org_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('workloom.org_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "comments" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "comments" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "comments"
  USING      ("organization_id" = nullif(current_setting('workloom.org_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('workloom.org_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "attachments" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "attachments" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "attachments"
  USING      ("organization_id" = nullif(current_setting('workloom.org_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('workloom.org_id', true), '')::uuid);
