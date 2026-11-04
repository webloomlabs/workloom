ALTER TABLE "billing_schedule_invoices" DROP CONSTRAINT "billing_schedule_invoices_invoice_key";--> statement-breakpoint
ALTER TABLE "billing_schedule_lines" ADD COLUMN "detail" text;--> statement-breakpoint
ALTER TABLE "billing_schedules" ADD COLUMN "periods_per_invoice" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE INDEX "billing_schedule_invoices_organization_invoice_idx" ON "billing_schedule_invoices" USING btree ("organization_id","invoice_id");--> statement-breakpoint
ALTER TABLE "billing_schedules" ADD CONSTRAINT "billing_schedules_periods_per_invoice_check" CHECK ("billing_schedules"."periods_per_invoice" between 1 and 12);