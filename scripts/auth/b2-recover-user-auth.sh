#!/usr/bin/env bash
# Stage 0B / B2 — one-time recovery of the three test users' auth columns on a
# SCRATCH copy, from a `user-auth-before.tsv` snapshot left by a rehearsal run
# that changed their passwords and then failed before restoring them.
#
#   scripts/auth/b2-recover-user-auth.sh <snapshot.tsv> [scratch_db]
#
# Defaults to dnds_rehearsal. It:
#   * refuses any database not named like a scratch copy, so dnds_prod cannot
#     be reached even by a typo
#   * reads the snapshot, restores exactly the users it names, and nothing else
#   * verifies every column of every user against the snapshot afterwards
#   * prints column NAMES and PASS/FAIL only - never a password or a hash
#
# The snapshot is the tab-separated output of
#   SELECT <auth columns> FROM `user` WHERE user_id IN (...) ORDER BY user_id
# with the mysql client's -N -B flags, so the first column is user_id, the
# remaining columns are the auth columns in the table's ordinal order, and an
# SQL NULL appears as the bare token NULL. (A literal string "NULL" in a
# password column would be indistinguishable; no such value exists, and the
# verification below would catch it if it did.)
set -uo pipefail

SNAPSHOT="${1:?usage: b2-recover-user-auth.sh <snapshot.tsv> [scratch_db]}"
SCRATCH="${2:-dnds_rehearsal}"
BIN="${MYSQL_BIN_DIR:-$HOME/mysql84/bin}"
DEFAULTS="${STAGE0A_DEFAULTS:-$HOME/.stage0a/app.cnf}"
MYSQL="$BIN/mysql"

fail() { echo "FAIL: $*" >&2; exit 1; }
case "$SCRATCH" in *rehearsal*|*scratch*|*restore_test*) ;; *) fail "refusing to touch '$SCRATCH' - not a scratch schema";; esac
[ -r "$SNAPSHOT" ] || fail "cannot read $SNAPSHOT"
[ -r "$DEFAULTS" ] || fail "cannot read $DEFAULTS"
[ -x "$MYSQL" ] || fail "$MYSQL not found (set MYSQL_BIN_DIR)"
Q() { "$MYSQL" --defaults-extra-file="$DEFAULTS" -N -B "$SCRATCH" -e "$1"; }

# The snapshot has no header, so the column names come from the same query the
# rehearsal used to write it: the auth columns this table has, ordinal order.
COLS="$(Q "SELECT GROUP_CONCAT(COLUMN_NAME ORDER BY ORDINAL_POSITION) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='$SCRATCH' AND TABLE_NAME='user' AND COLUMN_NAME IN ('user_id','password','password_hash','password_algo','must_change_password','password_flag_reason','failed_login_count','locked_until','last_login_at','token_valid_from','credential_rotated_at')")"
[ -n "$COLS" ] || fail "could not read the user table's auth columns from $SCRATCH"

ROWS="$(grep -c . "$SNAPSHOT")"
FIELDS="$(head -1 "$SNAPSHOT" | awk -F'\t' '{print NF}')"
EXPECTED="$(echo "$COLS" | awk -F',' '{print NF}')"
echo "== B2 one-time auth recovery on '$SCRATCH'"
echo "   snapshot: $SNAPSHOT  ($ROWS rows, $FIELDS fields per row)"
echo "   columns:  $COLS"
[ "$FIELDS" = "$EXPECTED" ] || fail "snapshot has $FIELDS fields but this table has $EXPECTED auth columns - wrong snapshot for this schema"
[ "$ROWS" -gt 0 ] || fail "snapshot is empty"

# Build the UPDATEs with awk: values are passed as SQL literals with the two
# characters that matter escaped, and the bare token NULL becomes SQL NULL.
# Nothing is echoed to the terminal - the statements go straight to the client.
SQL="$(awk -F'\t' -v cols="$COLS" '
  BEGIN { n = split(cols, c, ",") }
  NF == 0 { next }
  {
    stmt = ""
    for (i = 2; i <= n; i++) {
      v = $i
      if (v == "NULL") { lit = "NULL" }
      else {
        gsub(/\\/, "\\\\", v)
        gsub(/\x27/, "\\\x27", v)
        lit = "\x27" v "\x27"
      }
      stmt = stmt (stmt == "" ? "" : ", ") "`" c[i] "` = " lit
    }
    printf "UPDATE `user` SET %s WHERE user_id = %s;\n", stmt, $1
  }' "$SNAPSHOT")"
[ -n "$SQL" ] || fail "no statements generated"

echo "   applying $(printf '%s' "$SQL" | grep -c '^UPDATE') statement(s) (contents not shown)"
printf '%s\n' "$SQL" | "$MYSQL" --defaults-extra-file="$DEFAULTS" "$SCRATCH" || fail "the recovery statements did not apply"

# Verify: re-read the same columns for the same users and diff against the
# snapshot. Byte comparison, no values printed.
IDS="$(awk -F'\t' 'NF{printf "%s%s", sep, $1; sep=","}' "$SNAPSHOT")"
AFTER="$(mktemp)"
trap 'rm -f "$AFTER"' EXIT
Q "SELECT $(echo "$COLS" | sed 's/\([a-z_]*\)/`\1`/g') FROM \`user\` WHERE user_id IN ($IDS) ORDER BY user_id" > "$AFTER"
if diff -q "$SNAPSHOT" "$AFTER" >/dev/null; then
  echo "  PASS  all $ROWS users match the snapshot byte for byte"
  echo "RECOVERY VERIFIED: the auth columns of $IDS on $SCRATCH are back to their pre-rehearsal values"
  exit 0
fi
echo "  FAIL  the restored rows differ from the snapshot; differing user_ids:"
diff "$SNAPSHOT" "$AFTER" | grep -E '^[<>]' | awk -F'\t' '{print "        user_id " $1}' | sort -u
echo "        (values deliberately not shown; compare $SNAPSHOT yourself if needed)"
exit 1
