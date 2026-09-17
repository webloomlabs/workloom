import { auth } from '@workloom/auth'
import { Button, Card, CardHeader, EmptyState } from '@workloom/ui'
import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { CreateOrganizationForm } from '@/components/create-org-form'
import { switchOrganizationAction } from '@/lib/actions/auth'
import { isMultiTenant } from '@/lib/server/tenancy'

export const metadata: Metadata = { title: 'Choose an organization · Workloom' }

export default async function OnboardingPage() {
  const organizations = await auth.api.listOrganizations({ headers: await headers() })
  const multiTenant = isMultiTenant()

  return (
    <div className="mx-auto max-w-lg space-y-6">
      {organizations.length > 0 && (
        <Card>
          <CardHeader title="Your organizations" description="Pick one to continue." />
          <ul>
            {organizations.map((o) => (
              <li key={o.id} className="flex items-center justify-between border-b border-neutral-100 px-5 py-3 last:border-0 dark:border-neutral-800">
                <span className="text-sm font-medium">{o.name}</span>
                <form action={switchOrganizationAction}>
                  <input type="hidden" name="organizationId" value={o.id} />
                  <Button type="submit" variant="secondary" size="sm">Open</Button>
                </form>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {multiTenant ? (
        <Card>
          <CardHeader
            title={organizations.length > 0 ? 'Create another organization' : 'Create your organization'}
            description="Everything in Workloom — clients, projects, invoices — belongs to an organization."
          />
          <div className="p-5">
            <CreateOrganizationForm />
          </div>
        </Card>
      ) : (
        organizations.length === 0 && (
          // Reachable on a single-tenant installation only after someone has
          // been removed from the organization, or had their membership
          // revoked. There is nothing they can do about it themselves, so the
          // page says who can.
          <Card>
            <CardHeader title="No access yet" />
            <EmptyState>
              Your account is not a member of this installation&apos;s organization. Ask an
              administrator to add you.
            </EmptyState>
          </Card>
        )
      )}
    </div>
  )
}
