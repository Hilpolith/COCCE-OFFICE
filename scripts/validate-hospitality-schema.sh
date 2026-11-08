#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
MIGRATION_DIR="$ROOT/supabase/migrations"
MIGRATIONS=(
  "$MIGRATION_DIR/20261108010000_office_hospitality_management.sql"
  "$MIGRATION_DIR/20261108010100_office_hospitality_read_security.sql"
  "$MIGRATION_DIR/20261108010110_office_hospitality_finance.sql"
  "$MIGRATION_DIR/20261108010120_office_hospitality_food_stock.sql"
  "$MIGRATION_DIR/20261108010130_office_hospitality_operations.sql"
  "$MIGRATION_DIR/20261108010140_office_hospitality_dispatch.sql"
  "$MIGRATION_DIR/20261108010150_office_hospitality_guardrails.sql"
  "$MIGRATION_DIR/20261108020000_office_hospitality_workflow_repair.sql"
  "$MIGRATION_DIR/20261108020100_office_hospitality_finance_repair.sql"
  "$MIGRATION_DIR/20261108020200_office_hospitality_report_repair.sql"
)
PG_BINDIR=${PG_BINDIR:-/usr/lib/postgresql/16/bin}
for bin in initdb pg_ctl createdb psql; do command -v "$PG_BINDIR/$bin" >/dev/null || { echo "missing PostgreSQL binary: $PG_BINDIR/$bin" >&2; exit 1; }; done
TMP=$(mktemp -d -t cocce-hospitality-test.XXXXXX); PORT=$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()'); DB=hospitality_validation
cleanup(){ "$PG_BINDIR/pg_ctl" -D "$TMP/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$TMP"; }; trap cleanup EXIT
"$PG_BINDIR/initdb" -D "$TMP/data" -A trust --no-locale >/dev/null
"$PG_BINDIR/pg_ctl" -D "$TMP/data" -l "$TMP/postgres.log" -o "-h 127.0.0.1 -p $PORT -k $TMP" -w start >/dev/null
"$PG_BINDIR/createdb" -h 127.0.0.1 -p "$PORT" "$DB"
sed '/^[[:space:]]*\\\\/d' "$ROOT/supabase/tests/university-bootstrap.sql" > "$TMP/bootstrap.sql"
"$PG_BINDIR/psql" -X -1 -h 127.0.0.1 -p "$PORT" -d "$DB" -v ON_ERROR_STOP=1 -f "$TMP/bootstrap.sql" >/dev/null
for migration in "${MIGRATIONS[@]}"; do
  "$PG_BINDIR/psql" -X -1 -h 127.0.0.1 -p "$PORT" -d "$DB" -v ON_ERROR_STOP=1 -f "$migration" >/dev/null
done
"$PG_BINDIR/psql" -X -1 -h 127.0.0.1 -p "$PORT" -d "$DB" -v ON_ERROR_STOP=1 <<'SQL'
DO $$ DECLARE n integer; bad boolean; BEGIN
 SELECT count(*),NOT bool_and(relrowsecurity) INTO n,bad FROM pg_class c JOIN pg_namespace ns ON ns.oid=c.relnamespace WHERE ns.nspname='public' AND c.relname LIKE 'office_hospitality_%' AND c.relkind='r';
 IF n < 25 OR bad THEN RAISE EXCEPTION 'hospitality RLS assertion failed'; END IF;
 IF has_table_privilege('authenticated','public.office_hospitality_properties','select') THEN RAISE EXCEPTION 'direct table ACL failed'; END IF;
 IF NOT has_function_privilege('authenticated','public.office_hospitality_read(uuid,text,jsonb,integer,integer)','execute') OR NOT has_function_privilege('authenticated','public.office_hospitality_command(uuid,text,jsonb)','execute') THEN RAISE EXCEPTION 'public RPC grant missing'; END IF;
 IF has_function_privilege('anon','public.office_hospitality_read(uuid,text,jsonb,integer,integer)','execute') OR has_function_privilege('anon','public.office_hospitality_command(uuid,text,jsonb)','execute') THEN RAISE EXCEPTION 'anonymous RPC grant must be absent'; END IF;
 IF EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='office_private' AND p.proname LIKE 'hospitality_%' AND (has_function_privilege('authenticated',p.oid,'execute') OR has_function_privilege('anon',p.oid,'execute'))) THEN RAISE EXCEPTION 'private helper ACL failed'; END IF;
 RAISE NOTICE 'Hospitality native schema checks passed';
END $$;
SQL
node --test "$ROOT/scripts/office-hospitality-postgres-check.mjs"
node --test "$ROOT/scripts/office-hospitality-read-check.mjs" \
  "$ROOT/scripts/office-hospitality-finance-check.mjs" \
  "$ROOT/scripts/office-hospitality-food-stock-check.mjs" \
  "$ROOT/scripts/office-hospitality-operations-check.mjs"
node "$ROOT/scripts/office-hospitality-finance-repair-check.mjs"
node --test "$ROOT/scripts/office-hospitality-report-repair-check.mjs"
echo "Hospitality schema validation passed."
