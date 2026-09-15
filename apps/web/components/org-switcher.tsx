'use client'

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
    <form action={switchOrganizationAction} className="flex items-center gap-2">
      <label htmlFor="organizationId" className="sr-only">Organization</label>
      <select
        id="organizationId"
        name="organizationId"
        defaultValue={activeId ?? ''}
        onChange={(e) => e.currentTarget.form?.requestSubmit()}
        className="h-8 rounded-md border border-neutral-300 bg-white px-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
      >
        {!activeId && <option value="" disabled>Choose an organization</option>}
        {organizations.map((o) => (
          <option key={o.id} value={o.id}>{o.name}</option>
        ))}
      </select>
      <noscript>
        <button type="submit" className="text-sm">Switch</button>
      </noscript>
    </form>
  )
}
