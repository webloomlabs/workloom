# Self-hosting

What [installation.md](installation.md) leaves out: running Workloom somewhere
it matters.

## The shape of it

```text
        internet
            │  TLS terminates here
      ┌─────▼─────┐
      │   proxy   │  nginx, Caddy, Traefik — yours
      └─────┬─────┘
            │ http://web:3000
   ┌────────▼────────┐        ┌──────────┐
   │       web       │        │  worker  │
   │ UI · REST · PDF │        │ events,  │
   │  migrations     │        │ webhooks,│
   └────────┬────────┘        │ sweeps   │
            │                 └────┬─────┘
            └──────┬───────────────┘
              ┌────▼─────┐
              │ postgres │
              └──────────┘
```

Both application containers are stateless. The state is PostgreSQL and the file
storage volume.

## Behind a reverse proxy

Forward to the `web` container on port 3000 and set `APP_URL` to the public
address. A minimal Caddy configuration:

```caddy
workloom.example.com {
  reverse_proxy localhost:3000
}
```

Workloom reads `X-Forwarded-For` for the audit trail only, never for
authorisation — the header is caller-supplied and trivially forged.

## The database

`docker-compose.yml` includes PostgreSQL 17 for convenience. To use your own,
delete the `postgres` service and point `DATABASE_URL` at it. Two requirements,
both non-negotiable:

- **The role must not be a superuser, and must not have `BYPASSRLS`.** The
  application refuses to start otherwise, because with either one there is no
  isolation between organizations at all.
- **The role must own its schema**, so migrations can create tables. See
  [`docker/init-db.sh`](../docker/init-db.sh) for exactly what to create.

Set `DATABASE_POOL_SIZE` to something your server can take: it is per process,
and there are two processes.

## Files

Attachments default to a disk volume (`STORAGE_DRIVER=local`). For S3 or any
compatible service, set `STORAGE_DRIVER=s3` with the `S3_*` variables; see
[configuration.md](configuration.md). The bucket should not be public — every
download goes through a short-lived signed link issued after a permission check.

## Scaling

v0.1 is built for one of each container, and says so honestly.

- **The web container** is stateless and can be run several times over. Migrations
  take an advisory lock, so simultaneous boots cannot apply the same migration
  twice.
- **The worker** should be run once. The dispatcher claims work with
  `FOR UPDATE SKIP LOCKED` and is safe to run twice, but nothing has been tested
  that way and webhook delivery would be the place it showed.
- **Queues and rate limiting run on PostgreSQL** by default. `REDIS_URL` moves
  them to Redis, which is worth it at a scale this release has not seen.

## Watching it

- `GET /api/health` — used by the container healthcheck. Cheap.
- Both containers log to stdout; `docker compose logs -f web worker`.
- Every API response carries `X-Request-Id`, and the same id is on the audit
  entry and in the error envelope. That is the thread to pull when someone
  reports something.

## Keeping it safe

Read [security.md](security.md). The short version: keep the two secrets out of
the repository, keep the database role unprivileged, put TLS in front, and leave
`WORKLOOM_ALLOW_PRIVATE_WEBHOOKS` off.
