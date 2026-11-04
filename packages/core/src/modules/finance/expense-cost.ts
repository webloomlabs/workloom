import { schema, sql, type SQL } from '@workloom/db'

/**
 * What an expense cost the agency, as every report reads it.
 *
 * Only confirmed expenses count: a draft is a guess read from a receipt until a
 * person checks it. The tax on an expense is part of its cost unless the
 * organization claims it back -- an agency below the VAT threshold cannot, so
 * for it the receipt's total is the cost.
 *
 * Pure, and the same rule as the `spend` part of `project_financials_v`, so the
 * dashboard, the revenue report, project margins, and the tax pack agree.
 */
export function expenseCost(expense: { amountMinor: number; taxMinor: number }, reclaimsInputTax: boolean): number {
  return expense.amountMinor + (reclaimsInputTax ? 0 : expense.taxMinor)
}

const e = schema.expenses

/** Whether the organization claims back the tax on what it spends. */
const reclaims = sql`(select o.reclaims_input_tax from organization o where o.id = ${e.organizationId})`

/** An expense's cost in its own currency, in SQL. */
export const expenseCostSql: SQL<number> = sql<number>`(${e.amountMinor} + case when ${reclaims} then 0 else ${e.taxMinor} end)`

/** An expense's cost in the base currency, in SQL: the stored base amount, grossed up by the tax when it is a cost. */
export const expenseBaseCostSql: SQL<number> = sql<number>`(case when ${reclaims} or ${e.amountMinor} = 0 then ${e.amountBaseMinor}
  else round(${e.amountBaseMinor}::numeric * (${e.amountMinor} + ${e.taxMinor}) / ${e.amountMinor}) end)`

/** Only expenses a person has confirmed. */
export const countsAsCost: SQL = sql`${e.status} = 'confirmed'`
