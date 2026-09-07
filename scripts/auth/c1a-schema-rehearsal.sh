#!/usr/bin/env bash
# Stage 0C / C1a — rehearse the lifecycle schema migration on the SCRATCH copy.
#
# Usage (from the rehearsal checkout, on the Lightsail host):
#   MYSQL_BIN_DIR="$HOME/mysql84/bin" scripts/auth/c1a-schema-rehearsal.sh [scratch_db]
#
# WHAT CHANGED, AND WHY
#
# The first version drove `db-migrate up -c 1`. That applies the next PENDING
# migration, whichever it is - and the restored copy turned out to be behind
# the chain, so it applied B2 (the Stage 0B permission keys) and stopped,
# never testing C1a at all. `-c 1` names a COUNT, not a migration; the script
# had no business assuming the copy was current.
#
# This version never invokes db-migrate. It applies C1a's own UP and DOWN SQL
# files directly, so it can only ever run the migration it is named after. A
# pending migration belonging to some other stage cannot be dragged in.
#
# The consequence is deliberate: db-migrate's `migrations` metadata table is
# NOT written, because this script does not own that bookkeeping. So the copy
# must not be left with C1a's tables present and its metadata silent - a later
# real `db-migrate up` would then fail on `ALTER TABLE resignation ADD COLUMN`
# with a duplicate column. The run therefore ends with the schema ROLLED BACK
# by default. Set C1A_LEAVE=applied to keep it, only if you also intend to
# record the migration through db-migrate afterwards.
#
# Sequence: UP, verify, constraints, remove its own rows, DOWN, prove the
# schema came back, UP again, verify, then the chosen end state.
#
# No employee row is created, changed or deleted at any point. The only rows
# written are periods in the new table, using an existing employee_id purely
# as a foreign key, and they are removed before the rollback.
set -uo pipefail

SCRATCH="${1:-dnds_rehearsal}"
LEAVE="${C1A_LEAVE:-reverted}"
MIGRATION="20260907140000-c1a-employee-lifecycle-schema"
WT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BIN="${MYSQL_BIN_DIR:-$HOME/mysql84/bin}"
DEFAULTS="${STAGE0A_DEFAULTS:-$HOME/.stage0a/app.cnf}"
OUT="${OUT:-$HOME/db-backups}"
STAMP="$(date +%Y%m%d-%H%M%S)"
LOG="$OUT/c1a-rehearsal-$STAMP.log"
MYSQL="$BIN/mysql"
UP_SQL="$WT/migrations/mysql/migrations/sqls/$MIGRATION-up.sql"
DOWN_SQL="$WT/migrations/mysql/migrations/sqls/$MIGRATION-down.sql"

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
[ -r "$UP_SQL" ] || fail "missing $UP_SQL"
[ -r "$DOWN_SQL" ] || fail "missing $DOWN_SQL"
case "$LEAVE" in reverted|applied) ;; *) fail "C1A_LEAVE must be 'reverted' or 'applied'";; esac

Q()   { "$MYSQL" --defaults-extra-file="$DEFAULTS" -N -B "$SCRATCH" -e "$1"; }
QT()  { "$MYSQL" --defaults-extra-file="$DEFAULTS" --table "$SCRATCH" -e "$1"; }
try() { "$MYSQL" --defaults-extra-file="$DEFAULTS" "$SCRATCH" -e "$1" >/dev/null 2>&1; }
RUN() { "$MYSQL" --defaults-extra-file="$DEFAULTS" "$SCRATCH" < "$1"; }
EXISTS_T() { Q "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='$SCRATCH' AND TABLE_NAME='$1'"; }
EXISTS_V() { Q "SELECT COUNT(*) FROM information_schema.VIEWS  WHERE TABLE_SCHEMA='$SCRATCH' AND TABLE_NAME='$1'"; }

echo "== Stage 0C / C1a schema rehearsal on '$SCRATCH'  ($(date '+%F %T'))"
echo "   checkout $(git -C "$WT" rev-parse --short HEAD) on $(git -C "$WT" branch --show-current)"
echo "   applying C1a's own SQL directly - db-migrate is never invoked"
echo "   end state when finished: $LEAVE"

