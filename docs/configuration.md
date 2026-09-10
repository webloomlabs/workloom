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
| `APP_URL` | Public origin. Used for links in outbound email. |
| `DATABASE_URL` | Must **not** be a superuser — see [Architecture](architecture.md). |
| `BETTER_AUTH_SECRET` | `openssl rand -base64 32` |
| `WORKLOOM_ENCRYPTION_KEY` | 32 bytes, base64. Encrypts webhook signing secrets and integration credentials at rest. **Back it up** — losing it makes those secrets unrecoverable. |
| `SMTP_HOST`, `MAIL_FROM` | Invitations and invoice delivery depend on mail. |

## Optional

| Variable | Default | Notes |
| --- | --- | --- |
| `REDIS_URL` | unset | Queues and rate limiting run on Postgres by default. Redis is an opt-in upgrade for larger installations, not a requirement. |
| `STORAGE_DRIVER` | `local` | `local` or `s3`. S3 requires `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`. |
| `DATABASE_POOL_SIZE` | `10` | Per process. |
| `WORKLOOM_ALLOW_PRIVATE_WEBHOOKS` | `false` | Webhook URLs resolving to loopback, private, or link-local addresses are rejected. Workloom usually runs inside a private network, where such a URL is an SSRF vector against internal services. |
| `DANGEROUSLY_ALLOW_SUPERUSER_DB` | `false` | Lets the app boot despite failing isolation checks. Rejected outright in production. For tooling only. |
