import { oauthGrantList } from '@workloom/core/modules'
import { Badge, Card, CardHeader, EmptyState, Table, Td, Th, Tr } from '@workloom/ui'
import type { Metadata } from 'next'
import { McpConnectCard } from '@/components/mcp-connect-card'
import { RevokeOAuthGrantForm } from '@/components/oauth-grant-forms'
import { call } from '@/lib/server/procedures'
import { requireViewer } from '@/lib/server/viewer'

export const metadata: Metadata = { title: 'Connected apps · Workloom' }

function formatDate(value: Date | null) {
  return value ? value.toLocaleDateString() : '—'
}

/**
 * AI assistants and other apps people have connected through OAuth. Everyone
 * sees their own; those who manage API keys see everyone's.
 */
export default async function ConnectedAppsPage() {
  const viewer = await requireViewer()
  const { data: grants } = await call(oauthGrantList, { includeRevoked: false })
  const everyone = viewer.permissions.has('apiKey:read')
  const me = viewer.actor.type === 'user' ? viewer.actor.id : viewer.actor.type === 'apiKey' ? viewer.actor.userId : null
  const mayRevoke = (userId: string) => userId === me || viewer.permissions.has('apiKey:revoke')

  return (
    <div className="space-y-6">
      <McpConnectCard />

      <Card>
        <CardHeader
          title="Connected apps"
          description={everyone ? 'Apps people in this organization have allowed to act for them.' : 'Apps you have allowed to act for you.'}
        />
        {grants.length === 0 ? (
          <EmptyState>No apps connected yet.</EmptyState>
        ) : (
          <Table>
            <thead>
              <tr><Th>App</Th>{everyone && <Th>Person</Th>}<Th>Access</Th><Th>Connected</Th><Th>Last used</Th><Th /></tr>
            </thead>
            <tbody>
              {grants.map((grant) => (
                <Tr key={grant.id}>
                  <Td className="font-medium">{grant.clientName}</Td>
                  {everyone && <Td>{grant.userName}</Td>}
                  <Td>
                    {grant.scopes === null ? (
                      <Badge tone="accent">Full access</Badge>
                    ) : (
                      <Badge>Restricted · {grant.scopes.length}</Badge>
                    )}
                  </Td>
                  <Td className="text-muted">{formatDate(grant.createdAt)}</Td>
                  <Td className="text-muted">{formatDate(grant.lastUsedAt)}</Td>
                  <Td>{mayRevoke(grant.userId) && <RevokeOAuthGrantForm id={grant.id} name={grant.clientName} />}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  )
}
