#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
PG_BINDIR=${PG_BINDIR:-/usr/lib/postgresql/16/bin}
ORIGINAL=${HEALTH_ADMIN_MIGRATION_SQL:-"$ROOT/supabase/migrations/20261107200000_office_health_admin_management.sql"}
EXTENSION=${HEALTH_RESIDENCY_MIGRATION_SQL:-"$ROOT/supabase/migrations/20261107230615_office_health_residency_approval.sql"}
for bin in initdb pg_ctl createdb psql; do command -v "$PG_BINDIR/$bin" >/dev/null || { echo "missing PostgreSQL binary: $PG_BINDIR/$bin" >&2; exit 1; }; done
TMP=$(mktemp -d -t cocce-health-residency.XXXXXX)
PORT=$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')
DB=health_residency_validation
cleanup(){ "$PG_BINDIR/pg_ctl" -D "$TMP/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT
"$PG_BINDIR/initdb" -D "$TMP/data" -A trust --no-locale >/dev/null
"$PG_BINDIR/pg_ctl" -D "$TMP/data" -l "$TMP/postgres.log" -o "-h 127.0.0.1 -p $PORT -k $TMP" -w start >/dev/null
"$PG_BINDIR/createdb" -h 127.0.0.1 -p "$PORT" "$DB"
sed '/^[[:space:]]*\\.*$/d' "$ROOT/supabase/tests/university-bootstrap.sql" > "$TMP/bootstrap.sql"
PSQL=("$PG_BINDIR/psql" -X -1 -h 127.0.0.1 -p "$PORT" -d "$DB" -v ON_ERROR_STOP=1)
"${PSQL[@]}" -f "$TMP/bootstrap.sql" >/dev/null
"${PSQL[@]}" <<'SQL' >/dev/null
INSERT INTO public.office_workspaces(id) VALUES ('10000000-0000-4000-8000-000000000001');
INSERT INTO public.office_industry_spaces(workspace_id,industry_id) VALUES ('10000000-0000-4000-8000-000000000001','healthcare-admin');
SQL
"${PSQL[@]}" -f "$ORIGINAL" >/dev/null
"${PSQL[@]}" -f "$EXTENSION" >/dev/null
"${PSQL[@]}" <<'SQL'
DO $$ BEGIN
  IF (SELECT count(*) FROM public.office_health_admin_settings) < 1 THEN RAISE EXCEPTION 'settings seed missing'; END IF;
  IF (SELECT count(*) FROM public.office_health_admin_settings WHERE clinical_data_region='ap-southeast-1' AND clinical_data_enabled=false AND residency_approval_status='unrecorded') < 1 THEN RAISE EXCEPTION 'closed Singapore defaults missing'; END IF;
  IF has_table_privilege('authenticated','public.office_health_admin_settings','select') THEN RAISE EXCEPTION 'direct settings ACL exposed'; END IF;
  IF has_function_privilege('anon','public.office_health_admin_residency_command(uuid,text,jsonb)','execute') THEN RAISE EXCEPTION 'anon RPC ACL exposed'; END IF;
  IF NOT has_function_privilege('authenticated','public.office_health_admin_residency_command(uuid,text,jsonb)','execute') THEN RAISE EXCEPTION 'authenticated RPC grant missing'; END IF;
END $$;
SQL
printf 'Native PostgreSQL residency migration smoke passed. Running PGlite suite.\n'
HEALTH_RESIDENCY_MIGRATION_SQL="$EXTENSION" node --test "$ROOT/scripts/office-health-residency-approval-check.mjs"
printf 'Health residency approval validation passed.\n'
