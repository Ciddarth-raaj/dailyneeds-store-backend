#!/usr/bin/env bash
# Stage 0B / B2 — the PRODUCTION HR permission policy operation.
#
#   scripts/auth/b2-prod-policy.sh snapshot   <dir>
#   scripts/auth/b2-prod-policy.sh apply      <dir>   APPLY-B2-HR-POLICY
#   scripts/auth/b2-prod-policy.sh verify     <dir>
#   scripts/auth/b2-prod-policy.sh rollback   <dir>   ROLLBACK-B2-HR-POLICY
#
# The policy, and nothing else:
#   * designation 11 (HR Executive) holds all 22 B2 HR permission keys, active
#   * every other designation holds none of those 22
#   * no permission_key outside those 22 is read, written or deleted
#   * user_type = 2 (admin) is untouched - its bypass lives in code, not here
#
# Idempotent: apply clears the 22 keys everywhere and re-inserts the HR grant,
# so a second run leaves 22 rows, not 44. The `permissions` table has no unique
# key, so this delete-then-insert shape is the only safe way to converge.
#
# Rollback is exact, not approximate: snapshot writes every existing row that
# carries one of the 22 keys - designation_id, permission_key, is_active AND
# created_at - to a TSV, and rollback replays those four columns verbatim.
# Values move as bound-free TSV fields through awk, never through CONCAT or
# QUOTE in SQL, because building statements in SQL is what produced
# `ERROR 1270 Illegal mix of collations` on this very host during rehearsal.
#
# Both mutating subcommands require the literal confirmation word as the last
# argument, so neither can run from a shell-history arrow key.
set -uo pipefail

CMD="${1:-}"
DIR="${2:-}"
CONFIRM="${3:-}"
BIN="${MYSQL_BIN_DIR:-$HOME/mysql84/bin}"
DEFAULTS="${STAGE0A_DEFAULTS:-$HOME/.stage0a/app.cnf}"
DB="${B2_DB:-dnds_prod}"
HR_DESIGNATION="${B2_HR_DESIGNATION:-11}"
MYSQL="$BIN/mysql"

KEYS="'view_employees','add_employees','view_banks','add_banks','view_family','add_family','view_documents','add_documents','view_employee_sensitive','edit_employee_sensitive','view_salary_advance','add_salary_advance','view_resignation','add_resignation','view_designation','add_designation','view_department','add_department','view_shift','add_shifts','view_stores','add_stores'"

fail() { echo "FAIL: $*" >&2; exit 1; }
[ -n "$CMD" ] && [ -n "$DIR" ] || fail "usage: b2-prod-policy.sh snapshot|apply|verify|rollback <dir> [confirmation]"
[ -x "$MYSQL" ] || fail "$MYSQL not found (set MYSQL_BIN_DIR)"
[ -r "$DEFAULTS" ] || fail "cannot read $DEFAULTS"
mkdir -p "$DIR" || fail "cannot create $DIR"

SNAP="$DIR/b2-hr-permissions-before.tsv"
NONHR="$DIR/b2-non-hr-fingerprint-before.tsv"

Q()  { "$MYSQL" --defaults-extra-file="$DEFAULTS" -N -B "$DB" -e "$1"; }
QT() { "$MYSQL" --defaults-extra-file="$DEFAULTS" --table "$DB" -e "$1"; }

# The non-HR fingerprint is the proof that this operation touched nothing else:
# every permission row whose key is NOT one of the 22, ordered, compared
# byte for byte before and after.
nonhr_fingerprint() {
  Q "SELECT designation_id, permission_key, is_active FROM permissions
      WHERE permission_key NOT IN ($KEYS)
      ORDER BY designation_id, permission_key"
}

case "$CMD" in
  snapshot)
    echo "== B2 production policy — SNAPSHOT (read only) on '$DB'"
    Q "SELECT designation_id, permission_key, is_active, created_at
         FROM permissions WHERE permission_key IN ($KEYS)
        ORDER BY designation_id, permission_key" > "$SNAP" || fail "snapshot query failed"
    nonhr_fingerprint > "$NONHR" || fail "fingerprint query failed"
    chmod 600 "$SNAP" "$NONHR"
    echo "   HR-key rows before      : $(grep -c . "$SNAP")   -> $SNAP"
    echo "   non-HR permission rows  : $(grep -c . "$NONHR")  -> $NONHR"
    echo
    QT "SELECT designation_id, COUNT(*) AS hr_key_rows, SUM(is_active=1) AS active
          FROM permissions WHERE permission_key IN ($KEYS)
         GROUP BY designation_id ORDER BY designation_id"
    echo "SNAPSHOT COMPLETE - keep $DIR until the change is accepted"
    ;;

  apply)
    [ "$CONFIRM" = "APPLY-B2-HR-POLICY" ] || fail "apply requires the confirmation word APPLY-B2-HR-POLICY as the third argument"
    [ -s "$SNAP" ] || fail "no snapshot at $SNAP - run 'snapshot' first; there must be a rollback before there is a change"
    echo "== B2 production policy — APPLY on '$DB', HR designation $HR_DESIGNATION"
    "$MYSQL" --defaults-extra-file="$DEFAULTS" "$DB" <<SQL || fail "the policy did not apply"
