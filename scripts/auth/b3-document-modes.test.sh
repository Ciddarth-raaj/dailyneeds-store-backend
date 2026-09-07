#!/usr/bin/env bash
# Stage 0B / B3 — proves the three document modes b3-rehearsal.sh uses, against
# a REAL MySQL, on a throwaway schema of its own.
#
#   mysql -uroot must work locally;  bash scripts/auth/b3-document-modes.test.sh
#
# This exists because the first real run of the rehearsal failed on exactly
# this ground: dnds_rehearsal held no Aadhaar or PAN document, and the script
# exited before testing anything. The handling added for that - borrow an
# ordinary row, or create a temporary one - is only worth having if it puts
# the copy back exactly, and "exactly" is a claim about MySQL's behaviour
# (ON UPDATE CURRENT_TIMESTAMP, the AUTO_INCREMENT counter, CHECKSUM TABLE),
# not about shell. So it is checked against MySQL rather than reasoned about.
#
# It touches only its own scratch database and drops it again. It is not part
# of `node --test`, which needs no database.
set -uo pipefail
DB=b3_scratch_test
M="mysql -uroot"
Q() { $M -N -B "$DB" -e "$1"; }
RUNSQL() { $M "$DB"; }
lit() { [ "$1" = "NULL" ] && printf 'NULL' || printf "'%s'" "$1"; }

$M -e "DROP DATABASE IF EXISTS $DB; CREATE DATABASE $DB"
$M "$DB" -e "CREATE TABLE \`new_employee_documents\` ( \`document_id\` INT NOT NULL AUTO_INCREMENT, \`employee_id\` INT NULL, \`card_type\` VARCHAR(45) NULL, \`card_no\` VARCHAR(45) NULL, \`card_name\` VARCHAR(45) NULL, \`file\` LONGTEXT NOT NULL, \`expiry_date\` DATE NULL, \`is_verified\` TINYINT NULL DEFAULT '0', \`created_at\` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP, \`updated_at\` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, \`status\` TINYINT NULL DEFAULT 1, PRIMARY KEY (\`document_id\`));"

SENSITIVE_CARD_SQL="CAST(card_type AS UNSIGNED) IN (1,4)"
FAILED=0
check() { if [ "$2" = "$3" ]; then echo "  PASS  $1"; else echo "  FAIL  $1: got [$2] want [$3]"; FAILED=1; fi; }

doc_restore_line() {
  local id="$1" row ct st iv ua
  row="$(Q "SELECT IFNULL(card_type,'NULL'), IFNULL(status,'NULL'), IFNULL(is_verified,'NULL'), IFNULL(updated_at,'NULL') FROM new_employee_documents WHERE document_id = $id")"
  ct="$(echo "$row" | cut -f1)"; st="$(echo "$row" | cut -f2)"
  iv="$(echo "$row" | cut -f3)"; ua="$(echo "$row" | cut -f4)"
  echo "UPDATE \`new_employee_documents\` SET \`card_type\` = $(lit "$ct"), \`status\` = $(lit "$st"), \`is_verified\` = $(lit "$iv"), \`updated_at\` = $(lit "$ua") WHERE document_id = $id;"
}

echo "== mode: existing"
Q "INSERT INTO new_employee_documents (employee_id, card_type, card_no, card_name, file) VALUES (1,'1','A','Aadhaar','s3://a'),(1,'3','V','Voter','s3://v')"
check "sensitive row found" "$(Q "SELECT document_id FROM new_employee_documents WHERE $SENSITIVE_CARD_SQL ORDER BY document_id LIMIT 1")" "1"
check "ordinary row found"  "$(Q "SELECT document_id FROM new_employee_documents WHERE NOT ($SENSITIVE_CARD_SQL) ORDER BY document_id LIMIT 1")" "2"
check "PAN counts as sensitive" "$(Q "SELECT CAST('4' AS UNSIGNED) IN (1,4)")" "1"
check "a non-numeric type is not sensitive" "$(Q "SELECT CAST('other' AS UNSIGNED) IN (1,4)")" "0"

