CREATE TABLE "audit_seals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"day" date NOT NULL,
	"entries" integer NOT NULL,
	"digest" text NOT NULL,
	"previous_digest" text,
	"sealed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_seals_organization_id_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "audit_seals_day_key" UNIQUE("organization_id","day")
);
--> statement-breakpoint
CREATE TABLE "tax_packs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"label" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"storage_key" text,
	"sha256" text,
	"size_bytes" bigint,
	"summary" jsonb,
	"warnings" jsonb,
	"error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"requested_by" uuid,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "tax_packs_organization_id_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "tax_packs_status_check" CHECK ("tax_packs"."status" in ('pending', 'ready', 'failed')),
	CONSTRAINT "tax_packs_period_check" CHECK ("tax_packs"."period_start" <= "tax_packs"."period_end"),
	CONSTRAINT "tax_packs_ready_check" CHECK ("tax_packs"."status" <> 'ready' or ("tax_packs"."storage_key" is not null and "tax_packs"."sha256" is not null))
);
--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "books_locked_through" date;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN "snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "audit_seals" ADD CONSTRAINT "audit_seals_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_packs" ADD CONSTRAINT "tax_packs_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_packs" ADD CONSTRAINT "tax_packs_requested_by_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tax_packs_organization_status_idx" ON "tax_packs" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "audit_logs_organization_created_idx" ON "audit_logs" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_organization_action_idx" ON "audit_logs" USING btree ("organization_id","action");