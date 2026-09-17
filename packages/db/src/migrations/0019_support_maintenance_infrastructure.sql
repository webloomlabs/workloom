CREATE TABLE "billing_schedule_invoices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"schedule_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_schedule_invoices_organization_id_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "billing_schedule_invoices_period_key" UNIQUE("organization_id","schedule_id","period_start"),
	CONSTRAINT "billing_schedule_invoices_invoice_key" UNIQUE("organization_id","invoice_id"),
	CONSTRAINT "billing_schedule_invoices_period_check" CHECK ("billing_schedule_invoices"."period_end" >= "billing_schedule_invoices"."period_start")
);
--> statement-breakpoint
CREATE TABLE "billing_schedule_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"schedule_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"service_id" uuid,
	"description" text NOT NULL,
	"quantity" numeric(12, 4) DEFAULT '1' NOT NULL,
	"unit_amount_minor" bigint NOT NULL,
	"discount_percent" numeric(7, 4),
	"tax_rate_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_schedule_lines_organization_id_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "billing_schedule_lines_quantity_check" CHECK ("billing_schedule_lines"."quantity" > 0),
	CONSTRAINT "billing_schedule_lines_discount_check" CHECK ("billing_schedule_lines"."discount_percent" between 0 and 100),
	CONSTRAINT "billing_schedule_lines_position_check" CHECK ("billing_schedule_lines"."position" >= 1)
);
--> statement-breakpoint
CREATE TABLE "billing_schedules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"contact_id" uuid,
	"project_id" uuid,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"currency" text NOT NULL,
	"tax_mode" text DEFAULT 'exclusive' NOT NULL,
	"payment_terms_days" integer DEFAULT 14 NOT NULL,
	"notes" text,
	"terms" text,
	"interval_unit" text DEFAULT 'month' NOT NULL,
	"interval_count" integer DEFAULT 1 NOT NULL,
	"start_on" date NOT NULL,
	"next_run_on" date,
	"end_on" date,
	"max_occurrences" integer,
	"generated_count" integer DEFAULT 0 NOT NULL,
	"last_run_at" timestamp with time zone,
	"owner_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_schedules_organization_id_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "billing_schedules_organization_id_id_currency_key" UNIQUE("organization_id","id","currency"),
	CONSTRAINT "billing_schedules_status_check" CHECK ("billing_schedules"."status" in ('active', 'paused', 'ended')),
	CONSTRAINT "billing_schedules_interval_check" CHECK ("billing_schedules"."interval_unit" in ('week', 'month', 'quarter', 'year')),
	CONSTRAINT "billing_schedules_interval_count_check" CHECK ("billing_schedules"."interval_count" between 1 and 52),
	CONSTRAINT "billing_schedules_tax_mode_check" CHECK ("billing_schedules"."tax_mode" in ('exclusive', 'inclusive')),
	CONSTRAINT "billing_schedules_currency_check" CHECK ("billing_schedules"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "billing_schedules_terms_check" CHECK ("billing_schedules"."payment_terms_days" between 0 and 365),
	CONSTRAINT "billing_schedules_occurrences_check" CHECK ("billing_schedules"."max_occurrences" is null or "billing_schedules"."max_occurrences" >= 1),
	CONSTRAINT "billing_schedules_generated_check" CHECK ("billing_schedules"."generated_count" >= 0),
	CONSTRAINT "billing_schedules_window_check" CHECK ("billing_schedules"."end_on" is null or "billing_schedules"."end_on" >= "billing_schedules"."start_on"),
	CONSTRAINT "billing_schedules_next_run_check" CHECK (("billing_schedules"."status" = 'ended') = ("billing_schedules"."next_run_on" is null))
);
--> statement-breakpoint
CREATE TABLE "ticket_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"ticket_id" uuid NOT NULL,
	"author_id" uuid,
	"body" text NOT NULL,
	"internal" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ticket_messages_organization_id_id_key" UNIQUE("organization_id","id")
);
--> statement-breakpoint
CREATE TABLE "tickets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"number" text NOT NULL,
	"company_id" uuid,
	"contact_id" uuid,
	"project_id" uuid,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"type" text DEFAULT 'question' NOT NULL,
	"priority" text DEFAULT 'normal' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"assignee_id" uuid,
	"first_response_due_at" timestamp with time zone,
	"resolution_due_at" timestamp with time zone,
	"first_responded_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tickets_organization_id_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "tickets_type_check" CHECK ("tickets"."type" in ('bug', 'incident', 'question', 'feature_request', 'change_request', 'other')),
	CONSTRAINT "tickets_priority_check" CHECK ("tickets"."priority" in ('low', 'normal', 'high', 'urgent')),
	CONSTRAINT "tickets_status_check" CHECK ("tickets"."status" in ('open', 'in_progress', 'waiting_on_client', 'resolved', 'closed')),
	CONSTRAINT "tickets_resolved_check" CHECK (("tickets"."status" in ('resolved', 'closed')) = ("tickets"."resolved_at" is not null)),
	CONSTRAINT "tickets_closed_check" CHECK (("tickets"."status" = 'closed') = ("tickets"."closed_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "maintenance_plan_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"label" text NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "maintenance_plan_items_organization_id_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "maintenance_plan_items_position_check" CHECK ("maintenance_plan_items"."position" >= 1)
);
--> statement-breakpoint
CREATE TABLE "maintenance_plans" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'active' NOT NULL,
	"started_on" date NOT NULL,
	"ended_on" date,
	"response_hours" integer,
	"resolution_hours" integer,
	"included_hours" numeric(8, 2),
	"billing_schedule_id" uuid,
	"owner_id" uuid,
	"notes" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "maintenance_plans_organization_id_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "maintenance_plans_status_check" CHECK ("maintenance_plans"."status" in ('active', 'paused', 'ended')),
	CONSTRAINT "maintenance_plans_window_check" CHECK ("maintenance_plans"."ended_on" is null or "maintenance_plans"."ended_on" >= "maintenance_plans"."started_on"),
	CONSTRAINT "maintenance_plans_sla_check" CHECK (("maintenance_plans"."response_hours" is null or "maintenance_plans"."response_hours" between 1 and 8760) and ("maintenance_plans"."resolution_hours" is null or "maintenance_plans"."resolution_hours" between 1 and 8760)),
	CONSTRAINT "maintenance_plans_included_hours_check" CHECK ("maintenance_plans"."included_hours" is null or "maintenance_plans"."included_hours" > 0)
);
--> statement-breakpoint
CREATE TABLE "maintenance_visits" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"performed_on" date NOT NULL,
	"kind" text DEFAULT 'other' NOT NULL,
	"summary" text NOT NULL,
	"notes" text,
	"minutes_spent" integer,
	"performed_by" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "maintenance_visits_organization_id_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "maintenance_visits_kind_check" CHECK ("maintenance_visits"."kind" in ('security_update', 'backup', 'performance_check', 'uptime_check', 'content_update', 'review', 'incident', 'other')),
	CONSTRAINT "maintenance_visits_minutes_check" CHECK ("maintenance_visits"."minutes_spent" is null or "maintenance_visits"."minutes_spent" > 0)
);
--> statement-breakpoint
CREATE TABLE "infrastructure_assets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"company_id" uuid,
	"project_id" uuid,
	"kind" text DEFAULT 'other' NOT NULL,
	"name" text NOT NULL,
	"provider" text,
	"url" text,
	"environment" text DEFAULT 'production' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"expires_on" date,
	"auto_renew" boolean DEFAULT false NOT NULL,
	"renewal_cost_minor" bigint,
	"currency" text,
	"expiry_notice_sent_for" date,
	"owner_id" uuid,
	"notes" text,
	"decommissioned_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "infrastructure_assets_organization_id_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "infrastructure_assets_kind_check" CHECK ("infrastructure_assets"."kind" in ('domain', 'hosting', 'server', 'application', 'ssl_certificate', 'email', 'saas', 'other')),
	CONSTRAINT "infrastructure_assets_status_check" CHECK ("infrastructure_assets"."status" in ('active', 'pending', 'suspended', 'expired', 'decommissioned')),
	CONSTRAINT "infrastructure_assets_environment_check" CHECK ("infrastructure_assets"."environment" in ('production', 'staging', 'development', 'other')),
	CONSTRAINT "infrastructure_assets_currency_check" CHECK ("infrastructure_assets"."currency" is null or "infrastructure_assets"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "infrastructure_assets_cost_check" CHECK (("infrastructure_assets"."renewal_cost_minor" is null) = ("infrastructure_assets"."currency" is null) and ("infrastructure_assets"."renewal_cost_minor" is null or "infrastructure_assets"."renewal_cost_minor" >= 0)),
	CONSTRAINT "infrastructure_assets_decommissioned_check" CHECK (("infrastructure_assets"."status" = 'decommissioned') = ("infrastructure_assets"."decommissioned_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "client_documents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid,
	"title" text NOT NULL,
	"category" text DEFAULT 'other' NOT NULL,
	"filename" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"storage_key" text NOT NULL,
	"client_visible" boolean DEFAULT false NOT NULL,
	"notes" text,
	"uploaded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "client_documents_organization_id_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "client_documents_category_check" CHECK ("client_documents"."category" in ('contract', 'proposal', 'brief', 'specification', 'report', 'policy', 'identification', 'other')),
	CONSTRAINT "client_documents_size_check" CHECK ("client_documents"."size_bytes" > 0)
);
--> statement-breakpoint
ALTER TABLE "billing_schedule_invoices" ADD CONSTRAINT "billing_schedule_invoices_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_schedule_invoices" ADD CONSTRAINT "billing_schedule_invoices_schedule_fk" FOREIGN KEY ("organization_id","schedule_id") REFERENCES "public"."billing_schedules"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_schedule_invoices" ADD CONSTRAINT "billing_schedule_invoices_invoice_fk" FOREIGN KEY ("organization_id","invoice_id") REFERENCES "public"."invoices"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_schedule_lines" ADD CONSTRAINT "billing_schedule_lines_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_schedule_lines" ADD CONSTRAINT "billing_schedule_lines_schedule_fk" FOREIGN KEY ("organization_id","schedule_id") REFERENCES "public"."billing_schedules"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_schedule_lines" ADD CONSTRAINT "billing_schedule_lines_service_fk" FOREIGN KEY ("organization_id","service_id") REFERENCES "public"."services"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_schedule_lines" ADD CONSTRAINT "billing_schedule_lines_tax_rate_fk" FOREIGN KEY ("organization_id","tax_rate_id") REFERENCES "public"."tax_rates"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_schedules" ADD CONSTRAINT "billing_schedules_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_schedules" ADD CONSTRAINT "billing_schedules_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_schedules" ADD CONSTRAINT "billing_schedules_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_schedules" ADD CONSTRAINT "billing_schedules_company_fk" FOREIGN KEY ("organization_id","company_id") REFERENCES "public"."companies"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_schedules" ADD CONSTRAINT "billing_schedules_contact_fk" FOREIGN KEY ("organization_id","contact_id") REFERENCES "public"."contacts"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_schedules" ADD CONSTRAINT "billing_schedules_project_fk" FOREIGN KEY ("organization_id","project_id") REFERENCES "public"."projects"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_messages" ADD CONSTRAINT "ticket_messages_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_messages" ADD CONSTRAINT "ticket_messages_author_id_user_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_messages" ADD CONSTRAINT "ticket_messages_ticket_fk" FOREIGN KEY ("organization_id","ticket_id") REFERENCES "public"."tickets"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_assignee_id_user_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_company_fk" FOREIGN KEY ("organization_id","company_id") REFERENCES "public"."companies"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_contact_fk" FOREIGN KEY ("organization_id","contact_id") REFERENCES "public"."contacts"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_project_fk" FOREIGN KEY ("organization_id","project_id") REFERENCES "public"."projects"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_plan_items" ADD CONSTRAINT "maintenance_plan_items_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_plan_items" ADD CONSTRAINT "maintenance_plan_items_plan_fk" FOREIGN KEY ("organization_id","plan_id") REFERENCES "public"."maintenance_plans"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_plans" ADD CONSTRAINT "maintenance_plans_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_plans" ADD CONSTRAINT "maintenance_plans_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_plans" ADD CONSTRAINT "maintenance_plans_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_plans" ADD CONSTRAINT "maintenance_plans_company_fk" FOREIGN KEY ("organization_id","company_id") REFERENCES "public"."companies"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_plans" ADD CONSTRAINT "maintenance_plans_billing_schedule_fk" FOREIGN KEY ("organization_id","billing_schedule_id") REFERENCES "public"."billing_schedules"("organization_id","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_visits" ADD CONSTRAINT "maintenance_visits_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_visits" ADD CONSTRAINT "maintenance_visits_performed_by_user_id_fk" FOREIGN KEY ("performed_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_visits" ADD CONSTRAINT "maintenance_visits_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_visits" ADD CONSTRAINT "maintenance_visits_plan_fk" FOREIGN KEY ("organization_id","plan_id") REFERENCES "public"."maintenance_plans"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "infrastructure_assets" ADD CONSTRAINT "infrastructure_assets_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "infrastructure_assets" ADD CONSTRAINT "infrastructure_assets_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "infrastructure_assets" ADD CONSTRAINT "infrastructure_assets_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "infrastructure_assets" ADD CONSTRAINT "infrastructure_assets_company_fk" FOREIGN KEY ("organization_id","company_id") REFERENCES "public"."companies"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "infrastructure_assets" ADD CONSTRAINT "infrastructure_assets_project_fk" FOREIGN KEY ("organization_id","project_id") REFERENCES "public"."projects"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_documents" ADD CONSTRAINT "client_documents_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_documents" ADD CONSTRAINT "client_documents_uploaded_by_user_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_documents" ADD CONSTRAINT "client_documents_company_fk" FOREIGN KEY ("organization_id","company_id") REFERENCES "public"."companies"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_documents" ADD CONSTRAINT "client_documents_project_fk" FOREIGN KEY ("organization_id","project_id") REFERENCES "public"."projects"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "billing_schedule_lines_organization_schedule_idx" ON "billing_schedule_lines" USING btree ("organization_id","schedule_id","position");--> statement-breakpoint
CREATE INDEX "billing_schedules_organization_company_idx" ON "billing_schedules" USING btree ("organization_id","company_id");--> statement-breakpoint
CREATE INDEX "billing_schedules_organization_due_idx" ON "billing_schedules" USING btree ("organization_id","status","next_run_on");--> statement-breakpoint
CREATE INDEX "ticket_messages_organization_ticket_idx" ON "ticket_messages" USING btree ("organization_id","ticket_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tickets_organization_number_key" ON "tickets" USING btree ("organization_id","number");--> statement-breakpoint
CREATE INDEX "tickets_organization_status_idx" ON "tickets" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "tickets_organization_company_idx" ON "tickets" USING btree ("organization_id","company_id");--> statement-breakpoint
CREATE INDEX "tickets_organization_assignee_idx" ON "tickets" USING btree ("organization_id","assignee_id");--> statement-breakpoint
CREATE INDEX "maintenance_plan_items_organization_plan_idx" ON "maintenance_plan_items" USING btree ("organization_id","plan_id","position");--> statement-breakpoint
CREATE INDEX "maintenance_plans_organization_company_idx" ON "maintenance_plans" USING btree ("organization_id","company_id","status");--> statement-breakpoint
CREATE INDEX "maintenance_visits_organization_plan_idx" ON "maintenance_visits" USING btree ("organization_id","plan_id","performed_on");--> statement-breakpoint
CREATE INDEX "infrastructure_assets_organization_company_idx" ON "infrastructure_assets" USING btree ("organization_id","company_id");--> statement-breakpoint
CREATE INDEX "infrastructure_assets_organization_kind_idx" ON "infrastructure_assets" USING btree ("organization_id","kind","status");--> statement-breakpoint
CREATE INDEX "infrastructure_assets_organization_expiry_idx" ON "infrastructure_assets" USING btree ("organization_id","expires_on");--> statement-breakpoint
CREATE INDEX "client_documents_organization_company_idx" ON "client_documents" USING btree ("organization_id","company_id","category");--> statement-breakpoint
CREATE INDEX "client_documents_organization_project_idx" ON "client_documents" USING btree ("organization_id","project_id");