-- The key `payment_allocations` references, so an allocation cannot name an
-- invoice in another currency. Declared first: the foreign key below needs it.
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_organization_id_id_currency_key" UNIQUE("organization_id","id","currency");
--> statement-breakpoint
CREATE TABLE "expenses" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid,
	"company_id" uuid,
	"description" text NOT NULL,
	"supplier" text,
	"category" text DEFAULT 'other' NOT NULL,
	"incurred_on" date NOT NULL,
	"currency" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"tax_rate_id" uuid,
	"tax_name" text,
	"tax_rate_pct_snapshot" numeric(7, 4),
	"tax_minor" bigint DEFAULT 0 NOT NULL,
	"base_currency" text NOT NULL,
	"exchange_rate_to_base" numeric(18, 8) NOT NULL,
	"amount_base_minor" bigint NOT NULL,
	"billable" boolean DEFAULT false NOT NULL,
	"markup_percent" numeric(7, 4),
	"invoice_line_id" uuid,
	"notes" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "expenses_organization_id_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "expenses_category_check" CHECK ("expenses"."category" in ('software', 'hosting', 'domains', 'hardware', 'contractor', 'advertising', 'travel', 'office', 'fees', 'other')),
	CONSTRAINT "expenses_currency_check" CHECK ("expenses"."currency" ~ '^[A-Z]{3}$' and "expenses"."base_currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "expenses_amount_check" CHECK ("expenses"."amount_minor" >= 0 and "expenses"."tax_minor" >= 0),
	CONSTRAINT "expenses_exchange_rate_check" CHECK ("expenses"."exchange_rate_to_base" > 0),
	CONSTRAINT "expenses_tax_snapshot_check" CHECK (("expenses"."tax_rate_id" is null) = ("expenses"."tax_name" is null) and ("expenses"."tax_name" is null) = ("expenses"."tax_rate_pct_snapshot" is null)),
	CONSTRAINT "expenses_markup_check" CHECK ("expenses"."markup_percent" between 0 and 1000),
	CONSTRAINT "expenses_billable_check" CHECK ("expenses"."invoice_line_id" is null or "expenses"."billable")
);
--> statement-breakpoint
CREATE TABLE "payment_allocations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"currency" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_allocations_organization_id_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "payment_allocations_payment_invoice_key" UNIQUE("organization_id","payment_id","invoice_id"),
	CONSTRAINT "payment_allocations_amount_check" CHECK ("payment_allocations"."amount_minor" > 0),
	CONSTRAINT "payment_allocations_currency_check" CHECK ("payment_allocations"."currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"kind" text DEFAULT 'payment' NOT NULL,
	"received_on" date NOT NULL,
	"method" text DEFAULT 'bank_transfer' NOT NULL,
	"reference" text,
	"currency" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"base_currency" text NOT NULL,
	"exchange_rate_to_base" numeric(18, 8) NOT NULL,
	"amount_base_minor" bigint NOT NULL,
	"notes" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_organization_id_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "payments_organization_id_id_currency_key" UNIQUE("organization_id","id","currency"),
	CONSTRAINT "payments_kind_check" CHECK ("payments"."kind" in ('payment', 'refund')),
	CONSTRAINT "payments_method_check" CHECK ("payments"."method" in ('bank_transfer', 'card', 'direct_debit', 'cash', 'cheque', 'paypal', 'stripe', 'other')),
	CONSTRAINT "payments_currency_check" CHECK ("payments"."currency" ~ '^[A-Z]{3}$' and "payments"."base_currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "payments_amount_check" CHECK ("payments"."amount_minor" > 0),
	CONSTRAINT "payments_exchange_rate_check" CHECK ("payments"."exchange_rate_to_base" > 0)
);
--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_project_fk" FOREIGN KEY ("organization_id","project_id") REFERENCES "public"."projects"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_company_fk" FOREIGN KEY ("organization_id","company_id") REFERENCES "public"."companies"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_tax_rate_fk" FOREIGN KEY ("organization_id","tax_rate_id") REFERENCES "public"."tax_rates"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_invoice_line_fk" FOREIGN KEY ("organization_id","invoice_line_id") REFERENCES "public"."invoice_lines"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_payment_fk" FOREIGN KEY ("organization_id","payment_id","currency") REFERENCES "public"."payments"("organization_id","id","currency") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_invoice_fk" FOREIGN KEY ("organization_id","invoice_id","currency") REFERENCES "public"."invoices"("organization_id","id","currency") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_company_fk" FOREIGN KEY ("organization_id","company_id") REFERENCES "public"."companies"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "expenses_organization_incurred_on_idx" ON "expenses" USING btree ("organization_id","incurred_on");--> statement-breakpoint
CREATE INDEX "expenses_organization_project_idx" ON "expenses" USING btree ("organization_id","project_id");--> statement-breakpoint
CREATE INDEX "expenses_organization_company_idx" ON "expenses" USING btree ("organization_id","company_id");--> statement-breakpoint
CREATE INDEX "expenses_organization_invoice_line_idx" ON "expenses" USING btree ("organization_id","invoice_line_id");--> statement-breakpoint
CREATE INDEX "payment_allocations_organization_invoice_idx" ON "payment_allocations" USING btree ("organization_id","invoice_id");--> statement-breakpoint
CREATE INDEX "payments_organization_company_idx" ON "payments" USING btree ("organization_id","company_id");--> statement-breakpoint
CREATE INDEX "payments_organization_received_on_idx" ON "payments" USING btree ("organization_id","received_on");
