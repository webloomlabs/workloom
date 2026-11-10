'use client'

import { Button } from '@workloom/ui'
import { useActionState } from 'react'
import { revokeOAuthGrantAction } from '@/lib/actions/settings'
import { idle } from '@/lib/actions/state'

export function RevokeOAuthGrantForm({ id, name }: { id: string; name: string }) {
  const [state, action] = useActionState(revokeOAuthGrantAction, idle)
  return (
    <form
      action={action}
      onSubmit={(e) => {
        if (!confirm(`Disconnect “${name}”? It stops working immediately and has to be connected again.`)) e.preventDefault()
      }}
      className="flex items-center justify-end gap-2"
    >
      <input type="hidden" name="id" value={id} />
      <Button type="submit" variant="ghost" size="sm">Disconnect</Button>
      {state.status === 'error' && <span role="alert" className="text-xs text-critical">{state.message}</span>}
    </form>
  )
}
