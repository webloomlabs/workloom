/**
 * The whole project, as lines on a final invoice.
 *
 * The price first agreed, then every accepted change to it, each with a quiet
 * line saying which it is -- "Initially quoted project fee", "Additional
 * scope". They add up to exactly what the project is contracted for, so a
 * statement invoice that lists them and takes the earlier invoices off asks
 * for precisely what is left.
 */

export type ScopeRevision = { title: string; amountMinor: number; status: string; number: number }

export type ScopeLine = { description: string; detail: string; amountMinor: number }

export function contractScopeLines(project: { name: string; contractValueMinor: number | null }, revisions: readonly ScopeRevision[], baseTitle?: string | null): ScopeLine[] {
  const lines: ScopeLine[] = []
  if (project.contractValueMinor !== null && project.contractValueMinor !== 0) {
    lines.push({ description: baseTitle || project.name, detail: 'Initially quoted project fee', amountMinor: project.contractValueMinor })
  }
  for (const revision of [...revisions].filter((r) => r.status === 'accepted' && r.amountMinor !== 0).sort((a, b) => a.number - b.number)) {
    lines.push({ description: revision.title, detail: revision.amountMinor > 0 ? 'Additional scope' : 'Reduced scope', amountMinor: revision.amountMinor })
  }
  return lines
}
