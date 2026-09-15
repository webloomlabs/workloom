CREATE TABLE "attachments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"task_id" uuid,
	"filename" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"storage_key" text NOT NULL,
	"uploaded_by" uuid,
	"client_visible" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attachments_organization_id_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "attachments_size_check" CHECK ("attachments"."size_bytes" >= 0)
);
--> statement-breakpoint
CREATE TABLE "comments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"task_id" uuid,
	"author_id" uuid,
	"body" text NOT NULL,
	"client_visible" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "comments_organization_id_id_key" UNIQUE("organization_id","id")
);
--> statement-breakpoint
CREATE TABLE "milestones" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"due_date" date,
	"completed_at" timestamp with time zone,
	"client_visible" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "milestones_organization_id_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "milestones_organization_project_id_key" UNIQUE("organization_id","project_id","id")
);
--> statement-breakpoint
CREATE TABLE "project_members" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"billable_rate_minor" bigint,
	"cost_rate_minor" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_members_role_check" CHECK ("project_members"."role" in ('manager', 'member')),
	CONSTRAINT "project_members_rates_check" CHECK ("project_members"."billable_rate_minor" >= 0 and "project_members"."cost_rate_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"company_id" uuid,
	"deal_id" uuid,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'planning' NOT NULL,
	"start_date" date,
	"due_date" date,
	"currency" text NOT NULL,
	"budget_minor" bigint,
	"owner_id" uuid,
	"completed_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_organization_id_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "projects_status_check" CHECK ("projects"."status" in ('planning', 'in_progress', 'on_hold', 'review', 'completed', 'cancelled')),
	CONSTRAINT "projects_currency_check" CHECK ("projects"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "projects_budget_check" CHECK ("projects"."budget_minor" >= 0),
	CONSTRAINT "projects_completed_check" CHECK (("projects"."status" = 'completed') = ("projects"."completed_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "task_dependencies" (
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"depends_on_task_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_dependencies_pkey" PRIMARY KEY("organization_id","task_id","depends_on_task_id"),
	CONSTRAINT "task_dependencies_not_self_check" CHECK ("task_dependencies"."task_id" <> "task_dependencies"."depends_on_task_id")
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"milestone_id" uuid,
	"title" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'todo' NOT NULL,
	"priority" text DEFAULT 'normal' NOT NULL,
	"assignee_id" uuid,
	"due_date" date,
	"labels" text[] DEFAULT '{}'::text[] NOT NULL,
	"estimate_minutes" integer,
	"completed_at" timestamp with time zone,
	"client_visible" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tasks_organization_id_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "tasks_organization_project_id_key" UNIQUE("organization_id","project_id","id"),
	CONSTRAINT "tasks_status_check" CHECK ("tasks"."status" in ('todo', 'in_progress', 'in_review', 'done', 'cancelled')),
	CONSTRAINT "tasks_priority_check" CHECK ("tasks"."priority" in ('low', 'normal', 'high', 'urgent')),
	CONSTRAINT "tasks_estimate_check" CHECK ("tasks"."estimate_minutes" >= 0),
	CONSTRAINT "tasks_completed_check" CHECK (("tasks"."status" = 'done') = ("tasks"."completed_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_uploaded_by_user_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_project_fk" FOREIGN KEY ("organization_id","project_id") REFERENCES "public"."projects"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_task_fk" FOREIGN KEY ("organization_id","project_id","task_id") REFERENCES "public"."tasks"("organization_id","project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_author_id_user_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_project_fk" FOREIGN KEY ("organization_id","project_id") REFERENCES "public"."projects"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_task_fk" FOREIGN KEY ("organization_id","project_id","task_id") REFERENCES "public"."tasks"("organization_id","project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "milestones" ADD CONSTRAINT "milestones_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "milestones" ADD CONSTRAINT "milestones_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "milestones" ADD CONSTRAINT "milestones_project_fk" FOREIGN KEY ("organization_id","project_id") REFERENCES "public"."projects"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_project_fk" FOREIGN KEY ("organization_id","project_id") REFERENCES "public"."projects"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_company_fk" FOREIGN KEY ("organization_id","company_id") REFERENCES "public"."companies"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_deal_fk" FOREIGN KEY ("organization_id","deal_id") REFERENCES "public"."deals"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_task_fk" FOREIGN KEY ("organization_id","project_id","task_id") REFERENCES "public"."tasks"("organization_id","project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_depends_on_fk" FOREIGN KEY ("organization_id","project_id","depends_on_task_id") REFERENCES "public"."tasks"("organization_id","project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assignee_id_user_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_project_fk" FOREIGN KEY ("organization_id","project_id") REFERENCES "public"."projects"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_milestone_fk" FOREIGN KEY ("organization_id","project_id","milestone_id") REFERENCES "public"."milestones"("organization_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attachments_organization_project_task_idx" ON "attachments" USING btree ("organization_id","project_id","task_id");--> statement-breakpoint
CREATE UNIQUE INDEX "attachments_storage_key_key" ON "attachments" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "comments_organization_project_task_idx" ON "comments" USING btree ("organization_id","project_id","task_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_members_organization_project_user_key" ON "project_members" USING btree ("organization_id","project_id","user_id");--> statement-breakpoint
CREATE INDEX "projects_organization_status_idx" ON "projects" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "projects_organization_company_idx" ON "projects" USING btree ("organization_id","company_id");--> statement-breakpoint
CREATE INDEX "task_dependencies_organization_depends_on_idx" ON "task_dependencies" USING btree ("organization_id","depends_on_task_id");--> statement-breakpoint
CREATE INDEX "tasks_organization_project_status_idx" ON "tasks" USING btree ("organization_id","project_id","status");--> statement-breakpoint
CREATE INDEX "tasks_organization_assignee_status_idx" ON "tasks" USING btree ("organization_id","assignee_id","status");