ALTER TABLE "expenses" ADD COLUMN "bank_account_id" uuid;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "bank_account_id" uuid;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_bank_account_fk" FOREIGN KEY ("organization_id","bank_account_id","currency") REFERENCES "public"."bank_accounts"("organization_id","id","currency") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_bank_account_fk" FOREIGN KEY ("organization_id","bank_account_id","currency") REFERENCES "public"."bank_accounts"("organization_id","id","currency") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "expenses_organization_bank_account_idx" ON "expenses" USING btree ("organization_id","bank_account_id");--> statement-breakpoint
CREATE INDEX "payments_organization_bank_account_idx" ON "payments" USING btree ("organization_id","bank_account_id");