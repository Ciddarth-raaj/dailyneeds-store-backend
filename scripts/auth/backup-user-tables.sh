#!/usr/bin/env bash
# Stage 0A / gate 5 — logical backup of the LIVE database on AWS RDS.
#
# Produces, verifies and fingerprints:
#   <db>-auth-<STAMP>.sql.gz   the authentication tables only (fast partial rollback)
#   <db>-full-<STAMP>.sql.gz   the whole schema (the rehearsal + deployment-night artefact)
#   <db>-counts-<STAMP>.tsv    exact row counts per table at backup time
#   <db>-manifest-<STAMP>.txt  sizes, sha256, server/client versions, verification results
#
# Connection: NEVER on the command line. Credentials come from a my.cnf-style
# defaults file (mode 600) written by scripts/auth/db-defaults-file.js from the
# same config.json the backend uses. In this deployment NODE_ENV is unset, so
# the backend's "development" block IS the live dnds_prod connection on RDS —
# the label is misleading and this script prints the target so you can confirm.
#
# Client: the MySQL 8.4 official client is REQUIRED (server is MySQL 8.4.9).
# The MariaDB 10.5 mysqldump found in /usr/bin is refused unless
# ALLOW_MARIADB_CLIENT=1 is set explicitly — see the readiness report §5 for why.
#
# Usage:
#   scripts/auth/backup-user-tables.sh [out_dir]
# Environment:
#   STAGE0A_DEFAULTS        app defaults file (default ~/.stage0a/app.cnf) — used for the preflight and counts
#   STAGE0A_ADMIN_DEFAULTS  optional admin defaults file; when present it is used for the DUMPS themselves
#                           (read-only), because a least-privilege app user cannot SHOW CREATE FUNCTION/PROCEDURE
#                           and mysqldump then omits routines. Without it, routines must be explicitly skipped.
#   SKIP_ROUTINES=1         accept a full dump WITHOUT stored routines (recorded in the manifest)
#   MYSQL_BIN_DIR      directory holding mysql + mysqldump 8.4 (default ~/mysql84/bin)
#   STAGE0A_DB         database name (default: read from `db-defaults-file.js show`)
#   COUNT_ALL_TABLES   1 = exact COUNT(*) for every base table (default 1; 0 = auth tables only)
set -euo pipefail

OUT="${1:-$HOME/db-backups}"
DEFAULTS="${STAGE0A_DEFAULTS:-$HOME/.stage0a/app.cnf}"
ADMIN="${STAGE0A_ADMIN_DEFAULTS:-}"
BIN="${MYSQL_BIN_DIR:-$HOME/mysql84/bin}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
STAMP="$(date +%Y%m%d-%H%M%S)"

MYSQL="$BIN/mysql"
MYSQLDUMP="$BIN/mysqldump"

fail() { echo "FAIL: $*" >&2; exit 1; }
# shellcheck source=stream.sh
. "$HERE/stream.sh"

# ---- 0. preconditions --------------------------------------------------------
[ -r "$DEFAULTS" ] || fail "defaults file $DEFAULTS not found. Run: node scripts/auth/db-defaults-file.js app"
[ "$(stat -c %a "$DEFAULTS")" = "600" ] || fail "$DEFAULTS must be mode 600"
[ -x "$MYSQL" ] && [ -x "$MYSQLDUMP" ] || fail "mysql/mysqldump not found in $BIN (set MYSQL_BIN_DIR). Install the MySQL 8.4 client tarball first — readiness §5.2."

CLIENT_VER="$("$MYSQLDUMP" --version)"
case "$CLIENT_VER" in
  *MariaDB*)
    if [ "${ALLOW_MARIADB_CLIENT:-0}" != "1" ]; then
      fail "client is MariaDB ($CLIENT_VER); server is MySQL 8.4. Use the MySQL 8.4 client, or set ALLOW_MARIADB_CLIENT=1 to accept an unverified cross-vendor dump (not recommended for the deployment-night artefact)."
    fi
    echo "WARNING: proceeding with a MariaDB client against MySQL 8.4 — the restore rehearsal is the only proof this dump is usable." >&2
    ;;
esac
case "$CLIENT_VER" in *" 8.4."*|*"Ver 8.4"*) ;; *) echo "NOTE: client is not 8.4.x ($CLIENT_VER); server is 8.4.9. Same-major is strongly preferred." >&2 ;; esac

DB="${STAGE0A_DB:-$(node "$HERE/db-defaults-file.js" show | awk -F= '$1=="database"{print $2}')}"
[ -n "$DB" ] || fail "could not determine database name"
node "$HERE/db-defaults-file.js" show

