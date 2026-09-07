#!/usr/bin/env bash
# Stage 0B / B2 — rehearse the HR permission policy on the SCRATCH copy.
#
# Usage (from ~/stage0a-rehearsal, on the Lightsail host):
#   MYSQL_BIN_DIR="$HOME/mysql84/bin" scripts/auth/b2-rehearsal.sh [scratch_db] [hr_designation_id]
#
# Defaults: dnds_rehearsal, designation 11.
#
# Everything this script changes on the scratch copy it changes back, on
# success AND on failure, and then PROVES it: the undo statements are
# generated from the live rows BEFORE any mutation and executed from an EXIT
# trap, after which each snapshot is re-taken and diffed against the original.
# Four things are mutated and therefore four things are restored:
#
#   1. the `permissions` table (the policy itself)
#   2. the four B2 keys in `all_permissions` - but only the ones that were
#      ABSENT before this run; a key the migration already added stays
#   3. the auth columns of the three users given a staging password
#   4. the `user_auth_log` rows written by the rehearsal's own logins
#
# The scratch-schema guard is unchanged: the script and the policy SQL both
# refuse to touch anything not named like a scratch schema, so dnds_prod
# cannot be reached even by a typo. The app instance runs from THIS checkout
# on a private port with CRON_DISABLED=true.
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
RUN() { "$MYSQL" --defaults-extra-file="$DEFAULTS" "$SCRATCH"; }

HR_LIST="'view_employees','add_employees','view_banks','add_banks','view_family','add_family','view_documents','add_documents','view_employee_sensitive','edit_employee_sensitive','view_salary_advance','add_salary_advance','view_resignation','add_resignation','view_designation','add_designation','view_department','add_department','view_shift','add_shifts','view_stores','add_stores'"
B2_KEYS="'view_employee_sensitive','edit_employee_sensitive','add_documents','add_stores'"

echo "== Stage 0B / B2 rehearsal on '$SCRATCH', HR designation $HR_DESIGNATION  ($(date '+%F %T'))"
echo "   checkout $(git -C "$WT" rev-parse --short HEAD) on $(git -C "$WT" branch --show-current)"

EXISTS="$(Q "SELECT COUNT(*) FROM designation WHERE designation_id = $HR_DESIGNATION")"
[ "$EXISTS" = "1" ] || fail "designation $HR_DESIGNATION does not exist in $SCRATCH - pass the right id as argument 2"
echo "   HR designation: $(Q "SELECT designation_name FROM designation WHERE designation_id = $HR_DESIGNATION")"

# ---------------------------------------------------------------- snapshots
# Undo statements are GENERATED FROM THE LIVE ROWS, with QUOTE() so NULL comes
# back as NULL and not as the string "NULL". Nothing has been mutated yet.
SNAP="$OUT/b2-snapshot-$STAMP"
mkdir -p "$SNAP"; chmod 700 "$SNAP"
RESTORE_SQL="$SNAP/restore.sql"
: > "$RESTORE_SQL"; chmod 600 "$RESTORE_SQL"

# (1) permissions - the whole table, so the policy is fully reversible
Q "SELECT permission_key, designation_id, is_active FROM permissions ORDER BY designation_id, permission_key" > "$SNAP/permissions-before.tsv"
Q "SELECT permission_key, designation_id, is_active FROM permissions WHERE permission_key NOT IN ($HR_LIST) ORDER BY designation_id, permission_key" > "$SNAP/non-hr-before.tsv"
{
  echo "-- (1) permissions: replace the whole table with its pre-rehearsal contents"
  echo "DELETE FROM \`permissions\`;"
  Q "SELECT CONCAT('INSERT INTO \`permissions\` (\`permission_key\`,\`designation_id\`,\`is_active\`) VALUES (', QUOTE(permission_key), ',', QUOTE(designation_id), ',', QUOTE(is_active), ');') FROM permissions ORDER BY designation_id, permission_key"
} >> "$RESTORE_SQL"

