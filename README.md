# Workloom

An open-source, self-hostable operating system for digital agencies.

Workloom connects the operational lifecycle of an agency into one system —
`Lead → Client → Proposal → Project → Tasks → Invoice → Payment → Maintenance` —
so that a project is never separated from the commercial context around it.

> **Status: v0.1 ready.** The agency lifecycle works end to end: accounts,
> organizations, invitations, roles, API keys and an audit log (S1); signed
> webhooks with retries and idempotent API writes (S2); the CRM — leads,
> companies, contacts, deals, a pipeline and lead-to-client conversion (S3); a
> unified client view (S4); projects with milestones, tasks, dependencies,
> comments and files (S5); time tracking with rates copied onto each entry (S6);
> quotes, tax rates and a service catalogue on an exact money engine (S7a);
> invoices with PDFs, email and a client link (S7b); payments, refunds, expenses
> and the overdue sweep (S7c); project profitability and revenue reporting (S8);
> a dashboard (S9); and release hardening — containers, exports, published
> OpenAPI, backup and restore, and a security pass (S10).
>
> Since then, the first of Phase 2: support tickets with service levels,
> maintenance plans and their visit history, infrastructure with renewal
> tracking, documents filed against a client, and recurring billing that raises
> a draft invoice each period (S11).
> The rest of Phase 2 is in [Roadmap.md](Roadmap.md).

## Quick start

Requires Docker. Nothing else.

```bash
git clone https://github.com/webloomlabs/workloom.git
cd workloom
cp .env.example .env

# Set the two secrets .env asks for
openssl rand -base64 32   # -> BETTER_AUTH_SECRET
openssl rand -base64 32   # -> WORKLOOM_ENCRYPTION_KEY

docker compose up -d
```

Then open <http://localhost:3000> and complete the setup screen — it creates
the administrator account and your organization, and closes behind you. Do it
as soon as the stack is up. The application migrates the database and verifies
tenant isolation before it reports healthy, so a stack that is up is a stack
that is safe to use.

One installation, one agency, no public sign-up: administrators add everyone
else under Settings → Members. Set `MULTI_TENANT=true` to run one installation
for several independent agencies instead.

| Service | URL |
| --- | --- |
| Application | http://localhost:3000 |
| Mail catcher (Mailpit) | http://localhost:8025 |

Full instructions, including what to change before anyone real uses it, are in
[docs/installation.md](docs/installation.md).

## Working on it instead

```bash
pnpm install
cp .env.example .env      # set the two secrets
pnpm services:up          # postgres, mail catcher, object storage
pnpm db:migrate
pnpm dev                  # http://localhost:3000
pnpm worker               # in a second terminal
```

## Commands

```bash
pnpm dev              # run the web app
pnpm worker           # run the worker (webhook delivery, maintenance)
pnpm typecheck        # the only type gate — packages ship source, not builds
pnpm lint
pnpm test             # everything
pnpm test:isolation   # tenant isolation only
pnpm test:e2e         # browser journeys against a running app
pnpm db:generate      # generate a migration from the schema
pnpm openapi:check    # the published API description still matches the code
pnpm services:down
./scripts/backup.sh   # database and files
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

Everything is in [docs/](docs/README.md).

- [Installation](docs/installation.md) · [Configuration](docs/configuration.md) · [Self-hosting](docs/self-hosting.md)
- [Backup and restore](docs/backup-and-restore.md) · [Troubleshooting](docs/troubleshooting.md) · [Security](docs/security.md)
- [API](docs/api.md) · [openapi.json](docs/openapi.json) · [Webhooks](docs/webhooks.md) · [Automation](docs/automation.md)
- [Architecture](docs/architecture.md) · [Database](docs/database.md) · [Permissions](docs/permissions.md) · [Development](docs/development.md)
- [Roadmap](Roadmap.md)

## Licence

To be finalised before v0.1.
