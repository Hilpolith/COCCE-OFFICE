#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
PG_BINDIR=${PG_BINDIR:-/usr/lib/postgresql/16/bin}
for b in initdb pg_ctl createdb psql; do
  test -x "$PG_BINDIR/$b" || { echo "missing PostgreSQL binary: $b" >&2; exit 1; }
done
TMP=$(mktemp -d -t cocce-institutions.XXXXXX)
PORT=$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')
trap '"$PG_BINDIR/pg_ctl" -D "$TMP/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$TMP"' EXIT
"$PG_BINDIR/initdb" -D "$TMP/data" -A trust --no-locale >/dev/null
"$PG_BINDIR/pg_ctl" -D "$TMP/data" -l "$TMP/postgres.log" -o "-h 127.0.0.1 -p $PORT -k $TMP" -w start >/dev/null
"$PG_BINDIR/createdb" -h 127.0.0.1 -p "$PORT" institutions_validation
sed '/^[[:space:]]*\\/d' "$ROOT/supabase/tests/university-bootstrap.sql" > "$TMP/bootstrap.sql"
"$PG_BINDIR/psql" -X -1 -h 127.0.0.1 -p "$PORT" -d institutions_validation -v ON_ERROR_STOP=1 -f "$TMP/bootstrap.sql" >/dev/null
"$PG_BINDIR/psql" -X -h 127.0.0.1 -p "$PORT" -d institutions_validation -v ON_ERROR_STOP=1 -c "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon,authenticated,service_role; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon,authenticated,service_role;" >/dev/null
for f in "$ROOT"/supabase/migrations/2026110810*_office_institutions_*.sql; do
  printf 'Validating %s\n' "$(basename "$f")"
  "$PG_BINDIR/psql" -X -h 127.0.0.1 -p "$PORT" -d institutions_validation -v ON_ERROR_STOP=1 -f "$f" >/dev/null
done
"$PG_BINDIR/psql" -X -h 127.0.0.1 -p "$PORT" -d institutions_validation -v ON_ERROR_STOP=1 <<'SQL'
DO $$ DECLARE t record; f record; caller text; BEGIN
  FOR t IN SELECT c.oid,c.relname,c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname LIKE 'office_institutions_%' AND c.relkind='r' LOOP
    IF NOT t.relrowsecurity THEN RAISE EXCEPTION 'RLS missing: %',t.relname; END IF;
    FOREACH caller IN ARRAY ARRAY['anon','authenticated'] LOOP
      IF has_table_privilege(caller,t.oid,'SELECT,INSERT,UPDATE,DELETE') THEN RAISE EXCEPTION 'Direct table privilege: % %',caller,t.relname; END IF;
    END LOOP;
  END LOOP;
  FOR f IN SELECT p.oid,p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='office_private' AND left(p.proname,5)='inst_' LOOP
    IF has_function_privilege('authenticated',f.oid,'EXECUTE') OR has_function_privilege('anon',f.oid,'EXECUTE') THEN RAISE EXCEPTION 'Private helper exposed: %',f.signature; END IF;
  END LOOP;
  IF NOT has_function_privilege('authenticated','public.office_institutions_command(uuid,text,jsonb)','EXECUTE') OR NOT has_function_privilege('authenticated','public.office_institutions_read(uuid,text,jsonb,integer,integer)','EXECUTE') THEN RAISE EXCEPTION 'Authenticated RPC grant missing'; END IF;
  IF has_function_privilege('anon','public.office_institutions_command(uuid,text,jsonb)','EXECUTE') OR has_function_privilege('anon','public.office_institutions_read(uuid,text,jsonb,integer,integer)','EXECUTE') THEN RAISE EXCEPTION 'Anonymous RPC exposed'; END IF;
END $$;
SQL
node --test --test-concurrency=2 "$ROOT"/scripts/office-institutions-*-check.mjs
printf 'Institutions native PostgreSQL and persisted-state validation passed.\n'
