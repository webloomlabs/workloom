'use client'

import { Alert, Button, Input } from '@workloom/ui'
import { useState, type ReactNode } from 'react'

/** A secret shown exactly once, with a copy button and a warning that means it. */
export function OneTimeSecret({
  label,
  secret,
  warning,
  children,
}: {
  label: string
  secret: string
  warning: ReactNode
  children?: ReactNode
}) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="space-y-3">
      <Alert tone="warning">{warning}</Alert>
      <div className="flex gap-2">
        <label htmlFor="one-time-secret" className="sr-only">{label}</label>
        <Input
          id="one-time-secret"
          readOnly
          value={secret}
          className="font-mono text-xs"
          onFocus={(e) => e.currentTarget.select()}
        />
        <Button
          type="button"
          variant="secondary"
          onClick={async () => {
            await navigator.clipboard.writeText(secret)
            setCopied(true)
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      {children}
    </div>
  )
}
