#!/usr/bin/env bash
# Stage 0A / A1 — targeted backup of the authentication tables plus a full dump.
#
# Run on the database host BEFORE `db-migrate up` for any Stage 0A
# migration. Produces two files: the auth tables alone (fast to restore if
# only authentication must be rolled back) and a full logical dump.
#
# Usage:  scripts/auth/backup-user-tables.sh <db_name> [out_dir]
# Reads credentials from ~/.my.cnf or MYSQL_PWD; never pass them as args.
set -euo pipefail

DB="${1:?database name required}"
OUT="${2:-$HOME/db-backups}"
STAMP="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$OUT"
chmod 700 "$OUT"

AUTH_TABLES="user new_employee permissions all_permissions designation outlets"
AUTH_FILE="$OUT/${DB}-auth-${STAMP}.sql.gz"
FULL_FILE="$OUT/${DB}-full-${STAMP}.sql.gz"

echo "Dumping auth tables ($AUTH_TABLES) -> $AUTH_FILE"
# shellcheck disable=SC2086
mysqldump --single-transaction --quick --routines=false --triggers \
  --add-drop-table "$DB" $AUTH_TABLES | gzip -9 > "$AUTH_FILE"

echo "Dumping full database -> $FULL_FILE"
mysqldump --single-transaction --quick --routines --triggers --events \
  --add-drop-table "$DB" | gzip -9 > "$FULL_FILE"

chmod 600 "$AUTH_FILE" "$FULL_FILE"

echo "Verifying archives are readable and end cleanly"
for f in "$AUTH_FILE" "$FULL_FILE"; do
  gzip -t "$f"
  zcat "$f" | tail -n 3 | grep -q "Dump completed" || { echo "FAIL: $f does not end with 'Dump completed'"; exit 1; }
  echo "  ok: $f ($(du -h "$f" | cut -f1))"
done

echo
echo "Row counts at backup time (record these next to the files):"
mysql -N "$DB" -e "SELECT 'user', COUNT(*) FROM \`user\` UNION ALL SELECT 'new_employee', COUNT(*) FROM new_employee UNION ALL SELECT 'permissions', COUNT(*) FROM permissions;"
echo
echo "Restore test (into a scratch schema, never the live one):"
echo "  mysql -e 'CREATE DATABASE ${DB}_restore_test'"
echo "  zcat $AUTH_FILE | mysql ${DB}_restore_test"
echo "  mysql ${DB}_restore_test -e 'SELECT COUNT(*) FROM \`user\`'   # must match the count above"
echo "  mysql -e 'DROP DATABASE ${DB}_restore_test'"
