#!/usr/bin/env bash
# Stage 0B / B2 — rehearse the HR permission policy on the SCRATCH copy.
#
# Usage (from ~/stage0a-rehearsal, on the Lightsail host):
#   MYSQL_BIN_DIR="$HOME/mysql84/bin" scripts/auth/b2-rehearsal.sh [scratch_db] [hr_designation_id]
#
# Defaults: dnds_rehearsal, designation 11.
#
# What it does, in order:
#   1. refuses to run unless the target is a scratch schema
#   2. snapshots the permissions table so the run is reversible and so the
#      "non-HR permissions unchanged" claim can be PROVEN, not asserted
#   3. applies the B2 key migration to the scratch copy (idempotent)
#   4. applies the policy: all 22 HR keys to the HR designation, none to any
#      other designation, no other permission_key touched
#   5. verifies with b2-rehearsal-verify.sql
#   6. diffs non-HR permissions before/after - must be identical
#   7. starts the Stage 0B app on a private port against the scratch copy and
#      runs the API checks (HR user, non-HR user, admin, bootstrap, anonymous)
#   8. stops the instance and restores config.json
#
# Production is never touched: the app instance runs from THIS checkout on a
# private port with CRON_DISABLED=true, and every database statement names the
# scratch schema. Passwords are generated into a 600 file and never printed.
set -uo pipefail

SCRATCH="${1:-dnds_rehearsal}"
HR_DESIGNATION="${2:-11}"
PORT="${PORT:-18092}"
WT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BIN="${MYSQL_BIN_DIR:-$HOME/mysql84/bin}"
DEFAULTS="${STAGE0A_DEFAULTS:-$HOME/.stage0a/app.cnf}"
OUT="${OUT:-$HOME/db-backups}"
STAMP="$(date +%Y%m%d-%H%M%S)"
LOG="$OUT/b2-rehearsal-$STAMP.log"
APPLOG="$OUT/b2-app-$STAMP.log"
MYSQL="$BIN/mysql"

mkdir -p "$OUT"
exec > >(tee -a "$LOG") 2>&1
fail() { echo "FAIL: $*"; exit 1; }

case "$SCRATCH" in *rehearsal*|*scratch*|*restore_test*) ;; *) fail "refusing to touch '$SCRATCH' - not a scratch schema";; esac
[ -r "$DEFAULTS" ] || fail "defaults file $DEFAULTS missing"
[ -x "$MYSQL" ] || fail "$MYSQL not found (set MYSQL_BIN_DIR)"
Q() { "$MYSQL" --defaults-extra-file="$DEFAULTS" -N -B "$SCRATCH" -e "$1"; }
QT() { "$MYSQL" --defaults-extra-file="$DEFAULTS" --table "$SCRATCH" --init-command="SET @HR_DESIGNATION := $HR_DESIGNATION" -e "$1"; }

echo "== Stage 0B / B2 rehearsal on '$SCRATCH', HR designation $HR_DESIGNATION  ($(date '+%F %T'))"
echo "   checkout $(git -C "$WT" rev-parse --short HEAD) on $(git -C "$WT" branch --show-current)"

# ---- 1. the HR designation must exist -------------------------------------
EXISTS="$(Q "SELECT COUNT(*) FROM designation WHERE designation_id = $HR_DESIGNATION")"
[ "$EXISTS" = "1" ] || fail "designation $HR_DESIGNATION does not exist in $SCRATCH - pass the right id as argument 2"
echo "   HR designation: $(Q "SELECT designation_name FROM designation WHERE designation_id = $HR_DESIGNATION")"

# ---- 2. snapshot, so the run is reversible and provable --------------------
BACKUP="$OUT/permissions-before-$STAMP.tsv"
Q "SELECT permission_key, designation_id, is_active FROM permissions ORDER BY designation_id, permission_key" > "$BACKUP"
chmod 600 "$BACKUP"
NONHR_BEFORE="$OUT/non-hr-before-$STAMP.tsv"
HR_LIST="'view_employees','add_employees','view_banks','add_banks','view_family','add_family','view_documents','add_documents','view_employee_sensitive','edit_employee_sensitive','view_salary_advance','add_salary_advance','view_resignation','add_resignation','view_designation','add_designation','view_department','add_department','view_shift','add_shifts','view_stores','add_stores'"
Q "SELECT permission_key, designation_id, is_active FROM permissions WHERE permission_key NOT IN ($HR_LIST) ORDER BY designation_id, permission_key" > "$NONHR_BEFORE"
echo "   permissions snapshot: $BACKUP ($(wc -l < "$BACKUP") rows); non-HR rows: $(wc -l < "$NONHR_BEFORE")"
echo "   to undo this rehearsal: see the RESTORE line printed at the end"