# (2) all_permissions: which of the four B2 keys are ABSENT right now. Only
#     those get deleted on the way out - a key that already existed (because
#     the migration ran here earlier) must survive.
Q "SELECT permission_key FROM all_permissions WHERE permission_key IN ($B2_KEYS) ORDER BY permission_key" > "$SNAP/b2-keys-present-before.tsv"
ABSENT="$(Q "SELECT GROUP_CONCAT(CONCAT('''', k.permission_key, '''')) FROM (SELECT 'view_employee_sensitive' AS permission_key UNION ALL SELECT 'edit_employee_sensitive' UNION ALL SELECT 'add_documents' UNION ALL SELECT 'add_stores') k WHERE NOT EXISTS (SELECT 1 FROM all_permissions ap WHERE ap.permission_key = k.permission_key)")"
Q "SELECT permission_key FROM all_permissions ORDER BY permission_key" > "$SNAP/all-permissions-before.tsv"
if [ -n "$ABSENT" ] && [ "$ABSENT" != "NULL" ]; then
  echo "-- (2) all_permissions: remove only the B2 keys that did not exist before" >> "$RESTORE_SQL"
  echo "DELETE FROM \`all_permissions\` WHERE \`permission_key\` IN ($ABSENT);" >> "$RESTORE_SQL"
  echo "   B2 keys absent before this run (will be removed again afterwards): $ABSENT"
else
  echo "   all four B2 keys already exist here (migration applied earlier): none will be removed"
fi

# (3) user_auth_log: remember the high-water mark so the rehearsal's own
#     login rows can be removed. Audit rows about a test are not history.
LOG_MAX="$(Q "SELECT IFNULL(MAX(log_id), 0) FROM user_auth_log" 2>/dev/null || echo "")"
[ -n "$LOG_MAX" ] && echo "-- (3) user_auth_log: drop rows written by this rehearsal
DELETE FROM \`user_auth_log\` WHERE log_id > $LOG_MAX;" >> "$RESTORE_SQL"

echo "   snapshot: $SNAP  (permissions $(wc -l < "$SNAP/permissions-before.tsv") rows, non-HR $(wc -l < "$SNAP/non-hr-before.tsv") rows)"

# ------------------------------------------------------------- restore trap
# Runs on EVERY exit: success, failure, or interrupt.
RESTORED=0
restore_all() {
  [ "$RESTORED" = "1" ] && return
  RESTORED=1
  echo
  echo "== restoring $SCRATCH to its pre-rehearsal state"
  [ -n "${APP:-}" ] && { kill "$APP" 2>/dev/null; wait "$APP" 2>/dev/null; echo "   app instance stopped"; }
  if [ -f "$WT/config.b2bak.json" ]; then
    cp -p "$WT/config.b2bak.json" "$WT/config.json" && rm -f "$WT/config.b2bak.json"
    echo "   config.json restored -> $(node -e 'console.log(require(process.argv[1]).db.mysql.development.database)' "$WT/config.json")"
  fi
  if RUN < "$RESTORE_SQL"; then
    echo "   database statements applied"
  else
    echo "   RESTORE FAILED - the undo script is $RESTORE_SQL; run it by hand:"
    echo "     $MYSQL --defaults-extra-file=$DEFAULTS $SCRATCH < $RESTORE_SQL"
    return
  fi

  # prove it, rather than assert it
  local bad=0
  Q "SELECT permission_key, designation_id, is_active FROM permissions ORDER BY designation_id, permission_key" > "$SNAP/permissions-after.tsv"
  if diff -q "$SNAP/permissions-before.tsv" "$SNAP/permissions-after.tsv" >/dev/null; then
    echo "  PASS  permissions identical to before ($(wc -l < "$SNAP/permissions-after.tsv") rows)"
  else
    echo "  FAIL  permissions differ:"; diff "$SNAP/permissions-before.tsv" "$SNAP/permissions-after.tsv" | head -10; bad=1
  fi
  Q "SELECT permission_key FROM all_permissions ORDER BY permission_key" > "$SNAP/all-permissions-after.tsv"
  if diff -q "$SNAP/all-permissions-before.tsv" "$SNAP/all-permissions-after.tsv" >/dev/null; then
    echo "  PASS  all_permissions identical to before ($(wc -l < "$SNAP/all-permissions-after.tsv") keys)"
  else
    echo "  FAIL  all_permissions differ:"; diff "$SNAP/all-permissions-before.tsv" "$SNAP/all-permissions-after.tsv" | head -10; bad=1
  fi
  if [ -s "$SNAP/user-auth-before.tsv" ]; then
    Q "SELECT $AUTH_COLS FROM \`user\` WHERE user_id IN ($TOUCHED_IDS) ORDER BY user_id" > "$SNAP/user-auth-after.tsv"
    if diff -q "$SNAP/user-auth-before.tsv" "$SNAP/user-auth-after.tsv" >/dev/null; then
      echo "  PASS  auth fields of the $(wc -l < "$SNAP/user-auth-after.tsv") touched users identical to before"
    else
      echo "  FAIL  user auth fields differ:"; diff "$SNAP/user-auth-before.tsv" "$SNAP/user-auth-after.tsv" | head -10; bad=1
    fi
  fi
  [ -n "$LOG_MAX" ] && echo "  info  user_auth_log rows above $LOG_MAX removed (now max $(Q "SELECT IFNULL(MAX(log_id),0) FROM user_auth_log"))"
  [ "$bad" = "0" ] && echo "  RESTORE VERIFIED: $SCRATCH is byte-identical to its pre-rehearsal state" \
                   || echo "  RESTORE INCOMPLETE - see the differences above; undo script: $RESTORE_SQL"
}
AUTH_COLS=""; TOUCHED_IDS=""
: > "$SNAP/user-auth-before.tsv"
trap restore_all EXIT INT TERM

# ------------------------------------- migration keys + policy (idempotent)
echo
echo "== applying the B2 key migration and the policy (run twice to prove idempotency)"
for pass in 1 2; do
  RUN < "$WT/migrations/mysql/migrations/sqls/20260907120000-hr-permission-keys-b2-up.sql" || fail "migration failed"
  "$MYSQL" --defaults-extra-file="$DEFAULTS" "$SCRATCH" --init-command="SET @HR_DESIGNATION := $HR_DESIGNATION" < "$WT/scripts/auth/b2-rehearsal-policy.sql" >/dev/null || fail "policy failed"
  echo "   pass $pass: HR rows now $(Q "SELECT COUNT(*) FROM permissions WHERE designation_id = $HR_DESIGNATION AND permission_key IN ($HR_LIST)")"
done

echo
echo "== verification"
QT "$(grep -v '^SET @HR_DESIGNATION' "$WT/scripts/auth/b2-rehearsal-verify.sql")"

Q "SELECT permission_key, designation_id, is_active FROM permissions WHERE permission_key NOT IN ($HR_LIST) ORDER BY designation_id, permission_key" > "$SNAP/non-hr-during.tsv"
if diff -q "$SNAP/non-hr-before.tsv" "$SNAP/non-hr-during.tsv" >/dev/null; then
  echo "  PASS  non-HR permissions untouched by the policy ($(wc -l < "$SNAP/non-hr-during.tsv") rows)"
else
  echo "  FAIL  the policy touched non-HR permissions:"; diff "$SNAP/non-hr-before.tsv" "$SNAP/non-hr-during.tsv" | head -20; fail "policy touched permissions it must not touch"
fi

# ------------------------------------------------------------- API checks
echo
echo "== API checks"
HR_USER="$(Q "SELECT CONCAT(u.user_id,'|',u.username,'|',ne.designation_id) FROM \`user\` u JOIN new_employee ne ON ne.employee_id=u.employee_id WHERE u.status=1 AND u.user_type<>2 AND u.is_system_account=0 AND ne.status=1 AND ne.designation_id=$HR_DESIGNATION ORDER BY u.user_id LIMIT 1")"
OTHER_USER="$(Q "SELECT CONCAT(u.user_id,'|',u.username,'|',ne.designation_id) FROM \`user\` u JOIN new_employee ne ON ne.employee_id=u.employee_id WHERE u.status=1 AND u.user_type<>2 AND u.is_system_account=0 AND ne.status=1 AND ne.designation_id<>$HR_DESIGNATION ORDER BY u.user_id LIMIT 1")"
ADMIN_U="$(Q "SELECT CONCAT(u.user_id,'|',u.username,'|0') FROM \`user\` u WHERE u.status=1 AND u.user_type=2 AND u.is_system_account=0 ORDER BY u.user_id LIMIT 1")"

if [ -z "$HR_USER" ] || [ -z "$OTHER_USER" ] || [ -z "$ADMIN_U" ]; then
  echo "  INFO  this copy lacks one of the three logins the API checks need:"
  echo "        HR (designation $HR_DESIGNATION): ${HR_USER:-MISSING}"
  echo "        non-HR:                           ${OTHER_USER:-MISSING}"
  echo "        admin (user_type 2):              ${ADMIN_U:-MISSING}"
  echo "        The permission policy above is verified; the API half is skipped."
  echo "        No user row was modified. Re-run with a designation that has a login."
  exit 0
fi

# (4) snapshot the auth columns of exactly the users about to be changed.
#     The column list is intersected with information_schema, so a copy
#     without a Stage 0A column is handled rather than crashed on.
TOUCHED_IDS="${HR_USER%%|*},${OTHER_USER%%|*},${ADMIN_U%%|*}"
AUTH_COLS="$(Q "SELECT GROUP_CONCAT(CONCAT('\`', COLUMN_NAME, '\`') ORDER BY ORDINAL_POSITION) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='$SCRATCH' AND TABLE_NAME='user' AND COLUMN_NAME IN ('user_id','password','password_hash','password_algo','must_change_password','password_flag_reason','failed_login_count','locked_until','last_login_at','token_valid_from','credential_rotated_at')")"
[ -n "$AUTH_COLS" ] || fail "could not read the user table's auth columns"
Q "SELECT $AUTH_COLS FROM \`user\` WHERE user_id IN ($TOUCHED_IDS) ORDER BY user_id" > "$SNAP/user-auth-before.tsv"
{
  echo "-- (4) user: restore the auth columns of the users given a staging password"
  Q "SELECT CONCAT('UPDATE \`user\` SET ',
       GROUP_CONCAT(CONCAT(c.col, '=', c.val) SEPARATOR ', '),
       ' WHERE user_id=', c.user_id, ';')
     FROM (
       SELECT user_id, 'password' AS col, QUOTE(password) AS val FROM \`user\` WHERE user_id IN ($TOUCHED_IDS)
       UNION ALL SELECT user_id, 'password_hash', QUOTE(password_hash) FROM \`user\` WHERE user_id IN ($TOUCHED_IDS)
       UNION ALL SELECT user_id, 'password_algo', QUOTE(password_algo) FROM \`user\` WHERE user_id IN ($TOUCHED_IDS)
       UNION ALL SELECT user_id, 'must_change_password', QUOTE(must_change_password) FROM \`user\` WHERE user_id IN ($TOUCHED_IDS)
       UNION ALL SELECT user_id, 'password_flag_reason', QUOTE(password_flag_reason) FROM \`user\` WHERE user_id IN ($TOUCHED_IDS)
       UNION ALL SELECT user_id, 'failed_login_count', QUOTE(failed_login_count) FROM \`user\` WHERE user_id IN ($TOUCHED_IDS)
       UNION ALL SELECT user_id, 'locked_until', QUOTE(locked_until) FROM \`user\` WHERE user_id IN ($TOUCHED_IDS)
       UNION ALL SELECT user_id, 'last_login_at', QUOTE(last_login_at) FROM \`user\` WHERE user_id IN ($TOUCHED_IDS)
       UNION ALL SELECT user_id, 'token_valid_from', QUOTE(token_valid_from) FROM \`user\` WHERE user_id IN ($TOUCHED_IDS)
     ) c
     GROUP BY c.user_id"
} >> "$RESTORE_SQL"
echo "   auth snapshot taken for user_id in ($TOUCHED_IDS); undo statements appended to $RESTORE_SQL"

SECRETS="$HOME/.stage0a/b2-secrets.env"
umask 077
{
  echo "B2_HR_PASSWORD=$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-20)"
  echo "B2_OTHER_PASSWORD=$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-20)"
  echo "B2_ADMIN_PASSWORD=$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-20)"
} > "$SECRETS"
chmod 600 "$SECRETS"
set -a; . "$SECRETS"; set +a
for pair in "${HR_USER%%|*}:$B2_HR_PASSWORD" "${OTHER_USER%%|*}:$B2_OTHER_PASSWORD" "${ADMIN_U%%|*}:$B2_ADMIN_PASSWORD"; do
  uid="${pair%%:*}"; pw="${pair#*:}"
  Q "UPDATE \`user\` SET password = SHA1('$pw'), password_hash = NULL, password_algo = 'sha1', must_change_password = 0 WHERE user_id = $uid AND is_system_account = 0" || fail "could not set a staging password"
done
ACCOUNTS="$HOME/.stage0a/b2-accounts.env"
{ echo "B2_HR=$HR_USER"; echo "B2_OTHER=$OTHER_USER"; echo "B2_ADMIN=$ADMIN_U"; } > "$ACCOUNTS"
chmod 600 "$ACCOUNTS"
echo "   accounts: HR=${HR_USER#*|} non-HR=${OTHER_USER#*|} admin=${ADMIN_U#*|} (passwords in $SECRETS, 600, never printed)"

cd "$WT"
cp -p config.json config.b2bak.json
node -e 'const fs=require("fs");const c=JSON.parse(fs.readFileSync("config.json","utf8"));c.db.mysql.development.database=process.argv[1];fs.writeFileSync("config.json",JSON.stringify(c,null,2));' "$SCRATCH"

[ -r "$HOME/.stage0a/jwt.env" ] && { set -a; . "$HOME/.stage0a/jwt.env"; set +a; }
env -u NODE_ENV CRON_DISABLED=true PORT="$PORT" node server.js > "$APPLOG" 2>&1 &
APP=$!
# --max-time matters: a port held open by something that never answers would
# otherwise hang the readiness loop forever, leaving the scratch copy in its
# mutated state until someone noticed.
for i in $(seq 1 45); do curl -sS -m 3 -o /dev/null "http://127.0.0.1:$PORT/user/my-ip" 2>/dev/null && break; sleep 1; done
curl -sS -m 5 -o /dev/null "http://127.0.0.1:$PORT/user/my-ip" || { tail -5 "$APPLOG"; fail "instance did not start or did not answer (see $APPLOG)"; }

BASE_URL="http://127.0.0.1:$PORT" ACCOUNTS="$ACCOUNTS" SECRETS="$SECRETS" node scripts/auth/b2-rehearsal-checks.js
CHECKS=$?

echo
echo "report: $LOG   app log: $APPLOG"
[ "$CHECKS" = "0" ] && echo "B2 REHEARSAL: ALL CHECKS PASSED" || echo "B2 REHEARSAL: CHECKS FAILED"
exit "$CHECKS"
