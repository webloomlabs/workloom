import { auth } from '@workloom/auth'
import { Button, Card, CardHeader } from '@workloom/ui'
import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { CreateOrganizationForm } from '@/components/create-org-form'
import { switchOrganizationAction } from '@/lib/actions/auth'

export const metadata: Metadata = { title: 'Choose an organization · Workloom' }

export default async function OnboardingPage() {
  const organizations = await auth.api.listOrganizations({ headers: await headers() })

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
      <Card>
        <CardHeader
          title={organizations.length > 0 ? 'Create another organization' : 'Create your organization'}
          description="Everything in Workloom — clients, projects, invoices — belongs to an organization."
        />
        <div className="p-5">
          <CreateOrganizationForm />
        </div>
      </Card>
    </div>
  )
}
