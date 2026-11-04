-- Row-level security for the Telegram bot, linked chat accounts, link codes, and the update inbox (S19).
--> statement-breakpoint
ALTER TABLE "telegram_bots" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "telegram_bots" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "telegram_bots"
  USING      ("organization_id" = nullif(current_setting('workloom.org_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('workloom.org_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "messaging_identities" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "messaging_identities" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "messaging_identities"
  USING      ("organization_id" = nullif(current_setting('workloom.org_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('workloom.org_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "messaging_link_codes" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "messaging_link_codes" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "messaging_link_codes"
  USING      ("organization_id" = nullif(current_setting('workloom.org_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('workloom.org_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "telegram_updates" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "telegram_updates" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "telegram_updates"
  USING      ("organization_id" = nullif(current_setting('workloom.org_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('workloom.org_id', true), '')::uuid);
