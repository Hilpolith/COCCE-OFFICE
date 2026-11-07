#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
PG_BINDIR=${PG_BINDIR:-$(pg_config --bindir)}
TMP=$(mktemp -d -t cocce-business-test.XXXXXX)
PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')
DB=business_validation

cleanup() {
  "$PG_BINDIR/pg_ctl" -D "$TMP/data" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT

printf 'Initialising disposable PostgreSQL cluster on 127.0.0.1:%s\n' "$PORT"
"$PG_BINDIR/initdb" -D "$TMP/data" -A trust --no-locale >/dev/null
"$PG_BINDIR/pg_ctl" -D "$TMP/data" -l "$TMP/postgres.log" \
  -o "-h 127.0.0.1 -p $PORT -k $TMP" -w start >/dev/null
"$PG_BINDIR/createdb" -h 127.0.0.1 -p "$PORT" "$DB"

run_sql() {
  local mode=$1
  local sql=$2
  printf '\n==> %s (%s)\n' "$(basename "$sql")" "$mode"
  if [[ "$mode" == migration ]]; then
    # The migration is the only project SQL file with an explicit transaction contract.
    # -1 also makes a regenerated top-level-marker-free migration atomic as requested.
    "$PG_BINDIR/psql" -X -1 -h 127.0.0.1 -p "$PORT" -d "$DB" \
      -v ON_ERROR_STOP=1 -f "$sql" 2>&1 | tee -a "$TMP/validation.log"
  else
    "$PG_BINDIR/psql" -X -h 127.0.0.1 -p "$PORT" -d "$DB" \
      -v ON_ERROR_STOP=1 -f "$sql" 2>&1 | tee -a "$TMP/validation.log"
  fi
}

run_sql bootstrap "$ROOT/supabase/tests/university-bootstrap.sql"
run_sql migration "$ROOT/supabase/migrations/20261107130000_office_business_management.sql"
run_sql tests "$ROOT/supabase/tests/office_business_management.test.sql"
run_sql tests "$ROOT/supabase/tests/business-expanded-regression.sql"

printf '\nBusiness schema validation passed. Full PostgreSQL output was captured during the run.\n'
