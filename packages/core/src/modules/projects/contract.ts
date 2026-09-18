/**
 * What a project is contracted for.
 *
 * The agreed price plus every accepted change to it. Kept as a pure function
 * rather than a column or a view, for two different reasons:
 *
 *   - not a stored total, because the accepted revisions *are* the record and a
 *     second copy of their sum is a second thing that can be wrong;
 *   - not a column on `project_financials_v`, because that view is per-currency
 *     derived history, while this is one current fact in the project's own
 *     currency. It joins in at the application layer exactly as the budget does.
 *
 * A project with no agreed price is not fixed-price -- time and materials has
 * no total -- and returns null rather than zero, because "we did not agree a
 * price" and "we agreed a price of nothing" are different statements and only
 * the second should let a billing plan draw against it.
 */

export type RevisionAmount = { status: string; amountMinor: number }

/** Only accepted revisions count. A sent one is an offer, not an agreement. */
export function acceptedRevisionsMinor(revisions: readonly RevisionAmount[]): number {
  return revisions.reduce((total, r) => (r.status === 'accepted' ? total + r.amountMinor : total), 0)
}

export function contractedValue(base: number | null, revisions: readonly RevisionAmount[]): number | null {
  const accepted = acceptedRevisionsMinor(revisions)
  if (base === null) return accepted === 0 ? null : accepted
  return base + accepted
}
