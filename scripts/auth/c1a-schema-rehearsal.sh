#!/usr/bin/env bash
# Stage 0C / C1a — rehearse the lifecycle schema migration on the SCRATCH copy.
#
# Usage (from the rehearsal checkout, on the Lightsail host):
#   MYSQL_BIN_DIR="$HOME/mysql84/bin" scripts/auth/c1a-schema-rehearsal.sh [scratch_db]
#
# Defaults to dnds_rehearsal. Never connects to dnds_prod: the schema name is
# checked here and the migration runs through a config this script writes,
# with the database forced to the scratch copy.
#
# It drives the REAL `db-migrate` CLI, one migration at a time, because that
# is the path production takes - including the `migrations` metadata table,
# which a raw `mysql < file.sql` would leave untouched and therefore untested.
#
# The sequence is UP, verify, DOWN, prove the schema came back, UP again. No
# employee row is created, changed or deleted at any point: the only rows this
# script writes are periods in the new table, and it removes them itself
# before the DOWN.
#
# Exit status: 0 only when every check passed. Any failure is fatal and says
# which check failed.
set -uo pipefail

SCRATCH="${1:-dnds_rehearsal}"
MIGRATION="20260907140000-c1a-employee-lifecycle-schema"
WT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BIN="${MYSQL_BIN_DIR:-$HOME/mysql84/bin}"
DEFAULTS="${STAGE0A_DEFAULTS:-$HOME/.stage0a/app.cnf}"
OUT="${OUT:-$HOME/db-backups}"
STAMP="$(date +%Y%m%d-%H%M%S)"
LOG="$OUT/c1a-rehearsal-$STAMP.log"
MYSQL="$BIN/mysql"
DBMIGRATE="${DBMIGRATE:-db-migrate}"

mkdir -p "$OUT"
exec > >(tee -a "$LOG") 2>&1

FAILED=0
fail() { echo "FAIL: $*"; exit 1; }
ok()   { echo "  PASS  $1"; }
bad()  { echo "  FAIL  $1${2:+   [$2]}"; FAILED=1; }
check() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "got [$2] want [$3]"; fi; }

case "$SCRATCH" in *rehearsal*|*scratch*|*restore_test*) ;; *) fail "refusing to touch '$SCRATCH' - not a scratch schema";; esac
[ "$SCRATCH" != "dnds_prod" ] || fail "refusing dnds_prod"
[ -x "$MYSQL" ] || fail "$MYSQL not found (set MYSQL_BIN_DIR)"
[ -r "$DEFAULTS" ] || fail "cannot read $DEFAULTS"
command -v "$DBMIGRATE" >/dev/null || fail "$DBMIGRATE not on PATH (the deploy uses it; set DBMIGRATE)"
[ -r "$WT/config.json" ] || fail "no config.json in $WT - needed for the migration credentials"

Q()  { "$MYSQL" --defaults-extra-file="$DEFAULTS" -N -B "$SCRATCH" -e "$1"; }
QT() { "$MYSQL" --defaults-extra-file="$DEFAULTS" --table "$SCRATCH" -e "$1"; }
try() { "$MYSQL" --defaults-extra-file="$DEFAULTS" "$SCRATCH" -e "$1" >/dev/null 2>&1; }

echo "== Stage 0C / C1a schema rehearsal on '$SCRATCH'  ($(date '+%F %T'))"
echo "   checkout $(git -C "$WT" rev-parse --short HEAD) on $(git -C "$WT" branch --show-current)"

# ---------------------------------------------------------------- 1. guard
ACTIVE="$(Q "SELECT DATABASE()")"
check "active database is $SCRATCH" "$ACTIVE" "$SCRATCH"
[ "$ACTIVE" = "$SCRATCH" ] || fail "wrong database - stopping before any change"

