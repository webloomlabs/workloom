import { webhookDeliveryList, webhookGet } from '@workloom/core/modules'
import { Alert, Badge, Button, Card, CardHeader, EmptyState, Table, Td, Th } from '@workloom/ui'
import type { Metadata } from 'next'
import Link from 'next/link'
import { EndpointStatus } from '@/components/endpoint-status'
import { EditWebhookForm, RotateSecretForm, SendTestForm } from '@/components/webhook-forms'
import { deleteWebhookAction, retryDeliveryAction, setWebhookEnabledAction } from '@/lib/actions/webhooks'
import { eventFamilies } from '@/lib/server/event-families'
import { call } from '@/lib/server/procedures'
import { requireViewer } from '@/lib/server/viewer'

export const metadata: Metadata = { title: 'Webhook endpoint · Workloom' }

const statusTone = { succeeded: 'green', pending: 'amber', failed: 'red' } as const

export default async function WebhookEndpointPage({ params, searchParams }: PageProps<'/settings/webhooks/[id]'>) {
  const { id } = await params
  const query = await searchParams
  const cursor = typeof query.cursor === 'string' ? query.cursor : undefined

  const viewer = await requireViewer()
  const endpoint = await call(webhookGet, { id })
  const { data: deliveries, nextCursor } = await call(webhookDeliveryList, { id, limit: 25, ...(cursor ? { cursor } : {}) })
  const canUpdate = viewer.permissions.has('webhook:update')

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <Link href="/settings/webhooks" className="text-sm text-neutral-500 hover:underline">← Webhooks</Link>
          <h2 className="mt-1 break-all font-mono text-sm">{endpoint.url}</h2>
        </div>
        <EndpointStatus enabled={endpoint.enabled} disabledReason={endpoint.disabledReason} />
      </div>

      {endpoint.disabledReason && <Alert tone="error">{endpoint.disabledReason}</Alert>}
      {endpoint.rotating && (
        <Alert tone="info">A previous signing secret is still valid while you update your receiver. Deliveries are signed with both.</Alert>
      )}

      {canUpdate && (
        <Card>
          <CardHeader title="Actions" />
          <div className="flex flex-wrap items-start gap-3 p-5">
            <SendTestForm id={endpoint.id} />
            <form action={setWebhookEnabledAction}>
              <input type="hidden" name="id" value={endpoint.id} />
              <input type="hidden" name="enabled" value={String(!endpoint.enabled)} />
              <Button type="submit" variant="secondary" size="sm">{endpoint.enabled ? 'Disable' : 'Enable'}</Button>
            </form>
            <RotateSecretForm id={endpoint.id} />
            {viewer.permissions.has('webhook:delete') && (
              <form action={deleteWebhookAction}>
                <input type="hidden" name="id" value={endpoint.id} />
                <Button type="submit" variant="danger" size="sm">Delete</Button>
              </form>
            )}
          </div>
        </Card>
      )}

      <Card>
        <CardHeader
          title="Deliveries"
          description="Failed deliveries are retried 7 more times over about 21 hours. Delivery is at-least-once: deduplicate on Workloom-Event-Id."
        />
        {deliveries.length === 0 ? (
          <EmptyState>Nothing delivered yet. Send a test event to try it.</EmptyState>
        ) : (
          <Table>
            <thead><tr><Th>Event</Th><Th>Status</Th><Th>Attempts</Th><Th>Response</Th><Th>Last attempt</Th><Th /></tr></thead>
            <tbody>
              {deliveries.map((d) => (
                <tr key={d.id}>
                  <Td><code className="font-mono text-xs">{d.eventType}</code></Td>
                  <Td><Badge tone={statusTone[d.status]}>{d.status}</Badge></Td>
                  <Td>{d.attempts}</Td>
                  <Td className="max-w-xs">
                    <div className="text-xs">
                      {d.responseStatus ?? '—'}
                      {d.durationMs !== null && <span className="text-neutral-500"> · {d.durationMs} ms</span>}
                    </div>
                    {d.error && <div className="text-xs text-red-600">{d.error}</div>}
                    {d.responseBody && (
                      <details className="text-xs">
                        <summary className="cursor-pointer text-neutral-500">Body</summary>
                        <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-neutral-100 p-2 dark:bg-neutral-800">{d.responseBody}</pre>
                      </details>
                    )}
                  </Td>
                  <Td className="whitespace-nowrap text-xs text-neutral-500">
                    {d.lastAttemptAt?.toLocaleString() ?? '—'}
                    {d.status === 'pending' && d.nextAttemptAt && <div>next {d.nextAttemptAt.toLocaleTimeString()}</div>}
                  </Td>
                  <Td className="text-right">
                    {canUpdate && d.status === 'failed' && (
                      <form action={retryDeliveryAction}>
                        <input type="hidden" name="id" value={d.id} />
                        <input type="hidden" name="endpointId" value={endpoint.id} />
                        <Button type="submit" variant="ghost" size="sm">Retry</Button>
                      </form>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        {(cursor || nextCursor) && (
          <div className="flex justify-between px-5 py-3 text-sm">
            {cursor ? <Link href={`/settings/webhooks/${id}`} className="hover:underline">Newest</Link> : <span />}
            {nextCursor && <Link href={`/settings/webhooks/${id}?cursor=${nextCursor}`} className="hover:underline">Older →</Link>}
          </div>
        )}
      </Card>

      {canUpdate && (
        <Card>
          <CardHeader title="Settings" />
          <div className="p-5">
            <EditWebhookForm
              endpoint={{ id: endpoint.id, url: endpoint.url, description: endpoint.description, eventTypes: endpoint.eventTypes }}
              families={eventFamilies()}
            />
          </div>
        </Card>
      )}
    </div>
  )
}
