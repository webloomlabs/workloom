import { webhookList } from '@workloom/core/modules'
import { Card, CardHeader, EmptyState, Table, Td, Th, Tr } from '@workloom/ui'
import type { Metadata } from 'next'
import Link from 'next/link'
import { EndpointStatus } from '@/components/endpoint-status'
import { CreateWebhookForm } from '@/components/webhook-forms'
import { eventFamilies } from '@/lib/server/event-families'
import { call } from '@/lib/server/procedures'
import { requireViewer } from '@/lib/server/viewer'

export const metadata: Metadata = { title: 'Webhooks · Workloom' }

export default async function WebhooksPage() {
  const viewer = await requireViewer()
  const { data: endpoints } = await call(webhookList, {})

  return (
    <div className="space-y-6">
      {viewer.permissions.has('webhook:create') && (
        <Card>
          <CardHeader
            title="Add an endpoint"
            description="Workloom sends a signed POST to this URL whenever a subscribed event happens — for n8n, Make, Zapier, or your own service."
          />
          <div className="p-5"><CreateWebhookForm families={eventFamilies()} /></div>
        </Card>
      )}

      <Card>
        <CardHeader title="Endpoints" />
        {endpoints.length === 0 ? (
          <EmptyState>No webhook endpoints yet.</EmptyState>
        ) : (
          <Table>
            <thead><tr><Th>Endpoint</Th><Th>Events</Th><Th>Status</Th></tr></thead>
            <tbody>
              {endpoints.map((e) => (
                <Tr key={e.id}>
                  <Td>
                    <Link href={`/settings/webhooks/${e.id}`} className="font-medium hover:underline">
                      {e.description || e.url}
                    </Link>
                    {e.description && <div className="font-mono text-xs text-muted">{e.url}</div>}
                  </Td>
                  <Td className="text-xs text-muted">{e.eventTypes.join(', ')}</Td>
                  <Td><EndpointStatus enabled={e.enabled} disabledReason={e.disabledReason} /></Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  )
}