# A db-migrate config of our own, with the database FORCED to the scratch
# copy, built from the app's own config.json - the credential path proven by
# the B2/B3 tooling. 600, in a temp dir, removed on exit.
CFGDIR="$(mktemp -d)"; chmod 700 "$CFGDIR"
cleanup() { rm -rf "$CFGDIR"; }
trap cleanup EXIT
CFG="$CFGDIR/database.json"
node -e '
  const fs = require("fs");
  const c = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const env = process.env.NODE_ENV === undefined ? "development" : process.env.NODE_ENV;
  const b = c.db && c.db.mysql && c.db.mysql[env];
  if (!b) { console.error("no db.mysql." + env + " block"); process.exit(1); }
  const out = { rehearsal: {
    driver: "mysql", host: b.host, port: String(b.port || 3306),
    user: b.username, password: b.password === undefined ? "" : String(b.password),
    database: process.argv[2], schema: process.argv[2], multipleStatements: true,
  }};
  fs.writeFileSync(process.argv[3], JSON.stringify(out, null, 2), { mode: 0o600 });
' "$WT/config.json" "$SCRATCH" "$CFG" || fail "could not build the migration config"
chmod 600 "$CFG"
echo "   migration config written (database forced to $SCRATCH, credentials not shown)"

MIGRATE() { ( cd "$WT/migrations/mysql" && "$DBMIGRATE" "$@" --config "$CFG" -e rehearsal ); }

# ------------------------------------------------- 2. pre-migration state
SNAP="$OUT/c1a-snapshot-$STAMP"
mkdir -p "$SNAP"; chmod 700 "$SNAP"

Q "SHOW CREATE TABLE resignation"  > "$SNAP/resignation-before.txt"
Q "SHOW CREATE TABLE new_employee" > "$SNAP/new_employee-before.txt"
Q "SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT
     FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA='$SCRATCH' AND TABLE_NAME IN ('resignation','new_employee')
    ORDER BY TABLE_NAME, ORDINAL_POSITION" > "$SNAP/columns-before.tsv"
Q "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA='$SCRATCH' ORDER BY TABLE_NAME" > "$SNAP/tables-before.tsv"
EMP_BEFORE="$(Q "SELECT COUNT(*) FROM new_employee")"
RESIG_BEFORE="$(Q "SELECT COUNT(*) FROM resignation")"

META_TABLE="$(Q "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA='$SCRATCH' AND TABLE_NAME='migrations'")"
[ -n "$META_TABLE" ] || fail "no db-migrate 'migrations' metadata table in $SCRATCH - this copy was not restored from a migrated database"
Q "SELECT name FROM migrations ORDER BY id" > "$SNAP/migrations-before.tsv"
META_BEFORE="$(grep -c . "$SNAP/migrations-before.tsv")"

echo "   pre-state: $EMP_BEFORE employees, $RESIG_BEFORE resignation rows, $META_BEFORE applied migrations"
echo "   snapshot: $SNAP"

if grep -q "$MIGRATION" "$SNAP/migrations-before.tsv"; then
  fail "$MIGRATION is already applied to $SCRATCH - roll it back first, or use a fresh restore"
fi

# ------------------------------------------------------------- 3. UP (1st)
echo
echo "== applying the migration (db-migrate up -c 1)"
MIGRATE up -c 1 || fail "db-migrate up failed"

APPLIED="$(Q "SELECT name FROM migrations ORDER BY id DESC LIMIT 1")"
case "$APPLIED" in *"$MIGRATION"*) ok "the migration db-migrate applied is $MIGRATION";; *) bad "db-migrate applied something else" "$APPLIED"; fail "unexpected migration - stopping";; esac

# --------------------------------------------------------------- 4. verify
echo
echo "== verification after UP"
check "employee_employment_period exists" "$(Q "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='$SCRATCH' AND TABLE_NAME='employee_employment_period'")" "1"
check "employee_lifecycle_event exists"   "$(Q "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='$SCRATCH' AND TABLE_NAME='employee_lifecycle_event'")" "1"
check "v_employee_current_period exists"  "$(Q "SELECT COUNT(*) FROM information_schema.VIEWS WHERE TABLE_SCHEMA='$SCRATCH' AND TABLE_NAME='v_employee_current_period'")" "1"
check "resignation gained the 4 columns"  "$(Q "SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='$SCRATCH' AND TABLE_NAME='resignation' AND COLUMN_NAME IN ('employee_id','period_id','voided_at','voided_by')")" "4"