# ------------------------------------------------------------- 1. guard
ACTIVE="$(Q "SELECT DATABASE()")"
check "active database is $SCRATCH" "$ACTIVE" "$SCRATCH"
[ "$ACTIVE" = "$SCRATCH" ] || fail "wrong database - stopping before any change"

# The copy must not already carry C1a, or the UP would fail half way and the
# DOWN would remove objects this run did not create.
for t in employee_employment_period employee_lifecycle_event; do
  [ "$(EXISTS_T $t)" = "0" ] || fail "$t already exists in $SCRATCH - roll C1a back, or use a fresh restore"
done
[ "$(Q "SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='$SCRATCH' AND TABLE_NAME='resignation' AND COLUMN_NAME IN ('employee_id','period_id','voided_at','voided_by')")" = "0" ] \
  || fail "resignation already carries C1a's columns - roll C1a back, or use a fresh restore"

# --------------------------------------------------- 2. pre-migration state
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

# Captured and compared, never written: this script must not change a single
# permission row, and the comparison at the end proves it did not.
Q "SELECT permission_id, permission_key FROM all_permissions ORDER BY permission_id" > "$SNAP/all-permissions-before.tsv"
Q "SELECT designation_id, permission_key, is_active FROM permissions ORDER BY designation_id, permission_key" > "$SNAP/permissions-before.tsv"
# The db-migrate metadata is snapshotted so the run can PROVE it left the
# bookkeeping alone.
META_PRESENT="$(EXISTS_T migrations)"
[ "$META_PRESENT" = "1" ] && Q "SELECT id, name FROM migrations ORDER BY id" > "$SNAP/migrations-before.tsv"

echo "   pre-state: $EMP_BEFORE employees, $RESIG_BEFORE resignation rows,"
echo "              $(grep -c . "$SNAP/all-permissions-before.tsv") permission keys, $(grep -c . "$SNAP/permissions-before.tsv") grants"
echo "   snapshot: $SNAP"

# ------------------------------------------------------------- 3. UP (1st)
echo
echo "== applying C1a UP"
RUN "$UP_SQL" || fail "the C1a up migration did not apply"

# --------------------------------------------------------------- 4. verify
echo
echo "== verification after UP"
check "employee_employment_period exists" "$(EXISTS_T employee_employment_period)" "1"
check "employee_lifecycle_event exists"   "$(EXISTS_T employee_lifecycle_event)" "1"
check "v_employee_current_period exists"  "$(EXISTS_V v_employee_current_period)" "1"
check "resignation gained the 4 columns"  "$(Q "SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='$SCRATCH' AND TABLE_NAME='resignation' AND COLUMN_NAME IN ('employee_id','period_id','voided_at','voided_by')")" "4"

Q "SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT
     FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA='$SCRATCH' AND TABLE_NAME='resignation'
      AND COLUMN_NAME NOT IN ('employee_id','period_id','voided_at','voided_by')
    ORDER BY ORDINAL_POSITION" > "$SNAP/resignation-existing-after.tsv"
awk -F'\t' '$1=="resignation" && $2!="employee_id" && $2!="period_id" && $2!="voided_at" && $2!="voided_by" {print $2"\t"$3"\t"$4"\t"$5}' \
  "$SNAP/columns-before.tsv" > "$SNAP/resignation-existing-before.tsv"
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
echo "   using employee_id $E1 as a foreign key only - its own row is never written"

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

TEMP="$(Q "SELECT COUNT(*) FROM employee_employment_period WHERE period_no BETWEEN 9001 AND 9005")"
try "DELETE FROM employee_employment_period WHERE period_no BETWEEN 9001 AND 9005" || fail "could not remove the temporary rows"
check "temporary rows removed ($TEMP created)" "$(Q "SELECT COUNT(*) FROM employee_employment_period")" "0"

# --------------------------------------------------------------- 6. DOWN
echo
echo "== applying C1a DOWN"
RUN "$DOWN_SQL" || fail "the C1a down migration did not apply"

echo
echo "== verification after DOWN"
check "employee_employment_period gone" "$(EXISTS_T employee_employment_period)" "0"
check "employee_lifecycle_event gone"   "$(EXISTS_T employee_lifecycle_event)" "0"
check "v_employee_current_period gone"  "$(EXISTS_V v_employee_current_period)" "0"

