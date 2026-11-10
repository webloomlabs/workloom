import { auditLogList } from '@workloom/core/modules'
import { Button, Card, CardHeader, EmptyState, Input, Select, Table, Td, Th, Tr } from '@workloom/ui'
import type { Metadata } from 'next'
import Link from 'next/link'
import { call } from '@/lib/server/procedures'

export const metadata: Metadata = { title: 'Audit log · Workloom' }

function describeChanges(changes: unknown): string {
  if (!changes || typeof changes !== 'object') return ''
  return Object.entries(changes as Record<string, { from: unknown; to: unknown }>)
    .map(([field, { from, to }]) => `${field}: ${String(from ?? '—')} → ${String(to ?? '—')}`)
    .join('; ')
}

const SOURCES = { web: 'Web', api: 'API', telegram: 'Telegram', mcp: 'AI assistant (MCP)', worker: 'Worker', system: 'System' } as const
const DAY = /^\d{4}-\d{2}-\d{2}$/

/** The filters a person set, kept to what the procedure accepts. */
function filtersFrom(params: Record<string, string | string[] | undefined>) {
  const text = (name: string) => (typeof params[name] === 'string' ? (params[name] as string).trim() : '')
  const source = text('source')
  return {
    ...(text('action') ? { action: text('action').slice(0, 64) } : {}),
    ...(source in SOURCES ? { source: source as keyof typeof SOURCES } : {}),
    ...(DAY.test(text('from')) ? { from: text('from') } : {}),
    ...(DAY.test(text('to')) ? { to: text('to') } : {}),
  }
}

export default async function AuditLogPage({ searchParams }: PageProps<'/settings/audit-log'>) {
  const params = await searchParams
  const cursor = typeof params.cursor === 'string' ? params.cursor : undefined
  const filters = filtersFrom(params)
  const query = new URLSearchParams(filters as Record<string, string>).toString()
  const { data, nextCursor } = await call(auditLogList, { limit: 50, ...filters, ...(cursor ? { cursor } : {}) })

  return (
    <Card>
      <CardHeader
        title="Audit log"
        description="Every change — who made it, when, and from where. Entries cannot be edited or deleted, and each finished day is sealed so a change made behind Workloom's back would show."
        action={<a href={`/settings/audit-log/export${query ? `?${query}` : ''}`} className="text-sm font-medium hover:underline">Export CSV</a>}
      />
      <form method="get" className="flex flex-wrap items-end gap-3 border-b border-line px-5 py-3 text-sm">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted">Action</span>
          <Input name="action" defaultValue={filters.action ?? ''} placeholder="invoice. or expense.deleted" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted">From</span>
          <Select name="source" defaultValue={filters.source ?? ''}>
            <option value="">Anywhere</option>
            {Object.entries(SOURCES).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </Select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted">On or after</span>
          <Input type="date" name="from" defaultValue={filters.from ?? ''} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted">On or before</span>
          <Input type="date" name="to" defaultValue={filters.to ?? ''} />
        </label>
        <Button type="submit" variant="secondary">Filter</Button>
        {query && <Link href="/settings/audit-log" className="pb-2 text-muted hover:underline">Clear</Link>}
      </form>
      {data.length === 0 ? (
        <EmptyState>Nothing recorded yet.</EmptyState>
      ) : (
        <Table>
          <thead><tr><Th>When</Th><Th>Who</Th><Th>From</Th><Th>Action</Th><Th>Subject</Th><Th>Changes</Th></tr></thead>
          <tbody>
            {data.map((entry) => (
              <Tr key={entry.id}>
                <Td className="whitespace-nowrap text-muted">{entry.createdAt.toLocaleString()}</Td>
                <Td>{entry.actorLabel ?? entry.actorType}</Td>
                <Td className="text-muted">{entry.source ? SOURCES[entry.source as keyof typeof SOURCES] ?? entry.source : '—'}</Td>
                <Td><code className="font-mono text-xs">{entry.action}</code></Td>
                <Td>{entry.entityLabel ?? entry.entityType}</Td>
                <Td className="text-xs text-muted">{describeChanges(entry.changes)}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
      {(cursor || nextCursor) && (
        <div className="flex justify-between px-5 py-3 text-sm">
          {cursor ? <Link href={`/settings/audit-log${query ? `?${query}` : ''}`} className="hover:underline">Newest</Link> : <span />}
          {nextCursor && (
            <Link href={`/settings/audit-log?${query ? `${query}&` : ''}cursor=${nextCursor}`} className="hover:underline">Older →</Link>
          )}
        </div>
      )}
    </Card>
  )
}
