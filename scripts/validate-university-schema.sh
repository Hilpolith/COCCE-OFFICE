#!/usr/bin/env bash
# Synthetic fixtures only. Never connects to an existing database or Supabase.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
PG_BINDIR=${PG_BINDIR:-$(pg_config --bindir)}
TMP=$(mktemp -d -t cocce-university-test.XXXXXX)
PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')
cleanup() {
  "$PG_BINDIR/pg_ctl" -D "$TMP/data" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT
"$PG_BINDIR/initdb" -D "$TMP/data" -A trust --no-locale >/dev/null
"$PG_BINDIR/pg_ctl" -D "$TMP/data" -l "$TMP/postgres.log" -o "-h 127.0.0.1 -p $PORT -k $TMP" -w start >/dev/null
"$PG_BINDIR/createdb" -h 127.0.0.1 -p "$PORT" university_validation
for sql in "$ROOT/supabase/tests/university-bootstrap.sql" "$ROOT/supabase/migrations/20261107121500_office_university_management.sql" "$ROOT/supabase/migrations/20261110100100_office_university_server_kpis.sql" "$ROOT/supabase/tests/office_university_management.test.sql"; do
  echo "Validating $(basename "$sql") in disposable PostgreSQL on loopback:$PORT"
  "$PG_BINDIR/psql" -X -h 127.0.0.1 -p "$PORT" -d university_validation -v ON_ERROR_STOP=1 -f "$sql" >/dev/null
done
echo 'University schema, complete workflows, retry guards and role-security tests passed.'
