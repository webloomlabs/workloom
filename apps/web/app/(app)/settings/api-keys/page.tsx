import { apiKeyList } from '@workloom/core/modules'
import { Badge, Card, CardHeader, EmptyState, Table, Td, Th, Tr } from '@workloom/ui'
import type { Metadata } from 'next'
import { CreateApiKeyForm, RevokeApiKeyForm } from '@/components/api-key-forms'
import { McpConnectCard } from '@/components/mcp-connect-card'
import { actionLabel, groupScopes } from '@/lib/api-key-scopes'
import { call } from '@/lib/server/procedures'
import { requireViewer } from '@/lib/server/viewer'

export const metadata: Metadata = { title: 'API keys · Workloom' }

function formatDate(value: Date | null) {
  return value ? value.toLocaleDateString() : '—'
}

export default async function ApiKeysPage() {
  const viewer = await requireViewer()
  const { data: keys } = await call(apiKeyList, { includeRevoked: false })


  const now = Date.now()

  return (
    <div className="space-y-6">
      {viewer.permissions.has('apiKey:create') && viewer.actor.type === 'user' && (
        <Card>
          <CardHeader
            title="Create an API key"
            description="For connecting automation tools such as n8n, Make, or your own scripts."
          />
          <div className="p-5"><CreateApiKeyForm groups={groupScopes(viewer.permissions)} /></div>
        </Card>
      )}

      <Card>
        <CardHeader title="Active keys" />
        {keys.length === 0 ? (
          <EmptyState>No API keys yet.</EmptyState>
        ) : (
          <Table>
            <thead>
              <tr><Th>Name</Th><Th>Key</Th><Th>Access</Th><Th>Last used</Th><Th>Expires</Th><Th /></tr>
            </thead>
            <tbody>
              {keys.map((key) => {
                const expired = key.expiresAt !== null && key.expiresAt.getTime() <= now
                return (
                  <Tr key={key.id}>
                    <Td className="font-medium">{key.name}</Td>
                    <Td><code className="font-mono text-xs text-muted">{key.keyPrefix}…</code></Td>
                    <Td>
                      {key.scopes === null ? (
                        <Badge tone="accent">Full access</Badge>
                      ) : (
                        <ScopeSummary scopes={key.scopes} />
                      )}
                    </Td>
                    <Td className="text-muted">{formatDate(key.lastUsedAt)}</Td>
                    <Td>{expired ? <Badge tone="critical">Expired</Badge> : formatDate(key.expiresAt)}</Td>
                    <Td>
                      {viewer.permissions.has('apiKey:revoke') && <RevokeApiKeyForm id={key.id} name={key.name} />}
                    </Td>
                  </Tr>
                )
              })}
            </tbody>
          </Table>
        )}
      </Card>

      <McpConnectCard />
    </div>
  )
}

/** A restricted key's permissions: a count, opening to the list by area. */
function ScopeSummary({ scopes }: { scopes: string[] }) {
  const groups = groupScopes(scopes)
  return (
    <details className="group">
      <summary className="flex cursor-pointer list-none items-center gap-2 [&::-webkit-details-marker]:hidden">
        <Badge>Restricted</Badge>
        <span className="text-xs text-muted underline-offset-2 group-hover:underline">
          {scopes.length} {scopes.length === 1 ? 'permission' : 'permissions'}
        </span>
      </summary>
      <dl className="mt-2 space-y-1.5 text-xs">
        {groups.map((group) => (
          <div key={group.key}>
            <dt className="font-medium text-ink">{group.title}</dt>
            <dd className="text-muted">
              {group.resources.map((r) => `${r.label} (${r.actions.map(actionLabel).join(', ')})`).join(' · ')}
            </dd>
          </div>
        ))}
      </dl>
    </details>
  )
}
