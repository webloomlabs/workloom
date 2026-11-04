CREATE TABLE "expense_categories" (
	"organization_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"tax_treatment" text DEFAULT 'deductible' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "expense_categories_pkey" PRIMARY KEY("organization_id","key"),
	CONSTRAINT "expense_categories_key_check" CHECK ("expense_categories"."key" ~ '^[a-z0-9_]{1,40}$'),
	CONSTRAINT "expense_categories_tax_treatment_check" CHECK ("expense_categories"."tax_treatment" in ('deductible', 'non_deductible', 'capital'))
);
--> statement-breakpoint
CREATE TABLE "expense_receipts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"expense_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"filename" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"source" text DEFAULT 'web' NOT NULL,
	"uploaded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "expense_receipts_organization_id_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "expense_receipts_source_check" CHECK ("expense_receipts"."source" in ('web', 'api', 'telegram')),
	CONSTRAINT "expense_receipts_size_check" CHECK ("expense_receipts"."size_bytes" > 0),
	CONSTRAINT "expense_receipts_content_type_check" CHECK ("expense_receipts"."content_type" in ('image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'application/pdf'))
);
--> statement-breakpoint
ALTER TABLE "document_sequences" DROP CONSTRAINT "document_sequences_kind_check";--> statement-breakpoint
ALTER TABLE "expenses" DROP CONSTRAINT "expenses_category_check";--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "status" text DEFAULT 'confirmed' NOT NULL;--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "number" text;--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "payment_method" text;--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "paid_on" date;--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "reimbursable" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "source" text DEFAULT 'web' NOT NULL;--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "extraction" jsonb;--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "confirmed_by" uuid;--> statement-breakpoint
-- Every organization starts with the categories expenses already used, so the
-- foreign key below holds for every existing expense. New organizations are
-- given them on first use (core: ensureExpenseCategories).
INSERT INTO "expense_categories" ("organization_id", "key", "name", "tax_treatment", "position")
SELECT o.id, c.key, c.name, c.tax_treatment, c.position
FROM "organization" o
CROSS JOIN (VALUES
  ('software', 'Software and subscriptions', 'deductible', 1),
  ('hosting', 'Hosting', 'deductible', 2),
  ('domains', 'Domains', 'deductible', 3),
  ('hardware', 'Hardware and equipment', 'capital', 4),
  ('contractor', 'Contractors', 'deductible', 5),
  ('advertising', 'Advertising', 'deductible', 6),
  ('travel', 'Travel', 'deductible', 7),
  ('office', 'Office', 'deductible', 8),
  ('fees', 'Bank and professional fees', 'deductible', 9),
  ('other', 'Other', 'deductible', 10)
) AS c(key, name, tax_treatment, position)
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- Every expense recorded before drafts existed was entered by a person, so it
-- counts as confirmed when it was entered. The rebilled-expense guard would
-- refuse this bookkeeping on frozen rows; it is switched off for this one
-- statement only.
ALTER TABLE "expenses" DISABLE TRIGGER "expenses_guard";--> statement-breakpoint
UPDATE "expenses" SET "confirmed_at" = "created_at", "confirmed_by" = "created_by" WHERE "confirmed_at" IS NULL;--> statement-breakpoint
ALTER TABLE "expenses" ENABLE TRIGGER "expenses_guard";--> statement-breakpoint
ALTER TABLE "expense_categories" ADD CONSTRAINT "expense_categories_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_receipts" ADD CONSTRAINT "expense_receipts_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_receipts" ADD CONSTRAINT "expense_receipts_uploaded_by_user_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_receipts" ADD CONSTRAINT "expense_receipts_expense_fk" FOREIGN KEY ("organization_id","expense_id") REFERENCES "public"."expenses"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "expense_receipts_storage_key_key" ON "expense_receipts" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "expense_receipts_organization_expense_idx" ON "expense_receipts" USING btree ("organization_id","expense_id");--> statement-breakpoint
CREATE INDEX "expense_receipts_organization_sha256_idx" ON "expense_receipts" USING btree ("organization_id","sha256");--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_confirmed_by_user_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_category_fk" FOREIGN KEY ("organization_id","category") REFERENCES "public"."expense_categories"("organization_id","key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "expenses_organization_number_key" ON "expenses" USING btree ("organization_id","number");--> statement-breakpoint
CREATE INDEX "expenses_organization_status_idx" ON "expenses" USING btree ("organization_id","status");--> statement-breakpoint
ALTER TABLE "document_sequences" ADD CONSTRAINT "document_sequences_kind_check" CHECK ("document_sequences"."kind" in ('quote', 'invoice', 'ticket', 'expense'));--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_status_check" CHECK ("expenses"."status" in ('draft', 'confirmed'));--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_source_check" CHECK ("expenses"."source" in ('web', 'api', 'telegram'));--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_payment_method_check" CHECK ("expenses"."payment_method" in ('bank_transfer', 'card', 'direct_debit', 'cash', 'cheque', 'paypal', 'stripe', 'other', 'personal_card'));--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_confirmed_check" CHECK ("expenses"."status" = 'confirmed' or "expenses"."confirmed_at" is null);--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_draft_check" CHECK ("expenses"."status" = 'confirmed' or ("expenses"."number" is null and "expenses"."invoice_line_id" is null));