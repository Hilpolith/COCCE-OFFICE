#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
MIGRATION_SQL=${ACCOUNTING_MIGRATION_SQL:-"$ROOT/supabase/migrations/20261107160000_office_accounting_management.sql"}
PG_BINDIR=${PG_BINDIR:-$(pg_config --bindir)}
TMP=$(mktemp -d -t cocce-accounting-test.XXXXXX)
PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')
DB=accounting_validation
cleanup(){ "$PG_BINDIR/pg_ctl" -D "$TMP/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT
"$PG_BINDIR/initdb" -D "$TMP/data" -A trust --no-locale >/dev/null
"$PG_BINDIR/pg_ctl" -D "$TMP/data" -l "$TMP/postgres.log" -o "-h 127.0.0.1 -p $PORT -k $TMP" -w start >/dev/null
"$PG_BINDIR/createdb" -h 127.0.0.1 -p "$PORT" "$DB"
printf 'Validating Accounting migration in a disposable PostgreSQL cluster.\n'
"$PG_BINDIR/psql" -X -1 -h 127.0.0.1 -p "$PORT" -d "$DB" -v ON_ERROR_STOP=1 -f "$ROOT/supabase/tests/university-bootstrap.sql" >/dev/null
"$PG_BINDIR/psql" -X -1 -h 127.0.0.1 -p "$PORT" -d "$DB" -v ON_ERROR_STOP=1 -f "$MIGRATION_SQL" >/dev/null
"$PG_BINDIR/psql" -X -1 -h 127.0.0.1 -p "$PORT" -d "$DB" -v ON_ERROR_STOP=1 -f "$ROOT/supabase/migrations/20261107175000_office_accounting_rls.sql" >/dev/null
printf 'Migration applied cleanly. Running isolated PGlite domain harness...\n'
node --test "$ROOT/scripts/office-accounting-management-postgres-check.mjs"
printf 'Accounting schema validation passed.\n'
