# Configuration

All configuration comes from environment variables, parsed once at startup
against a schema in `packages/config`. A misconfigured install fails
immediately, listing every problem at once rather than one per restart.

A single `.env` at the repository root serves the web app, the worker, and the
CLI — they are three entrypoints into one installation. Real environment
variables always take precedence over the file, so a container passing
`DATABASE_URL` is never overridden by a stale checked-out `.env`.

See [.env.example](../.env.example) for the annotated list.

## Required

| Variable | Notes |
| --- | --- |
| `APP_URL` | Public origin. Used for links in outbound email, and for the link on an invoice that its client opens. It must be reachable by clients, not only by staff. |
| `DATABASE_URL` | Must **not** be a superuser — see [Architecture](architecture.md). |
| `BETTER_AUTH_SECRET` | `openssl rand -base64 32` |
| `WORKLOOM_ENCRYPTION_KEY` | 32 bytes, base64. Encrypts webhook signing secrets and integration credentials at rest. **Back it up** — losing it makes those secrets unrecoverable. |
| `SMTP_HOST`, `MAIL_FROM` | Invitations, email confirmation, password resets and invoice delivery depend on mail. `SMTP_HOST` is required while `MAIL_DRIVER` is `smtp`. An invoice email carries its PDF as an attachment, so the server must accept messages of a few hundred kilobytes. |

## Optional

| Variable | Default | Notes |
| --- | --- | --- |
| `MULTI_TENANT` | `false` | `false`: one agency, one organization, no public sign-up. The first visit goes to a setup screen that creates the administrator and the organization; every account after that is created by an administrator under Settings → Members. `true`: anyone may sign up and create their own organization, which is what a hosted installation serving several agencies needs. Organizations are isolated by row-level security either way — see [Authentication](authentication.md#how-accounts-come-to-exist). |
| `REDIS_URL` | unset | Queues and rate limiting run on Postgres by default. Redis is an opt-in upgrade for larger installations, not a requirement. |
| `STORAGE_DRIVER` | `local` | `local` or `s3`. S3 requires `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`. Attachments are up to 20 MB each; a reverse proxy in front must accept request bodies of at least 21 MB. |
| `DATABASE_POOL_SIZE` | `10` | Per process. |
| `MAIL_DRIVER` | `smtp` | `smtp` delivers mail. `memory` keeps messages in the process for tests to inspect, and is rejected in production — invitations would silently never arrive. |
| `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_SECURE` | `587`, unset, unset, `false` | Standard SMTP settings. |
| `WORKLOOM_PREVIOUS_ENCRYPTION_KEYS` | unset | Comma-separated keys that used to be `WORKLOOM_ENCRYPTION_KEY`. Secrets encrypted under them stay readable after rotation. Remove an old key only once nothing references it. |
| `WORKLOOM_ALLOW_PRIVATE_WEBHOOKS` | `false` | Webhook URLs resolving to loopback, private, or link-local addresses are rejected, and `https://` is required. Workloom usually runs inside a private network, where such a URL is an SSRF vector against internal services. Set to `true` only for local development, on both the app and the worker. |
| `DANGEROUSLY_ALLOW_SUPERUSER_DB` | `false` | Lets the app boot despite failing isolation checks. Rejected outright in production. For tooling only. |

## Documents

Quotes and invoices are rendered to PDF in the application itself, with no
headless browser and no external service. The font is embedded (Noto Sans, SIL
Open Font License, in `packages/pdf/fonts`), so every reader sees the same page:
Latin, Greek, Cyrillic, and Vietnamese. Other scripts -- CJK, Arabic,
Devanagari -- would need their own font added there; without one, those
characters render as blank boxes.

What appears at the top of a document, and how a client is told to pay, comes
from **Settings → Organization**: legal name, address, tax number, payment
instructions, and the default payment terms in days.

## What the worker does on a schedule

Some things change with the passing of time rather than because someone did
something, and they happen in the worker:

- **Quotes expire** the day after their validity date.
- **Invoices go overdue** the day after their due date, unless they have been
  paid or cancelled.

Both are decided per organization, in **that organization's time zone** — set in
Settings → Organization — because a due date is a date, not an instant, and
getting it wrong makes invoice ageing off by a day.

An installation whose worker is not running will leave invoices reading as sent
past their due date. The invoices list and the invoice page still mark them late
from the due date alone, so nothing is hidden; only the stored status, the
`invoice.overdue` event, and anything subscribed to it wait for the worker.
