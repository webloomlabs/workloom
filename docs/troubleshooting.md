# Troubleshooting

## The application refuses to start

Workloom fails loudly at boot rather than running in a state it cannot vouch
for. Read the first error; it names the problem.

### `Invalid environment configuration`

A variable is missing or malformed, and every problem is listed at once. The
two most common:

- `WORKLOOM_ENCRYPTION_KEY must be 32 bytes, base64-encoded` — generate it with
  `openssl rand -base64 32`, not by typing 32 characters.
- `BETTER_AUTH_SECRET` shorter than 32 characters.

### `the application is connected as a database superuser`

The application will not run as one. A superuser bypasses row-level security
unconditionally, so every organization could read every other organization's
data and nothing would look wrong. Connect as an unprivileged role — see
[`docker/init-db.sh`](../docker/init-db.sh) — and check the role with:

```sql
select rolsuper, rolbypassrls from pg_roles where rolname = current_user;
```

Both must be false.

### `has an organization_id column but no row-level security`

A migration created a tenant table without a policy. This should only ever
happen mid-development; the CI job that catches it is `tenant-isolation`.

### `Can't find meta/_journal.json file`

The migration files are not where the application is looking. In a container,
`WORKLOOM_MIGRATIONS_DIR` must point at them; the shipped image sets it.

## Mail never arrives

1. Check the worker is running: `docker compose ps`.
2. In a default installation mail goes to Mailpit, not to the internet — open
   <http://localhost:8025>.
3. Otherwise check `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE` and the credentials,
   and read `docker compose logs web worker` for the send failure.

Invoices are emailed **after** the change commits, so a failed send leaves the
invoice issued. Send it again from the invoice; it does not take a new number.

## Webhooks are not delivered

- **`refused: … is a private or reserved address`.** Intentional. Workloom
  refuses to deliver to loopback, private, and link-local addresses because it
  usually runs inside a private network, where such a URL is a way to make the
  server attack internal services. For local testing only:
  `WORKLOOM_ALLOW_PRIVATE_WEBHOOKS=true docker compose up -d`, which must be set
  on the app **and** the worker.
- **Nothing is attempted at all.** The worker delivers, not the web container.
  Check it is running, and that only **one** worker is running — a second one
  started by hand, with different configuration, will claim deliveries and
  refuse them.
- **Deliveries fail and the endpoint disables itself.** After five consecutive
  exhausted retries an endpoint is disabled and shows why. Fix the receiver,
  re-enable it, and retry the failed deliveries from its log.

## An invoice will not change

That is the design: an issued invoice is a record of a demand for payment. The
service refuses, and so does a database trigger — even for a superuser. Cancel
it and raise another. Likewise, time and expenses that an invoice has billed are
frozen until that invoice line is removed.

## An invoice says "sent" when it is overdue

The stored status is set by the worker's nightly sweep. The list and the invoice
page still mark it late from the due date alone, so nothing is hidden — but if
the status never changes, the worker is not running.

## A page shows a dash where a number should be

A dash is "there is no answer", not "zero". A margin percentage before anything
has been billed is a share of nothing; an effective hourly rate before any time
is tracked is a division by zero. The dash is deliberate.

## Everything is slow

- Check `DATABASE_POOL_SIZE` against what your PostgreSQL will accept. It is per
  process and there are two.
- `X-RateLimit-Remaining` on any API response shows whether you are being
  throttled rather than being slow.

## Getting a useful report

Every API response carries `X-Request-Id`, and the same id appears on the audit
entry and in the error envelope. Quote it. `docker compose logs web worker` for
the rest.
