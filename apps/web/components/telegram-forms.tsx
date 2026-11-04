'use client'

import { Button, Field, Select } from '@workloom/ui'
import { useActionState } from 'react'
import { idle } from '@/lib/actions/state'
import { connectBotAction, createGroupCodeAction, createLinkCodeAction, disconnectBotAction, setReceiptReadingAction, updateBotAction } from '@/lib/actions/telegram'
import { FormMessage, SubmitButton } from './form-bits'
import { TextField } from './crm/fields'

const MODES = [
  { value: 'poll', label: 'Workloom asks Telegram every few seconds (works anywhere)' },
  { value: 'webhook', label: 'Telegram sends to Workloom (needs a public HTTPS address)' },
]

export function ConnectBotForm({ https }: { https: boolean }) {
  const [state, action] = useActionState(connectBotAction, idle)
  return (
    <form action={action} className="space-y-3" noValidate>
      <TextField state={state} id="bot-token" name="token" label="Bot token" placeholder="123456789:AA…" hint="From @BotFather: send it /newbot, then copy the token it gives you." required />
      <Field id="bot-mode" label="How messages arrive">
        <Select id="bot-mode" name="mode" defaultValue={https ? 'webhook' : 'poll'}>
          {MODES.map((m) => (
            <option key={m.value} value={m.value}>{m.label}</option>
          ))}
        </Select>
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton pendingLabel="Connecting…">Connect the bot</SubmitButton>
        <FormMessage state={state} />
      </div>
    </form>
  )
}

export function BotControls({ mode, paused }: { mode: string; paused: boolean }) {
  const [state, action] = useActionState(updateBotAction, idle)
  const [disconnectState, disconnect] = useActionState(disconnectBotAction, idle)
  return (
    <div className="space-y-4">
      <form action={action} className="flex flex-wrap items-end gap-3" noValidate>
        <Field id="bot-mode-change" label="How messages arrive">
          <Select id="bot-mode-change" name="mode" defaultValue={mode}>
            {MODES.map((m) => (
              <option key={m.value} value={m.value}>{m.label}</option>
            ))}
          </Select>
        </Field>
        <Field id="bot-paused" label="Bot">
          <Select id="bot-paused" name="paused" defaultValue={paused ? 'true' : 'false'}>
            <option value="false">Answering</option>
            <option value="true">Paused — messages are ignored</option>
          </Select>
        </Field>
        <SubmitButton size="sm" pendingLabel="Saving…">Save</SubmitButton>
        <FormMessage state={state} />
      </form>
      <form
        action={disconnect}
        onSubmit={(e) => {
          if (!window.confirm('Disconnect the bot? It stops answering until you connect it again.')) e.preventDefault()
        }}
      >
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" size="sm" variant="secondary">Disconnect</Button>
          <FormMessage state={disconnectState} />
        </div>
      </form>
    </div>
  )
}

export function LinkMyTelegram() {
  const [state, action] = useActionState(createLinkCodeAction, idle)
  const link = state.status === 'success' ? state.data : undefined
  return (
    <div className="space-y-3">
      <form action={action} className="flex flex-wrap items-center gap-3">
        <SubmitButton size="sm" pendingLabel="Making a code…">{link ? 'Make a new code' : 'Link my Telegram'}</SubmitButton>
        {state.status === 'error' && <FormMessage state={state} />}
      </form>
      {link && (
        <div className="space-y-2 rounded-md border border-line p-4 text-sm">
          <p>
            Open <a className="font-medium underline" href={link.deepLink} target="_blank" rel="noreferrer">@{link.botUsername}</a> on this phone or computer and press Start — or send it:
          </p>
          <p className="font-mono text-base select-all">/start {link.code}</p>
          <p className="text-xs text-muted">The code works once, for ten minutes.</p>
        </div>
      )}
    </div>
  )
}

export function AddToGroup() {
  const [state, action] = useActionState(createGroupCodeAction, idle)
  const link = state.status === 'success' ? state.data : undefined
  return (
    <div className="space-y-3">
      <form action={action} className="flex flex-wrap items-center gap-3">
        <SubmitButton size="sm" variant="secondary" pendingLabel="Making a code…">{link ? 'Make a new code' : 'Add the bot to a group'}</SubmitButton>
        {state.status === 'error' && <FormMessage state={state} />}
      </form>
      {link && (
        <div className="space-y-2 rounded-md border border-line p-4 text-sm">
          <p>
            <a className="font-medium underline" href={link.addToGroupLink} target="_blank" rel="noreferrer">Open Telegram and pick the group</a> — the bot joins it and the group is approved.
          </p>
          <p>If the bot is already in the group, send this there instead:</p>
          <p className="font-mono text-base select-all">/link {link.code}</p>
          <p className="text-xs text-muted">The code works once, for ten minutes.</p>
        </div>
      )}
    </div>
  )
}

export function ReceiptReadingForm({ enabled, reader }: { enabled: boolean; reader: { name: string; model: string } | null }) {
  const [state, action] = useActionState(setReceiptReadingAction, idle)
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="enabled" value={enabled ? 'false' : 'true'} />
      <p className="text-sm text-muted">
        {!reader
          ? 'Not available: this installation has no AI provider key (ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, or GROQ_API_KEY).'
          : enabled
            ? `On. Receipts sent to the bot, or dropped on a new expense, are read by ${reader.name} (${reader.model}) and fill in the draft. A person still checks and confirms each one.`
            : `Off. Receipts are stored, and a person types in the amount. Turning it on sends each receipt to ${reader.name} (${reader.model}) to be read.`}
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton size="sm" variant={enabled ? 'secondary' : 'primary'} disabled={!enabled && !reader} pendingLabel="Saving…">
          {enabled ? 'Turn reading off' : `Read receipts with ${reader?.name ?? 'AI'}`}
        </SubmitButton>
        <FormMessage state={state} />
      </div>
    </form>
  )
}
