#!/usr/bin/env bash
# Stage 0A / gates 13 + 14 — READ-ONLY scans against the restored rehearsal
# copy. Never the live schema: the target name must look like a scratch
# schema and must differ from the database the app config points at.
#
#   gate 13  scripts/auth/default-password-scan.sql        pattern categories, no password values
#   gate 14  scripts/auth/account-integrity-audit.sql       duplicates, orphans, collisions, conventions
#   gate 14  scripts/auth/duplicate-employee-diagnosis.sql  the duplicate employee_id, side by side
#
# Usage:  scripts/auth/gate13-14-scans.sh [scratch_db]     (default dnds_rehearsal)
# Environment: MYSQL_BIN_DIR (default ~/mysql84/bin), STAGE0A_DEFAULTS (default ~/.stage0a/app.cnf),
#              OUT (default ~/db-backups) — the report is written there, mode 600.
#
# Output contains account identifiers (user_id, username, employee_id) and
# categories only. It never contains a password, a hash, a token or a key:
# every SQL file is checked for that before it runs.
set -euo pipefail

SCRATCH="${1:-dnds_rehearsal}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WT="$(cd "$HERE/../.." && pwd)"
BIN="${MYSQL_BIN_DIR:-$HOME/mysql84/bin}"
DEFAULTS="${STAGE0A_DEFAULTS:-$HOME/.stage0a/app.cnf}"
OUT="${OUT:-$HOME/db-backups}"
MYSQL="$BIN/mysql"
fail() { echo "FAIL: $*" >&2; exit 1; }

case "$SCRATCH" in *rehearsal*|*scratch*|*restore_test*) ;; *) fail "refusing to scan '$SCRATCH' (must be a scratch schema)";; esac
case "$SCRATCH" in *prod*|*production*|mysql|sys|information_schema|performance_schema) fail "refusing '$SCRATCH'";; esac
[ -x "$MYSQL" ] || fail "mysql not found in $BIN"
[ -r "$DEFAULTS" ] || fail "defaults file $DEFAULTS missing (node scripts/auth/db-defaults-file.js app)"
LIVE_DB="$(cd "$WT" && node scripts/auth/db-defaults-file.js show | awk -F= '$1=="database"{print $2}')"
[ "$SCRATCH" != "$LIVE_DB" ] || fail "scratch equals the live schema ($LIVE_DB)"

Q() { "$MYSQL" --defaults-extra-file="$DEFAULTS" -N -B -e "$1"; }
[ "$(Q "SELECT COUNT(*) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME='$SCRATCH'")" = "1" ] || fail "schema $SCRATCH does not exist"
# the copy must be post-Stage-0A (password_algo present) — that is what the scans key on
[ "$(Q "SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='$SCRATCH' AND TABLE_NAME='user' AND COLUMN_NAME='password_algo'")" = "1" ] \
  || fail "$SCRATCH.user has no password_algo column — run the migration rehearsal first"

# every scan file must be free of anything that would print a secret
for f in default-password-scan.sql account-integrity-audit.sql duplicate-employee-diagnosis.sql; do
  [ -r "$HERE/$f" ] || fail "$HERE/$f missing"
  if grep -nE '^\s*(SELECT|,)\s*(u\.)?password(_hash)?\s*(,|$| AS)|SELECT \*' "$HERE/$f" | grep -v '^\s*--' >/dev/null; then
    fail "$f would output a password column or SELECT * — refusing"
  fi
  if grep -inE 'insert|update|delete|alter|drop|create|truncate|grant' "$HERE/$f" | grep -vE '^\s*[0-9]+:\s*--' | grep -viE "created_at|updated_at|resignation_date|date_of_joining|'(insert|update|delete)" >/dev/null; then
    fail "$f contains a write statement — refusing"
  fi
done

mkdir -p "$OUT"; chmod 700 "$OUT"
STAMP="$(date +%Y%m%d-%H%M%S)"
REPORT="$OUT/gate13-14-$STAMP.txt"
touch "$REPORT"; chmod 600 "$REPORT"
exec > >(tee -a "$REPORT") 2>&1

