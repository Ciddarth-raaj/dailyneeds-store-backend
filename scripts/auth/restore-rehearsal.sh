#!/usr/bin/env bash
# Stage 0A / gate 5 — isolated full restore of a backup into a SCRATCH schema on
# the same RDS instance, timed and verified. Never touches the source schema.
#
# Usage:
#   scripts/auth/restore-rehearsal.sh <full-dump.sql.gz> <counts.tsv> [scratch_db]
# Environment:
#   STAGE0A_DEFAULTS        app defaults file (default ~/.stage0a/app.cnf) — used for the restore itself
#   STAGE0A_ADMIN_DEFAULTS  optional admin defaults file (~/.stage0a/admin.cnf) — used ONLY to CREATE the
#                           scratch schema and grant the app user on it, when the app user lacks CREATE
#   MYSQL_BIN_DIR           MySQL 8.4 client dir (default ~/mysql84/bin)
#   SOURCE_DB               name of the live schema, for the refusal check (default: from db-defaults-file.js show)
#   KEEP_DEFINERS=1         do not strip DEFINER= clauses (default: strip — RDS refuses foreign definers without SUPER)
#   SKIP_EVENTS=0           default 1: CREATE EVENT statements are dropped from the stream so a restored
#                           copy never schedules work on the shared instance
set -euo pipefail

FULL="${1:?full dump .sql.gz required}"
COUNTS="${2:?counts .tsv required}"
SCRATCH="${3:-dnds_rehearsal}"
DEFAULTS="${STAGE0A_DEFAULTS:-$HOME/.stage0a/app.cnf}"
ADMIN="${STAGE0A_ADMIN_DEFAULTS:-}"
BIN="${MYSQL_BIN_DIR:-$HOME/mysql84/bin}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MYSQL="$BIN/mysql"
fail() { echo "FAIL: $*" >&2; exit 1; }

[ -r "$FULL" ] && [ -r "$COUNTS" ] || fail "dump or counts file not readable"
[ -x "$MYSQL" ] || fail "mysql not found in $BIN"
[ -r "$DEFAULTS" ] || fail "defaults file $DEFAULTS missing"

SOURCE_DB="${SOURCE_DB:-$(node "$HERE/db-defaults-file.js" show | awk -F= '$1=="database"{print $2}')}"

# ---- refusal guards: this must never become a restore over production -------
[ -n "$SCRATCH" ] || fail "empty scratch name"
[ "$SCRATCH" != "$SOURCE_DB" ] || fail "scratch schema equals the live schema ($SOURCE_DB)"
case "$SCRATCH" in *prod*|*production*|mysql|sys|information_schema|performance_schema) fail "refusing scratch name '$SCRATCH'";; esac
case "$SCRATCH" in *rehearsal*|*scratch*|*restore_test*) ;; *) fail "scratch name must contain 'rehearsal', 'scratch' or 'restore_test' (got '$SCRATCH')";; esac
if zcat "$FULL" | head -n 200 | grep -q '^USE \|^CREATE DATABASE'; then fail "dump carries USE/CREATE DATABASE — refuse; re-take it without --databases"; fi

Q()  { "$MYSQL" --defaults-extra-file="$DEFAULTS" -N -B -e "$1"; }
QA() { "$MYSQL" --defaults-extra-file="$ADMIN"    -N -B -e "$1"; }

echo "== target: scratch schema '$SCRATCH' on $(Q "SELECT @@hostname, VERSION()") (live schema is '$SOURCE_DB', untouched) =="

# ---- 1. scratch schema --------------------------------------------------------
EXISTS="$(Q "SELECT COUNT(*) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME='$SCRATCH'")"
if [ "$EXISTS" = "1" ]; then
  echo "scratch schema already exists — it will be dropped and recreated"
fi
APP_USER="$(Q "SELECT CURRENT_USER()")"
CAN_CREATE="$(Q "SHOW GRANTS" | grep -ciE 'GRANT (ALL PRIVILEGES|.*\bCREATE\b.*) ON \*\.\*' || true)"
if [ "$CAN_CREATE" -ge 1 ]; then
  echo "app user $APP_USER has global CREATE — creating $SCRATCH with it"
  Q "DROP DATABASE IF EXISTS \`$SCRATCH\`; CREATE DATABASE \`$SCRATCH\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci"
else
  echo "app user $APP_USER has NO global CREATE (expected on a least-privilege RDS user)"
  [ -n "$ADMIN" ] && [ -r "$ADMIN" ] || fail "set STAGE0A_ADMIN_DEFAULTS to an admin defaults file (node scripts/auth/db-defaults-file.js admin --host … --user …) so the scratch schema can be created"
  QA "DROP DATABASE IF EXISTS \`$SCRATCH\`; CREATE DATABASE \`$SCRATCH\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci"
  # grant the APP user everything on the scratch schema only — nothing on any other schema changes
  QA "GRANT ALL PRIVILEGES ON \`$SCRATCH\`.* TO $APP_USER; FLUSH PRIVILEGES"
  echo "created $SCRATCH with admin; granted ALL on $SCRATCH.* to $APP_USER"
fi
Q "SELECT COUNT(*) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME='$SCRATCH'" | grep -q 1 || fail "scratch schema not visible to app user"

# ---- 2. restore (timed) -------------------------------------------------------
LOG_BIN="$(Q "SELECT @@log_bin")"; TRUST="$(Q "SELECT @@log_bin_trust_function_creators")"
if [ "$LOG_BIN" = "1" ] && [ "$TRUST" = "0" ]; then
  echo "NOTE: log_bin=1 and log_bin_trust_function_creators=0 — creating FUNCTIONs/TRIGGERs needs SUPER or that RDS parameter set to 1. If the restore fails on a CREATE FUNCTION/TRIGGER, that is the cause (parameter group change, admin)." >&2
