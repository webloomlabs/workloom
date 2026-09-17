#!/usr/bin/env bash
#
# Restores a Workloom backup over an EMPTY database.
#
#   ./scripts/restore.sh backups/20260917T000000Z
#
# Restoring is destructive by nature, so this refuses a database that already
# has tables rather than merging into one. Drop and recreate first:
#
#   docker compose down -v && docker compose up -d postgres
set -euo pipefail

cd "$(dirname "$0")/.."

SRC="${1:?usage: ./scripts/restore.sh <backup-directory>}"
[ -f "$SRC/database.dump" ] || { echo "restore: no database.dump in $SRC" >&2; exit 1; }

DB_NAME="${WORKLOOM_DB_NAME:-workloom}"
DB_USER="${WORKLOOM_DB_USER:-workloom_app}"

compose_pg() { docker compose ps -q postgres 2>/dev/null | grep -q . ; }

if compose_pg; then
  EXISTING="$(docker compose exec -T postgres psql -tAq --username=postgres "$DB_NAME" \
    -c "select count(*) from information_schema.tables where table_schema='public'" | tr -d '[:space:]')"
  if [ "$EXISTING" -gt 0 ]; then
    echo "restore: $DB_NAME already has $EXISTING tables. Recreate it empty first:" >&2
    echo "  docker compose down -v && docker compose up -d postgres" >&2
    exit 1
  fi

  echo "restore: loading database.dump"
  # Connected as the superuser, but every object created as the application
  # role: the app connects as that role, and tables it does not own are tables
  # it cannot read.
  docker compose exec -T postgres pg_restore --no-owner --no-privileges \
    --username=postgres --role="$DB_USER" --dbname="$DB_NAME" < "$SRC/database.dump"

  if [ -f "$SRC/storage.tar.gz" ]; then
    echo "restore: unpacking uploaded files"
    docker run --rm -v "${WORKLOOM_STORAGE_VOLUME:-workloom_storage-data}":/data \
      -v "$(cd "$SRC" && pwd)":/backup:ro alpine sh -c 'tar xzf /backup/storage.tar.gz -C /data'
  fi
else
  : "${DATABASE_URL:?set DATABASE_URL, or start the compose stack}"
  echo "restore: loading database.dump with the host's pg_restore"
  pg_restore --no-owner --no-privileges --dbname="$DATABASE_URL" < "$SRC/database.dump"

  if [ -f "$SRC/storage.tar.gz" ]; then
    STORAGE="${STORAGE_LOCAL_PATH:-./storage-data}"
    mkdir -p "$STORAGE"
    tar xzf "$SRC/storage.tar.gz" -C "$STORAGE"
  fi
fi

echo "restore: done. Start the application; it will apply any newer migrations on boot."
