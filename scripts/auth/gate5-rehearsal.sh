#!/usr/bin/env bash
# Stage 0A / gate 5 — ONE operator sequence: defaults file → backups →
# verification → isolated restore → Stage 0A migration rehearsal.
#
# Runs from the rehearsal checkout (~/stage0a-rehearsal), never from the
# production deployment clone. Every step stops the run on its first failure
# (set -e in every script, explicit FAIL: lines), credentials are never
# printed, the live schema receives only SELECTs and the consistent-snapshot
# dump, and the restore/migration steps refuse anything but a scratch schema.
#
# Usage (from ~/stage0a-rehearsal):
#   scripts/auth/gate5-rehearsal.sh                # full run
#   scripts/auth/gate5-rehearsal.sh --skip-backup  # reuse the newest dump in $OUT (restore + migrations only)
#
# Environment (all optional):
#   MYSQL_BIN_DIR           default ~/mysql84/bin
#   OUT                     default ~/db-backups
#   SCRATCH_DB              default dnds_rehearsal
#   STAGE0A_ADMIN_DEFAULTS  admin defaults file, only needed if the app user lacks CREATE DATABASE
#   REHEARSAL_LOG           default $OUT/gate5-<stamp>.log (everything below is tee'd there; no secrets appear)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=stream.sh
. "$HERE/stream.sh"
WT="$(cd "$HERE/../.." && pwd)"
export MYSQL_BIN_DIR="${MYSQL_BIN_DIR:-$HOME/mysql84/bin}"
OUT="${OUT:-$HOME/db-backups}"
SCRATCH="${SCRATCH_DB:-dnds_rehearsal}"
SKIP_BACKUP=0
[ "${1:-}" = "--skip-backup" ] && SKIP_BACKUP=1

case "$WT" in "$HOME/dailyneeds-store-backend"|"$HOME/dailyneeds-store-backend/"*)
  echo "FAIL: run this from the rehearsal checkout, not the production deployment clone ($WT)" >&2; exit 1;; esac
[ -r "$WT/config.json" ] || { echo "FAIL: $WT/config.json missing — copy the production config.json here (chmod 600)" >&2; exit 1; }
[ "$(stat -c %a "$WT/config.json")" = "600" ] || { echo "FAIL: $WT/config.json must be mode 600" >&2; exit 1; }

mkdir -p "$OUT"; chmod 700 "$OUT"
STAMP="$(date +%Y%m%d-%H%M%S)"
LOG="${REHEARSAL_LOG:-$OUT/gate5-$STAMP.log}"
touch "$LOG"; chmod 600 "$LOG"
exec > >(tee -a "$LOG") 2>&1

banner() { printf '\n==================== %s ====================\n' "$*"; }
T0=$(date +%s)
banner "GATE 5 REHEARSAL $STAMP  (checkout $(git -C "$WT" rev-parse --short HEAD), log $LOG)"
echo "client: $("$MYSQL_BIN_DIR/mysqldump" --version)"

banner "1/5 defaults file (credentials -> ~/.stage0a/app.cnf, mode 600; never printed)"
( cd "$WT" && node scripts/auth/db-defaults-file.js app )

if [ "$SKIP_BACKUP" = "0" ]; then
  banner "2/5 backup: auth tables + full dump + exact row counts + verification + manifest"
  ( cd "$WT" && scripts/auth/backup-user-tables.sh "$OUT" )
else
  banner "2/5 backup SKIPPED (--skip-backup): reusing newest dump in $OUT"
fi
# ---- artefact set: ONE stamp, derived from the newest full dump; never mix stamps ----
FULL="$(ls -t "$OUT"/*-full-*.sql.gz 2>/dev/null | head -1)"
[ -n "$FULL" ] && [ -r "$FULL" ] || { echo "FAIL: no full dump found in $OUT" >&2; exit 1; }
BASE="$(basename "$FULL")"                       # <db>-full-<STAMP>.sql.gz
ASTAMP="${BASE##*-full-}"; ASTAMP="${ASTAMP%.sql.gz}"
ADB="${BASE%-full-*}"
AUTH="$OUT/$ADB-auth-$ASTAMP.sql.gz"
COUNTS="$OUT/$ADB-counts-$ASTAMP.tsv"
MANIFEST="$OUT/$ADB-manifest-$ASTAMP.txt"
echo "artefact set: db=$ADB stamp=$ASTAMP"
for f in "$FULL" "$AUTH" "$COUNTS"; do [ -r "$f" ] || { echo "FAIL: $f missing (all three files of stamp $ASTAMP are required)" >&2; exit 1; }; done
echo "using: $FULL"; echo "       $AUTH"; echo "       $COUNTS"

