import { auth } from '@workloom/auth'
import { memberList } from '@workloom/core/modules'
import { Badge, Button, Card, CardHeader, EmptyState, Table, Td, Th } from '@workloom/ui'
import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { AddMemberForm, InviteMemberForm, MemberRoleForm, RemoveMemberForm, ROLE_LABELS } from '@/components/member-forms'
import { cancelInvitationAction } from '@/lib/actions/settings'
import { call } from '@/lib/server/procedures'
import { isMultiTenant } from '@/lib/server/tenancy'
import { requireViewer } from '@/lib/server/viewer'

export const metadata: Metadata = { title: 'Members · Workloom' }

export default async function MembersPage() {
  const viewer = await requireViewer()
  const { data: members } = await call(memberList, {})

  const canInvite = viewer.permissions.has('member:invite')
  const canUpdate = viewer.permissions.has('member:update')
  const canRemove = viewer.permissions.has('member:remove')
  // Only an owner may create another owner; otherwise an admin could promote
  // themselves past the one permission that sets owners apart.
  const canInviteOwner = viewer.role === 'owner'

  /**
   * Invitations only make sense where an invitee can complete a sign-up. On a
   * single-tenant installation they cannot, so the same permission opens a
   * form that creates the account outright instead.
   */
  const multiTenant = isMultiTenant()
  const invitations =
    canInvite && multiTenant
      ? (await auth.api.listInvitations({
          query: { organizationId: viewer.organizationId },
          headers: await headers(),
        })).filter((i) => i.status === 'pending')
      : []

  const selfId = viewer.actor.type === 'user' ? viewer.actor.id : null

  return (
    <div className="space-y-6">
      {canInvite && (multiTenant ? (
        <Card>
          <CardHeader title="Invite someone" description="They'll get an email with a link to join. Invitations expire after 7 days." />
          <div className="p-5"><InviteMemberForm canInviteOwner={canInviteOwner} /></div>
        </Card>
      ) : (
        <Card>
          <CardHeader
            title="Add a member"
            description="Creates their account and adds them straight away. Nothing is emailed — pass the password on yourself, and they can change it from “Forgot password?”."
          />
          <div className="p-5"><AddMemberForm canAddOwner={canInviteOwner} /></div>
        </Card>
      ))}

      <Card>
        <CardHeader title="Members" description={`${members.length} ${members.length === 1 ? 'person' : 'people'}`} />
        <Table>
          <thead>
            <tr><Th>Name</Th><Th>Role</Th><Th>Joined</Th><Th /></tr>
          </thead>
          <tbody>
            {members.map((m) => {
              const isSelf = m.userId === selfId
              return (
                <tr key={m.id}>
                  <Td>
                    <div className="font-medium">{m.name} {isSelf && <Badge>You</Badge>}</div>
                    <div className="text-xs text-neutral-500">{m.email}</div>
                  </Td>
                  <Td>
                    {canUpdate && !isSelf ? (
                      <MemberRoleForm memberId={m.id} role={m.role} canInviteOwner={canInviteOwner} />
                    ) : (
                      ROLE_LABELS[m.role]
                    )}
                  </Td>
                  <Td className="text-neutral-500">{m.joinedAt.toLocaleDateString()}</Td>
                  <Td className="text-right">
                    {canRemove && !isSelf && <RemoveMemberForm userId={m.userId} name={m.name} />}
                  </Td>
                </tr>
              )
            })}
          </tbody>
        </Table>
      </Card>

      {canInvite && multiTenant && (
        <Card>
          <CardHeader title="Pending invitations" />
          {invitations.length === 0 ? (
            <EmptyState>No invitations waiting.</EmptyState>
          ) : (
            <Table>
              <thead><tr><Th>Email</Th><Th>Role</Th><Th>Expires</Th><Th /></tr></thead>
              <tbody>
                {invitations.map((i) => (
                  <tr key={i.id}>
                    <Td>{i.email}</Td>
                    <Td>{ROLE_LABELS[i.role as keyof typeof ROLE_LABELS] ?? i.role}</Td>
                    <Td className="text-neutral-500">{new Date(i.expiresAt).toLocaleDateString()}</Td>
                    <Td className="text-right">
                      <form action={cancelInvitationAction}>
                        <input type="hidden" name="invitationId" value={i.id} />
                        <Button type="submit" variant="ghost" size="sm">Cancel</Button>
                      </form>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      )}
    </div>
  )
}