START TRANSACTION;
DELETE FROM \`permissions\` WHERE \`permission_key\` IN ($KEYS);
INSERT INTO \`permissions\` (\`permission_key\`, \`designation_id\`, \`is_active\`)
SELECT k.permission_key, $HR_DESIGNATION, 1 FROM (
  SELECT 'view_employees' AS permission_key UNION ALL SELECT 'add_employees' UNION ALL
  SELECT 'view_banks'              UNION ALL SELECT 'add_banks'              UNION ALL
  SELECT 'view_family'             UNION ALL SELECT 'add_family'             UNION ALL
  SELECT 'view_documents'          UNION ALL SELECT 'add_documents'          UNION ALL
  SELECT 'view_employee_sensitive' UNION ALL SELECT 'edit_employee_sensitive' UNION ALL
  SELECT 'view_salary_advance'     UNION ALL SELECT 'add_salary_advance'     UNION ALL
  SELECT 'view_resignation'        UNION ALL SELECT 'add_resignation'        UNION ALL
  SELECT 'view_designation'        UNION ALL SELECT 'add_designation'        UNION ALL
  SELECT 'view_department'         UNION ALL SELECT 'add_department'         UNION ALL
  SELECT 'view_shift'              UNION ALL SELECT 'add_shifts'             UNION ALL
  SELECT 'view_stores'             UNION ALL SELECT 'add_stores'
) k;
COMMIT;
SQL
    echo "POLICY APPLIED - now run: $0 verify $DIR"
    ;;

  rollback)
    [ "$CONFIRM" = "ROLLBACK-B2-HR-POLICY" ] || fail "rollback requires the confirmation word ROLLBACK-B2-HR-POLICY as the third argument"
    [ -r "$SNAP" ] || fail "cannot read $SNAP"
    echo "== B2 production policy — ROLLBACK on '$DB' from $SNAP"
    SQL="$(awk -F'\t' '
      function lit(v) {
        if (v == "NULL") return "NULL"
        gsub(/\\/, "\\\\", v); gsub(/\x27/, "\\\x27", v)
        return "\x27" v "\x27"
      }
      NF == 0 { next }
      { printf "INSERT INTO `permissions` (`designation_id`,`permission_key`,`is_active`,`created_at`) VALUES (%s,%s,%s,%s);\n", lit($1), lit($2), lit($3), lit($4) }
    ' "$SNAP")"
    ROWS="$(grep -c . "$SNAP")"
    printf 'START TRANSACTION;\nDELETE FROM `permissions` WHERE `permission_key` IN (%s);\n%s\nCOMMIT;\n' "$KEYS" "$SQL" \
      | "$MYSQL" --defaults-extra-file="$DEFAULTS" "$DB" || fail "rollback did not apply"
    AFTER="$(mktemp)"; trap 'rm -f "$AFTER"' EXIT
    Q "SELECT designation_id, permission_key, is_active, created_at
         FROM permissions WHERE permission_key IN ($KEYS)
        ORDER BY designation_id, permission_key" > "$AFTER"
    if diff -q "$SNAP" "$AFTER" >/dev/null; then
      echo "  PASS  all $ROWS HR-key rows match the pre-change snapshot byte for byte"
      echo "ROLLBACK VERIFIED"
      exit 0
    fi
    echo "  FAIL  the restored rows differ from the snapshot"
    diff "$SNAP" "$AFTER" | head -40
    exit 1
    ;;

  verify)
    echo "== B2 production policy — VERIFY (read only) on '$DB'"
    QT "SELECT $HR_DESIGNATION AS hr_designation_id, COUNT(*) AS rows_total,
               COUNT(DISTINCT permission_key) AS distinct_keys, SUM(is_active=1) AS active_rows,
               IF(COUNT(*)=22 AND COUNT(DISTINCT permission_key)=22 AND SUM(is_active=1)=22,'PASS','FAIL') AS verdict
          FROM permissions WHERE designation_id = $HR_DESIGNATION AND permission_key IN ($KEYS)"
    QT "SELECT COUNT(*) AS stray_hr_rows_on_other_designations, IF(COUNT(*)=0,'PASS','FAIL') AS verdict
          FROM permissions WHERE designation_id <> $HR_DESIGNATION AND permission_key IN ($KEYS)"
    QT "SELECT ap.permission_key,
               (SELECT COUNT(*) FROM permissions p WHERE p.permission_key=ap.permission_key AND p.is_active=1) AS active_grants
          FROM all_permissions ap
         WHERE ap.permission_key IN ('view_employee_sensitive','edit_employee_sensitive','add_documents','add_stores')
         ORDER BY ap.permission_key"
    if [ -r "$NONHR" ]; then
      AFTER="$(mktemp)"; trap 'rm -f "$AFTER"' EXIT
      nonhr_fingerprint > "$AFTER"
      if diff -q "$NONHR" "$AFTER" >/dev/null; then
        echo "  PASS  non-HR permissions unchanged ($(grep -c . "$NONHR") rows, byte for byte)"
      else
        echo "  FAIL  non-HR permissions CHANGED:"
        diff "$NONHR" "$AFTER" | head -40
        exit 1
      fi
    else
      echo "  WARN  no pre-change fingerprint at $NONHR - cannot prove non-HR rows are unchanged"
      exit 1
    fi
    echo "VERIFY COMPLETE - read the PASS/FAIL verdicts above"
    ;;

  *) fail "unknown subcommand '$CMD'";;
esac