# ---- 3 + 4. migration keys, then the policy (both idempotent) --------------
echo
echo "== applying the B2 key migration and the policy (run twice to prove idempotency)"
for pass in 1 2; do
  "$MYSQL" --defaults-extra-file="$DEFAULTS" "$SCRATCH" < "$WT/migrations/mysql/migrations/sqls/20260907120000-hr-permission-keys-b2-up.sql" || fail "migration failed"
  "$MYSQL" --defaults-extra-file="$DEFAULTS" "$SCRATCH" --init-command="SET @HR_DESIGNATION := $HR_DESIGNATION" < "$WT/scripts/auth/b2-rehearsal-policy.sql" >/dev/null || fail "policy failed"
  echo "   pass $pass: HR rows now $(Q "SELECT COUNT(*) FROM permissions WHERE designation_id = $HR_DESIGNATION AND permission_key IN ($HR_LIST)")"
done

# ---- 5. verification queries ----------------------------------------------
echo
echo "== verification"
QT "$(cat "$WT/scripts/auth/b2-rehearsal-verify.sql" | grep -v '^SET @HR_DESIGNATION')"

# ---- 6. prove the non-HR permissions did not move --------------------------
NONHR_AFTER="$OUT/non-hr-after-$STAMP.tsv"
Q "SELECT permission_key, designation_id, is_active FROM permissions WHERE permission_key NOT IN ($HR_LIST) ORDER BY designation_id, permission_key" > "$NONHR_AFTER"
if diff -q "$NONHR_BEFORE" "$NONHR_AFTER" >/dev/null; then
  echo "  PASS  non-HR permissions byte-identical before and after ($(wc -l < "$NONHR_AFTER") rows)"
else
  echo "  FAIL  non-HR permissions CHANGED:"; diff "$NONHR_BEFORE" "$NONHR_AFTER" | head -20; fail "policy touched permissions it must not touch"
fi

