CREATE TABLE "default_rates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid,
	"currency" text NOT NULL,
	"billable_rate_minor" bigint,
	"cost_rate_minor" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "default_rates_organization_user_currency_key" UNIQUE NULLS NOT DISTINCT("organization_id","user_id","currency"),
	CONSTRAINT "default_rates_currency_check" CHECK ("default_rates"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "default_rates_rates_check" CHECK ("default_rates"."billable_rate_minor" >= 0 and "default_rates"."cost_rate_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE "time_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"task_id" uuid,
	"description" text,
	"spent_on" date NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"duration_seconds" integer,
	"billable" boolean NOT NULL,
	"currency" text NOT NULL,
	"billable_rate_minor" bigint,
	"billable_rate_source" text,
	"cost_rate_minor" bigint,
	"cost_rate_source" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "time_entries_organization_id_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "time_entries_running_check" CHECK (("time_entries"."duration_seconds" is null) = ("time_entries"."started_at" is not null and "time_entries"."ended_at" is null)),
	CONSTRAINT "time_entries_ended_check" CHECK ("time_entries"."ended_at" is null or ("time_entries"."started_at" is not null and "time_entries"."ended_at" >= "time_entries"."started_at")),
	CONSTRAINT "time_entries_duration_check" CHECK ("time_entries"."duration_seconds" >= 0),
	CONSTRAINT "time_entries_currency_check" CHECK ("time_entries"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "time_entries_rates_check" CHECK ("time_entries"."billable_rate_minor" >= 0 and "time_entries"."cost_rate_minor" >= 0),
	CONSTRAINT "time_entries_billable_source_check" CHECK (("time_entries"."billable_rate_minor" is null) = ("time_entries"."billable_rate_source" is null) and "time_entries"."billable_rate_source" in ('project_member', 'member', 'organization')),
	CONSTRAINT "time_entries_cost_source_check" CHECK (("time_entries"."cost_rate_minor" is null) = ("time_entries"."cost_rate_source" is null) and "time_entries"."cost_rate_source" in ('project_member', 'member', 'organization'))
);
--> statement-breakpoint
ALTER TABLE "default_rates" ADD CONSTRAINT "default_rates_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "default_rates" ADD CONSTRAINT "default_rates_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_project_fk" FOREIGN KEY ("organization_id","project_id") REFERENCES "public"."projects"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_task_fk" FOREIGN KEY ("organization_id","project_id","task_id") REFERENCES "public"."tasks"("organization_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "time_entries_one_running_timer_key" ON "time_entries" USING btree ("organization_id","user_id") WHERE "time_entries"."started_at" is not null and "time_entries"."ended_at" is null;--> statement-breakpoint
CREATE INDEX "time_entries_organization_user_spent_on_idx" ON "time_entries" USING btree ("organization_id","user_id","spent_on");--> statement-breakpoint
CREATE INDEX "time_entries_organization_project_spent_on_idx" ON "time_entries" USING btree ("organization_id","project_id","spent_on");--> statement-breakpoint
CREATE INDEX "time_entries_organization_task_idx" ON "time_entries" USING btree ("organization_id","task_id");