#!/usr/bin/env bash
#
# Backs up a Workloom installation: the database, and the uploaded files.
#
#   ./scripts/backup.sh [directory]
#
# Produces one timestamped directory holding a compressed database dump and a
# tar of the file storage. Both are needed: the database holds the row that
# names a file, the storage holds the bytes, and either alone is useless.
#
# It does NOT back up your .env. Keep WORKLOOM_ENCRYPTION_KEY somewhere else and
# somewhere safe -- without it, every webhook signing secret in the dump is
# unreadable, and no amount of database is going to bring them back.
set -euo pipefail

cd "$(dirname "$0")/.."

DEST="${1:-backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$DEST/$STAMP"
mkdir -p "$OUT"

# Run inside the container when the composed installation is up, so no
# PostgreSQL client tools are needed on the host; otherwise use the host's.
compose_pg() { docker compose ps -q postgres 2>/dev/null | grep -q . ; }

DB_NAME="${WORKLOOM_DB_NAME:-workloom}"
DB_USER="${WORKLOOM_DB_USER:-workloom_app}"
# The compose project is named `workloom`, so its volumes are prefixed with it.
STORAGE_VOLUME="${WORKLOOM_STORAGE_VOLUME:-workloom_storage-data}"

if compose_pg; then
  echo "backup: dumping database $DB_NAME from the compose stack"
  # As the superuser over the container's local socket, so no password is
  # needed; --no-owner keeps the dump portable between installations.
  # --format=custom lets pg_restore be selective and parallel on the way back.
  docker compose exec -T postgres pg_dump --format=custom --no-owner --no-privileges \
    --username=postgres "$DB_NAME" > "$OUT/database.dump"

  echo "backup: archiving uploaded files"
  docker run --rm -v "${STORAGE_VOLUME}":/data:ro -v "$(cd "$OUT" && pwd)":/backup \
    alpine tar czf /backup/storage.tar.gz -C /data .
else
  : "${DATABASE_URL:?set DATABASE_URL, or start the compose stack}"
  echo "backup: dumping database with the host's pg_dump"
  pg_dump --format=custom --no-owner --no-privileges "$DATABASE_URL" > "$OUT/database.dump"

  STORAGE="${STORAGE_LOCAL_PATH:-./storage-data}"
  echo "backup: archiving $STORAGE"
  tar czf "$OUT/storage.tar.gz" -C "$STORAGE" .
fi

# What produced this, so a restore two years from now knows what it is holding.
cat > "$OUT/MANIFEST" <<META
workloom backup
taken:     $STAMP
database:  $DB_NAME
git:       $(git rev-parse --short HEAD 2>/dev/null || echo unknown)
migrations: $(ls packages/db/src/migrations/*.sql | wc -l | tr -d ' ') applied at the time of writing
META

echo "backup: written to $OUT"
ls -lh "$OUT"
