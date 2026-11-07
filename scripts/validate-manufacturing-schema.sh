#!/usr/bin/env bash
# Disposable native PostgreSQL 16 validation plus the real public-RPC PGlite suite.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
MIGRATION_SQL=${MANUFACTURING_MIGRATION_SQL:-"$ROOT/supabase/migrations/20261107181000_office_manufacturing_management.sql"}
PG_BINDIR=${PG_BINDIR:-/usr/lib/postgresql/16/bin}
RPC_TEST_SQL=${MANUFACTURING_RPC_TEST_SQL:-"$MIGRATION_SQL"}
for bin in initdb pg_ctl createdb psql; do command -v "$PG_BINDIR/$bin" >/dev/null || { echo "missing PostgreSQL binary: $PG_BINDIR/$bin" >&2; exit 1; }; done
TMP=$(mktemp -d -t cocce-manufacturing-test.XXXXXX)
PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')
DB=manufacturing_validation
cleanup(){ "$PG_BINDIR/pg_ctl" -D "$TMP/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT
"$PG_BINDIR/initdb" -D "$TMP/data" -A trust --no-locale >/dev/null
"$PG_BINDIR/pg_ctl" -D "$TMP/data" -l "$TMP/postgres.log" -o "-h 127.0.0.1 -p $PORT -k $TMP" -w start >/dev/null
"$PG_BINDIR/createdb" -h 127.0.0.1 -p "$PORT" "$DB"
printf 'Validating manufacturing migration in disposable PostgreSQL 16 cluster.\n'
# The bootstrap is a SQL fixture; strip only psql meta-commands for native psql parity.
sed '/^[[:space:]]*\\/d' "$ROOT/supabase/tests/university-bootstrap.sql" > "$TMP/bootstrap.sql"
"$PG_BINDIR/psql" -X -1 -h 127.0.0.1 -p "$PORT" -d "$DB" -v ON_ERROR_STOP=1 -f "$TMP/bootstrap.sql" >/dev/null
# Reuse the exact cloud metadata declarations required by the manufacturing migration.
python3 - "$ROOT/supabase/migrations/20261104080000_office_cloud_files.sql" "$TMP/cloud.sql" <<'PY'
from pathlib import Path
src=Path(__import__('sys').argv[1]).read_text()
out=[]
for name in ('office_cloud_files','office_cloud_revisions'):
    start=src.index(f'CREATE TABLE public.{name} (')
    end=src.index('\n);',start)+3
    out.append(src[start:end])
Path(__import__('sys').argv[2]).write_text('\n'.join(out)+'\n')
PY
"$PG_BINDIR/psql" -X -1 -h 127.0.0.1 -p "$PORT" -d "$DB" -v ON_ERROR_STOP=1 -f "$TMP/cloud.sql" >/dev/null
"$PG_BINDIR/psql" -X -1 -h 127.0.0.1 -p "$PORT" -d "$DB" -v ON_ERROR_STOP=1 -f "$MIGRATION_SQL" >/dev/null
"$PG_BINDIR/psql" -X -1 -h 127.0.0.1 -p "$PORT" -d "$DB" -v ON_ERROR_STOP=1 -f "$ROOT/supabase/migrations/20261107192000_office_manufacturing_helper_acl.sql" >/dev/null
"$PG_BINDIR/psql" -X -1 -h 127.0.0.1 -p "$PORT" -d "$DB" -v ON_ERROR_STOP=1 <<'SQL'
DO $$ DECLARE n integer; bad boolean; BEGIN
  SELECT count(*), NOT bool_and(relrowsecurity) INTO n,bad FROM pg_class c JOIN pg_namespace ns ON ns.oid=c.relnamespace
    WHERE ns.nspname='public' AND c.relname LIKE 'office_manufacturing_%' AND c.relkind='r';
  IF n <> 24 OR bad THEN RAISE EXCEPTION 'manufacturing RLS assertion failed'; END IF;
  RAISE NOTICE 'manufacturing tables RLS: ok';
END $$;
DO $$ DECLARE ok boolean; BEGIN
  SELECT p.prosecdef AND p.proconfig @> ARRAY['search_path=""'] INTO ok FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace
    WHERE ns.nspname='public' AND p.proname='office_manufacturing_command';
  IF NOT ok THEN RAISE EXCEPTION 'public command security assertion failed'; END IF;
  RAISE NOTICE 'public command security boundary: ok';
END $$;
DO $$ BEGIN
  IF has_table_privilege('authenticated','public.office_manufacturing_items','select') THEN RAISE EXCEPTION 'direct ACL assertion failed'; END IF;
  RAISE NOTICE 'direct table ACL: ok';
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace WHERE ns.nspname='office_private' AND p.proname LIKE 'mfg_%' AND (has_function_privilege('authenticated',p.oid,'execute') OR has_function_privilege('anon',p.oid,'execute'))) THEN RAISE EXCEPTION 'private helper ACL assertion failed'; END IF;
END $$;
SQL
printf 'Native migration smoke passed. Running public-RPC PGlite suite.\n'
MANUFACTURING_MIGRATION_SQL="$RPC_TEST_SQL" node --test "$ROOT/scripts/office-manufacturing-management-postgres-check.mjs"
printf 'Manufacturing schema validation passed.\n'
