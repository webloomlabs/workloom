-- An invoice that was paid, then refunded, can then be cancelled -- and it keeps
-- the day it was paid, which stays true whatever happened afterwards.
ALTER TABLE "invoices" DROP CONSTRAINT "invoices_paid_check";--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_paid_check" CHECK ("invoices"."amount_paid_minor" >= 0 and ("invoices"."paid_at" is null or "invoices"."status" in ('paid', 'refunded', 'cancelled')));
