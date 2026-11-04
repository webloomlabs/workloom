ALTER TABLE "invoices" DROP CONSTRAINT "invoices_issued_check";--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "fiscal_year_start_month" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "logo_key" text;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "brand_color" text;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "payment_details" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "invoice_notes_default" text;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "invoice_terms_default" text;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "quote_terms_default" text;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "document_footer" text;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "reclaims_input_tax" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "document_sequences" ADD COLUMN "scope" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "document_sequences" ADD COLUMN "format" text;--> statement-breakpoint
ALTER TABLE "document_sequences" ADD COLUMN "reset" text DEFAULT 'never' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "kind" text DEFAULT 'item' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "detail" text;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "billing_type" text;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "period_start" date;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "period_end" date;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "deducts_invoice_id" uuid;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "deduction_settled" boolean;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "due_label" text;--> statement-breakpoint
ALTER TABLE "quote_lines" ADD COLUMN "detail" text;--> statement-breakpoint
ALTER TABLE "quote_lines" ADD COLUMN "billing_type" text;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_deducts_fk" FOREIGN KEY ("organization_id","deducts_invoice_id") REFERENCES "public"."invoices"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invoice_lines_organization_deducts_idx" ON "invoice_lines" USING btree ("organization_id","deducts_invoice_id");--> statement-breakpoint
ALTER TABLE "document_sequences" DROP CONSTRAINT "document_sequences_pkey";
--> statement-breakpoint
ALTER TABLE "document_sequences" ADD CONSTRAINT "document_sequences_pkey" PRIMARY KEY("organization_id","kind","scope");--> statement-breakpoint
ALTER TABLE "organization" ADD CONSTRAINT "organization_fiscal_year_start_month_check" CHECK ("organization"."fiscal_year_start_month" between 1 and 12);--> statement-breakpoint
ALTER TABLE "organization" ADD CONSTRAINT "organization_brand_color_check" CHECK ("organization"."brand_color" ~ '^#[0-9a-f]{6}$');--> statement-breakpoint
ALTER TABLE "organization" ADD CONSTRAINT "organization_payment_details_check" CHECK (jsonb_typeof("organization"."payment_details") = 'array' and jsonb_array_length("organization"."payment_details") <= 8);--> statement-breakpoint
ALTER TABLE "document_sequences" ADD CONSTRAINT "document_sequences_reset_check" CHECK ("document_sequences"."reset" in ('never', 'yearly', 'fiscal_yearly'));--> statement-breakpoint
ALTER TABLE "document_sequences" ADD CONSTRAINT "document_sequences_format_check" CHECK ("document_sequences"."format" is null or (length("document_sequences"."format") <= 60 and "document_sequences"."format" ~ '\{N+\}'));--> statement-breakpoint
ALTER TABLE "document_sequences" ADD CONSTRAINT "document_sequences_reset_year_check" CHECK ("document_sequences"."reset" = 'never' or "document_sequences"."format" ~ '\{(YYYY|YY|FY)\}');--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_kind_check" CHECK ("invoice_lines"."kind" in ('item', 'deduction'));--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_billing_type_check" CHECK ("invoice_lines"."billing_type" in ('one_off', 'recurring'));--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_period_check" CHECK (("invoice_lines"."period_start" is null) = ("invoice_lines"."period_end" is null) and ("invoice_lines"."period_end" is null or "invoice_lines"."period_end" >= "invoice_lines"."period_start"));--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_deduction_check" CHECK (("invoice_lines"."kind" = 'deduction') = ("invoice_lines"."deducts_invoice_id" is not null) and ("invoice_lines"."kind" = 'item' or ("invoice_lines"."unit_amount_minor" < 0 and "invoice_lines"."quantity" = 1 and "invoice_lines"."discount_percent" is null and "invoice_lines"."service_id" is null)));--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_deduction_settled_check" CHECK ("invoice_lines"."deduction_settled" is null or "invoice_lines"."kind" = 'deduction');--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_due_check" CHECK (case when "invoices"."status" = 'draft' then "invoices"."due_date" is null else "invoices"."due_date" is not null or "invoices"."due_label" is not null end);--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_due_label_check" CHECK (length("invoices"."due_label") between 1 and 80);--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_issued_check" CHECK (("invoices"."status" = 'draft') = ("invoices"."sent_at" is null and "invoices"."issue_date" is null and "invoices"."exchange_rate_to_base" is null and "invoices"."base_currency" is null and "invoices"."total_base_minor" is null));--> statement-breakpoint
ALTER TABLE "quote_lines" ADD CONSTRAINT "quote_lines_billing_type_check" CHECK ("quote_lines"."billing_type" in ('one_off', 'recurring'));