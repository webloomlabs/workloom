CREATE TABLE "project_budget_alerts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"measure" text NOT NULL,
	"period_start" date NOT NULL,
	"threshold" integer NOT NULL,
	"percent" integer NOT NULL,
	"alerted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_budget_alerts_organization_id_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "project_budget_alerts_once_key" UNIQUE("organization_id","project_id","measure","period_start","threshold"),
	CONSTRAINT "project_budget_alerts_measure_check" CHECK ("project_budget_alerts"."measure" in ('cost', 'hours')),
	CONSTRAINT "project_budget_alerts_threshold_check" CHECK ("project_budget_alerts"."threshold" between 1 and 1000)
);
--> statement-breakpoint
CREATE TABLE "project_types" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"default_billing_model" text DEFAULT 'fixed_price' NOT NULL,
	"default_budget_period" text DEFAULT 'total' NOT NULL,
	"color" text,
	"position" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_types_organization_id_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "project_types_billing_model_check" CHECK ("project_types"."default_billing_model" in ('fixed_price', 'retainer', 'time_and_materials', 'non_billable')),
	CONSTRAINT "project_types_budget_period_check" CHECK ("project_types"."default_budget_period" in ('total', 'week', 'month', 'quarter', 'year')),
	CONSTRAINT "project_types_color_check" CHECK ("project_types"."color" ~ '^#[0-9a-f]{6}$')
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "project_type_id" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "billing_model" text DEFAULT 'time_and_materials' NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "budget_hours" numeric(10, 2);--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "budget_period" text DEFAULT 'total' NOT NULL;--> statement-breakpoint
-- What each existing project is: a contract value means a fixed price, no
-- client means internal work, and anything else bills the time it took.
UPDATE "projects" SET "billing_model" = CASE
  WHEN "contract_value_minor" IS NOT NULL THEN 'fixed_price'
  WHEN "company_id" IS NULL THEN 'non_billable'
  ELSE 'time_and_materials'
END;--> statement-breakpoint
ALTER TABLE "project_budget_alerts" ADD CONSTRAINT "project_budget_alerts_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_budget_alerts" ADD CONSTRAINT "project_budget_alerts_project_fk" FOREIGN KEY ("organization_id","project_id") REFERENCES "public"."projects"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_types" ADD CONSTRAINT "project_types_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_types_organization_name_key" ON "project_types" USING btree ("organization_id",lower("name")) WHERE "project_types"."archived_at" is null;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_project_type_fk" FOREIGN KEY ("organization_id","project_type_id") REFERENCES "public"."project_types"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_billing_model_check" CHECK ("projects"."billing_model" in ('fixed_price', 'retainer', 'time_and_materials', 'non_billable'));--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_budget_period_check" CHECK ("projects"."budget_period" in ('total', 'week', 'month', 'quarter', 'year'));--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_budget_hours_check" CHECK ("projects"."budget_hours" >= 0);--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_retainer_contract_check" CHECK ("projects"."billing_model" <> 'retainer' or "projects"."contract_value_minor" is null);--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_fixed_price_period_check" CHECK ("projects"."billing_model" <> 'fixed_price' or "projects"."budget_period" = 'total');