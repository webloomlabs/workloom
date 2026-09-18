ALTER TABLE "time_entries" DROP CONSTRAINT "time_entries_cost_source_check";--> statement-breakpoint
ALTER TABLE "project_members" ADD COLUMN "fixed_fee_minor" bigint;--> statement-breakpoint
ALTER TABLE "project_members" ADD COLUMN "fixed_fee_on" date;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_fixed_fee_check" CHECK ("project_members"."fixed_fee_minor" >= 0);--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_fixed_fee_date_check" CHECK ("project_members"."fixed_fee_on" is null or "project_members"."fixed_fee_minor" is not null);--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_cost_source_check" CHECK (("time_entries"."cost_rate_minor" is null) = ("time_entries"."cost_rate_source" is null) and "time_entries"."cost_rate_source" in ('project_member', 'member', 'organization', 'project_member_fixed'));