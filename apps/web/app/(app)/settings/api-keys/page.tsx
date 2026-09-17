import { apiKeyList } from '@workloom/core/modules'
import { Badge, Card, CardHeader, EmptyState, Table, Td, Th, Tr } from '@workloom/ui'
import type { Metadata } from 'next'
import { CreateApiKeyForm, RevokeApiKeyForm } from '@/components/api-key-forms'
import { call } from '@/lib/server/procedures'
import { requireViewer } from '@/lib/server/viewer'

export const metadata: Metadata = { title: 'API keys · Workloom' }

function formatDate(value: Date | null) {
  return value ? value.toLocaleDateString() : '—'
}

export default async function ApiKeysPage() {
  const viewer = await requireViewer()
  const { data: keys } = await call(apiKeyList, { includeRevoked: false })

  const grantable: Record<string, string[]> = {}
  for (const permission of [...viewer.permissions].sort()) {
    const [resource, action] = permission.split(':') as [string, string]
    ;(grantable[resource] ??= []).push(action)
  }

  const now = Date.now()

  return (
    <div className="space-y-6">
      {viewer.permissions.has('apiKey:create') && viewer.actor.type === 'user' && (
        <Card>
          <CardHeader
            title="Create an API key"
            description="For connecting automation tools such as n8n, Make, or your own scripts."
          />
          <div className="p-5"><CreateApiKeyForm grantable={grantable} /></div>
        </Card>
      )}

      <Card>
        <CardHeader title="Active keys" />
        {keys.length === 0 ? (
          <EmptyState>No API keys yet.</EmptyState>
        ) : (
          <Table>
            <thead>
              <tr><Th>Name</Th><Th>Key</Th><Th>Scopes</Th><Th>Last used</Th><Th>Expires</Th><Th /></tr>
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
                        <Badge>Owner&apos;s permissions</Badge>
                      ) : (
                        <span className="text-xs text-muted">{key.scopes.join(', ')}</span>
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
    </div>
  )
}
