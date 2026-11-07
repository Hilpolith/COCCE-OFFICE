#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
MIGRATION_SQL=${HEALTH_ADMIN_MIGRATION_SQL:-"$ROOT/supabase/migrations/20261107200000_office_health_admin_management.sql"}
PG_BINDIR=${PG_BINDIR:-/usr/lib/postgresql/16/bin}
for bin in initdb pg_ctl createdb psql; do command -v "$PG_BINDIR/$bin" >/dev/null || { echo "missing PostgreSQL binary: $PG_BINDIR/$bin" >&2; exit 1; }; done
TMP=$(mktemp -d -t cocce-health-admin.XXXXXX); PORT=$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()'); DB=health_admin_validation
cleanup(){ "$PG_BINDIR/pg_ctl" -D "$TMP/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$TMP"; }; trap cleanup EXIT
"$PG_BINDIR/initdb" -D "$TMP/data" -A trust --no-locale >/dev/null
"$PG_BINDIR/pg_ctl" -D "$TMP/data" -l "$TMP/postgres.log" -o "-h 127.0.0.1 -p $PORT -k $TMP" -w start >/dev/null
"$PG_BINDIR/createdb" -h 127.0.0.1 -p "$PORT" "$DB"
sed '/^[[:space:]]*\\\\.*$/d' "$ROOT/supabase/tests/university-bootstrap.sql" > "$TMP/bootstrap.sql"
"$PG_BINDIR/psql" -X -1 -h 127.0.0.1 -p "$PORT" -d "$DB" -v ON_ERROR_STOP=1 -f "$TMP/bootstrap.sql" >/dev/null
"$PG_BINDIR/psql" -X -1 -h 127.0.0.1 -p "$PORT" -d "$DB" -v ON_ERROR_STOP=1 -f "$MIGRATION_SQL" >/dev/null
"$PG_BINDIR/psql" -X -1 -h 127.0.0.1 -p "$PORT" -d "$DB" -v ON_ERROR_STOP=1 <<'SQL'
DO $$ DECLARE n integer; bad boolean; BEGIN SELECT count(*),coalesce(bool_or(NOT relrowsecurity),false) INTO n,bad FROM pg_class c JOIN pg_namespace nsp ON nsp.oid=c.relnamespace WHERE nsp.nspname='public' AND c.relname LIKE 'office_health_admin_%' AND c.relkind='r'; IF n<40 OR bad THEN RAISE EXCEPTION 'health admin RLS/table assertion failed: %, %',n,bad; END IF; END $$;
DO $$ BEGIN
 IF has_table_privilege('authenticated','public.office_health_admin_facilities','select') THEN RAISE EXCEPTION 'direct table ACL assertion failed'; END IF;
 IF EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='office_private' AND p.proname LIKE 'health_%' AND (has_function_privilege('authenticated',p.oid,'execute') OR has_function_privilege('anon',p.oid,'execute'))) THEN RAISE EXCEPTION 'private helper ACL assertion failed'; END IF;
 IF has_function_privilege('authenticated','public.office_health_admin_command_generic(uuid,text,jsonb)','execute') OR has_function_privilege('anon','public.office_health_admin_command_generic(uuid,text,jsonb)','execute') THEN RAISE EXCEPTION 'renamed legacy dispatcher must not be client-executable'; END IF;
END $$;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_proc WHERE proname='office_health_admin_command' AND prosrc LIKE '%clinical_data_enabled=true%') THEN RAISE EXCEPTION 'public command must not enable clinical storage'; END IF; END $$;
SQL
printf 'Native PostgreSQL migration smoke passed. Running PGlite synthetic suite.\n'
HEALTH_ADMIN_MIGRATION_SQL="$MIGRATION_SQL" node --test "$ROOT/scripts/office-health-admin-postgres-check.mjs"
printf 'Health administration schema validation passed.\n'