echo "== mode: borrowed (single ordinary row, so a second pass is needed)"
$M -e "DROP DATABASE IF EXISTS $DB; CREATE DATABASE $DB"
$M "$DB" -e "CREATE TABLE \`new_employee_documents\` ( \`document_id\` INT NOT NULL AUTO_INCREMENT, \`employee_id\` INT NULL, \`card_type\` VARCHAR(45) NULL, \`card_no\` VARCHAR(45) NULL, \`card_name\` VARCHAR(45) NULL, \`file\` LONGTEXT NOT NULL, \`expiry_date\` DATE NULL, \`is_verified\` TINYINT NULL DEFAULT '0', \`created_at\` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP, \`updated_at\` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, \`status\` TINYINT NULL DEFAULT 1, PRIMARY KEY (\`document_id\`));"
Q "INSERT INTO new_employee_documents (employee_id, card_type, card_no, card_name, file) VALUES (1,'3','V','Voter','s3://v')"
CK_BEFORE="$(Q "CHECKSUM TABLE new_employee_documents" | cut -f2)"
BEFORE_ROW="$(Q "SELECT document_id, card_type, status, is_verified, updated_at FROM new_employee_documents ORDER BY document_id")"
SENSITIVE_DOC="$(Q "SELECT document_id FROM new_employee_documents WHERE $SENSITIVE_CARD_SQL ORDER BY document_id LIMIT 1")"
check "no sensitive row to start with" "${SENSITIVE_DOC:-none}" "none"
BORROWED_DOC="$(Q "SELECT document_id FROM new_employee_documents WHERE NOT ($SENSITIVE_CARD_SQL) ORDER BY document_id LIMIT 1")"
BORROWED_CARD_TYPE="$(Q "SELECT IFNULL(card_type,'NULL') FROM new_employee_documents WHERE document_id = $BORROWED_DOC")"
SECOND="$(Q "SELECT document_id FROM new_employee_documents WHERE NOT ($SENSITIVE_CARD_SQL) AND document_id <> $BORROWED_DOC ORDER BY document_id LIMIT 1")"
check "no second ordinary row, so a second pass is required" "${SECOND:-none}" "none"
RESTORE="$(mktemp)"
trap 'rm -f "$RESTORE"' EXIT
doc_restore_line "$BORROWED_DOC" > "$RESTORE"
sleep 1
Q "UPDATE new_employee_documents SET card_type = '1' WHERE document_id = $BORROWED_DOC"
check "the borrowed row now reads as Aadhaar" "$(Q "SELECT card_type FROM new_employee_documents WHERE document_id = $BORROWED_DOC")" "1"
check "and the guard would treat it as sensitive" "$(Q "SELECT COUNT(*) FROM new_employee_documents WHERE $SENSITIVE_CARD_SQL")" "1"
# second pass: give the type back before the ordinary check
Q "UPDATE new_employee_documents SET card_type = $(lit "$BORROWED_CARD_TYPE") WHERE document_id = $BORROWED_DOC"
check "second pass sees an ordinary document again" "$(Q "SELECT COUNT(*) FROM new_employee_documents WHERE $SENSITIVE_CARD_SQL")" "0"
# an app write of the same status, as the checker performs
Q "UPDATE new_employee_documents SET status = status WHERE document_id = $BORROWED_DOC"
RUNSQL < "$RESTORE"
check "row restored exactly (updated_at included)" "$(Q "SELECT document_id, card_type, status, is_verified, updated_at FROM new_employee_documents ORDER BY document_id")" "$BEFORE_ROW"
check "table checksum unchanged" "$(Q "CHECKSUM TABLE new_employee_documents" | cut -f2)" "$CK_BEFORE"

echo "== mode: created (no documents at all)"
$M -e "DROP DATABASE IF EXISTS $DB; CREATE DATABASE $DB"
$M "$DB" -e "CREATE TABLE \`new_employee_documents\` ( \`document_id\` INT NOT NULL AUTO_INCREMENT, \`employee_id\` INT NULL, \`card_type\` VARCHAR(45) NULL, \`card_no\` VARCHAR(45) NULL, \`card_name\` VARCHAR(45) NULL, \`file\` LONGTEXT NOT NULL, \`expiry_date\` DATE NULL, \`is_verified\` TINYINT NULL DEFAULT '0', \`created_at\` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP, \`updated_at\` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, \`status\` TINYINT NULL DEFAULT 1, PRIMARY KEY (\`document_id\`));"
# make the counter non-trivial, as a real copy's would be
Q "INSERT INTO new_employee_documents (employee_id, card_type, card_no, card_name, file) VALUES (1,'3','V','Voter','s3://v')"
Q "DELETE FROM new_employee_documents"
CK_BEFORE="$(Q "CHECKSUM TABLE new_employee_documents" | cut -f2)"
AI_BEFORE="$(Q "SELECT AUTO_INCREMENT FROM information_schema.TABLES WHERE TABLE_SCHEMA='$DB' AND TABLE_NAME='new_employee_documents'")"
MARKER="B3-REHEARSAL-TEST"
{
  echo "DELETE FROM \`new_employee_documents\` WHERE \`card_no\` = '$MARKER';"
  echo "ALTER TABLE \`new_employee_documents\` AUTO_INCREMENT = $AI_BEFORE;"
} > "$RESTORE"
Q "INSERT INTO \`new_employee_documents\` (employee_id, card_type, card_no, card_name, file, is_verified, status) VALUES (1, '1', '$MARKER', 'B3 rehearsal', 'rehearsal-only://no-file', 0, 1)"
CREATED="$(Q "SELECT document_id FROM new_employee_documents WHERE card_no = '$MARKER' ORDER BY document_id LIMIT 1")"
check "temporary document created" "$(Q "SELECT card_type FROM new_employee_documents WHERE document_id = $CREATED")" "1"
RUNSQL < "$RESTORE"
check "temporary document deleted" "$(Q "SELECT COUNT(*) FROM new_employee_documents WHERE card_no = '$MARKER'")" "0"
check "AUTO_INCREMENT put back" "$(Q "SELECT AUTO_INCREMENT FROM information_schema.TABLES WHERE TABLE_SCHEMA='$DB' AND TABLE_NAME='new_employee_documents'")" "$AI_BEFORE"
check "table checksum unchanged" "$(Q "CHECKSUM TABLE new_employee_documents" | cut -f2)" "$CK_BEFORE"

$M -e "DROP DATABASE IF EXISTS $DB"
[ "$FAILED" = "0" ] && echo "ALL DOCUMENT-MODE CHECKS PASSED" || echo "DOCUMENT-MODE CHECKS FAILED"
exit "$FAILED"
