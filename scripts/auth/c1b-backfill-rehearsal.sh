#!/usr/bin/env bash
# Stage 0C / C1b — rehearse the employment-period backfill on the SCRATCH copy.
#
# Usage (from the rehearsal checkout, on the Lightsail host):
#   MYSQL_BIN_DIR="$HOME/mysql84/bin" scripts/auth/c1b-backfill-rehearsal.sh [scratch_db]
#
# Runs the real backfill script - check, apply, verify, rerun for idempotency -
# and then rolls it back, so the copy is left as it was found. Set
# C1B_LEAVE=applied to keep the periods.
#
# The backfill itself can target any schema, because production is where it
# eventually has to run. THIS wrapper cannot: it refuses anything not named
# like a scratch copy, and refuses dnds_prod by name.
#
# Expected counts are never passed in. The backfill derives all of them from
# whatever database it is pointed at - the copy had 629 employees when
# production had 630, and a script carrying either number would be wrong
# somewhere.
set -uo pipefail

SCRATCH="${1:-dnds_rehearsal}"
LEAVE="${C1B_LEAVE:-reverted}"
WT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BIN="${MYSQL_BIN_DIR:-$HOME/mysql84/bin}"
DEFAULTS="${STAGE0A_DEFAULTS:-$HOME/.stage0a/app.cnf}"
OUT="${OUT:-$HOME/db-backups}"
STAMP="$(date +%Y%m%d-%H%M%S)"
LOG="$OUT/c1b-rehearsal-$STAMP.log"
MYSQL="$BIN/mysql"
BACKFILL="$WT/scripts/auth/c1b-backfill.js"

mkdir -p "$OUT"
exec > >(tee -a "$LOG") 2>&1
FAILED=0
fail() { echo "FAIL: $*"; exit 1; }
ok()   { echo "  PASS  $1"; }
bad()  { echo "  FAIL  $1${2:+   [$2]}"; FAILED=1; }
check() { if [ "$2" = "$3" ]; then ok "$1 ($2)"; else bad "$1" "got $2, want $3"; fi; }

case "$SCRATCH" in *rehearsal*|*scratch*|*restore_test*) ;; *) fail "refusing '$SCRATCH' - not a scratch schema";; esac
[ "$SCRATCH" != "dnds_prod" ] || fail "refusing dnds_prod"
[ -x "$MYSQL" ] || fail "$MYSQL not found (set MYSQL_BIN_DIR)"
[ -r "$DEFAULTS" ] || fail "cannot read $DEFAULTS"
[ -r "$BACKFILL" ] || fail "missing $BACKFILL"
[ -r "$WT/config.json" ] || fail "no config.json in $WT"
case "$LEAVE" in reverted|applied) ;; *) fail "C1B_LEAVE must be 'reverted' or 'applied'";; esac

Q() { "$MYSQL" --defaults-extra-file="$DEFAULTS" -N -B "$SCRATCH" -e "$1"; }
RUN() { node "$BACKFILL" "$@" --db "$SCRATCH" --config "$WT/config.json"; }

echo "== Stage 0C / C1b backfill rehearsal on '$SCRATCH'  ($(date '+%F %T'))"
echo "   checkout $(git -C "$WT" rev-parse --short HEAD) on $(git -C "$WT" branch --show-current)"
echo "   end state when finished: $LEAVE"

# The employee master must come through untouched; this is how that is proved
# rather than asserted.
EMP_BEFORE="$(Q "SELECT COUNT(*) FROM new_employee")"
SUM_BEFORE="$(Q "CHECKSUM TABLE new_employee" | cut -f2)"
EVENTS_BEFORE="$(Q "SELECT COUNT(*) FROM employee_lifecycle_event")"
echo "   before: $EMP_BEFORE employees, new_employee checksum $SUM_BEFORE, $EVENTS_BEFORE lifecycle events"

echo; echo "== 1. check (read only)"
RUN check || fail "preflight failed - nothing was written"

echo; echo "== 2. apply"
RUN apply --confirm APPLY-C1B-BACKFILL || fail "the backfill failed"

echo; echo "== 3. apply again (idempotency)"
RUN apply --confirm APPLY-C1B-BACKFILL || fail "the second run failed"
PERIODS="$(Q "SELECT COUNT(*) FROM employee_employment_period")"
check "a second run left the period count where it was" "$PERIODS" "$EMP_BEFORE"
check "no employee gained a second period" "$(Q "SELECT COUNT(*) FROM (SELECT employee_id FROM employee_employment_period GROUP BY employee_id HAVING COUNT(*) > 1) d")" "0"

echo; echo "== 4. verify"
RUN verify || bad "verify reported a problem"

echo; echo "== 5. the employee master is untouched"
check "new_employee row count" "$(Q "SELECT COUNT(*) FROM new_employee")" "$EMP_BEFORE"
check "new_employee checksum" "$(Q "CHECKSUM TABLE new_employee" | cut -f2)" "$SUM_BEFORE"
check "no lifecycle events were created" "$(Q "SELECT COUNT(*) FROM employee_lifecycle_event")" "$EVENTS_BEFORE"

echo; echo "== 6. what a human still has to look at"
"$MYSQL" --defaults-extra-file="$DEFAULTS" --table "$SCRATCH" -e "
  SELECT
    SUM(needs_review = 1) AS needs_review,
    SUM(joined_on IS NULL) AS unknown_joining_date,
    SUM(period_state = 'closed' AND ended_on IS NULL) AS closed_with_unknown_end,
    SUM(period_state = 'open') AS open_periods,
    SUM(period_state = 'closed') AS closed_periods
  FROM employee_employment_period"

echo
if [ "$LEAVE" = "reverted" ]; then
  echo "== 7. rolling the backfill back, leaving '$SCRATCH' as it was found"
  RUN rollback --confirm ROLLBACK-C1B-BACKFILL || fail "rollback failed"
  check "no period rows remain" "$(Q "SELECT COUNT(*) FROM employee_employment_period")" "0"
  check "new_employee checksum after rollback" "$(Q "CHECKSUM TABLE new_employee" | cut -f2)" "$SUM_BEFORE"
else
  echo "== 7. leaving the backfill APPLIED (C1B_LEAVE=applied)"
  echo "   roll it back with:"
  echo "     node $BACKFILL rollback --db $SCRATCH --confirm ROLLBACK-C1B-BACKFILL"
fi

echo
echo "report: $LOG"
[ "$FAILED" = "0" ] && echo "C1B BACKFILL REHEARSAL: ALL CHECKS PASSED" || echo "C1B BACKFILL REHEARSAL: CHECKS FAILED"
exit "$FAILED"
