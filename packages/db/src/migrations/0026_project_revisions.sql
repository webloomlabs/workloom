CREATE TABLE "project_revisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"kind" text DEFAULT 'variation' NOT NULL,
	"title" text NOT NULL,
	"summary" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"currency" text NOT NULL,
	"amount_minor" bigint DEFAULT 0 NOT NULL,
	"new_due_date" date,
	"requested_on" date NOT NULL,
	"quote_id" uuid,
	"previous_contract_value_minor" bigint,
	"previous_due_date" date,
	"applied_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	"accepted_by" uuid,
	"declined_at" timestamp with time zone,
	"decline_reason" text,
	"withdrawn_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_revisions_organization_id_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "project_revisions_project_number_key" UNIQUE("organization_id","project_id","number"),
	CONSTRAINT "project_revisions_kind_check" CHECK ("project_revisions"."kind" in ('variation', 'extension')),
	CONSTRAINT "project_revisions_status_check" CHECK ("project_revisions"."status" in ('draft', 'sent', 'accepted', 'declined', 'withdrawn')),
	CONSTRAINT "project_revisions_currency_check" CHECK ("project_revisions"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "project_revisions_number_check" CHECK ("project_revisions"."number" >= 1),
	CONSTRAINT "project_revisions_extension_check" CHECK ("project_revisions"."kind" <> 'extension' or "project_revisions"."amount_minor" = 0),
	CONSTRAINT "project_revisions_extension_date_check" CHECK ("project_revisions"."kind" <> 'extension' or "project_revisions"."new_due_date" is not null),
	CONSTRAINT "project_revisions_sent_check" CHECK (("project_revisions"."status" = 'draft') = ("project_revisions"."sent_at" is null)),
	CONSTRAINT "project_revisions_accepted_check" CHECK (("project_revisions"."status" = 'accepted') = ("project_revisions"."accepted_at" is not null)),
	CONSTRAINT "project_revisions_applied_check" CHECK (("project_revisions"."accepted_at" is null) = ("project_revisions"."applied_at" is null)),
	CONSTRAINT "project_revisions_declined_check" CHECK (("project_revisions"."status" = 'declined') = ("project_revisions"."declined_at" is not null)),
	CONSTRAINT "project_revisions_withdrawn_check" CHECK (("project_revisions"."status" = 'withdrawn') = ("project_revisions"."withdrawn_at" is not null)),
	CONSTRAINT "project_revisions_decline_reason_check" CHECK ("project_revisions"."decline_reason" is null or "project_revisions"."status" = 'declined')
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "contract_value_minor" bigint;--> statement-breakpoint
-- Ahead of the foreign keys below: project_revisions_project_fk references it.
ALTER TABLE "projects" ADD CONSTRAINT "projects_organization_id_id_currency_key" UNIQUE("organization_id","id","currency");--> statement-breakpoint
ALTER TABLE "project_revisions" ADD CONSTRAINT "project_revisions_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_revisions" ADD CONSTRAINT "project_revisions_accepted_by_user_id_fk" FOREIGN KEY ("accepted_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_revisions" ADD CONSTRAINT "project_revisions_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_revisions" ADD CONSTRAINT "project_revisions_project_fk" FOREIGN KEY ("organization_id","project_id","currency") REFERENCES "public"."projects"("organization_id","id","currency") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_revisions" ADD CONSTRAINT "project_revisions_quote_fk" FOREIGN KEY ("organization_id","quote_id") REFERENCES "public"."quotes"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_revisions_organization_project_status_idx" ON "project_revisions" USING btree ("organization_id","project_id","status");--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_contract_value_check" CHECK ("projects"."contract_value_minor" >= 0);