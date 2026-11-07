#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
MIGRATION_SQL=${NGO_MIGRATION_SQL:-"$ROOT/supabase/migrations/20261108000000_office_ngo_management.sql"}
PG_BINDIR=${PG_BINDIR:-/usr/lib/postgresql/16/bin}
for bin in initdb pg_ctl createdb psql; do command -v "$PG_BINDIR/$bin" >/dev/null || { echo "missing PostgreSQL binary: $PG_BINDIR/$bin" >&2; exit 1; }; done
TMP=$(mktemp -d -t cocce-ngo-test.XXXXXX); PORT=$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()'); DB=ngo_validation
cleanup(){ "$PG_BINDIR/pg_ctl" -D "$TMP/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$TMP"; }; trap cleanup EXIT
"$PG_BINDIR/initdb" -D "$TMP/data" -A trust --no-locale >/dev/null
"$PG_BINDIR/pg_ctl" -D "$TMP/data" -l "$TMP/postgres.log" -o "-h 127.0.0.1 -p $PORT -k $TMP" -w start >/dev/null
"$PG_BINDIR/createdb" -h 127.0.0.1 -p "$PORT" "$DB"
sed '/^[[:space:]]*\\/d' "$ROOT/supabase/tests/university-bootstrap.sql" > "$TMP/bootstrap.sql"
"$PG_BINDIR/psql" -X -1 -h 127.0.0.1 -p "$PORT" -d "$DB" -v ON_ERROR_STOP=1 -f "$TMP/bootstrap.sql" >/dev/null
"$PG_BINDIR/psql" -X -1 -h 127.0.0.1 -p "$PORT" -d "$DB" -v ON_ERROR_STOP=1 -f "$MIGRATION_SQL" >/dev/null
"$PG_BINDIR/psql" -X -1 -h 127.0.0.1 -p "$PORT" -d "$DB" -v ON_ERROR_STOP=1 <<'SQL'
DO $$ DECLARE n int; bad bool; BEGIN SELECT count(*),NOT bool_and(relrowsecurity) INTO n,bad FROM pg_class c JOIN pg_namespace ns ON ns.oid=c.relnamespace WHERE ns.nspname='public' AND c.relname LIKE 'office_ngo_%' AND c.relkind='r'; IF n < 25 OR bad THEN RAISE EXCEPTION 'NGO RLS assertion failed'; END IF; IF has_table_privilege('authenticated','public.office_ngo_donors','select') THEN RAISE EXCEPTION 'direct table ACL failed'; END IF; RAISE NOTICE 'NGO native schema checks passed'; END $$;
DO $$ BEGIN
 IF NOT has_function_privilege('authenticated','public.office_ngo_read(uuid,text,jsonb,integer,integer)','execute') OR NOT has_function_privilege('authenticated','public.office_ngo_command(uuid,text,jsonb)','execute') THEN RAISE EXCEPTION 'public NGO RPC grant missing'; END IF;
 IF has_function_privilege('anon','public.office_ngo_read(uuid,text,jsonb,integer,integer)','execute') OR has_function_privilege('anon','public.office_ngo_command(uuid,text,jsonb)','execute') THEN RAISE EXCEPTION 'anonymous NGO RPC grant must be absent'; END IF;
 IF EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='office_private' AND p.proname LIKE 'ngo_%' AND (has_function_privilege('authenticated',p.oid,'execute') OR has_function_privilege('anon',p.oid,'execute'))) THEN RAISE EXCEPTION 'private NGO helper ACL failed'; END IF;
END $$;
SQL
node --test "$ROOT/scripts/office-ngo-postgres-check.mjs"
echo "NGO schema validation passed."
