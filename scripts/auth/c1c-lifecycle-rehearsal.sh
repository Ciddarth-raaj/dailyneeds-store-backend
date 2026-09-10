#!/usr/bin/env bash
# Stage 0C / C1c — rehearse the lifecycle reconciler on the SCRATCH copy.
#
# Usage (from the rehearsal checkout, on the Lightsail host):
#   MYSQL_BIN_DIR="$HOME/mysql84/bin" scripts/auth/c1c-lifecycle-rehearsal.sh [scratch_db]
#
# Drives the real reconciler through
#
#   join -> resign -> rejoin -> resign -> rejoin
#
# reconciling three times at every state, on FIXTURE employees created and
# deleted by the run. No production employee is used as a test subject, and
# the copy is checksummed before and after to prove it.
#
# Set C1C_KEEP=1 to leave the fixtures in place for inspection; the default
# removes them and restores AUTO_INCREMENT.
#
# This wrapper refuses dnds_prod by name and refuses any schema not named
# like a scratch copy. The driver refuses them again independently.
set -uo pipefail

SCRATCH="${1:-dnds_rehearsal}"
WT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BIN="${MYSQL_BIN_DIR:-$HOME/mysql84/bin}"
DEFAULTS="${STAGE0A_DEFAULTS:-$HOME/.stage0a/app.cnf}"
OUT="${OUT:-$HOME/db-backups}"
STAMP="$(date +%Y%m%d-%H%M%S)"
LOG="$OUT/c1c-rehearsal-$STAMP.log"
MYSQL="$BIN/mysql"
DRIVER="$WT/scripts/auth/c1c-lifecycle-rehearsal.js"

mkdir -p "$OUT"
exec > >(tee -a "$LOG") 2>&1
fail() { echo "FAIL: $*"; exit 1; }

case "$SCRATCH" in *rehearsal*|*scratch*|*restore_test*) ;; *) fail "refusing '$SCRATCH' - not a scratch schema";; esac
[ "$SCRATCH" != "dnds_prod" ] || fail "refusing dnds_prod"
[ -x "$MYSQL" ] || fail "$MYSQL not found (set MYSQL_BIN_DIR)"
[ -r "$DEFAULTS" ] || fail "cannot read $DEFAULTS"
[ -r "$DRIVER" ] || fail "missing $DRIVER"
[ -r "$WT/config.json" ] || fail "no config.json in $WT"
[ -d "$WT/node_modules/mysql" ] || fail "node_modules/mysql missing in $WT - run npm i"

Q() { "$MYSQL" --defaults-extra-file="$DEFAULTS" -N -B "$SCRATCH" -e "$1"; }

echo "== Stage 0C / C1c lifecycle rehearsal on '$SCRATCH'  ($(date '+%F %T'))"
echo "   checkout $(git -C "$WT" rev-parse --short HEAD) on $(git -C "$WT" branch --show-current)"

# Proved here as well as inside the driver, through a different client, so a
# defect in the driver's own bookkeeping cannot hide a change to the copy.
EMP_BEFORE="$(Q "SELECT COUNT(*) FROM new_employee")"
SUM_BEFORE="$(Q "CHECKSUM TABLE new_employee" | cut -f2)"
PER_BEFORE="$(Q "SELECT COUNT(*) FROM employee_employment_period")"
EVT_BEFORE="$(Q "SELECT COUNT(*) FROM employee_lifecycle_event")"
echo "   before: $EMP_BEFORE employees, $PER_BEFORE period(s), $EVT_BEFORE event(s), checksum $SUM_BEFORE"

KEEP_FLAG=""
[ "${C1C_KEEP:-0}" = "1" ] && KEEP_FLAG="--keep"

node "$DRIVER" --db "$SCRATCH" --config "$WT/config.json" $KEEP_FLAG
RC=$?

EMP_AFTER="$(Q "SELECT COUNT(*) FROM new_employee")"
SUM_AFTER="$(Q "CHECKSUM TABLE new_employee" | cut -f2)"
PER_AFTER="$(Q "SELECT COUNT(*) FROM employee_employment_period")"
EVT_AFTER="$(Q "SELECT COUNT(*) FROM employee_lifecycle_event")"
echo
echo "   after:  $EMP_AFTER employees, $PER_AFTER period(s), $EVT_AFTER event(s), checksum $SUM_AFTER"

if [ "${C1C_KEEP:-0}" != "1" ]; then
  [ "$EMP_BEFORE" = "$EMP_AFTER" ] || { echo "  FAIL  employee count changed"; RC=1; }
  [ "$SUM_BEFORE" = "$SUM_AFTER" ] || { echo "  FAIL  new_employee checksum changed"; RC=1; }
  [ "$PER_BEFORE" = "$PER_AFTER" ] || { echo "  FAIL  period count changed"; RC=1; }
  [ "$EVT_BEFORE" = "$EVT_AFTER" ] || { echo "  FAIL  event count changed"; RC=1; }
fi

echo
echo "   log: $LOG"
if [ "$RC" -ne 0 ]; then
  echo "C1C LIFECYCLE REHEARSAL: FAILED"
  exit 1
fi
echo "C1C LIFECYCLE REHEARSAL: ALL CHECKS PASSED (wrapper agrees)"
