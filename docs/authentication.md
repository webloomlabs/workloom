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

### Invitations

An owner or admin invites by email and chooses a role. The invitee follows the
emailed link, creates an account or signs in, **confirms their email address**,
and accepts. Unconfirmed addresses cannot accept an invitation.

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
