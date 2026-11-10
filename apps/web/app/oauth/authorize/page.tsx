import { oauth } from '@workloom/auth'
import { permissionsForRole } from '@workloom/core'
import { Card } from '@workloom/ui'
import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { AuthShell } from '@/components/auth-shell'
import { OAuthConsentForm } from '@/components/oauth-consent-form'
import { groupScopes } from '@/lib/api-key-scopes'
import { OAUTH_PARAMS } from '@/lib/oauth/params'
import { getSession } from '@/lib/server/viewer'

export const metadata: Metadata = { title: 'Connect an app · Workloom' }
export const dynamic = 'force-dynamic'

/**
 * The OAuth consent screen: where ChatGPT, Claude, or another app sends a
 * person to ask for access to Workloom.
 *
 * Outside the `(auth)` group because it needs a session, and wider than the
 * sign-in card because the permissions list is long.
 */
export default async function AuthorizePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const raw = await searchParams
  const first = (name: string) => {
    const value = raw[name]
    return Array.isArray(value) ? value[0] : value
  }
  const params = Object.fromEntries(
    OAUTH_PARAMS.flatMap((name) => {
      const value = first(name)
      return value === undefined ? [] : [[name, value]]
    }),
  ) as Record<string, string>

  const validation = await oauth.validateAuthorizeRequest(params)
  if (!validation.ok) {
    if (validation.kind === 'redirect') redirect(validation.redirectTo)
    return (
      <AuthShell wide>
        <Card className="p-6 sm:p-7">
          <h1 className="mb-2 text-lg font-semibold tracking-tight text-ink">Can’t connect this app</h1>
          <p className="text-sm text-muted">{validation.message}</p>
        </Card>
      </AuthShell>
    )
  }

  const session = await getSession()
  if (!session) {
    const back = `/oauth/authorize?${new URLSearchParams({ ...params, ...(first('organization_id') ? { organization_id: first('organization_id')! } : {}) })}`
    redirect(`/sign-in?next=${encodeURIComponent(back)}`)
  }

  const memberships = await oauth.listMemberships(session.user.id)
  const chosen =
    memberships.find((m) => m.organizationId === first('organization_id')) ??
    memberships.find((m) => m.organizationId === session.session.activeOrganizationId) ??
    memberships[0]
  if (!chosen) redirect('/onboarding')

  const { client, redirectUri } = validation.request
  const returnHost = new URL(redirectUri).host || new URL(redirectUri).protocol

  return (
    <AuthShell wide>
      <Card className="p-6 sm:p-7">
        <h1 className="text-lg font-semibold tracking-tight text-ink">
          <span className="break-words">{client.clientName}</span> wants to work in Workloom as you
        </h1>
        <p className="mt-2 text-sm text-muted">
          It will be able to see and change what you choose below, in{' '}
          <strong className="text-ink">{chosen.name}</strong>, as{' '}
          <strong className="text-ink">{session.user.name || session.user.email}</strong>. Everything it does is
          recorded in the audit log.
        </p>
        <p className="mt-3 rounded-md border border-line bg-raised px-3 py-2 text-xs text-muted">
          After you choose, you’ll be returned to <strong className="text-ink">{returnHost}</strong>. The app named
          itself — only allow it if you started this connection there.
        </p>

        <div className="mt-6">
          <OAuthConsentForm
            params={params}
            organizations={memberships.map((m) => ({ id: m.organizationId, name: m.name }))}
            organizationId={chosen.organizationId}
            groups={groupScopes(permissionsForRole(chosen.role))}
          />
        </div>
        <p className="mt-6 text-xs text-muted">
          You can disconnect it at any time in Settings → Connected apps.
        </p>
      </Card>
    </AuthShell>
  )
}
