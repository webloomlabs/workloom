# Backup and restore

Two things need backing up, and one thing needs keeping somewhere else entirely.

| What | Where it lives | Why it matters |
| --- | --- | --- |
| The database | PostgreSQL | Everything. |
| Uploaded files | the `storage-data` volume, or S3 | The database holds the row naming a file; this holds the bytes. Either alone is useless. |
| `WORKLOOM_ENCRYPTION_KEY` | your `.env`, and somewhere safe | Webhook signing secrets are encrypted with it. Without it, no backup will bring them back. |

## Taking a backup

```bash
./scripts/backup.sh            # writes to ./backups/<timestamp>/
./scripts/backup.sh /mnt/nas   # or wherever you keep them
```

It writes three files: `database.dump` (PostgreSQL custom format),
`storage.tar.gz`, and a `MANIFEST` recording when it ran, against which database,
and at which commit.

The script runs `pg_dump` inside the PostgreSQL container when the composed
stack is up, so you need no client tools on the host. If you run your own
database, set `DATABASE_URL` and it uses the host's `pg_dump` instead.

Run it from cron, nightly:

```cron
15 2 * * *  cd /srv/workloom && ./scripts/backup.sh /mnt/backups >> /var/log/workloom-backup.log 2>&1
```

Keep the backups somewhere the server cannot reach, and delete old ones on a
schedule you have decided on rather than when the disk fills.

## Restoring

Restoring is destructive, so the script refuses a database that already has
tables rather than merging into one. Start from empty:

```bash
docker compose down -v          # removes the database and the file volume
docker compose up -d postgres   # recreates them, empty
./scripts/restore.sh backups/20260917T012603Z
docker compose up -d            # the app boots and applies any newer migrations
```

## This has been done, not just written

The procedure above was executed against a populated installation while writing
this page. The transcript:

```text
$ docker compose exec -T postgres psql -tAq --username=postgres workloom \
    -c "select ... from organization, companies, invoices, attachments"
13 orgs, 17 companies, 8 invoices, 2 attachments

$ ./scripts/backup.sh backups
backup: dumping database workloom from the compose stack
backup: archiving uploaded files
backup: written to backups/20260917T012603Z
-rw-r--r--  129B  MANIFEST
-rw-r--r--  254K  database.dump
-rw-r--r--  291B  storage.tar.gz

$ docker compose down -v          # everything destroyed
$ docker compose up -d postgres
$ ./scripts/restore.sh backups/20260917T012603Z
restore: loading database.dump
restore: unpacking uploaded files
restore: done.

$ docker compose exec -T postgres psql ... (the same query)
13 orgs, 17 companies, 8 invoices, 2 attachments

$ docker compose exec -T postgres psql -tAq --username=postgres workloom \
    -c "select distinct tableowner from pg_tables where schemaname='public'"
workloom_app

$ docker compose exec -T postgres psql -tAq --username=postgres workloom \
    -c "select count(*) ... where relrowsecurity and relforcerowsecurity"
30

$ docker compose up -d && docker compose logs web | grep boot:
boot: migrations up to date
boot: tenant isolation verified
```

Three things were checked, not just the row counts:

1. **Every row came back**, across four tables.
2. **The tables are owned by `workloom_app`.** A restore that leaves them owned
   by the superuser produces an application that can read nothing at all, and
   the restore script passes `--role` precisely to avoid it.
3. **Row-level security is still forced** on all 30 tables. An isolation
   mechanism that a restore quietly drops is worse than none, because nothing
   would look wrong.

The CI `clean-install` job runs the same round trip on every push, so this page
cannot quietly stop being true.

## What a backup will not save you from

- **A lost `WORKLOOM_ENCRYPTION_KEY`.** Webhook secrets become unreadable.
  Everything else restores. Endpoints then need their secrets rotated.
- **Restoring into a newer release.** That works — the app migrates on boot.
  Restoring into an *older* release does not, and will fail loudly.
- **A backup nobody has restored.** Practise this on a spare machine once.
