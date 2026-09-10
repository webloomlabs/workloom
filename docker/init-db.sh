#!/bin/bash
# Runs once, on first initialisation of the Postgres data directory.
#
# Creates the unprivileged role the application connects as. This is not
# cosmetic: PostgreSQL superusers bypass row-level security unconditionally,
# so an app connecting as a superuser has NO tenant isolation regardless of
# how carefully the policies are written. The app must never be a superuser.
#
# The app role owns its tables, which is fine because every policy is created
# with FORCE ROW LEVEL SECURITY -- that subjects the table owner to the policy
# too. This lets a self-hosted install run with a single application role
# rather than a separate migrator/runtime split.
set -euo pipefail

: "${WORKLOOM_DB_USER:=workloom_app}"
: "${WORKLOOM_DB_PASSWORD:?WORKLOOM_DB_PASSWORD must be set}"
: "${WORKLOOM_DB_NAME:=workloom}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<-SQL
	CREATE ROLE "${WORKLOOM_DB_USER}" WITH LOGIN NOSUPERUSER NOCREATEROLE NOBYPASSRLS
	  PASSWORD '${WORKLOOM_DB_PASSWORD}';

	CREATE DATABASE "${WORKLOOM_DB_NAME}" OWNER "${WORKLOOM_DB_USER}";
SQL

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$WORKLOOM_DB_NAME" <<-SQL
	-- The app role owns the schema so migrations can create tables without
	-- needing elevated privileges at runtime.
	ALTER SCHEMA public OWNER TO "${WORKLOOM_DB_USER}";
	REVOKE ALL ON SCHEMA public FROM PUBLIC;
	GRANT ALL ON SCHEMA public TO "${WORKLOOM_DB_USER}";
SQL

echo "init-db: created non-superuser role ${WORKLOOM_DB_USER} owning ${WORKLOOM_DB_NAME}"
