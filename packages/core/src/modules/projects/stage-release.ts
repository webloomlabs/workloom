import { eq, schema } from '@workloom/db'
import type { ActorContext } from '../../context.ts'

/**
 * Returns a billing stage to pending when the draft invoice it raised goes
 * away. The money was never demanded, so the plan must stop saying it was.
 *
 * Kept in its own file, importing nothing but the schema, because both
 * `finance/invoices.ts` (which calls it on delete) and
 * `projects/billing-stages.ts` (which owns the rest of the plan) need it, and
 * having either import the other would be a module cycle.
 */
export async function releaseStageForInvoice(ctx: ActorContext, invoiceId: string): Promise<void> {
  const s = schema.projectBillingStages
  const [stage] = await ctx.tx.select().from(s).where(eq(s.invoiceId, invoiceId)).limit(1).for('update')
  if (!stage) return
  await ctx.tx
    .update(s)
    .set({ status: 'pending', invoiceId: null, releasedAmountMinor: null, releasedAt: null, updatedAt: ctx.now })
    .where(eq(s.id, stage.id))
  await ctx.audit({
    action: 'project_billing_stage.updated',
    entityType: 'project',
    entityId: stage.projectId,
    entityLabel: stage.name,
    changes: { status: { from: 'invoiced', to: 'pending' } },
  })
}
