#!/usr/bin/env bash
# Stage 0B / B3 — rehearse sensitive-field protection on the SCRATCH copy.
#
# Usage (from the rehearsal checkout, on the Lightsail host):
#   MYSQL_BIN_DIR="$HOME/mysql84/bin" scripts/auth/b3-rehearsal.sh [scratch_db] [hr_designation_id]
#
# Defaults: dnds_rehearsal, designation 11.
#
# B2 rehearsed "who may reach an endpoint". B3 rehearses "who may see and
# change the fields inside it", which needs a caller B2's policy does not
# produce: someone who holds view_employees and view_documents but NOT
# view_employee_sensitive. That caller is created here, temporarily, on a
# designation that already exists in the copy, and removed again.
#
# Everything this script changes it changes back, on success AND on failure,
# and then proves it. Five things are mutated and five are restored:
#
#   1. the `permissions` table (the B2 policy plus the directory-only grant)
#   2. the four B2 keys in `all_permissions` - only those ABSENT before
#   3. the auth columns of the three users given a staging password
#   4. the `user_auth_log` rows written by the rehearsal's own logins
#   5. the two columns of the one employee row the write checks touch
#
# Exit status: 0 only when the rehearsal passed AND the copy was restored and
# verified. 130 = interrupted, 143 = terminated, 3 = the rehearsal passed but
# the restore did not, any other non-zero = the rehearsal's own failure.
#
# The scratch-schema guard is the same one B2 uses: this script and every SQL
# file it runs refuse anything not named like a scratch copy, so dnds_prod
# cannot be reached by a typo. The app instance runs from THIS checkout on a
# private port with CRON_DISABLED=true.
set -uo pipefail

SCRATCH="${1:-dnds_rehearsal}"
HR_DESIGNATION="${2:-11}"
PORT="${PORT:-18093}"
WT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BIN="${MYSQL_BIN_DIR:-$HOME/mysql84/bin}"
DEFAULTS="${STAGE0A_DEFAULTS:-$HOME/.stage0a/app.cnf}"
OUT="${OUT:-$HOME/db-backups}"
STAMP="$(date +%Y%m%d-%H%M%S)"
LOG="$OUT/b3-rehearsal-$STAMP.log"
APPLOG="$OUT/b3-app-$STAMP.log"
MYSQL="$BIN/mysql"

mkdir -p "$OUT"
exec > >(tee -a "$LOG") 2>&1
fail() { echo "FAIL: $*"; exit 1; }

case "$SCRATCH" in *rehearsal*|*scratch*|*restore_test*) ;; *) fail "refusing to touch '$SCRATCH' - not a scratch schema";; esac
[ -r "$DEFAULTS" ] || fail "defaults file $DEFAULTS missing"
[ -x "$MYSQL" ] || fail "$MYSQL not found (set MYSQL_BIN_DIR)"
Q() { "$MYSQL" --defaults-extra-file="$DEFAULTS" -N -B "$SCRATCH" -e "$1"; }
QT() { "$MYSQL" --defaults-extra-file="$DEFAULTS" --table "$SCRATCH" -e "$1"; }
RUN() { "$MYSQL" --defaults-extra-file="$DEFAULTS" "$SCRATCH"; }

HR_LIST="'view_employees','add_employees','view_banks','add_banks','view_family','add_family','view_documents','add_documents','view_employee_sensitive','edit_employee_sensitive','view_salary_advance','add_salary_advance','view_resignation','add_resignation','view_designation','add_designation','view_department','add_department','view_shift','add_shifts','view_stores','add_stores'"
B2_KEYS="'view_employee_sensitive','edit_employee_sensitive','add_documents','add_stores'"
# What the directory-only caller gets: enough to run the staff list and the
# document screen, and nothing that touches sensitive data.
DIRECTORY_KEYS="'view_employees','add_employees','view_documents'"

echo "== Stage 0B / B3 rehearsal on '$SCRATCH', HR designation $HR_DESIGNATION  ($(date '+%F %T'))"
echo "   checkout $(git -C "$WT" rev-parse --short HEAD) on $(git -C "$WT" branch --show-current)"

