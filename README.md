# Workloom

An open-source, self-hostable operating system for digital agencies.

Workloom connects the operational lifecycle of an agency into one system —
`Lead → Client → Proposal → Project → Tasks → Invoice → Payment → Maintenance` —
so that a project is never separated from the commercial context around it.

> **Status: pre-release.** In place: accounts, organizations, invitations, roles,
> API keys, an audit log (S1); signed webhooks with retries and idempotent API
> writes (S2); and the CRM — leads, companies, contacts, deals, a pipeline, activity
> history, and lead-to-client conversion (S3). Projects arrive in S5. See
> [Roadmap.md](Roadmap.md).

## Quick start

Requires Docker and Node 22+.

```bash
pnpm install
cp .env.example .env

# Generate the two required secrets
openssl rand -base64 32   # -> BETTER_AUTH_SECRET
openssl rand -base64 32   # -> WORKLOOM_ENCRYPTION_KEY

pnpm services:up          # postgres, mail catcher, object storage
pnpm dev                  # http://localhost:3000
pnpm worker               # in a second terminal: delivers webhooks
```

Check it came up: `curl localhost:3000/api/health`

| Service | URL |
| --- | --- |
| Application | http://localhost:3000 |
| Mail catcher (Mailpit) | http://localhost:8025 |
| Object storage console (MinIO) | http://localhost:9001 |

## Commands

```bash
pnpm dev              # run the web app
pnpm worker           # run the worker (webhook delivery, maintenance)
pnpm typecheck        # the only type gate — packages ship source, not builds
pnpm lint
pnpm test             # everything
pnpm test:isolation   # tenant isolation only
pnpm test:e2e         # browser journeys against a running app (pnpm dev)
pnpm db:generate      # generate a migration from the schema
pnpm services:down
```

## A note on the database role

Workloom refuses to start if it is connected to PostgreSQL as a superuser.

This is deliberate. Isolation between organizations is enforced by row-level
security, and PostgreSQL superusers bypass row-level security unconditionally —
so an app running as one has no isolation at all, while looking like it does.
The bundled Compose file provisions an unprivileged `workloom_app` role for
this reason. If you point `DATABASE_URL` at a superuser, the boot check will
tell you.

## Documentation

- [Architecture](docs/architecture.md) — tenant isolation, money, events
- [Configuration](docs/configuration.md) — every environment variable
- [Webhooks](docs/webhooks.md) — payloads, signature verification, retries
- API reference — served by a running instance at `/api/v1/openapi.json`
- [Roadmap](Roadmap.md)

## Licence

To be finalised before v0.1.
