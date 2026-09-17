'use client'

import { Select } from '@workloom/ui'
import { switchOrganizationAction } from '@/lib/actions/auth'

/**
 * Switches the session's active organization. Submits on change; the button
 * is there for keyboard and no-JavaScript use.
 */
export function OrganizationSwitcher({
  organizations,
  activeId,
}: {
  organizations: Array<{ id: string; name: string }>
  activeId: string | null
}) {
  return (
    <form action={switchOrganizationAction}>
      <label htmlFor="organizationId" className="sr-only">Organization</label>
      <Select
        id="organizationId"
        name="organizationId"
        defaultValue={activeId ?? ''}
        onChange={(e) => e.currentTarget.form?.requestSubmit()}
        className="h-8 bg-raised text-[13px]"
      >
        {!activeId && <option value="" disabled>Choose an organization</option>}
        {organizations.map((o) => (
          <option key={o.id} value={o.id}>{o.name}</option>
        ))}
      </Select>
      <noscript>
        <button type="submit" className="mt-1 text-xs text-muted underline">Switch</button>
      </noscript>
    </form>
  )
}
