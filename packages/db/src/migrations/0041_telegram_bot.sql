CREATE TABLE "messaging_identities" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"external_user_id" text NOT NULL,
	"chat_id" text NOT NULL,
	"display_name" text,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	CONSTRAINT "messaging_identities_organization_id_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "messaging_identities_provider_check" CHECK ("messaging_identities"."provider" in ('telegram'))
);
--> statement-breakpoint
CREATE TABLE "messaging_link_codes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messaging_link_codes_organization_id_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "messaging_link_codes_code_key" UNIQUE("organization_id","code_hash")
);
--> statement-breakpoint
CREATE TABLE "telegram_bots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"telegram_bot_id" text NOT NULL,
	"username" text NOT NULL,
	"token_encrypted" text NOT NULL,
	"webhook_secret_hash" text,
	"mode" text DEFAULT 'poll' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"last_error" text,
	"last_update_id" bigint,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "telegram_bots_organization_id_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "telegram_bots_organization_key" UNIQUE("organization_id"),
	CONSTRAINT "telegram_bots_mode_check" CHECK ("telegram_bots"."mode" in ('webhook', 'poll')),
	CONSTRAINT "telegram_bots_status_check" CHECK ("telegram_bots"."status" in ('active', 'paused', 'error')),
	CONSTRAINT "telegram_bots_webhook_secret_check" CHECK ("telegram_bots"."mode" = 'poll' or "telegram_bots"."webhook_secret_hash" is not null)
);
--> statement-breakpoint
CREATE TABLE "telegram_updates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"bot_id" uuid NOT NULL,
	"update_id" bigint NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_until" timestamp with time zone,
	"last_error" text,
	"extraction" jsonb,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	CONSTRAINT "telegram_updates_organization_id_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "telegram_updates_once_key" UNIQUE("organization_id","bot_id","update_id"),
	CONSTRAINT "telegram_updates_status_check" CHECK ("telegram_updates"."status" in ('pending', 'done', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "receipt_reading_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN "source" text;--> statement-breakpoint
ALTER TABLE "messaging_identities" ADD CONSTRAINT "messaging_identities_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messaging_identities" ADD CONSTRAINT "messaging_identities_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messaging_identities" ADD CONSTRAINT "messaging_identities_revoked_by_user_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messaging_link_codes" ADD CONSTRAINT "messaging_link_codes_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messaging_link_codes" ADD CONSTRAINT "messaging_link_codes_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_bots" ADD CONSTRAINT "telegram_bots_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_bots" ADD CONSTRAINT "telegram_bots_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_updates" ADD CONSTRAINT "telegram_updates_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_updates" ADD CONSTRAINT "telegram_updates_bot_fk" FOREIGN KEY ("organization_id","bot_id") REFERENCES "public"."telegram_bots"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "messaging_identities_live_key" ON "messaging_identities" USING btree ("organization_id","provider","external_user_id") WHERE "messaging_identities"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "messaging_identities_user_idx" ON "messaging_identities" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE INDEX "telegram_updates_due_idx" ON "telegram_updates" USING btree ("organization_id","status","next_attempt_at");--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_source_check" CHECK ("audit_logs"."source" in ('web', 'api', 'telegram', 'worker', 'system'));