APPCNF="$HOME/.stage0a/app.cnf"
MYSQLC="$MYSQL_BIN_DIR/mysql"
Q() { "$MYSQLC" --defaults-extra-file="$APPCNF" -N -B -e "$1"; }

if [ ! -r "$MANIFEST" ]; then
  banner "2b/5 manifest $MANIFEST is missing — reconstructing it from the artefacts after independent re-verification"
  # (this happens when a previous run failed inside the verifier, after the dumps were written but before the manifest)
  # 1. gzip integrity — whole archives, not filenames
  for f in "$AUTH" "$FULL"; do gzip -t "$f" || { echo "FAIL: $f is not a valid gzip archive" >&2; exit 1; }; echo "  gzip ok: $f"; done
  # 2. Dump completed trailer
  for f in "$AUTH" "$FULL"; do
    T="$(gz_tail_count "$f" 3 'Dump completed')" || exit 1
    [ "$T" = "1" ] || { echo "FAIL: $f does not end with 'Dump completed' (truncated dump)" >&2; exit 1; }
    echo "  trailer ok: $f"
  done
  # 3. auth table list
  R_AUTH="$(gz_matches "$AUTH" '^CREATE TABLE `[^`]+`' -E)" || exit 1
  R_AUTH="${R_AUTH//CREATE TABLE \`/}"; R_AUTH="${R_AUTH//\`/}"
  for t in user new_employee permissions all_permissions designation outlets; do
    list_has "$R_AUTH" "$t" || { echo "FAIL: auth dump lacks table $t (found: $(printf '%s' "$R_AUTH" | tr '\n' ' '))" >&2; exit 1; }
  done
  echo "  auth dump tables: $(printf '%s' "$R_AUTH" | tr '\n' ' ')"
  # 4. full CREATE TABLE count, against the live server's base-table count (read-only information_schema query)
  R_CT="$(gz_count "$FULL" '^CREATE TABLE ')" || exit 1
  LIVE_DB="$(cd "$WT" && node scripts/auth/db-defaults-file.js show | awk -F= '$1=="database"{print $2}')"
  [ "$LIVE_DB" = "$ADB" ] || { echo "FAIL: artefacts are for database '$ADB' but the live config points at '$LIVE_DB'" >&2; exit 1; }
  LIVE_CT="$(Q "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='$LIVE_DB' AND TABLE_TYPE='BASE TABLE'")"
  [ "$R_CT" = "$LIVE_CT" ] || { echo "FAIL: full dump has $R_CT CREATE TABLE statements, live $LIVE_DB has $LIVE_CT base tables" >&2; exit 1; }
  R_USE="$(gz_count "$FULL" '^USE |^CREATE DATABASE' -E)" || exit 1
  [ "$R_USE" = "0" ] || { echo "FAIL: full dump carries USE/CREATE DATABASE" >&2; exit 1; }
  echo "  full dump: $R_CT CREATE TABLE statements = $LIVE_CT live base tables; no USE/CREATE DATABASE"
  # 5. counts file: well-formed, and its table set equals the live base-table set
  [ -s "$COUNTS" ] || { echo "FAIL: counts file is empty" >&2; exit 1; }
  # Structural checks only. Table names are NOT matched against an identifier
  # regex: production has names such as `purchase-2024-2025`, and any name
  # MySQL accepts as a quoted identifier is legitimate here. The authoritative
  # safety check is exact set equality with the live schema, below.
  CV="$(awk -F'\t' '
    NF != 2                { bad++; printf "  line %d: expected 2 tab-separated fields, got %d\n", NR, NF; next }
    $1 == ""               { bad++; printf "  line %d: empty table name\n", NR; next }
    $2 !~ /^[0-9]+$/       { bad++; printf "  line %d: count is not an unsigned integer\n", NR; next }
    ($1 in seen)           { bad++; printf "  line %d: duplicate table name\n", NR; next }
    { seen[$1] = 1 }
    END { if (bad) exit 1 }' "$COUNTS")" || { echo "FAIL: counts file is malformed:" >&2; echo "$CV" >&2; exit 1; }
  DIFF="$(diff <(cut -f1 "$COUNTS" | sort) <(Q "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA='$LIVE_DB' AND TABLE_TYPE='BASE TABLE'" | sort) || true)"
  [ -z "$DIFF" ] || { echo "FAIL: counts file table set differs from live base tables (< only in file, > only live):" >&2; echo "$DIFF" >&2; exit 1; }
  echo "  counts file: $(wc -l < "$COUNTS") tables, well-formed, same table set as live $LIVE_DB"
  # 6. SHA-256 — computed now and recorded; from here on every later stage checks against these
  R_MTIME="$(date -r "$FULL" '+%Y-%m-%d %H:%M:%S')"
  {
    echo "stamp=$ASTAMP"
    echo "database=$ADB"
    echo "reconstructed=yes (manifest rebuilt by gate5-rehearsal.sh on $(date '+%Y-%m-%d %H:%M:%S') after independent re-verification; original run failed in its verifier after the dumps were written)"
    echo "full_dump_mtime=$R_MTIME"
    echo "server_version=$(Q "SELECT VERSION()")"
    echo "client_version=$("$MYSQL_BIN_DIR/mysqldump" --version)"
    echo "tables=$R_CT"
    echo "last_migration=$(Q "SELECT name FROM \`$LIVE_DB\`.migrations ORDER BY run_on DESC, id DESC LIMIT 1")"
    echo "routines_included=$([ "$(gz_count "$FULL" 'CREATE.*(FUNCTION|PROCEDURE) ' -E)" != "0" ] && echo yes || echo "none-or-NO")"
    echo "counts_file=$COUNTS"
    sha256sum "$AUTH" "$FULL" "$COUNTS"
    ls -l "$AUTH" "$FULL"
  } > "$MANIFEST"
  chmod 600 "$MANIFEST"
  echo "  manifest written: $MANIFEST"; cat "$MANIFEST"
fi

banner "3/5 re-verification of the artefacts before restoring (checksums; trailer; table lists)"
( cd "$OUT" && grep -E '^[0-9a-f]{64}  ' "$MANIFEST" | sha256sum -c --strict )
for f in "$AUTH" "$FULL"; do
  TRAILER="$(gz_tail_count "$f" 3 'Dump completed')" || exit 1
  [ "$TRAILER" = "1" ] || { echo "FAIL: $f does not end with 'Dump completed'" >&2; exit 1; }
done
AUTH_TABLES_IN_DUMP="$(gz_matches "$AUTH" '^CREATE TABLE `[^`]+`' -E)" || exit 1
AUTH_TABLES_IN_DUMP="${AUTH_TABLES_IN_DUMP//CREATE TABLE \`/}"; AUTH_TABLES_IN_DUMP="${AUTH_TABLES_IN_DUMP//\`/}"
for t in user new_employee permissions all_permissions designation outlets; do
  list_has "$AUTH_TABLES_IN_DUMP" "$t" || { echo "FAIL: auth dump lacks table $t (found: $(printf '%s' "$AUTH_TABLES_IN_DUMP" | tr '\n' ' '))" >&2; exit 1; }
done
echo "auth dump tables: $(printf '%s' "$AUTH_TABLES_IN_DUMP" | tr '\n' ' ')"
EXPECTED_CT="$(grep -oE '^tables=[0-9]+' "$MANIFEST" | cut -d= -f2)"
ACTUAL_CT="$(gz_count "$FULL" '^CREATE TABLE ')" || exit 1
[ "$ACTUAL_CT" = "$EXPECTED_CT" ] || { echo "FAIL: full dump has $ACTUAL_CT CREATE TABLE statements, manifest says $EXPECTED_CT" >&2; exit 1; }
echo "full dump: $ACTUAL_CT CREATE TABLE statements = manifest"

banner "4/5 isolated restore into '$SCRATCH' (timed; every table's row count compared; live schema untouched)"
( cd "$WT" && scripts/auth/restore-rehearsal.sh "$FULL" "$COUNTS" "$SCRATCH" )

banner "5/5 Stage 0A migrations on '$SCRATCH' only: up / idempotent up / down x4 / up"
( cd "$WT" && scripts/auth/migration-rehearsal.sh "$SCRATCH" "$WT" )

banner "GATE 5 REHEARSAL COMPLETE in $(( $(date +%s) - T0 ))s"
echo "artefacts (600): $FULL"
echo "                 $AUTH"
echo "                 $COUNTS"
echo "                 $MANIFEST"
echo "log:             $LOG"
echo "scratch schema '$SCRATCH' is left in the post-Stage-0A state for the gate 13/14 scans; drop it afterwards:"
echo "  $MYSQL_BIN_DIR/mysql --defaults-extra-file=\$HOME/.stage0a/app.cnf -e 'DROP DATABASE \`$SCRATCH\`'"