fi

FILTER=(cat)
if [ "${KEEP_DEFINERS:-0}" != "1" ]; then
  # strip DEFINER=`x`@`y` from routines/triggers/views/events so RDS accepts them as the restoring user
  FILTER=(sed -E 's/DEFINER=`[^`]+`@`[^`]+`//g; s/\/\*!50017 DEFINER=[^*]*\*\///g')
fi
EVENT_FILTER=(cat)
if [ "${SKIP_EVENTS:-1}" = "1" ]; then
  # drop the whole events section: mysqldump brackets it between
  # "SET @save_time_zone" and "SET TIME_ZONE= @save_time_zone" (one block per
  # schema, however many events it holds)
  EVENT_FILTER=(awk 'BEGIN{skip=0} /SET @save_time_zone= *@@TIME_ZONE/{skip=1} skip&&/SET TIME_ZONE= *@save_time_zone/{skip=0; next} !skip{print}')
fi

echo "== restoring $FULL into $SCRATCH (definers stripped: $([ "${KEEP_DEFINERS:-0}" = "1" ] && echo no || echo yes); events skipped: ${SKIP_EVENTS:-1}) =="
START=$(date +%s)
zcat "$FULL" | "${FILTER[@]}" | "${EVENT_FILTER[@]}" \
  | "$MYSQL" --defaults-extra-file="$DEFAULTS" --max-allowed-packet=1G "$SCRATCH"
RESTORE_SECONDS=$(( $(date +%s) - START ))
echo "restore took ${RESTORE_SECONDS}s"

# ---- 3. verification ----------------------------------------------------------
echo "== row-count comparison (backup-time counts vs restored) =="
MISMATCH=0; CHECKED=0
while IFS=$'\t' read -r t n; do
  [ -n "$t" ] || continue
  r="$(Q "SELECT COUNT(*) FROM \`$SCRATCH\`.\`$t\`" 2>/dev/null || echo "MISSING")"
  CHECKED=$((CHECKED+1))
  if [ "$r" != "$n" ]; then echo "  MISMATCH $t: backup=$n restored=$r"; MISMATCH=$((MISMATCH+1)); fi
done < "$COUNTS"
echo "checked $CHECKED tables, $MISMATCH mismatches"
[ "$MISMATCH" = "0" ] || fail "row counts differ — the dump is not a faithful copy"

echo "== schema / integrity checks =="
Q "SELECT 'base_tables', COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='$SCRATCH' AND TABLE_TYPE='BASE TABLE'
   UNION ALL SELECT 'views', COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='$SCRATCH' AND TABLE_TYPE='VIEW'
   UNION ALL SELECT 'routines', COUNT(*) FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA='$SCRATCH'
   UNION ALL SELECT 'triggers', COUNT(*) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA='$SCRATCH'
   UNION ALL SELECT 'events', COUNT(*) FROM information_schema.EVENTS WHERE EVENT_SCHEMA='$SCRATCH'"
echo "-- last migration in restored copy (must be 20260906070000-telegram-password-reset or later):"
Q "SELECT name, run_on FROM \`$SCRATCH\`.migrations ORDER BY run_on DESC, id DESC LIMIT 3"
echo "-- upstream Telegram tables present:"
Q "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA='$SCRATCH' AND TABLE_NAME IN ('telegram_links','telegram_link_tokens','password_reset_codes')"
echo "-- user table shape (pre-Stage-0A: expect NO password_hash / password_algo / is_system_account yet):"
Q "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='$SCRATCH' AND TABLE_NAME='user' ORDER BY ORDINAL_POSITION" | tr '\n' ' '; echo
echo "-- auth data readable:"
Q "SELECT 'users_total', COUNT(*) FROM \`$SCRATCH\`.\`user\`
   UNION ALL SELECT 'users_with_password', COUNT(*) FROM \`$SCRATCH\`.\`user\` WHERE password IS NOT NULL AND password <> ''
   UNION ALL SELECT 'users_active', COUNT(*) FROM \`$SCRATCH\`.\`user\` WHERE status = 1
   UNION ALL SELECT 'logins_without_employee_row', COUNT(*) FROM \`$SCRATCH\`.\`user\` u LEFT JOIN \`$SCRATCH\`.new_employee ne ON ne.employee_id = u.employee_id WHERE ne.employee_id IS NULL
   UNION ALL SELECT 'duplicate_usernames', COUNT(*) FROM (SELECT username FROM \`$SCRATCH\`.\`user\` GROUP BY username HAVING COUNT(*) > 1) d
   UNION ALL SELECT 'duplicate_employee_ids', COUNT(*) FROM (SELECT employee_id FROM \`$SCRATCH\`.\`user\` WHERE employee_id IS NOT NULL GROUP BY employee_id HAVING COUNT(*) > 1) d"
echo "-- InnoDB check of the auth tables:"
"$MYSQL" --defaults-extra-file="$DEFAULTS" -B -e "CHECK TABLE \`$SCRATCH\`.\`user\`, \`$SCRATCH\`.new_employee, \`$SCRATCH\`.permissions, \`$SCRATCH\`.migrations"

echo
echo "RESTORE OK: schema=$SCRATCH seconds=$RESTORE_SECONDS tables_checked=$CHECKED mismatches=0"
echo "Next: scripts/auth/migration-rehearsal.sh $SCRATCH     (Stage 0A up/down on the copy)"
echo "Tear down when finished:  $MYSQL --defaults-extra-file=$DEFAULTS -e 'DROP DATABASE \`$SCRATCH\`'"