# The pre-existing resignation columns must be untouched - same names, types,
# nullability and defaults, in the same order.
Q "SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT
     FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA='$SCRATCH' AND TABLE_NAME='resignation'
      AND COLUMN_NAME NOT IN ('employee_id','period_id','voided_at','voided_by')
    ORDER BY ORDINAL_POSITION" > "$SNAP/resignation-existing-after.tsv"
grep -v -E "^(employee_id|period_id|voided_at|voided_by)	" "$SNAP/columns-before.tsv" \
  | awk -F'\t' '$1=="resignation" {print $2"\t"$3"\t"$4"\t"$5}' > "$SNAP/resignation-existing-before.tsv"
if diff -q "$SNAP/resignation-existing-before.tsv" "$SNAP/resignation-existing-after.tsv" >/dev/null; then
  ok "existing resignation columns unchanged"
else
  bad "existing resignation columns changed"; diff "$SNAP/resignation-existing-before.tsv" "$SNAP/resignation-existing-after.tsv" | head -10
fi

check "employee_employment_period is empty" "$(Q "SELECT COUNT(*) FROM employee_employment_period")" "0"
check "employee_lifecycle_event is empty"   "$(Q "SELECT COUNT(*) FROM employee_lifecycle_event")" "0"
check "v_employee_current_period returns 0 rows" "$(Q "SELECT COUNT(*) FROM v_employee_current_period")" "0"
check "new_employee row count unchanged" "$(Q "SELECT COUNT(*) FROM new_employee")" "$EMP_BEFORE"
check "resignation row count unchanged"  "$(Q "SELECT COUNT(*) FROM resignation")" "$RESIG_BEFORE"

# ---------------------------------------------- 5. constraints, temp rows
echo
echo "== constraints, against temporary rows in the new table only"
E1="$(Q "SELECT employee_id FROM new_employee ORDER BY employee_id LIMIT 1")"
[ -n "$E1" ] || fail "no employee to attach a test period to"
echo "   using employee_id $E1 (its own row is never read, written or deleted)"

try "INSERT INTO employee_employment_period (employee_id,period_no,period_state,joined_on,source) VALUES ($E1,9001,'open','2019-01-01','local')" \
  && ok "one open period accepted" || bad "open period rejected"
try "INSERT INTO employee_employment_period (employee_id,period_no,period_state,joined_on,source) VALUES ($E1,9002,'open','2026-01-01','local')" \
  && bad "a SECOND open period was accepted" || ok "second open period rejected"
try "INSERT INTO employee_employment_period (employee_id,period_no,period_state,joined_on,ended_on,source) VALUES ($E1,9001,'closed','2019-01-01','2024-01-01','local')" \
  && bad "duplicate (employee_id, period_no) accepted" || ok "duplicate (employee_id, period_no) rejected"
try "INSERT INTO employee_employment_period (employee_id,period_no,period_state,source,needs_review) VALUES ($E1,9003,'closed','local',1)" \
  && ok "closed period with unknown dates accepted" || bad "closed period with unknown dates rejected"
try "INSERT INTO employee_employment_period (employee_id,period_no,period_state,joined_on,ended_on,source) VALUES ($E1,9004,'open','2020-01-01','2021-01-01','local')" \
  && bad "open period WITH ended_on accepted" || ok "open period with ended_on rejected"
try "INSERT INTO employee_employment_period (employee_id,period_no,period_state,joined_on,ended_on,source) VALUES ($E1,9005,'closed','2021-01-01','2020-01-01','local')" \
  && bad "ended_on before joined_on accepted" || ok "ended_on before joined_on rejected"

# 6. remove exactly what was created here, and nothing else
TEMP="$(Q "SELECT COUNT(*) FROM employee_employment_period WHERE period_no BETWEEN 9001 AND 9005")"
try "DELETE FROM employee_employment_period WHERE period_no BETWEEN 9001 AND 9005" || fail "could not remove the temporary rows"
check "temporary rows removed ($TEMP created)" "$(Q "SELECT COUNT(*) FROM employee_employment_period")" "0"

