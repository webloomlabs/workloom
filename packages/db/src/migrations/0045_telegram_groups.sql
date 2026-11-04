CREATE TABLE "telegram_groups" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"bot_id" uuid NOT NULL,
	"chat_id" text NOT NULL,
	"title" text,
	"approved_by" uuid,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	CONSTRAINT "telegram_groups_organization_id_id_key" UNIQUE("organization_id","id")
);
--> statement-breakpoint
ALTER TABLE "messaging_link_codes" ADD COLUMN "purpose" text DEFAULT 'identity' NOT NULL;--> statement-breakpoint
ALTER TABLE "telegram_groups" ADD CONSTRAINT "telegram_groups_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_groups" ADD CONSTRAINT "telegram_groups_approved_by_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_groups" ADD CONSTRAINT "telegram_groups_bot_fk" FOREIGN KEY ("organization_id","bot_id") REFERENCES "public"."telegram_bots"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_groups_live_key" ON "telegram_groups" USING btree ("organization_id","chat_id") WHERE "telegram_groups"."revoked_at" is null;--> statement-breakpoint
ALTER TABLE "messaging_link_codes" ADD CONSTRAINT "messaging_link_codes_purpose_check" CHECK ("messaging_link_codes"."purpose" in ('identity', 'group'));