Q() { "$MYSQL" --defaults-extra-file="$DEFAULTS" -N -B -e "$1"; }
# identity used for the dumps (read-only either way)
DUMP_DEFAULTS="$DEFAULTS"
if [ -n "$ADMIN" ] && [ -r "$ADMIN" ]; then
  [ "$(stat -c %a "$ADMIN")" = "600" ] || fail "$ADMIN must be mode 600"
  DUMP_DEFAULTS="$ADMIN"
fi
QD() { "$MYSQL" --defaults-extra-file="$DUMP_DEFAULTS" -N -B -e "$1"; }

echo "== connectivity / server =="
SERVER_VER="$(Q "SELECT VERSION()")" || fail "cannot connect with $DEFAULTS"
echo "server: $SERVER_VER   client: $CLIENT_VER"
CUR_DB_EXISTS="$(Q "SELECT COUNT(*) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME='$DB'")"
[ "$CUR_DB_EXISTS" = "1" ] || fail "database $DB not visible to this user"

echo "== grants (recorded, password hashes are never in SHOW GRANTS) =="
Q "SHOW GRANTS" | sed 's/IDENTIFIED BY.*//' || true
echo "dump identity: $(QD "SELECT CURRENT_USER()") ($([ "$DUMP_DEFAULTS" = "$DEFAULTS" ] && echo app defaults || echo admin defaults))"

echo "== server settings that affect restore =="
Q "SELECT @@version_comment, @@log_bin, @@log_bin_trust_function_creators, @@gtid_mode, @@max_allowed_packet, @@event_scheduler"

