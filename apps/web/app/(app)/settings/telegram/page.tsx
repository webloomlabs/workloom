import { env } from '@workloom/config'
import { messagingIdentityList, organizationGet, telegramBotGet } from '@workloom/core/modules'
import { Alert, Badge, Button, Card, CardHeader, EmptyState, Table, Td, Th, Tr } from '@workloom/ui'
import type { Metadata } from 'next'
import { BotControls, ConnectBotForm, LinkMyTelegram, ReceiptReadingForm } from '@/components/telegram-forms'
import { revokeIdentityAction } from '@/lib/actions/telegram'
import { formatDate } from '@/lib/format'
import { call } from '@/lib/server/procedures'
import { requireViewer } from '@/lib/server/viewer'

export const metadata: Metadata = { title: 'Telegram · Workloom' }

const STATUS = { active: 'Answering', paused: 'Paused', error: 'Cannot reach Telegram' } as const

export default async function TelegramSettingsPage() {
  const viewer = await requireViewer()
  const canManage = viewer.permissions.has('integration:manage')
  const canSetReading = viewer.permissions.has('organization:update')
  const [{ bot }, people, organization] = await Promise.all([call(telegramBotGet, {}), call(messagingIdentityList, {}), call(organizationGet, {})])
  const https = env.APP_URL.startsWith('https://')

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          title="Telegram bot"
          description="Snap a receipt, send it to the bot, and it becomes a draft expense in Workloom for you to confirm — from the chat or here."
        />
        <div className="space-y-4 p-5">
          {bot ? (
            <>
              <p className="text-sm">
                <span className="font-medium">@{bot.username}</span>{' '}
                <Badge tone={bot.status === 'active' ? 'positive' : bot.status === 'error' ? 'critical' : 'caution'}>{STATUS[bot.status]}</Badge>{' '}
                <span className="text-muted">· {bot.linkedPeople} {bot.linkedPeople === 1 ? 'person' : 'people'} linked · connected {formatDate(bot.createdAt)}</span>
              </p>
              {bot.lastError && <Alert tone="warning">Telegram said: {bot.lastError}</Alert>}
              {bot.webhookUrl && <p className="text-xs text-muted">Telegram sends messages to {bot.webhookUrl}</p>}
              {canManage && <BotControls mode={bot.mode} paused={bot.status === 'paused'} />}
            </>
          ) : canManage ? (
            <ConnectBotForm https={https} />
          ) : (
            <EmptyState>No bot yet. An owner or admin connects the organization&apos;s Telegram bot here.</EmptyState>
          )}
        </div>
      </Card>

      {bot && (
        <Card>
          <CardHeader title="Your Telegram" description="Link your own Telegram account so the bot knows the receipts are yours." />
          <div className="p-5">
            <LinkMyTelegram />
          </div>
        </Card>
      )}

      <Card>
        <CardHeader title="Reading receipts" description="Whether an AI model reads each receipt and fills in the draft — from Telegram and from a new expense." />
        <div className="p-5">
          {canSetReading ? (
            <ReceiptReadingForm enabled={organization.receiptReadingEnabled} reader={organization.receiptReader} />
          ) : (
            <p className="text-sm text-muted">{organization.receiptReadingEnabled ? 'On.' : 'Off.'} An owner or admin can change this.</p>
          )}
        </div>
      </Card>

      {people.data.length > 0 && (
        <Card>
          <CardHeader title={canManage ? 'Linked people' : 'Your linked account'} />
          <Table>
            <thead>
              <tr><Th>Person</Th><Th>Telegram</Th><Th>Linked</Th><Th /></tr>
            </thead>
            <tbody>
              {people.data.map((p) => (
                <Tr key={p.id}>
                  <Td className="font-medium">{p.userName}</Td>
                  <Td className="text-muted">{p.displayName ?? '—'}</Td>
                  <Td className="text-muted">{formatDate(p.linkedAt)}</Td>
                  <Td className="text-right">
                    <form action={revokeIdentityAction}>
                      <input type="hidden" name="id" value={p.id} />
                      <Button type="submit" size="sm" variant="ghost">Unlink</Button>
                    </form>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
    </div>
  )
}
