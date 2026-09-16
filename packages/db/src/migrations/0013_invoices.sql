CREATE TABLE "invoice_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"service_id" uuid,
	"description" text NOT NULL,
	"quantity" numeric(14, 4) NOT NULL,
	"unit_amount_minor" bigint NOT NULL,
	"discount_percent" numeric(7, 4),
	"tax_rate_id" uuid,
	"tax_name" text,
	"tax_rate_pct_snapshot" numeric(7, 4),
	"amount_minor" bigint NOT NULL,
	"line_discount_minor" bigint NOT NULL,
	"net_minor" bigint NOT NULL,
	"document_discount_minor" bigint NOT NULL,
	"tax_minor" bigint NOT NULL,
	"total_minor" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoice_lines_organization_id_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "invoice_lines_quantity_check" CHECK ("invoice_lines"."quantity" <> 0),
	CONSTRAINT "invoice_lines_discount_check" CHECK ("invoice_lines"."discount_percent" between 0 and 100),
	CONSTRAINT "invoice_lines_tax_snapshot_check" CHECK (("invoice_lines"."tax_rate_id" is null) = ("invoice_lines"."tax_name" is null) and ("invoice_lines"."tax_name" is null) = ("invoice_lines"."tax_rate_pct_snapshot" is null)),
	CONSTRAINT "invoice_lines_totals_check" CHECK ("invoice_lines"."net_minor" = "invoice_lines"."amount_minor" - "invoice_lines"."line_discount_minor")
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"number" text,
	"company_id" uuid NOT NULL,
	"contact_id" uuid,
	"deal_id" uuid,
	"project_id" uuid,
	"quote_id" uuid,
	"title" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"currency" text NOT NULL,
	"tax_mode" text DEFAULT 'exclusive' NOT NULL,
	"issue_date" date,
	"due_date" date,
	"payment_terms_days" integer DEFAULT 14 NOT NULL,
	"discount_percent" numeric(7, 4),
	"discount_amount_minor" bigint,
	"subtotal_minor" bigint DEFAULT 0 NOT NULL,
	"discount_minor" bigint DEFAULT 0 NOT NULL,
	"tax_minor" bigint DEFAULT 0 NOT NULL,
	"total_minor" bigint DEFAULT 0 NOT NULL,
	"amount_paid_minor" bigint DEFAULT 0 NOT NULL,
	"base_currency" text,
	"exchange_rate_to_base" numeric(18, 8),
	"total_base_minor" bigint,
	"notes" text,
	"terms" text,
	"sent_at" timestamp with time zone,
	"email_to" text,
	"email_sent_at" timestamp with time zone,
	"viewed_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoices_organization_id_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "invoices_status_check" CHECK ("invoices"."status" in ('draft', 'sent', 'viewed', 'partially_paid', 'paid', 'overdue', 'cancelled', 'refunded')),
	CONSTRAINT "invoices_tax_mode_check" CHECK ("invoices"."tax_mode" in ('exclusive', 'inclusive')),
	CONSTRAINT "invoices_currency_check" CHECK ("invoices"."currency" ~ '^[A-Z]{3}$' and ("invoices"."base_currency" is null or "invoices"."base_currency" ~ '^[A-Z]{3}$')),
	CONSTRAINT "invoices_one_discount_check" CHECK ("invoices"."discount_percent" is null or "invoices"."discount_amount_minor" is null),
	CONSTRAINT "invoices_discount_check" CHECK ("invoices"."discount_percent" between 0 and 100 and "invoices"."discount_amount_minor" >= 0),
	CONSTRAINT "invoices_number_check" CHECK (("invoices"."status" = 'draft') = ("invoices"."number" is null)),
	CONSTRAINT "invoices_issued_check" CHECK (("invoices"."status" = 'draft') = ("invoices"."sent_at" is null and "invoices"."issue_date" is null and "invoices"."due_date" is null and "invoices"."exchange_rate_to_base" is null and "invoices"."base_currency" is null and "invoices"."total_base_minor" is null)),
	CONSTRAINT "invoices_exchange_rate_check" CHECK ("invoices"."exchange_rate_to_base" > 0),
	CONSTRAINT "invoices_due_date_check" CHECK ("invoices"."due_date" is null or "invoices"."due_date" >= "invoices"."issue_date"),
	CONSTRAINT "invoices_payment_terms_check" CHECK ("invoices"."payment_terms_days" between 0 and 365),
	CONSTRAINT "invoices_cancelled_check" CHECK (("invoices"."status" = 'cancelled') = ("invoices"."cancelled_at" is not null)),
	CONSTRAINT "invoices_paid_check" CHECK ("invoices"."amount_paid_minor" >= 0 and ("invoices"."paid_at" is null or "invoices"."status" in ('paid', 'refunded'))),
	CONSTRAINT "invoices_viewed_check" CHECK ("invoices"."viewed_at" is null or "invoices"."status" <> 'draft')
);
--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "legal_name" text;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "billing_address" text;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "tax_number" text;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "payment_instructions" text;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "payment_terms_days" integer DEFAULT 14 NOT NULL;--> statement-breakpoint
ALTER TABLE "time_entries" ADD COLUMN "invoice_line_id" uuid;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_invoice_fk" FOREIGN KEY ("organization_id","invoice_id") REFERENCES "public"."invoices"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_service_fk" FOREIGN KEY ("organization_id","service_id") REFERENCES "public"."services"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_tax_rate_fk" FOREIGN KEY ("organization_id","tax_rate_id") REFERENCES "public"."tax_rates"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_company_fk" FOREIGN KEY ("organization_id","company_id") REFERENCES "public"."companies"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_contact_fk" FOREIGN KEY ("organization_id","contact_id") REFERENCES "public"."contacts"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_deal_fk" FOREIGN KEY ("organization_id","deal_id") REFERENCES "public"."deals"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_project_fk" FOREIGN KEY ("organization_id","project_id") REFERENCES "public"."projects"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_quote_fk" FOREIGN KEY ("organization_id","quote_id") REFERENCES "public"."quotes"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invoice_lines_organization_invoice_position_idx" ON "invoice_lines" USING btree ("organization_id","invoice_id","position");--> statement-breakpoint
CREATE INDEX "invoice_lines_organization_tax_rate_idx" ON "invoice_lines" USING btree ("organization_id","tax_rate_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_organization_number_key" ON "invoices" USING btree ("organization_id","number");--> statement-breakpoint
CREATE INDEX "invoices_organization_status_idx" ON "invoices" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "invoices_organization_company_idx" ON "invoices" USING btree ("organization_id","company_id");--> statement-breakpoint
CREATE INDEX "invoices_organization_due_date_idx" ON "invoices" USING btree ("organization_id","due_date");--> statement-breakpoint
CREATE INDEX "invoices_organization_quote_idx" ON "invoices" USING btree ("organization_id","quote_id");--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_invoice_line_fk" FOREIGN KEY ("organization_id","invoice_line_id") REFERENCES "public"."invoice_lines"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "time_entries_organization_invoice_line_idx" ON "time_entries" USING btree ("organization_id","invoice_line_id");