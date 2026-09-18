CREATE TABLE "bank_accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'bank' NOT NULL,
	"currency" text NOT NULL,
	"institution" text,
	"account_identifier" text,
	"opening_balance_minor" bigint DEFAULT 0 NOT NULL,
	"opening_balance_on" date NOT NULL,
	"current_balance_minor" bigint DEFAULT 0 NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"import_mapping" jsonb,
	"unreconciled_notice_on" date,
	"archived_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_accounts_organization_id_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "bank_accounts_organization_id_id_currency_key" UNIQUE("organization_id","id","currency"),
	CONSTRAINT "bank_accounts_kind_check" CHECK ("bank_accounts"."kind" in ('bank', 'credit_card', 'cash', 'paypal', 'stripe', 'other')),
	CONSTRAINT "bank_accounts_currency_check" CHECK ("bank_accounts"."currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "bank_reconciliations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"bank_account_id" uuid NOT NULL,
	"currency" text NOT NULL,
	"statement_start_on" date NOT NULL,
	"statement_end_on" date NOT NULL,
	"opening_balance_minor" bigint NOT NULL,
	"closing_balance_minor" bigint NOT NULL,
	"computed_balance_minor" bigint NOT NULL,
	"transaction_count" integer NOT NULL,
	"completed_by" uuid,
	"completed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_reconciliations_organization_id_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "bank_reconciliations_period_key" UNIQUE("organization_id","bank_account_id","statement_end_on"),
	CONSTRAINT "bank_reconciliations_period_check" CHECK ("bank_reconciliations"."statement_end_on" >= "bank_reconciliations"."statement_start_on"),
	CONSTRAINT "bank_reconciliations_balanced_check" CHECK ("bank_reconciliations"."closing_balance_minor" = "bank_reconciliations"."computed_balance_minor")
);
--> statement-breakpoint
CREATE TABLE "bank_statement_imports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"bank_account_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"byte_size" integer NOT NULL,
	"content_hash" text NOT NULL,
	"format" text NOT NULL,
	"column_mapping" jsonb,
	"row_count" integer NOT NULL,
	"imported_count" integer NOT NULL,
	"duplicate_count" integer NOT NULL,
	"earliest_on" date,
	"latest_on" date,
	"imported_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_statement_imports_organization_id_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "bank_statement_imports_content_key" UNIQUE("organization_id","bank_account_id","content_hash"),
	CONSTRAINT "bank_statement_imports_format_check" CHECK ("bank_statement_imports"."format" in ('csv', 'ofx', 'manual')),
	CONSTRAINT "bank_statement_imports_counts_check" CHECK ("bank_statement_imports"."row_count" >= 0 and "bank_statement_imports"."imported_count" >= 0 and "bank_statement_imports"."duplicate_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "bank_transaction_matches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"bank_transaction_id" uuid NOT NULL,
	"currency" text NOT NULL,
	"kind" text NOT NULL,
	"payment_id" uuid,
	"expense_id" uuid,
	"counterpart_transaction_id" uuid,
	"amount_minor" bigint NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_transaction_matches_organization_id_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "bank_transaction_matches_payment_key" UNIQUE("organization_id","bank_transaction_id","payment_id"),
	CONSTRAINT "bank_transaction_matches_expense_key" UNIQUE("organization_id","bank_transaction_id","expense_id"),
	CONSTRAINT "bank_transaction_matches_transfer_key" UNIQUE("organization_id","bank_transaction_id","counterpart_transaction_id"),
	CONSTRAINT "bank_transaction_matches_kind_check" CHECK ("bank_transaction_matches"."kind" in ('payment', 'expense', 'transfer')),
	CONSTRAINT "bank_transaction_matches_target_check" CHECK (num_nonnulls("bank_transaction_matches"."payment_id", "bank_transaction_matches"."expense_id", "bank_transaction_matches"."counterpart_transaction_id") = 1
        and ("bank_transaction_matches"."kind" = 'payment') = ("bank_transaction_matches"."payment_id" is not null)
        and ("bank_transaction_matches"."kind" = 'expense') = ("bank_transaction_matches"."expense_id" is not null)
        and ("bank_transaction_matches"."kind" = 'transfer') = ("bank_transaction_matches"."counterpart_transaction_id" is not null)),
	CONSTRAINT "bank_transaction_matches_amount_check" CHECK ("bank_transaction_matches"."amount_minor" <> 0),
	CONSTRAINT "bank_transaction_matches_expense_sign_check" CHECK ("bank_transaction_matches"."kind" <> 'expense' or "bank_transaction_matches"."amount_minor" < 0),
	CONSTRAINT "bank_transaction_matches_currency_check" CHECK ("bank_transaction_matches"."currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "bank_transactions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"bank_account_id" uuid NOT NULL,
	"currency" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"matched_minor" bigint DEFAULT 0 NOT NULL,
	"booked_on" date NOT NULL,
	"value_on" date,
	"description" text NOT NULL,
	"counterparty" text,
	"reference" text,
	"balance_after_minor" bigint,
	"status" text DEFAULT 'unexplained' NOT NULL,
	"ignored_reason" text,
	"ignored_at" timestamp with time zone,
	"reconciliation_id" uuid,
	"reconciled_at" timestamp with time zone,
	"import_id" uuid,
	"fingerprint" text NOT NULL,
	"notes" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_transactions_organization_id_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "bank_transactions_organization_id_id_currency_key" UNIQUE("organization_id","id","currency"),
	CONSTRAINT "bank_transactions_fingerprint_key" UNIQUE("organization_id","bank_account_id","fingerprint"),
	CONSTRAINT "bank_transactions_status_check" CHECK ("bank_transactions"."status" in ('unexplained', 'part_explained', 'explained', 'reconciled', 'ignored')),
	CONSTRAINT "bank_transactions_currency_check" CHECK ("bank_transactions"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "bank_transactions_amount_check" CHECK ("bank_transactions"."amount_minor" <> 0),
	CONSTRAINT "bank_transactions_matched_check" CHECK (sign("bank_transactions"."matched_minor") in (0, sign("bank_transactions"."amount_minor")) and abs("bank_transactions"."matched_minor") <= abs("bank_transactions"."amount_minor")),
	CONSTRAINT "bank_transactions_ignored_check" CHECK (("bank_transactions"."status" = 'ignored') = ("bank_transactions"."ignored_at" is not null)),
	CONSTRAINT "bank_transactions_reconciled_check" CHECK (("bank_transactions"."reconciliation_id" is null) = ("bank_transactions"."reconciled_at" is null))
);
--> statement-breakpoint
-- Ahead of the foreign keys below, because the match table references it.
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_organization_id_id_currency_key" UNIQUE("organization_id","id","currency");--> statement-breakpoint
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_reconciliations" ADD CONSTRAINT "bank_reconciliations_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_reconciliations" ADD CONSTRAINT "bank_reconciliations_completed_by_user_id_fk" FOREIGN KEY ("completed_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_reconciliations" ADD CONSTRAINT "bank_reconciliations_account_fk" FOREIGN KEY ("organization_id","bank_account_id","currency") REFERENCES "public"."bank_accounts"("organization_id","id","currency") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statement_imports" ADD CONSTRAINT "bank_statement_imports_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statement_imports" ADD CONSTRAINT "bank_statement_imports_imported_by_user_id_fk" FOREIGN KEY ("imported_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statement_imports" ADD CONSTRAINT "bank_statement_imports_account_fk" FOREIGN KEY ("organization_id","bank_account_id") REFERENCES "public"."bank_accounts"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transaction_matches" ADD CONSTRAINT "bank_transaction_matches_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transaction_matches" ADD CONSTRAINT "bank_transaction_matches_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transaction_matches" ADD CONSTRAINT "bank_transaction_matches_transaction_fk" FOREIGN KEY ("organization_id","bank_transaction_id","currency") REFERENCES "public"."bank_transactions"("organization_id","id","currency") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transaction_matches" ADD CONSTRAINT "bank_transaction_matches_payment_fk" FOREIGN KEY ("organization_id","payment_id","currency") REFERENCES "public"."payments"("organization_id","id","currency") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transaction_matches" ADD CONSTRAINT "bank_transaction_matches_expense_fk" FOREIGN KEY ("organization_id","expense_id","currency") REFERENCES "public"."expenses"("organization_id","id","currency") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transaction_matches" ADD CONSTRAINT "bank_transaction_matches_counterpart_fk" FOREIGN KEY ("organization_id","counterpart_transaction_id","currency") REFERENCES "public"."bank_transactions"("organization_id","id","currency") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_account_fk" FOREIGN KEY ("organization_id","bank_account_id","currency") REFERENCES "public"."bank_accounts"("organization_id","id","currency") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_import_fk" FOREIGN KEY ("organization_id","import_id") REFERENCES "public"."bank_statement_imports"("organization_id","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_reconciliation_fk" FOREIGN KEY ("organization_id","reconciliation_id") REFERENCES "public"."bank_reconciliations"("organization_id","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bank_accounts_organization_name_key" ON "bank_accounts" USING btree ("organization_id",lower("name")) WHERE "bank_accounts"."archived_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "bank_accounts_organization_default_key" ON "bank_accounts" USING btree ("organization_id") WHERE "bank_accounts"."is_default" and "bank_accounts"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "bank_accounts_organization_kind_idx" ON "bank_accounts" USING btree ("organization_id","kind");--> statement-breakpoint
CREATE INDEX "bank_reconciliations_organization_account_idx" ON "bank_reconciliations" USING btree ("organization_id","bank_account_id","statement_end_on");--> statement-breakpoint
CREATE INDEX "bank_statement_imports_organization_account_idx" ON "bank_statement_imports" USING btree ("organization_id","bank_account_id","created_at");--> statement-breakpoint
CREATE INDEX "bank_transaction_matches_organization_payment_idx" ON "bank_transaction_matches" USING btree ("organization_id","payment_id");--> statement-breakpoint
CREATE INDEX "bank_transaction_matches_organization_expense_idx" ON "bank_transaction_matches" USING btree ("organization_id","expense_id");--> statement-breakpoint
CREATE INDEX "bank_transactions_organization_account_booked_idx" ON "bank_transactions" USING btree ("organization_id","bank_account_id","booked_on");--> statement-breakpoint
CREATE INDEX "bank_transactions_organization_unexplained_idx" ON "bank_transactions" USING btree ("organization_id","bank_account_id","booked_on") WHERE "bank_transactions"."status" in ('unexplained', 'part_explained');--> statement-breakpoint
CREATE INDEX "bank_transactions_organization_import_idx" ON "bank_transactions" USING btree ("organization_id","import_id");--> statement-breakpoint
CREATE INDEX "bank_transactions_organization_reconciliation_idx" ON "bank_transactions" USING btree ("organization_id","reconciliation_id");
