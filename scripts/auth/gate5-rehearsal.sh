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
FULL="$(ls -t "$OUT"/*-full-*.sql.gz | head -1)"
COUNTS="$(ls -t "$OUT"/*-counts-*.tsv | head -1)"
MANIFEST="$(ls -t "$OUT"/*-manifest-*.txt | head -1)"
[ -r "$FULL" ] && [ -r "$COUNTS" ] || { echo "FAIL: no dump/counts found in $OUT" >&2; exit 1; }
echo "using: $FULL"; echo "       $COUNTS"

banner "3/5 re-verification of the artefacts before restoring (checksums; trailer; table lists)"
( cd "$OUT" && grep -E '^[0-9a-f]{64}  ' "$MANIFEST" | sha256sum -c --strict )
AUTH="$(ls -t "$OUT"/*-auth-*.sql.gz | head -1)"
for f in "$AUTH" "$FULL"; do
  [ "$(zcat "$f" | tail -n 3 | grep -c 'Dump completed' || true)" = "1" ] || { echo "FAIL: $f does not end with 'Dump completed'" >&2; exit 1; }
done
AUTH_TABLES_IN_DUMP="$(zcat "$AUTH" | grep -oE '^CREATE TABLE `[^`]+`' | sed -E 's/^CREATE TABLE `([^`]+)`/\1/' || true)"
for t in user new_employee permissions all_permissions designation outlets; do
  [[ $'\n'"$AUTH_TABLES_IN_DUMP"$'\n' == *$'\n'"$t"$'\n'* ]] || { echo "FAIL: auth dump lacks table $t (found: $(printf '%s' "$AUTH_TABLES_IN_DUMP" | tr '\n' ' '))" >&2; exit 1; }
done
echo "auth dump tables: $(printf '%s' "$AUTH_TABLES_IN_DUMP" | tr '\n' ' ')"
EXPECTED_CT="$(grep -oE '^tables=[0-9]+' "$MANIFEST" | cut -d= -f2)"
ACTUAL_CT="$(zcat "$FULL" | grep -c '^CREATE TABLE ' || true)"
[ "$ACTUAL_CT" = "$EXPECTED_CT" ] || { echo "FAIL: full dump has $ACTUAL_CT CREATE TABLE statements, manifest says $EXPECTED_CT" >&2; exit 1; }
echo "full dump: $ACTUAL_CT CREATE TABLE statements = manifest"

banner "4/5 isolated restore into '$SCRATCH' (timed; every table's row count compared; live schema untouched)"
( cd "$WT" && scripts/auth/restore-rehearsal.sh "$FULL" "$COUNTS" "$SCRATCH" )

banner "5/5 Stage 0A migrations on '$SCRATCH' only: up / idempotent up / down x4 / up"
( cd "$WT" && scripts/auth/migration-rehearsal.sh "$SCRATCH" "$WT" )

banner "GATE 5 REHEARSAL COMPLETE in $(( $(date +%s) - T0 ))s"
echo "artefacts (600): $FULL"
echo "                 $(ls -t "$OUT"/*-auth-*.sql.gz | head -1)"
echo "                 $COUNTS"
echo "                 $MANIFEST"
echo "log:             $LOG"
echo "scratch schema '$SCRATCH' is left in the post-Stage-0A state for the gate 13/14 scans; drop it afterwards:"
echo "  $MYSQL_BIN_DIR/mysql --defaults-extra-file=\$HOME/.stage0a/app.cnf -e 'DROP DATABASE \`$SCRATCH\`'"