# ---- 7. API checks against a real instance --------------------------------
echo
echo "== API checks"
OUTLET_HR="$(Q "SELECT CONCAT(u.user_id,'|',u.username,'|',ne.designation_id) FROM \`user\` u JOIN new_employee ne ON ne.employee_id=u.employee_id WHERE u.status=1 AND u.user_type<>2 AND u.is_system_account=0 AND ne.status=1 AND ne.designation_id=$HR_DESIGNATION ORDER BY u.user_id LIMIT 1")"
OUTLET_OTHER="$(Q "SELECT CONCAT(u.user_id,'|',u.username,'|',ne.designation_id) FROM \`user\` u JOIN new_employee ne ON ne.employee_id=u.employee_id WHERE u.status=1 AND u.user_type<>2 AND u.is_system_account=0 AND ne.status=1 AND ne.designation_id<>$HR_DESIGNATION ORDER BY u.user_id LIMIT 1")"
ADMIN_U="$(Q "SELECT CONCAT(u.user_id,'|',u.username,'|0') FROM \`user\` u WHERE u.status=1 AND u.user_type=2 AND u.is_system_account=0 ORDER BY u.user_id LIMIT 1")"

if [ -z "$OUTLET_HR" ]; then
  echo "  INFO  no active non-admin login has designation $HR_DESIGNATION on this copy."
  echo "        The permission policy above is still verified; the API checks need"
  echo "        such a user. Re-run with a designation that has one, or assign one"
  echo "        on the SCRATCH copy only."
  echo
  echo "RESTORE (undo this rehearsal on $SCRATCH):"
  echo "  $MYSQL --defaults-extra-file=$DEFAULTS $SCRATCH -e \"DELETE FROM permissions\" && \\"
  echo "  awk -F'\\t' '{printf \"INSERT INTO permissions (permission_key,designation_id,is_active) VALUES (%c%s%c,%s,%s);\\n\", 39,\$1,39,\$2,\$3}' $BACKUP | $MYSQL --defaults-extra-file=$DEFAULTS $SCRATCH"
  exit 0
fi
[ -n "$OUTLET_OTHER" ] || fail "no active non-admin login outside designation $HR_DESIGNATION - cannot test the negative case"
[ -n "$ADMIN_U" ] || fail "no active admin (user_type 2) login on this copy"

# staging-only passwords on the SCRATCH copy, never printed
SECRETS="$HOME/.stage0a/b2-secrets.env"
umask 077
{
  echo "B2_HR_PASSWORD=$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-20)"
  echo "B2_OTHER_PASSWORD=$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-20)"
  echo "B2_ADMIN_PASSWORD=$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-20)"
} > "$SECRETS"
chmod 600 "$SECRETS"
set -a; . "$SECRETS"; set +a
for pair in "${OUTLET_HR%%|*}:$B2_HR_PASSWORD" "${OUTLET_OTHER%%|*}:$B2_OTHER_PASSWORD" "${ADMIN_U%%|*}:$B2_ADMIN_PASSWORD"; do
  uid="${pair%%:*}"; pw="${pair#*:}"
  Q "UPDATE \`user\` SET password = SHA1('$pw'), password_hash = NULL, password_algo = 'sha1', must_change_password = 0 WHERE user_id = $uid AND is_system_account = 0" || fail "could not set a staging password"
done
ACCOUNTS="$HOME/.stage0a/b2-accounts.env"
{ echo "B2_HR=$OUTLET_HR"; echo "B2_OTHER=$OUTLET_OTHER"; echo "B2_ADMIN=$ADMIN_U"; } > "$ACCOUNTS"
chmod 600 "$ACCOUNTS"
echo "   accounts: HR=${OUTLET_HR#*|} non-HR=${OUTLET_OTHER#*|} admin=${ADMIN_U#*|} (passwords in $SECRETS, 600, never printed)"

cd "$WT"
cp -p config.json config.b2bak.json
node -e 'const fs=require("fs");const c=JSON.parse(fs.readFileSync("config.json","utf8"));c.db.mysql.development.database=process.argv[1];fs.writeFileSync("config.json",JSON.stringify(c,null,2));' "$SCRATCH"
cleanup() { [ -n "${APP:-}" ] && kill "$APP" 2>/dev/null; [ -f config.b2bak.json ] && cp -p config.b2bak.json config.json && rm -f config.b2bak.json; }
trap cleanup EXIT

[ -r "$HOME/.stage0a/jwt.env" ] && { set -a; . "$HOME/.stage0a/jwt.env"; set +a; }
env -u NODE_ENV CRON_DISABLED=true PORT="$PORT" node server.js > "$APPLOG" 2>&1 &
APP=$!
for i in $(seq 1 45); do curl -sS -o /dev/null "http://127.0.0.1:$PORT/user/my-ip" 2>/dev/null && break; sleep 1; done
curl -sS -o /dev/null "http://127.0.0.1:$PORT/user/my-ip" || { tail -5 "$APPLOG"; fail "instance did not start (see $APPLOG)"; }

BASE_URL="http://127.0.0.1:$PORT" ACCOUNTS="$ACCOUNTS" SECRETS="$SECRETS" node scripts/auth/b2-rehearsal-checks.js
CHECKS=$?

echo
echo "report: $LOG   app log: $APPLOG"
echo "RESTORE (undo this rehearsal on $SCRATCH):"
echo "  $MYSQL --defaults-extra-file=$DEFAULTS $SCRATCH -e \"DELETE FROM permissions\" && \\"
echo "  awk -F'\\t' '{printf \"INSERT INTO permissions (permission_key,designation_id,is_active) VALUES (%c%s%c,%s,%s);\\n\", 39,\$1,39,\$2,\$3}' $BACKUP | $MYSQL --defaults-extra-file=$DEFAULTS $SCRATCH"
[ "$CHECKS" = "0" ] && echo "B2 REHEARSAL: ALL CHECKS PASSED" || echo "B2 REHEARSAL: CHECKS FAILED"
exit "$CHECKS"
