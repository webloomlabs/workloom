CREATE TABLE "events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"type" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"actor" jsonb NOT NULL,
	"data" jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	CONSTRAINT "events_organization_id_id_key" UNIQUE("organization_id","id")
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"organization_id" uuid NOT NULL,
	"actor_key" text NOT NULL,
	"key" text NOT NULL,
	"procedure" text NOT NULL,
	"request_hash" text NOT NULL,
	"response" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY("organization_id","actor_key","key")
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"locked_until" timestamp with time zone,
	"last_attempt_at" timestamp with time zone,
	"response_status" integer,
	"response_body" text,
	"error" text,
	"duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "webhook_endpoints" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"url" text NOT NULL,
	"description" text,
	"event_types" text[] NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"disabled_reason" text,
	"secret_encrypted" text NOT NULL,
	"previous_secret_encrypted" text,
	"previous_secret_expires_at" timestamp with time zone,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_endpoints_organization_id_id_key" UNIQUE("organization_id","id")
);
--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_endpoint_fk" FOREIGN KEY ("organization_id","endpoint_id") REFERENCES "public"."webhook_endpoints"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_event_fk" FOREIGN KEY ("organization_id","event_id") REFERENCES "public"."events"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "events_organization_id_id_idx" ON "events" USING btree ("organization_id","id");--> statement-breakpoint
CREATE INDEX "events_unpublished_idx" ON "events" USING btree ("id") WHERE "events"."published_at" is null;--> statement-breakpoint
CREATE INDEX "webhook_deliveries_organization_id_id_idx" ON "webhook_deliveries" USING btree ("organization_id","id");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_endpoint_idx" ON "webhook_deliveries" USING btree ("organization_id","endpoint_id","id");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_due_idx" ON "webhook_deliveries" USING btree ("next_attempt_at") WHERE "webhook_deliveries"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "webhook_endpoints_organization_id_id_idx" ON "webhook_endpoints" USING btree ("organization_id","id");