TABLE_COUNT="$(Q "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='$DB' AND TABLE_TYPE='BASE TABLE'")"
VIEW_COUNT="$(Q "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='$DB' AND TABLE_TYPE='VIEW'")"
ROUTINE_COUNT="$(Q "SELECT COUNT(*) FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA='$DB'")"
TRIGGER_COUNT="$(Q "SELECT COUNT(*) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA='$DB'")"
EVENT_COUNT="$(Q "SELECT COUNT(*) FROM information_schema.EVENTS WHERE EVENT_SCHEMA='$DB'")"
DATA_MB="$(Q "SELECT ROUND(SUM(data_length+index_length)/1024/1024,1) FROM information_schema.TABLES WHERE TABLE_SCHEMA='$DB'")"
LAST_MIGRATION="$(Q "SELECT name FROM \`$DB\`.migrations ORDER BY run_on DESC, id DESC LIMIT 1" 2>/dev/null || echo "n/a")"
echo "tables=$TABLE_COUNT views=$VIEW_COUNT routines=$ROUTINE_COUNT triggers=$TRIGGER_COUNT events=$EVENT_COUNT size_mb=$DATA_MB last_migration=$LAST_MIGRATION"

for t in user new_employee permissions all_permissions designation outlets migrations; do
  [ "$(Q "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='$DB' AND TABLE_NAME='$t'")" = "1" ] || fail "expected table $t missing in $DB"
done

# Routines: mysqldump --routines needs SHOW CREATE FUNCTION/PROCEDURE to succeed
# for every routine, which a least-privilege user is usually denied (it then
# prints a warning and silently omits them). Prove it up front.
ROUTINES_FLAG="--routines"
if [ "$ROUTINE_COUNT" != "0" ]; then
  MISSING=0
  while IFS=$'\t' read -r rtype rname; do
    [ -n "$rname" ] || continue
    if ! "$MYSQL" --defaults-extra-file="$DUMP_DEFAULTS" -N -B -e "SHOW CREATE $rtype \`$DB\`.\`$rname\`" >/dev/null 2>&1; then
      echo "  cannot SHOW CREATE $rtype $rname as the dump identity"; MISSING=$((MISSING+1))
    fi
  done < <(QD "SELECT ROUTINE_TYPE, ROUTINE_NAME FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA='$DB'")
  if [ "$MISSING" != "0" ]; then
    if [ "${SKIP_ROUTINES:-0}" = "1" ]; then
      echo "WARNING: $MISSING routine(s) not dumpable — proceeding WITHOUT routines (SKIP_ROUTINES=1); recorded in manifest" >&2
      ROUTINES_FLAG="--skip-routines"
    else
      fail "$MISSING of $ROUTINE_COUNT stored routines cannot be read by the dump identity. Provide STAGE0A_ADMIN_DEFAULTS (an identity with SHOW_ROUTINE / global SELECT, e.g. the RDS master user) or set SKIP_ROUTINES=1 to accept a dump without them."
    fi
  else
    echo "routines: all $ROUTINE_COUNT readable by the dump identity"
  fi
fi

# Disk: need roughly the uncompressed size twice (dump stream + gzip) — be generous.
NEED_MB=$(( ${DATA_MB%.*} * 3 + 512 ))
mkdir -p "$OUT"; chmod 700 "$OUT"
FREE_MB="$(df -Pm "$OUT" | awk 'NR==2{print $4}')"
[ "$FREE_MB" -gt "$NEED_MB" ] || fail "free disk ${FREE_MB}MB at $OUT < required ~${NEED_MB}MB"
echo "disk: free ${FREE_MB}MB, need ~${NEED_MB}MB"

# ---- 1. row counts at backup time (exact) -----------------------------------
COUNTS="$OUT/${DB}-counts-${STAMP}.tsv"
: > "$COUNTS"; chmod 600 "$COUNTS"
if [ "${COUNT_ALL_TABLES:-1}" = "1" ]; then
  TABLES="$(Q "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA='$DB' AND TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME")"
else
  TABLES="$(printf '%s\n' user new_employee permissions all_permissions designation outlets migrations)"
fi
echo "== exact row counts -> $COUNTS =="
# One table per LINE, never word-split: production names contain '-' and may
# contain spaces; the name is always backtick-quoted in SQL. A count that is
# not an unsigned integer (query error) fails the backup here, not later.
while IFS= read -r t; do
  [ -n "$t" ] || continue
  case "$t" in *\`*) fail "table name contains a backtick: $t";; esac
  n="$(Q "SELECT COUNT(*) FROM \`$DB\`.\`$t\`")" || fail "COUNT(*) failed for table $t"
  case "$n" in ''|*[!0-9]*) fail "COUNT(*) for table $t returned '$n'";; esac
  printf '%s\t%s\n' "$t" "$n" >> "$COUNTS"
done <<< "$TABLES"
grep -E $'^(user|new_employee|permissions|migrations)\t' "$COUNTS"

# ---- 2. dumps -----------------------------------------------------------------
AUTH_TABLES="user new_employee permissions all_permissions designation outlets"
AUTH_FILE="$OUT/${DB}-auth-${STAMP}.sql.gz"
FULL_FILE="$OUT/${DB}-full-${STAMP}.sql.gz"

# Flags:
#  --single-transaction  consistent InnoDB snapshot, no table locks on the live DB
#  --quick               stream rows, no client-side buffering of large tables
#  --set-gtid-purged=OFF no GTID preamble (RDS; also avoids the RELOAD-privilege requirement)
#  --skip-lock-tables    never LOCK TABLES on production
#  --no-tablespaces      mysqldump 8 otherwise queries tablespaces, which needs PROCESS (denied on RDS app users)
#  NO --databases        the dump carries no CREATE DATABASE / USE, so it restores into
#                        whatever schema the client selects — this is what makes the
#                        isolated restore possible and a restore over dnds_prod hard.
COMMON=(--defaults-extra-file="$DUMP_DEFAULTS" --single-transaction --quick --skip-lock-tables --no-tablespaces --set-gtid-purged=OFF --add-drop-table --hex-blob --default-character-set=utf8mb4 --dump-date)
case "$CLIENT_VER" in *MariaDB*) COMMON=(--defaults-extra-file="$DUMP_DEFAULTS" --single-transaction --quick --skip-lock-tables --no-tablespaces --add-drop-table --hex-blob --default-character-set=utf8mb4 --dump-date);; esac

echo "== auth tables ($AUTH_TABLES) -> $AUTH_FILE =="
# shellcheck disable=SC2086
"$MYSQLDUMP" "${COMMON[@]}" --skip-routines --triggers "$DB" $AUTH_TABLES | gzip -6 > "$AUTH_FILE"

echo "== full database -> $FULL_FILE (this is the long step; ~${DATA_MB}MB over the RDS link) =="
START=$(date +%s)
"$MYSQLDUMP" "${COMMON[@]}" $ROUTINES_FLAG --triggers --events "$DB" | gzip -6 > "$FULL_FILE"
DUMP_SECONDS=$(( $(date +%s) - START ))
chmod 600 "$AUTH_FILE" "$FULL_FILE"
echo "full dump took ${DUMP_SECONDS}s"

# ---- 3. verification (more than gzip -t) --------------------------------------
echo "== verification =="
for f in "$AUTH_FILE" "$FULL_FILE"; do
  gzip -t "$f" || fail "$f is not a valid gzip stream"
  # tail before grep so the pipe is drained fully (no SIGPIPE under pipefail)
  TRAILER="$(gz_tail_count "$f" 3 'Dump completed')" || exit 1
  [ "$TRAILER" = "1" ] || fail "$f does not end with 'Dump completed' (truncated dump)"
  echo "  ok: $f ($(du -h "$f" | cut -f1)) ends cleanly"
done
CT_IN_DUMP="$(gz_count "$FULL_FILE" '^CREATE TABLE ')" || exit 1
[ "$CT_IN_DUMP" = "$TABLE_COUNT" ] || fail "full dump has $CT_IN_DUMP CREATE TABLE statements, server has $TABLE_COUNT base tables"
echo "  ok: $CT_IN_DUMP CREATE TABLE statements = $TABLE_COUNT base tables"
if [ "$TRIGGER_COUNT" != "0" ]; then
  TR_IN_DUMP="$(gz_count "$FULL_FILE" 'CREATE.*TRIGGER')" || exit 1
  [ "$TR_IN_DUMP" -ge "$TRIGGER_COUNT" ] || fail "full dump has $TR_IN_DUMP triggers, server has $TRIGGER_COUNT"
fi
if [ "$ROUTINES_FLAG" = "--routines" ] && [ "$ROUTINE_COUNT" != "0" ]; then
  RT_IN_DUMP="$(gz_count "$FULL_FILE" 'CREATE.*(FUNCTION|PROCEDURE) ' -E)" || exit 1
  [ "$RT_IN_DUMP" -ge "$ROUTINE_COUNT" ] || fail "full dump has $RT_IN_DUMP routines, server has $ROUTINE_COUNT"
  echo "  ok: $RT_IN_DUMP routine definitions present"
fi
# NOTE: never `zcat | grep -q` here — grep -q exits on the first match, zcat
# dies of SIGPIPE, and under pipefail the check fails on a perfectly good
# dump (seen on production 06-09-2026: "auth dump missing table user").
# Every check reads the whole stream once and compares counts.
USE_IN_DUMP="$(gz_count "$FULL_FILE" '^USE |^CREATE DATABASE' -E)" || exit 1
[ "$USE_IN_DUMP" = "0" ] || fail "dump contains USE/CREATE DATABASE — must not (isolated restore safety)"
AUTH_TABLES_IN_DUMP="$(gz_matches "$AUTH_FILE" '^CREATE TABLE `[^`]+`' -E)" || exit 1
AUTH_TABLES_IN_DUMP="${AUTH_TABLES_IN_DUMP//CREATE TABLE \`/}"; AUTH_TABLES_IN_DUMP="${AUTH_TABLES_IN_DUMP//\`/}"
for t in $AUTH_TABLES; do
  list_has "$AUTH_TABLES_IN_DUMP" "$t" || fail "auth dump missing table $t (tables found: $(printf '%s' "$AUTH_TABLES_IN_DUMP" | tr '\n' ' '))"
done
echo "  ok: auth dump has all $(( $(echo $AUTH_TABLES | wc -w) )) tables ($(printf '%s' "$AUTH_TABLES_IN_DUMP" | tr '\n' ' '))"

# ---- 4. manifest --------------------------------------------------------------
MANIFEST="$OUT/${DB}-manifest-${STAMP}.txt"
{
  echo "stamp=$STAMP"
  echo "database=$DB"
  echo "server_version=$SERVER_VER"
  echo "client_version=$CLIENT_VER"
  echo "tables=$TABLE_COUNT views=$VIEW_COUNT routines=$ROUTINE_COUNT triggers=$TRIGGER_COUNT events=$EVENT_COUNT"
  echo "size_mb_reported=$DATA_MB"
  echo "last_migration=$LAST_MIGRATION"
  echo "full_dump_seconds=$DUMP_SECONDS"
  echo "dump_identity=$(QD "SELECT CURRENT_USER()")"
  echo "routines_included=$([ "$ROUTINES_FLAG" = "--routines" ] && echo yes || echo NO)"
  echo "counts_file=$COUNTS"
  sha256sum "$AUTH_FILE" "$FULL_FILE" "$COUNTS"
  ls -l "$AUTH_FILE" "$FULL_FILE"
} > "$MANIFEST"
chmod 600 "$MANIFEST"
echo "== manifest =="; cat "$MANIFEST"
echo
echo "Next: scripts/auth/restore-rehearsal.sh $FULL_FILE $COUNTS   (into a scratch schema, never $DB)"
