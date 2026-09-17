# Authentication

Two ways in, one place they meet.

```text
Bearer wl_live_…  ─┐
                   ├─→ resolveActor ─→ ActorContext { organization, actor, permissions }
session cookie  ───┘
```

`resolveActor` is the only thing that turns a request into an identity, and
everything downstream takes the result rather than the request. That is what
lets the same service run from a page, the REST API, and a background job.

## People

Accounts, sessions, passwords, email verification, and invitations are handled
by [Better Auth](https://better-auth.com). Passwords are hashed by it; Workloom
never sees one.

A person is **not** scoped to an organization — they can belong to several, and
"which organizations does this user belong to?" has to be answerable before any
organization context exists. Membership is checked on every request. Being
signed in but not a member of the organization you asked about is a **404**, not
a 403: a 403 would confirm it exists.

## How accounts come to exist

This is the one thing `MULTI_TENANT` changes. Isolation between organizations
is row-level security either way; the flag decides who may create accounts and
organizations, not how they are kept apart.

| | `MULTI_TENANT=false` (default) | `MULTI_TENANT=true` |
| --- | --- | --- |
| First account | The setup screen at `/setup` | Sign-up |
| Later accounts | An administrator, under Settings → Members | Sign-up, or an invitation |
| Email verification | Not required — the address came from an administrator | Required before joining an organization |
| Creating an organization | Only at setup | Anyone, at any time |
| `POST /api/auth/sign-up/email` | Refused | Open |
| `POST /api/auth/organization/create` | Refused | Open |

### Setup, on a single-tenant installation

`/setup` is the one screen that creates an account without one already
existing, so it is open to whoever reaches it — and it closes the moment the
first account exists, permanently. **Complete it as soon as the stack is up.**

It creates the administrator, the organization, and the owning membership in a
single transaction, then signs the administrator in.

The test for "already set up" is whether **any account** exists, not whether
any organization does. An owner who deletes their organization would otherwise
reopen setup for whoever reached the URL next; instead they lock themselves out,
which is the better of the two failures. Recovering from that means restoring a
backup.

### Adding people, on a single-tenant installation

Anyone with `member:invite` adds a member under **Settings → Members** by
entering their name, email, role, and a first password. The account is created
already verified and already a member; **nothing is emailed**, so adding a
colleague does not depend on a working mail server. Pass the password on
yourself. They can change it from "Forgot password?" — which does need mail — or
you can add them again after removing them.

Only an owner may create another owner, the same rule invitations follow.

This is restricted to single-tenant installations on purpose. Where several
organizations share an installation, one organization's administrator minting
accounts that exist instance-wide is a larger grant than `member:invite` is
meant to be; there, an invitation the recipient has to accept is the right
shape.

The two functions that create accounts without a session live in
`packages/auth/src/provisioning.ts` and authorise nothing themselves. Their
only callers are `setupAction` (guarded by "no account exists yet") and
`addMemberAction` (guarded by `member:invite`).

### Invitations, on a multi-tenant installation

An owner or admin invites by email and chooses a role. The invitee follows the
emailed link, creates an account or signs in, **confirms their email address**,
and accepts. Unconfirmed addresses cannot accept an invitation.

Verification matters here because an invitation link that leaks — a forwarded
email, a browser history, a proxy log — plus a sign-up using the invitee's
address would otherwise be enough to join someone else's organization. A
single-tenant installation has no invitations and no sign-up, which is why it
does not require verification.

## Programs

API keys are created in **Settings → API keys** and shown once. Only a hash is
stored, and it is compared in constant time.

A key carries:

- the organization it was made in,
- the person who made it,
- the scopes chosen for it.

**Effective permissions are `rolePermissions(role) ∩ key.scopes`, computed on
every request.** A key can therefore never exceed its owner's permissions, and
demoting them narrows every key they hold immediately — without anyone having to
remember to revoke anything.

Keys can carry an expiry, and can be revoked. A revoked key stops working at
once.

## What is exempt

One thing in Workloom is reachable without authenticating: the link a client
gets on their invoice (`/i/<token>`). It is an HMAC over the organization and
invoice, signed with a key derived for that purpose alone, so a token minted for
one purpose cannot be replayed as another. **Holding the link is the authority**
— which is what an emailed invoice has to be. It opens exactly one invoice,
shows nothing else of the organization's, and does not expire. Staff PDF links
are signed the same way and last ten minutes.

## Cross-site request forgery

The API accepts the session cookie, so a cookie-authenticated **write** must
carry an `Origin` matching `APP_URL`. Cookies are already `SameSite=Lax`; this
makes the guarantee explicit rather than dependent on a cookie attribute and
browser behaviour. API-key requests carry no ambient credential and are exempt.

## Rate limiting

Authentication attempts are limited by IP and email, more tightly than ordinary
reads and writes. See [api.md](api.md).