# ------------------------------------------------------------- 7. DOWN
echo
echo "== rolling the migration back (db-migrate down -c 1)"
MIGRATE down -c 1 || fail "db-migrate down failed"

# ------------------------------------------- 8. prove the schema came back
echo
echo "== verification after DOWN"
check "employee_employment_period gone" "$(Q "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='$SCRATCH' AND TABLE_NAME='employee_employment_period'")" "0"
check "employee_lifecycle_event gone"   "$(Q "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='$SCRATCH' AND TABLE_NAME='employee_lifecycle_event'")" "0"
check "v_employee_current_period gone"  "$(Q "SELECT COUNT(*) FROM information_schema.VIEWS WHERE TABLE_SCHEMA='$SCRATCH' AND TABLE_NAME='v_employee_current_period'")" "0"

for pair in "resignation" "new_employee"; do
  Q "SHOW CREATE TABLE $pair" > "$SNAP/$pair-after.txt"
  if diff -q "$SNAP/$pair-before.txt" "$SNAP/$pair-after.txt" >/dev/null; then
    ok "$pair definition is byte-identical to before"
  else
    bad "$pair definition differs"; diff "$SNAP/$pair-before.txt" "$SNAP/$pair-after.txt" | head -20
  fi
done

Q "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA='$SCRATCH' ORDER BY TABLE_NAME" > "$SNAP/tables-after.tsv"
if diff -q "$SNAP/tables-before.tsv" "$SNAP/tables-after.tsv" >/dev/null; then
  ok "the schema has exactly the tables it started with"
else
  bad "table list differs"; diff "$SNAP/tables-before.tsv" "$SNAP/tables-after.tsv" | head -10
fi

Q "SELECT name FROM migrations ORDER BY id" > "$SNAP/migrations-after.tsv"
if diff -q "$SNAP/migrations-before.tsv" "$SNAP/migrations-after.tsv" >/dev/null; then
  ok "db-migrate metadata is back to its pre-rehearsal contents"
else
  bad "migrations metadata differs"; diff "$SNAP/migrations-before.tsv" "$SNAP/migrations-after.tsv" | head -10
fi

check "new_employee row count still unchanged" "$(Q "SELECT COUNT(*) FROM new_employee")" "$EMP_BEFORE"
check "resignation row count still unchanged"  "$(Q "SELECT COUNT(*) FROM resignation")" "$RESIG_BEFORE"

# --------------------------------------------------------- 9. UP (2nd)
echo
echo "== re-applying the migration, and leaving it applied"
MIGRATE up -c 1 || fail "the second db-migrate up failed"
check "employee_employment_period exists again" "$(Q "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='$SCRATCH' AND TABLE_NAME='employee_employment_period'")" "1"
check "and is empty" "$(Q "SELECT COUNT(*) FROM employee_employment_period")" "0"
check "v_employee_current_period exists again" "$(Q "SELECT COUNT(*) FROM information_schema.VIEWS WHERE TABLE_SCHEMA='$SCRATCH' AND TABLE_NAME='v_employee_current_period'")" "1"
check "new_employee row count unchanged throughout" "$(Q "SELECT COUNT(*) FROM new_employee")" "$EMP_BEFORE"

echo
echo "-- final state of $SCRATCH"
QT "SELECT
      (SELECT COUNT(*) FROM new_employee) AS employees,
      (SELECT COUNT(*) FROM resignation) AS resignation_rows,
      (SELECT COUNT(*) FROM employee_employment_period) AS periods,
      (SELECT COUNT(*) FROM employee_lifecycle_event) AS events,
      (SELECT COUNT(*) FROM migrations) AS applied_migrations"
echo
echo "   The migration is LEFT APPLIED, matching what production will look like"
echo "   after C1a deploys. Roll it back with:"
echo "     ( cd $WT/migrations/mysql && $DBMIGRATE down -c 1 --config <config> -e rehearsal )"
echo
echo "report: $LOG"
[ "$FAILED" = "0" ] && echo "C1A SCHEMA REHEARSAL: ALL CHECKS PASSED" || echo "C1A SCHEMA REHEARSAL: CHECKS FAILED"
exit "$FAILED"
