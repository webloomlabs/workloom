import { auditLogList } from '@workloom/core/modules'
import { Card, CardHeader, EmptyState, Table, Td, Th } from '@workloom/ui'
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

export default async function AuditLogPage({ searchParams }: PageProps<'/settings/audit-log'>) {
  const params = await searchParams
  const cursor = typeof params.cursor === 'string' ? params.cursor : undefined
  const { data, nextCursor } = await call(auditLogList, { limit: 50, ...(cursor ? { cursor } : {}) })

  return (
    <Card>
      <CardHeader
        title="Audit log"
        description="Every change to members, keys, and settings — who did it, and when. Entries cannot be edited or deleted."
      />
      {data.length === 0 ? (
        <EmptyState>Nothing recorded yet.</EmptyState>
      ) : (
        <Table>
          <thead><tr><Th>When</Th><Th>Who</Th><Th>Action</Th><Th>Subject</Th><Th>Changes</Th></tr></thead>
          <tbody>
            {data.map((entry) => (
              <tr key={entry.id}>
                <Td className="whitespace-nowrap text-neutral-500">{entry.createdAt.toLocaleString()}</Td>
                <Td>{entry.actorLabel ?? entry.actorType}</Td>
                <Td><code className="font-mono text-xs">{entry.action}</code></Td>
                <Td>{entry.entityLabel ?? entry.entityType}</Td>
                <Td className="text-xs text-neutral-600">{describeChanges(entry.changes)}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {(cursor || nextCursor) && (
        <div className="flex justify-between px-5 py-3 text-sm">
          {cursor ? <Link href="/settings/audit-log" className="hover:underline">Newest</Link> : <span />}
          {nextCursor && (
            <Link href={`/settings/audit-log?cursor=${nextCursor}`} className="hover:underline">Older →</Link>
          )}
        </div>
      )}
    </Card>
  )
}
