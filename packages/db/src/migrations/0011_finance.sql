CREATE TABLE "document_sequences" (
	"organization_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"prefix" text NOT NULL,
	"padding" integer DEFAULT 4 NOT NULL,
	"next_value" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_sequences_pkey" PRIMARY KEY("organization_id","kind"),
	CONSTRAINT "document_sequences_kind_check" CHECK ("document_sequences"."kind" in ('quote', 'invoice')),
	CONSTRAINT "document_sequences_next_value_check" CHECK ("document_sequences"."next_value" >= 1),
	CONSTRAINT "document_sequences_padding_check" CHECK ("document_sequences"."padding" between 1 and 12)
);
--> statement-breakpoint
CREATE TABLE "quote_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"quote_id" uuid NOT NULL,
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
	CONSTRAINT "quote_lines_organization_id_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "quote_lines_quantity_check" CHECK ("quote_lines"."quantity" <> 0),
	CONSTRAINT "quote_lines_discount_check" CHECK ("quote_lines"."discount_percent" between 0 and 100),
	CONSTRAINT "quote_lines_tax_snapshot_check" CHECK (("quote_lines"."tax_rate_id" is null) = ("quote_lines"."tax_name" is null) and ("quote_lines"."tax_name" is null) = ("quote_lines"."tax_rate_pct_snapshot" is null)),
	CONSTRAINT "quote_lines_totals_check" CHECK ("quote_lines"."net_minor" = "quote_lines"."amount_minor" - "quote_lines"."line_discount_minor")
);
--> statement-breakpoint
CREATE TABLE "quotes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"number" text,
	"company_id" uuid NOT NULL,
	"contact_id" uuid,
	"deal_id" uuid,
	"project_id" uuid,
	"title" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"currency" text NOT NULL,
	"tax_mode" text DEFAULT 'exclusive' NOT NULL,
	"issue_date" date,
	"valid_until" date NOT NULL,
	"discount_percent" numeric(7, 4),
	"discount_amount_minor" bigint,
	"subtotal_minor" bigint DEFAULT 0 NOT NULL,
	"discount_minor" bigint DEFAULT 0 NOT NULL,
	"tax_minor" bigint DEFAULT 0 NOT NULL,
	"total_minor" bigint DEFAULT 0 NOT NULL,
	"base_currency" text,
	"exchange_rate_to_base" numeric(18, 8),
	"total_base_minor" bigint,
	"notes" text,
	"terms" text,
	"sent_at" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	"declined_at" timestamp with time zone,
	"decline_reason" text,
	"expired_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quotes_organization_id_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "quotes_status_check" CHECK ("quotes"."status" in ('draft', 'sent', 'accepted', 'declined', 'expired')),
	CONSTRAINT "quotes_tax_mode_check" CHECK ("quotes"."tax_mode" in ('exclusive', 'inclusive')),
	CONSTRAINT "quotes_currency_check" CHECK ("quotes"."currency" ~ '^[A-Z]{3}$' and ("quotes"."base_currency" is null or "quotes"."base_currency" ~ '^[A-Z]{3}$')),
	CONSTRAINT "quotes_one_discount_check" CHECK ("quotes"."discount_percent" is null or "quotes"."discount_amount_minor" is null),
	CONSTRAINT "quotes_discount_check" CHECK ("quotes"."discount_percent" between 0 and 100 and "quotes"."discount_amount_minor" >= 0),
	CONSTRAINT "quotes_number_check" CHECK (("quotes"."status" = 'draft') = ("quotes"."number" is null)),
	CONSTRAINT "quotes_issued_check" CHECK (("quotes"."status" = 'draft') = ("quotes"."sent_at" is null and "quotes"."issue_date" is null and "quotes"."exchange_rate_to_base" is null and "quotes"."base_currency" is null and "quotes"."total_base_minor" is null)),
	CONSTRAINT "quotes_exchange_rate_check" CHECK ("quotes"."exchange_rate_to_base" > 0),
	CONSTRAINT "quotes_accepted_check" CHECK (("quotes"."status" = 'accepted') = ("quotes"."accepted_at" is not null)),
	CONSTRAINT "quotes_declined_check" CHECK (("quotes"."status" = 'declined') = ("quotes"."declined_at" is not null)),
	CONSTRAINT "quotes_expired_check" CHECK (("quotes"."status" = 'expired') = ("quotes"."expired_at" is not null)),
	CONSTRAINT "quotes_valid_until_check" CHECK ("quotes"."issue_date" is null or "quotes"."valid_until" >= "quotes"."issue_date")
);
--> statement-breakpoint
CREATE TABLE "services" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"pricing_model" text DEFAULT 'fixed' NOT NULL,
	"billing_type" text DEFAULT 'one_off' NOT NULL,
	"unit" text,
	"currency" text NOT NULL,
	"default_price_minor" bigint,
	"default_tax_rate_id" uuid,
	"archived_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "services_organization_id_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "services_pricing_model_check" CHECK ("services"."pricing_model" in ('fixed', 'hourly', 'per_unit')),
	CONSTRAINT "services_billing_type_check" CHECK ("services"."billing_type" in ('one_off', 'recurring')),
	CONSTRAINT "services_currency_check" CHECK ("services"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "services_price_check" CHECK ("services"."default_price_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE "tax_rates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"rate" numeric(7, 4) NOT NULL,
	"description" text,
	"archived_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tax_rates_organization_id_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "tax_rates_rate_check" CHECK ("tax_rates"."rate" between 0 and 100)
);
--> statement-breakpoint
ALTER TABLE "document_sequences" ADD CONSTRAINT "document_sequences_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_lines" ADD CONSTRAINT "quote_lines_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_lines" ADD CONSTRAINT "quote_lines_quote_fk" FOREIGN KEY ("organization_id","quote_id") REFERENCES "public"."quotes"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_lines" ADD CONSTRAINT "quote_lines_service_fk" FOREIGN KEY ("organization_id","service_id") REFERENCES "public"."services"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_lines" ADD CONSTRAINT "quote_lines_tax_rate_fk" FOREIGN KEY ("organization_id","tax_rate_id") REFERENCES "public"."tax_rates"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_company_fk" FOREIGN KEY ("organization_id","company_id") REFERENCES "public"."companies"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_contact_fk" FOREIGN KEY ("organization_id","contact_id") REFERENCES "public"."contacts"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_deal_fk" FOREIGN KEY ("organization_id","deal_id") REFERENCES "public"."deals"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_project_fk" FOREIGN KEY ("organization_id","project_id") REFERENCES "public"."projects"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_default_tax_rate_fk" FOREIGN KEY ("organization_id","default_tax_rate_id") REFERENCES "public"."tax_rates"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_rates" ADD CONSTRAINT "tax_rates_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_rates" ADD CONSTRAINT "tax_rates_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "quote_lines_organization_quote_position_idx" ON "quote_lines" USING btree ("organization_id","quote_id","position");--> statement-breakpoint
CREATE INDEX "quote_lines_organization_tax_rate_idx" ON "quote_lines" USING btree ("organization_id","tax_rate_id");--> statement-breakpoint
CREATE UNIQUE INDEX "quotes_organization_number_key" ON "quotes" USING btree ("organization_id","number");--> statement-breakpoint
CREATE INDEX "quotes_organization_status_idx" ON "quotes" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "quotes_organization_company_idx" ON "quotes" USING btree ("organization_id","company_id");--> statement-breakpoint
CREATE INDEX "quotes_organization_deal_idx" ON "quotes" USING btree ("organization_id","deal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "services_organization_name_key" ON "services" USING btree ("organization_id",lower("name")) WHERE "services"."archived_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "tax_rates_organization_name_key" ON "tax_rates" USING btree ("organization_id",lower("name")) WHERE "tax_rates"."archived_at" is null;