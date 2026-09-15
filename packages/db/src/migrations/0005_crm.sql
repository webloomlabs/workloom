CREATE TABLE "activities" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"type" text NOT NULL,
	"body" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"author_id" uuid,
	"company_id" uuid,
	"contact_id" uuid,
	"lead_id" uuid,
	"deal_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "activities_organization_id_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "activities_type_check" CHECK ("activities"."type" in ('note', 'call', 'email', 'meeting')),
	CONSTRAINT "activities_linked_check" CHECK (num_nonnulls("activities"."company_id", "activities"."contact_id", "activities"."lead_id", "activities"."deal_id") > 0)
);
--> statement-breakpoint
CREATE TABLE "companies" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"website" text,
	"email" text,
	"phone" text,
	"industry" text,
	"address" text,
	"description" text,
	"lifecycle_stage" text DEFAULT 'prospect' NOT NULL,
	"became_client_at" timestamp with time zone,
	"owner_id" uuid,
	"last_activity_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "companies_organization_id_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "companies_lifecycle_stage_check" CHECK ("companies"."lifecycle_stage" in ('prospect', 'client', 'former_client'))
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"company_id" uuid,
	"first_name" text NOT NULL,
	"last_name" text,
	"email" text,
	"phone" text,
	"job_title" text,
	"owner_id" uuid,
	"last_activity_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contacts_organization_id_id_key" UNIQUE("organization_id","id")
);
--> statement-breakpoint
CREATE TABLE "deals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"contact_id" uuid,
	"name" text NOT NULL,
	"stage" text DEFAULT 'qualified' NOT NULL,
	"value_minor" bigint DEFAULT 0 NOT NULL,
	"currency" text NOT NULL,
	"expected_close_date" date,
	"owner_id" uuid,
	"closed_at" timestamp with time zone,
	"lost_reason" text,
	"last_activity_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deals_organization_id_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "deals_stage_check" CHECK ("deals"."stage" in ('qualified', 'proposal_sent', 'negotiation', 'won', 'lost')),
	CONSTRAINT "deals_value_check" CHECK ("deals"."value_minor" >= 0),
	CONSTRAINT "deals_currency_check" CHECK ("deals"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "deals_closed_check" CHECK (("deals"."stage" in ('won', 'lost')) = ("deals"."closed_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "leads" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"contact_name" text,
	"email" text,
	"phone" text,
	"company_name" text,
	"website" text,
	"source" text DEFAULT 'other' NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"details" text,
	"disqualified_reason" text,
	"owner_id" uuid,
	"last_activity_at" timestamp with time zone,
	"converted_at" timestamp with time zone,
	"converted_company_id" uuid,
	"converted_contact_id" uuid,
	"converted_deal_id" uuid,
	"archived_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "leads_organization_id_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "leads_status_check" CHECK ("leads"."status" in ('new', 'contacted', 'qualified', 'disqualified', 'converted')),
	CONSTRAINT "leads_source_check" CHECK ("leads"."source" in ('website', 'referral', 'inbound_email', 'phone', 'social', 'event', 'partner', 'outbound', 'other')),
	CONSTRAINT "leads_identifiable_check" CHECK (coalesce("leads"."contact_name", "leads"."company_name", "leads"."email") is not null),
	CONSTRAINT "leads_converted_check" CHECK (("leads"."status" = 'converted') = ("leads"."converted_at" is not null and "leads"."converted_company_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_author_id_user_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_company_fk" FOREIGN KEY ("organization_id","company_id") REFERENCES "public"."companies"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_contact_fk" FOREIGN KEY ("organization_id","contact_id") REFERENCES "public"."contacts"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_lead_fk" FOREIGN KEY ("organization_id","lead_id") REFERENCES "public"."leads"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_deal_fk" FOREIGN KEY ("organization_id","deal_id") REFERENCES "public"."deals"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_company_fk" FOREIGN KEY ("organization_id","company_id") REFERENCES "public"."companies"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_company_fk" FOREIGN KEY ("organization_id","company_id") REFERENCES "public"."companies"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_contact_fk" FOREIGN KEY ("organization_id","contact_id") REFERENCES "public"."contacts"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_converted_company_fk" FOREIGN KEY ("organization_id","converted_company_id") REFERENCES "public"."companies"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_converted_contact_fk" FOREIGN KEY ("organization_id","converted_contact_id") REFERENCES "public"."contacts"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_converted_deal_fk" FOREIGN KEY ("organization_id","converted_deal_id") REFERENCES "public"."deals"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activities_organization_company_idx" ON "activities" USING btree ("organization_id","company_id","occurred_at");--> statement-breakpoint
CREATE INDEX "activities_organization_contact_idx" ON "activities" USING btree ("organization_id","contact_id","occurred_at");--> statement-breakpoint
CREATE INDEX "activities_organization_lead_idx" ON "activities" USING btree ("organization_id","lead_id","occurred_at");--> statement-breakpoint
CREATE INDEX "activities_organization_deal_idx" ON "activities" USING btree ("organization_id","deal_id","occurred_at");--> statement-breakpoint
CREATE INDEX "companies_organization_stage_idx" ON "companies" USING btree ("organization_id","lifecycle_stage");--> statement-breakpoint
CREATE INDEX "companies_organization_name_idx" ON "companies" USING btree ("organization_id","name");--> statement-breakpoint
CREATE INDEX "contacts_organization_company_idx" ON "contacts" USING btree ("organization_id","company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_organization_email_key" ON "contacts" USING btree ("organization_id",lower("email")) WHERE "contacts"."email" is not null and "contacts"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "deals_organization_stage_idx" ON "deals" USING btree ("organization_id","stage");--> statement-breakpoint
CREATE INDEX "deals_organization_company_idx" ON "deals" USING btree ("organization_id","company_id");--> statement-breakpoint
CREATE INDEX "leads_organization_status_idx" ON "leads" USING btree ("organization_id","status");