for t in resignation new_employee; do
  Q "SHOW CREATE TABLE $t" > "$SNAP/$t-after.txt"
  if diff -q "$SNAP/$t-before.txt" "$SNAP/$t-after.txt" >/dev/null; then
    ok "$t definition is byte-identical to before"
  else
    bad "$t definition differs"; diff "$SNAP/$t-before.txt" "$SNAP/$t-after.txt" | head -20
  fi
done

Q "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA='$SCRATCH' ORDER BY TABLE_NAME" > "$SNAP/tables-after.tsv"
if diff -q "$SNAP/tables-before.tsv" "$SNAP/tables-after.tsv" >/dev/null; then
  ok "the schema has exactly the tables it started with"
else
  bad "table list differs"; diff "$SNAP/tables-before.tsv" "$SNAP/tables-after.tsv" | head -10
fi
check "new_employee row count still unchanged" "$(Q "SELECT COUNT(*) FROM new_employee")" "$EMP_BEFORE"
check "resignation row count still unchanged"  "$(Q "SELECT COUNT(*) FROM resignation")" "$RESIG_BEFORE"

# ------------------------------------------------------------- 7. UP (2nd)
echo
echo "== re-applying C1a UP, to prove it is repeatable"
RUN "$UP_SQL" || fail "the second C1a up did not apply"
check "employee_employment_period exists again" "$(EXISTS_T employee_employment_period)" "1"
check "and is empty" "$(EXISTS_T employee_employment_period)" "1"
check "v_employee_current_period exists again" "$(EXISTS_V v_employee_current_period)" "1"

# ----------------------------------------------------------- 8. end state
echo
if [ "$LEAVE" = "reverted" ]; then
  echo "== leaving $SCRATCH with C1a ROLLED BACK (db-migrate has no record of it)"
  RUN "$DOWN_SQL" || fail "the final rollback did not apply"
  check "employee_employment_period gone" "$(EXISTS_T employee_employment_period)" "0"
  check "v_employee_current_period gone"  "$(EXISTS_V v_employee_current_period)" "0"
else
  echo "== leaving $SCRATCH with C1a APPLIED (C1A_LEAVE=applied)"
  echo "   db-migrate has NO record of it. Record it, or roll it back with:"
  echo "     $MYSQL --defaults-extra-file=$DEFAULTS $SCRATCH < $DOWN_SQL"
fi

# --------------------------------------------- 9. nothing else was touched
echo
echo "== proof that nothing outside C1a moved"
Q "SELECT permission_id, permission_key FROM all_permissions ORDER BY permission_id" > "$SNAP/all-permissions-after.tsv"
Q "SELECT designation_id, permission_key, is_active FROM permissions ORDER BY designation_id, permission_key" > "$SNAP/permissions-after.tsv"
for f in all-permissions permissions; do
  if diff -q "$SNAP/$f-before.tsv" "$SNAP/$f-after.tsv" >/dev/null; then
    ok "$f identical to before ($(grep -c . "$SNAP/$f-after.tsv") rows)"
  else
    bad "$f changed"; diff "$SNAP/$f-before.tsv" "$SNAP/$f-after.tsv" | head -10
  fi
done
if [ "$META_PRESENT" = "1" ]; then
  Q "SELECT id, name FROM migrations ORDER BY id" > "$SNAP/migrations-after.tsv"
  if diff -q "$SNAP/migrations-before.tsv" "$SNAP/migrations-after.tsv" >/dev/null; then
    ok "db-migrate metadata untouched - no migration was applied or removed by this script"
  else
    bad "migrations metadata changed"; diff "$SNAP/migrations-before.tsv" "$SNAP/migrations-after.tsv" | head -10
  fi
fi

echo
QT "SELECT
      (SELECT COUNT(*) FROM new_employee) AS employees,
      (SELECT COUNT(*) FROM resignation) AS resignation_rows,
      (SELECT COUNT(*) FROM all_permissions) AS permission_keys,
      (SELECT COUNT(*) FROM permissions) AS grants"
echo
echo "report: $LOG"
[ "$FAILED" = "0" ] && echo "C1A SCHEMA REHEARSAL: ALL CHECKS PASSED" || echo "C1A SCHEMA REHEARSAL: CHECKS FAILED"
exit "$FAILED"
