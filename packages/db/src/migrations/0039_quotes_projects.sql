CREATE TABLE "quote_option_groups" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid,
	"name" text NOT NULL,
	"decided_quote_id" uuid,
	"decided_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quote_option_groups_organization_id_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "quote_option_groups_decided_check" CHECK (("quote_option_groups"."decided_quote_id" is null) = ("quote_option_groups"."decided_at" is null))
);
--> statement-breakpoint
ALTER TABLE "project_billing_stages" DROP CONSTRAINT "project_billing_stages_basis_check";--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "contract_quote_id" uuid;--> statement-breakpoint
ALTER TABLE "project_billing_stages" ADD COLUMN "invoice_style" text DEFAULT 'single_line' NOT NULL;--> statement-breakpoint
ALTER TABLE "quote_lines" ADD COLUMN "interval_unit" text;--> statement-breakpoint
ALTER TABLE "quote_lines" ADD COLUMN "interval_count" integer;--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "option_group_id" uuid;--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "option_label" text;--> statement-breakpoint
ALTER TABLE "billing_schedules" ADD COLUMN "quote_id" uuid;--> statement-breakpoint
ALTER TABLE "quote_option_groups" ADD CONSTRAINT "quote_option_groups_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_option_groups" ADD CONSTRAINT "quote_option_groups_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_option_groups" ADD CONSTRAINT "quote_option_groups_company_fk" FOREIGN KEY ("organization_id","company_id") REFERENCES "public"."companies"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_option_groups" ADD CONSTRAINT "quote_option_groups_project_fk" FOREIGN KEY ("organization_id","project_id") REFERENCES "public"."projects"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "quote_option_groups_organization_company_idx" ON "quote_option_groups" USING btree ("organization_id","company_id");--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_option_group_fk" FOREIGN KEY ("organization_id","option_group_id") REFERENCES "public"."quote_option_groups"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_billing_stages_one_balance_key" ON "project_billing_stages" USING btree ("organization_id","project_id") WHERE "project_billing_stages"."basis" = 'balance' and "project_billing_stages"."status" <> 'cancelled';--> statement-breakpoint
CREATE INDEX "quotes_organization_project_idx" ON "quotes" USING btree ("organization_id","project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "quotes_one_accepted_option_key" ON "quotes" USING btree ("organization_id","option_group_id") WHERE "quotes"."status" = 'accepted' and "quotes"."option_group_id" is not null;--> statement-breakpoint
ALTER TABLE "project_billing_stages" ADD CONSTRAINT "project_billing_stages_invoice_style_check" CHECK ("project_billing_stages"."invoice_style" in ('single_line', 'statement'));--> statement-breakpoint
ALTER TABLE "project_billing_stages" ADD CONSTRAINT "project_billing_stages_basis_check" CHECK ("project_billing_stages"."basis" in ('amount', 'percent', 'balance'));--> statement-breakpoint
ALTER TABLE "quote_lines" ADD CONSTRAINT "quote_lines_interval_check" CHECK (("quote_lines"."interval_unit" is null) = ("quote_lines"."interval_count" is null) and ("quote_lines"."interval_unit" is null or ("quote_lines"."billing_type" = 'recurring' and "quote_lines"."interval_unit" in ('week', 'month', 'quarter', 'year') and "quote_lines"."interval_count" between 1 and 52)));