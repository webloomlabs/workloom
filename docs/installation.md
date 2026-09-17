# Installation

Workloom runs as two containers — the application and a background worker —
against PostgreSQL. Everything else is optional.

## What you need

- Docker with Compose v2 (`docker compose version` should print 2.x or later)
- A machine with 2 GB of memory to spare
- Nothing else. No Node, no pnpm, no PostgreSQL client.

## Install

```bash
git clone https://github.com/webloomlabs/workloom.git
cd workloom
cp .env.example .env
```

Open `.env` and set the two secrets it asks for:

```bash
openssl rand -base64 32   # paste as BETTER_AUTH_SECRET
openssl rand -base64 32   # paste as WORKLOOM_ENCRYPTION_KEY
```

**Keep `WORKLOOM_ENCRYPTION_KEY` somewhere safe and separate.** It encrypts
webhook signing secrets at rest. Lose it and those secrets are unrecoverable —
no backup of the database will bring them back.

Then:

```bash
docker compose up -d
```

The first run builds both images, which takes a few minutes. After that:

```bash
curl localhost:3000/api/health
```

Open <http://localhost:3000>. You land on a setup screen: name your
organization, then create the administrator account that will own it.

**Do this straight away.** Setup is the one screen that creates an account
without one already existing, so until it is completed it is open to whoever
reaches the URL. It closes for good the moment the first account exists.

If you are running one installation for several independent agencies instead,
set `MULTI_TENANT=true` before the first boot. There is no setup screen in that
shape: everyone signs up and creates their own organization. See
[Authentication](authentication.md#how-accounts-come-to-exist).

## What just happened

- `postgres` started and created an **unprivileged** `workloom_app` role. The
  application must never connect as a superuser: superusers bypass row-level
  security, which is the entire mechanism separating one organization's data
  from another's.
- `web` applied every pending migration under an advisory lock, then verified
  tenant isolation against the live database, and only then reported healthy.
  A container that is up is a container whose database is safe to write to.
- `worker` ran the same isolation check, then began dispatching events, retrying
  webhooks, and sweeping quotes and overdue invoices.
- `mailpit` caught the outbound mail so nothing escapes a trial installation.
  Its inbox is at <http://localhost:8025>.

## Before anyone real uses it

1. **Send mail somewhere real.** Point `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`
   and `SMTP_PASSWORD` at your relay, set `MAIL_FROM`, and remove the `mailpit`
   service. Invitations, invoices, and password resets all go through it.
2. **Set `APP_URL` to the address people will use.** Every link in outbound
   mail — including the one a client opens to see their invoice — is built from
   it, and the API's cross-origin check compares against it.
3. **Put TLS in front of it.** Workloom speaks plain HTTP on :3000 and expects a
   reverse proxy to terminate TLS. Once `APP_URL` is `https://`, the application
   starts sending HSTS.
4. **Arrange backups.** See [backup-and-restore.md](backup-and-restore.md). Do
   it before you have data worth losing.

See [self-hosting.md](self-hosting.md) for running it properly, and
[configuration.md](configuration.md) for every setting.

## Upgrading

```bash
git pull
docker compose up -d --build
```

Migrations apply on boot. Take a backup first — see
[backup-and-restore.md](backup-and-restore.md) — and read the release notes for
anything that says otherwise.

## Developing instead of deploying

To run the application from source with the backing services in containers, see
[development.md](development.md).