EXISTS="$(Q "SELECT COUNT(*) FROM designation WHERE designation_id = $HR_DESIGNATION")"
[ "$EXISTS" = "1" ] || fail "designation $HR_DESIGNATION does not exist in $SCRATCH - pass the right id as argument 2"

# ------------------------------------------------------------------ accounts
# Chosen BEFORE anything is mutated, because the directory grant below is
# written against the non-HR user's own designation.
HR_USER="$(Q "SELECT CONCAT(u.user_id,'|',u.username,'|',ne.designation_id) FROM \`user\` u JOIN new_employee ne ON ne.employee_id=u.employee_id WHERE u.status=1 AND u.user_type<>2 AND u.is_system_account=0 AND ne.status=1 AND ne.designation_id=$HR_DESIGNATION ORDER BY u.user_id LIMIT 1")"
DIR_USER="$(Q "SELECT CONCAT(u.user_id,'|',u.username,'|',ne.designation_id) FROM \`user\` u JOIN new_employee ne ON ne.employee_id=u.employee_id WHERE u.status=1 AND u.user_type<>2 AND u.is_system_account=0 AND ne.status=1 AND ne.designation_id<>$HR_DESIGNATION ORDER BY u.user_id LIMIT 1")"
ADMIN_U="$(Q "SELECT CONCAT(u.user_id,'|',u.username,'|0') FROM \`user\` u WHERE u.status=1 AND u.user_type=2 AND u.is_system_account=0 ORDER BY u.user_id LIMIT 1")"
if [ -z "$HR_USER" ] || [ -z "$DIR_USER" ] || [ -z "$ADMIN_U" ]; then
  echo "  INFO  this copy lacks one of the three logins the checks need:"
  echo "        HR (designation $HR_DESIGNATION): ${HR_USER:-MISSING}"
  echo "        non-HR:                           ${DIR_USER:-MISSING}"
  echo "        admin (user_type 2):              ${ADMIN_U:-MISSING}"
  echo "        Nothing has been modified. Re-run with a designation that has a login."
  exit 0
fi
DIR_DESIGNATION="${DIR_USER##*|}"
[ -n "$DIR_DESIGNATION" ] || fail "could not read the non-HR user's designation"
[ "$DIR_DESIGNATION" != "$HR_DESIGNATION" ] || fail "the two test users share a designation - the split cannot be tested"

# The employee row the write checks touch, and the two columns they change.
TARGET_EMPLOYEE="$(Q "SELECT employee_id FROM new_employee WHERE status = 1 AND salary IS NOT NULL ORDER BY employee_id LIMIT 1")"
[ -n "$TARGET_EMPLOYEE" ] || fail "no active employee with a salary to use as the write target"
TARGET_SALARY="$(Q "SELECT IFNULL(salary, 0) FROM new_employee WHERE employee_id = $TARGET_EMPLOYEE")"

echo "   HR designation: $(Q "SELECT designation_name FROM designation WHERE designation_id = $HR_DESIGNATION")"
echo "   directory-only designation for this run: $DIR_DESIGNATION ($(Q "SELECT IFNULL(designation_name,'?') FROM designation WHERE designation_id = $DIR_DESIGNATION"))"
echo "   write target: employee $TARGET_EMPLOYEE (its salary is written back unchanged)"

# ---------------------------------------------------------------- snapshots
SNAP="$OUT/b3-snapshot-$STAMP"
mkdir -p "$SNAP"; chmod 700 "$SNAP"
RESTORE_SQL="$SNAP/restore.sql"
: > "$RESTORE_SQL"; chmod 600 "$RESTORE_SQL"

# (1) permissions - the whole table, so both the policy and the temporary
#     directory grant are fully reversible.
Q "SELECT permission_key, designation_id, is_active FROM permissions ORDER BY designation_id, permission_key" > "$SNAP/permissions-before.tsv"
Q "SELECT permission_key, designation_id, is_active FROM permissions WHERE permission_key NOT IN ($HR_LIST) ORDER BY designation_id, permission_key" > "$SNAP/non-hr-before.tsv"
{
  echo "-- (1) permissions: replace the whole table with its pre-rehearsal contents"
  echo "DELETE FROM \`permissions\`;"
  Q "SELECT CONCAT('INSERT INTO \`permissions\` (\`permission_key\`,\`designation_id\`,\`is_active\`) VALUES (', QUOTE(permission_key), ',', QUOTE(designation_id), ',', QUOTE(is_active), ');') FROM permissions ORDER BY designation_id, permission_key"
} >> "$RESTORE_SQL"

# (2) all_permissions: only the B2 keys that are absent right now get removed.
Q "SELECT permission_key FROM all_permissions ORDER BY permission_key" > "$SNAP/all-permissions-before.tsv"
ABSENT="$(Q "SELECT GROUP_CONCAT(CONCAT('''', k.permission_key, '''')) FROM (SELECT 'view_employee_sensitive' AS permission_key UNION ALL SELECT 'edit_employee_sensitive' UNION ALL SELECT 'add_documents' UNION ALL SELECT 'add_stores') k WHERE NOT EXISTS (SELECT 1 FROM all_permissions ap WHERE ap.permission_key = k.permission_key)")"
if [ -n "$ABSENT" ] && [ "$ABSENT" != "NULL" ]; then
  echo "-- (2) all_permissions: remove only the B2 keys that did not exist before" >> "$RESTORE_SQL"
  echo "DELETE FROM \`all_permissions\` WHERE \`permission_key\` IN ($ABSENT);" >> "$RESTORE_SQL"
  echo "   B2 keys absent before this run (removed again afterwards): $ABSENT"
fi

# (3) user_auth_log high-water mark: audit rows about a test are not history.
LOG_MAX="$(Q "SELECT IFNULL(MAX(log_id), 0) FROM user_auth_log" 2>/dev/null || echo "")"
[ -n "$LOG_MAX" ] && echo "-- (3) user_auth_log: drop rows written by this rehearsal
DELETE FROM \`user_auth_log\` WHERE log_id > $LOG_MAX;" >> "$RESTORE_SQL"

# (5) the one employee row the write checks touch. QUOTE() so a NULL comes
#     back as NULL rather than as the string 'NULL'.
Q "SELECT employee_id, salary, blood_group FROM new_employee WHERE employee_id = $TARGET_EMPLOYEE" > "$SNAP/employee-before.tsv"
{
  echo "-- (5) the write target's two columns, exactly as they were"
  Q "SELECT CONCAT('UPDATE \`new_employee\` SET \`salary\` = ', QUOTE(salary), ', \`blood_group\` = ', QUOTE(blood_group), ' WHERE employee_id = ', employee_id, ';') FROM new_employee WHERE employee_id = $TARGET_EMPLOYEE"
} >> "$RESTORE_SQL"

echo "   snapshot: $SNAP  (permissions $(wc -l < "$SNAP/permissions-before.tsv") rows, non-HR $(wc -l < "$SNAP/non-hr-before.tsv") rows)"

# ------------------------------------------------------------- restore trap
# Identical discipline to B2: ONE handler on EXIT restores exactly once; INT
# and TERM only record the conventional status and exit, so a Ctrl-C can
# never resume into a later mutation, and never restores twice.
RESTORE_FAILED_RC=3
RESTORED=0
RESTORE_RC=0
SIGNAL_RC=0
AUTH_COLS=""; TOUCHED_IDS=""; AUTH_SNAPSHOT=""
: > "$SNAP/user-auth-before.tsv"

on_signal() {
  echo
  echo "== $1 received - stopping before any further change to $SCRATCH"
  SIGNAL_RC="$2"
  exit "$2"
}

on_exit() {
  local rc=$?
  [ "$SIGNAL_RC" != "0" ] && rc="$SIGNAL_RC"
  restore_all
  if [ "$RESTORE_RC" != "0" ]; then
    echo "  the scratch copy is NOT back to its pre-rehearsal state - see above"
    [ "$rc" = "0" ] && rc="$RESTORE_FAILED_RC"
  fi
  trap - EXIT
  exit "$rc"
}

restore_all() {
  [ "$RESTORED" = "1" ] && return
  RESTORED=1
  echo
  echo "== restoring $SCRATCH to its pre-rehearsal state"
  [ -n "${APP:-}" ] && { kill "$APP" 2>/dev/null; wait "$APP" 2>/dev/null; echo "   app instance stopped"; }
  if [ -f "$WT/config.b3bak.json" ]; then
    cp -p "$WT/config.b3bak.json" "$WT/config.json" && rm -f "$WT/config.b3bak.json"
    echo "   config.json restored -> $(node -e 'console.log(require(process.argv[1]).db.mysql.development.database)' "$WT/config.json")"
  fi
  if [ -s "${AUTH_SNAPSHOT:-}" ]; then
    if node "$WT/scripts/auth/b2-user-auth.js" restore --db "$SCRATCH" --in "$AUTH_SNAPSHOT" --config "$WT/config.json"; then
      echo "   user auth columns restored and verified"
    else
      echo "   USER AUTH RESTORE FAILED - recover with:"
      echo "     node $WT/scripts/auth/b2-user-auth.js restore --db $SCRATCH --in $AUTH_SNAPSHOT --config $WT/config.json"
      RESTORE_RC=1
    fi
  fi
  if RUN < "$RESTORE_SQL"; then
    echo "   database statements applied"
  else
    echo "   RESTORE FAILED - the undo script is $RESTORE_SQL; run it by hand:"
    echo "     $MYSQL --defaults-extra-file=$DEFAULTS $SCRATCH < $RESTORE_SQL"
    RESTORE_RC=1
    return
  fi

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
  Q "SELECT employee_id, salary, blood_group FROM new_employee WHERE employee_id = $TARGET_EMPLOYEE" > "$SNAP/employee-after.tsv"
  if diff -q "$SNAP/employee-before.tsv" "$SNAP/employee-after.tsv" >/dev/null; then
    echo "  PASS  the write target's row is identical to before"
  else
    echo "  FAIL  the write target's row differs:"; diff "$SNAP/employee-before.tsv" "$SNAP/employee-after.tsv" | head -5; bad=1
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
  if [ "$bad" = "0" ]; then
    echo "  RESTORE VERIFIED: $SCRATCH is byte-identical to its pre-rehearsal state"
  else
    echo "  RESTORE INCOMPLETE - see the differences above; undo script: $RESTORE_SQL"
    RESTORE_RC=1
  fi
}
trap on_exit EXIT
trap 'on_signal SIGINT 130' INT
trap 'on_signal SIGTERM 143' TERM

# --------------------------------------------- keys, B2 policy, B3 overlay
echo
echo "== applying the B2 key migration and policy, then the B3 directory grant (twice, to prove idempotency)"
for pass in 1 2; do
  RUN < "$WT/migrations/mysql/migrations/sqls/20260907120000-hr-permission-keys-b2-up.sql" || fail "migration failed"
  "$MYSQL" --defaults-extra-file="$DEFAULTS" "$SCRATCH" --init-command="SET @HR_DESIGNATION := $HR_DESIGNATION" < "$WT/scripts/auth/b2-rehearsal-policy.sql" >/dev/null || fail "policy failed"
  # The directory-only caller: cleared first so a second pass converges.
  RUN <<SQL || fail "directory grant failed"
DELETE FROM \`permissions\` WHERE designation_id = $DIR_DESIGNATION AND permission_key IN ($HR_LIST);
INSERT INTO \`permissions\` (\`permission_key\`, \`designation_id\`, \`is_active\`)
SELECT k.permission_key, $DIR_DESIGNATION, 1 FROM (
  SELECT 'view_employees' AS permission_key UNION ALL SELECT 'add_employees' UNION ALL SELECT 'view_documents'
) k;
SQL
  echo "   pass $pass: HR keys $(Q "SELECT COUNT(*) FROM permissions WHERE designation_id = $HR_DESIGNATION AND permission_key IN ($HR_LIST)"), directory keys $(Q "SELECT COUNT(*) FROM permissions WHERE designation_id = $DIR_DESIGNATION AND permission_key IN ($HR_LIST)")"
done

SENSITIVE_ON_DIR="$(Q "SELECT COUNT(*) FROM permissions WHERE designation_id = $DIR_DESIGNATION AND permission_key IN ('view_employee_sensitive','edit_employee_sensitive') AND is_active = 1")"
[ "$SENSITIVE_ON_DIR" = "0" ] || fail "the directory designation still holds a sensitive key - the test would prove nothing"
echo "   directory designation $DIR_DESIGNATION holds $DIRECTORY_KEYS and no sensitive key"

Q "SELECT permission_key, designation_id, is_active FROM permissions WHERE permission_key NOT IN ($HR_LIST) ORDER BY designation_id, permission_key" > "$SNAP/non-hr-during.tsv"
if diff -q "$SNAP/non-hr-before.tsv" "$SNAP/non-hr-during.tsv" >/dev/null; then
  echo "  PASS  non-HR permissions untouched ($(wc -l < "$SNAP/non-hr-during.tsv") rows)"
else
  echo "  FAIL  the policy touched non-HR permissions:"; diff "$SNAP/non-hr-before.tsv" "$SNAP/non-hr-during.tsv" | head -20; fail "policy touched permissions it must not touch"
fi

# ------------------------------------------------------- staging logins
TOUCHED_IDS="${HR_USER%%|*},${DIR_USER%%|*},${ADMIN_U%%|*}"
AUTH_COLS="$(Q "SELECT GROUP_CONCAT(CONCAT('\`', COLUMN_NAME, '\`') ORDER BY ORDINAL_POSITION) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='$SCRATCH' AND TABLE_NAME='user' AND COLUMN_NAME IN ('user_id','password','password_hash','password_algo','must_change_password','password_flag_reason','failed_login_count','locked_until','last_login_at','token_valid_from','credential_rotated_at')")"
[ -n "$AUTH_COLS" ] || fail "could not read the user table's auth columns"
Q "SELECT $AUTH_COLS FROM \`user\` WHERE user_id IN ($TOUCHED_IDS) ORDER BY user_id" > "$SNAP/user-auth-before.tsv"

# Captured through the driver into JSON and written back as bound parameters -
# the B2 lesson: building these statements in SQL failed with ERROR 1270 AFTER
# the passwords had been changed. Capturing first, and aborting here if it does
# not work, is what makes that impossible.
AUTH_SNAPSHOT="$SNAP/user-auth-before.json"
node "$WT/scripts/auth/b2-user-auth.js" capture --db "$SCRATCH" --users "$TOUCHED_IDS" --out "$AUTH_SNAPSHOT" --config "$WT/config.json" \
  || fail "could not capture the users' auth columns - NO password has been changed"
[ -s "$AUTH_SNAPSHOT" ] || fail "auth snapshot is empty - NO password has been changed"

SECRETS="$HOME/.stage0a/b3-secrets.env"
umask 077
{
  echo "B3_HR_PASSWORD=$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-20)"
  echo "B3_DIRECTORY_PASSWORD=$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-20)"
  echo "B3_ADMIN_PASSWORD=$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-20)"
} > "$SECRETS"
chmod 600 "$SECRETS"
set -a; . "$SECRETS"; set +a

# Same normalisation B2 needed: a copy of production carries whatever state
# these accounts are in, and an IP-restricted account is correctly refused
# from a loopback instance. Every column touched here is in the snapshot.
for pair in "${HR_USER%%|*}:$B3_HR_PASSWORD" "${DIR_USER%%|*}:$B3_DIRECTORY_PASSWORD" "${ADMIN_U%%|*}:$B3_ADMIN_PASSWORD"; do
  uid="${pair%%:*}"; pw="${pair#*:}"
  Q "UPDATE \`user\` SET password = SHA1('$pw'), password_hash = NULL, password_algo = 'sha1',
       must_change_password = 0, password_flag_reason = NULL,
       failed_login_count = 0, locked_until = NULL, token_valid_from = NULL,
       ip_policy = 'unrestricted', allowed_ips = NULL
     WHERE user_id = $uid AND is_system_account = 0" || fail "could not set the staging login state"
done
echo "   staging login state normalised for $TOUCHED_IDS (credential, lockout counters, token cut-off, forced-change flag, IP policy)"

ACCOUNTS="$HOME/.stage0a/b3-accounts.env"
{
  echo "B3_HR=$HR_USER"
  echo "B3_DIRECTORY=$DIR_USER"
  echo "B3_ADMIN=$ADMIN_U"
  echo "B3_TARGET_EMPLOYEE=$TARGET_EMPLOYEE"
  echo "B3_TARGET_SALARY=$TARGET_SALARY"
} > "$ACCOUNTS"
chmod 600 "$ACCOUNTS"
echo "   accounts: HR=${HR_USER#*|} directory=${DIR_USER#*|} admin=${ADMIN_U#*|} (passwords in $SECRETS, 600, never printed)"

# ------------------------------------------------------------- API checks
cd "$WT"
cp -p config.json config.b3bak.json
node -e 'const fs=require("fs");const c=JSON.parse(fs.readFileSync("config.json","utf8"));c.db.mysql.development.database=process.argv[1];fs.writeFileSync("config.json",JSON.stringify(c,null,2));' "$SCRATCH"

[ -r "$HOME/.stage0a/jwt.env" ] && { set -a; . "$HOME/.stage0a/jwt.env"; set +a; }
env -u NODE_ENV CRON_DISABLED=true PORT="$PORT" node server.js > "$APPLOG" 2>&1 &
APP=$!
for i in $(seq 1 45); do curl -sS -m 3 -o /dev/null "http://127.0.0.1:$PORT/user/my-ip" 2>/dev/null && break; sleep 1; done
curl -sS -m 5 -o /dev/null "http://127.0.0.1:$PORT/user/my-ip" || { tail -5 "$APPLOG"; fail "instance did not start or did not answer (see $APPLOG)"; }

echo
BASE_URL="http://127.0.0.1:$PORT" ACCOUNTS="$ACCOUNTS" SECRETS="$SECRETS" node scripts/auth/b3-rehearsal-checks.js
CHECKS=$?

# The refusal has to be visible in the data, not only in the HTTP status: the
# unauthorised write must have left the stored salary alone.
SALARY_NOW="$(Q "SELECT IFNULL(salary,0) FROM new_employee WHERE employee_id = $TARGET_EMPLOYEE")"
if [ "$SALARY_NOW" = "$TARGET_SALARY" ]; then
  echo "  PASS  the stored salary of employee $TARGET_EMPLOYEE is unchanged after both write attempts"
else
  echo "  FAIL  the stored salary changed ($TARGET_SALARY -> $SALARY_NOW)"
  CHECKS=1
fi

if [ "$CHECKS" != "0" ]; then
  echo
  echo "-- diagnosis: non-secret auth state of the staging accounts"
  QT "SELECT u.user_id, u.username, u.status AS user_status, u.user_type, u.is_system_account,
             ne.status AS employee_status, ne.designation_id,
             u.failed_login_count, u.locked_until, u.must_change_password, u.password_algo,
             u.ip_policy, (u.allowed_ips IS NOT NULL) AS has_allowed_ips
        FROM \`user\` u LEFT JOIN new_employee ne ON ne.employee_id = u.employee_id
       WHERE u.user_id IN ($TOUCHED_IDS) ORDER BY u.user_id"
  echo "-- diagnosis: permissions held by the two test designations"
  QT "SELECT designation_id, permission_key, is_active FROM permissions
       WHERE designation_id IN ($HR_DESIGNATION, $DIR_DESIGNATION) AND permission_key IN ($HR_LIST)
       ORDER BY designation_id, permission_key"
fi

echo
echo "report: $LOG   app log: $APPLOG"
[ "$CHECKS" = "0" ] && echo "B3 REHEARSAL: ALL CHECKS PASSED" || echo "B3 REHEARSAL: CHECKS FAILED"
exit "$CHECKS"
