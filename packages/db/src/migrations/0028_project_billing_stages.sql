CREATE TABLE "project_billing_stages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"name" text NOT NULL,
	"basis" text DEFAULT 'amount' NOT NULL,
	"percent" numeric(7, 4),
	"amount_minor" bigint,
	"currency" text NOT NULL,
	"trigger" text,
	"due_on" date,
	"milestone_id" uuid,
	"revision_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"released_amount_minor" bigint,
	"invoice_id" uuid,
	"released_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_billing_stages_organization_id_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "project_billing_stages_basis_check" CHECK ("project_billing_stages"."basis" in ('amount', 'percent')),
	CONSTRAINT "project_billing_stages_percent_check" CHECK (("project_billing_stages"."basis" = 'percent') = ("project_billing_stages"."percent" is not null) and ("project_billing_stages"."percent" is null or "project_billing_stages"."percent" between 0 and 100)),
	CONSTRAINT "project_billing_stages_amount_check" CHECK (("project_billing_stages"."basis" = 'amount') = ("project_billing_stages"."amount_minor" is not null) and ("project_billing_stages"."amount_minor" is null or "project_billing_stages"."amount_minor" >= 0)),
	CONSTRAINT "project_billing_stages_status_check" CHECK ("project_billing_stages"."status" in ('pending', 'invoiced', 'cancelled')),
	CONSTRAINT "project_billing_stages_position_check" CHECK ("project_billing_stages"."position" >= 1),
	CONSTRAINT "project_billing_stages_currency_check" CHECK ("project_billing_stages"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "project_billing_stages_released_check" CHECK (("project_billing_stages"."status" = 'invoiced') = ("project_billing_stages"."invoice_id" is not null)
          and ("project_billing_stages"."invoice_id" is null) = ("project_billing_stages"."released_amount_minor" is null)
          and ("project_billing_stages"."invoice_id" is null) = ("project_billing_stages"."released_at" is null)),
	CONSTRAINT "project_billing_stages_cancelled_check" CHECK (("project_billing_stages"."status" = 'cancelled') = ("project_billing_stages"."cancelled_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "project_billing_stages" ADD CONSTRAINT "project_billing_stages_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_billing_stages" ADD CONSTRAINT "project_billing_stages_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_billing_stages" ADD CONSTRAINT "project_billing_stages_project_fk" FOREIGN KEY ("organization_id","project_id","currency") REFERENCES "public"."projects"("organization_id","id","currency") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_billing_stages" ADD CONSTRAINT "project_billing_stages_milestone_fk" FOREIGN KEY ("organization_id","project_id","milestone_id") REFERENCES "public"."milestones"("organization_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_billing_stages" ADD CONSTRAINT "project_billing_stages_revision_fk" FOREIGN KEY ("organization_id","revision_id") REFERENCES "public"."project_revisions"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_billing_stages" ADD CONSTRAINT "project_billing_stages_invoice_fk" FOREIGN KEY ("organization_id","invoice_id") REFERENCES "public"."invoices"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_billing_stages_project_position_key" ON "project_billing_stages" USING btree ("organization_id","project_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "project_billing_stages_invoice_key" ON "project_billing_stages" USING btree ("organization_id","invoice_id");--> statement-breakpoint
CREATE INDEX "project_billing_stages_organization_project_status_idx" ON "project_billing_stages" USING btree ("organization_id","project_id","status");