section() { printf '\n==================== %s ====================\n' "$*"; }
run_sql() { "$MYSQL" --defaults-extra-file="$DEFAULTS" --table --comments=false "$SCRATCH" < "$1"; }

section "GATES 13 + 14 on '$SCRATCH' (live schema '$LIVE_DB' not touched) — $STAMP — report $REPORT"
Q "SELECT CONCAT('server ', VERSION(), '; copy last migration: ', (SELECT name FROM \`$SCRATCH\`.migrations ORDER BY run_on DESC, id DESC LIMIT 1))"
Q "SELECT CONCAT('user rows: ', COUNT(*), '  active: ', SUM(status=1), '  sha1: ', SUM(password_algo='sha1'), '  system: ', SUM(is_system_account=1)) FROM \`$SCRATCH\`.\`user\`"

section "GATE 13 — default-password scan (categories only; nothing here is a password)"
run_sql "$HERE/default-password-scan.sql"

section "GATE 13 — headline"
Q "SELECT CONCAT(
     'active sha1 accounts: ', SUM(u.status = 1),
     ' | on provisioning default <employee_id>@123: ', SUM(u.status = 1 AND u.password = SHA1(CONCAT(u.employee_id, '@123'))),
     ' | on literal \"password\": ', SUM(u.status = 1 AND u.password = SHA1('password')),
     ' | = username: ', SUM(u.status = 1 AND u.password = SHA1(u.username)),
     ' | = employee_id: ', SUM(u.status = 1 AND u.password = SHA1(CAST(u.employee_id AS CHAR))),
     ' | = mobile: ', SUM(u.status = 1 AND ne.primary_contact_number IS NOT NULL AND u.password = SHA1(ne.primary_contact_number)),
     ' | user_type 2 on any default: ', SUM(u.status = 1 AND u.user_type = 2 AND u.password IN (SHA1(CONCAT(u.employee_id, '@123')), SHA1('password'), SHA1(u.username), SHA1(CAST(u.employee_id AS CHAR)))))
   FROM \`$SCRATCH\`.\`user\` u LEFT JOIN \`$SCRATCH\`.new_employee ne ON ne.employee_id = u.employee_id
   WHERE u.password_algo = 'sha1' AND u.password IS NOT NULL"

section "GATE 14 — account integrity audit"
run_sql "$HERE/account-integrity-audit.sql"

section "GATE 14 — duplicate employee_id diagnosis"
run_sql "$HERE/duplicate-employee-diagnosis.sql"

section "GATE 14 — headline"
Q "SELECT CONCAT(
     'duplicate usernames: ', (SELECT COUNT(*) FROM (SELECT username FROM \`$SCRATCH\`.\`user\` GROUP BY username HAVING COUNT(*) > 1) d),
     ' | employees with >1 login: ', (SELECT COUNT(*) FROM (SELECT employee_id FROM \`$SCRATCH\`.\`user\` WHERE employee_id IS NOT NULL GROUP BY employee_id HAVING COUNT(*) > 1) d),
     ' | logins with no employee row: ', (SELECT COUNT(*) FROM \`$SCRATCH\`.\`user\` u LEFT JOIN \`$SCRATCH\`.new_employee ne ON ne.employee_id = u.employee_id WHERE u.employee_id IS NOT NULL AND ne.employee_id IS NULL),
     ' | logins with employee_id NULL: ', (SELECT COUNT(*) FROM \`$SCRATCH\`.\`user\` WHERE employee_id IS NULL),
     ' | active login on inactive employee: ', (SELECT COUNT(*) FROM \`$SCRATCH\`.\`user\` u JOIN \`$SCRATCH\`.new_employee ne ON ne.employee_id = u.employee_id WHERE u.status = 1 AND ne.status <> 1 AND u.is_system_account = 0),
     ' | empty usernames: ', (SELECT COUNT(*) FROM \`$SCRATCH\`.\`user\` WHERE username IS NULL OR TRIM(username) = ''))"

section "DONE — report: $REPORT (mode 600). Contains identifiers and categories only. Destroy after the gate is recorded."
