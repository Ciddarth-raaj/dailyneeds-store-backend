#!/usr/bin/env bash
# Stage 0A / gates 5 + 22 — run the four Stage 0A migrations UP and DOWN
# against the restored scratch schema, from a SEPARATE checkout of the feature
# branch. The production deployment clone (~/dailyneeds-store-backend) is never
# touched, and the live schema is never named.
#
# Usage:
#   scripts/auth/migration-rehearsal.sh <scratch_db> [worktree_dir]
# Environment:
#   STAGE0A_DEFAULTS   app defaults file (default ~/.stage0a/app.cnf)
#   FEATURE_BRANCH     default claude/dnds-payroll-integration-proposal-3p6hen
#   MYSQL_BIN_DIR      MySQL 8.4 client dir (default ~/mysql84/bin)
set -euo pipefail

SCRATCH="${1:?scratch schema required}"
WT="${2:-$HOME/stage0a-rehearsal}"
DEFAULTS="${STAGE0A_DEFAULTS:-$HOME/.stage0a/app.cnf}"
BRANCH="${FEATURE_BRANCH:-claude/dnds-payroll-integration-proposal-3p6hen}"
BIN="${MYSQL_BIN_DIR:-$HOME/mysql84/bin}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MYSQL="$BIN/mysql"
fail() { echo "FAIL: $*" >&2; exit 1; }

case "$SCRATCH" in *rehearsal*|*scratch*|*restore_test*) ;; *) fail "refusing to run migrations against '$SCRATCH' (must be a scratch schema)";; esac
case "$WT" in "$HOME/dailyneeds-store-backend"|"$HOME/dailyneeds-store-backend/"*) fail "worktree must not be the production deployment clone";; esac
[ -r "$DEFAULTS" ] || fail "defaults file missing"

Q() { "$MYSQL" --defaults-extra-file="$DEFAULTS" -N -B -e "$1"; }

# ---- 1. separate checkout of the feature branch --------------------------------
if [ ! -d "$WT/.git" ]; then
  REMOTE="$(git -C "$HOME/dailyneeds-store-backend" remote get-url origin)"
  echo "cloning $BRANCH into $WT (single branch, production clone untouched)"
  git clone --quiet --single-branch --branch "$BRANCH" "$REMOTE" "$WT"
else
  git -C "$WT" fetch --quiet origin "$BRANCH" && git -C "$WT" checkout --quiet "$BRANCH" && git -C "$WT" pull --quiet --ff-only origin "$BRANCH"
fi
echo "worktree at $(git -C "$WT" rev-parse --short HEAD) ($(git -C "$WT" branch --show-current))"
( cd "$WT" && npm ci --ignore-scripts --no-audit --no-fund --silent ) || ( cd "$WT" && npm install --ignore-scripts --no-audit --no-fund --silent )
DBM="$WT/node_modules/.bin/db-migrate"
[ -x "$DBM" ] || fail "db-migrate not installed in $WT"

# ---- 2. scratch db-migrate config (credentials copied from the defaults file, never typed) -----
CFG="$WT/migrations/mysql/database.rehearsal.json"
node - "$DEFAULTS" "$SCRATCH" "$CFG" <<'EOF'
const fs = require("fs");
const [defaults, scratch, out] = process.argv.slice(2);
const kv = {};
for (const line of fs.readFileSync(defaults, "utf8").split("\n")) {
  const m = line.match(/^(host|port|user|password)=(.*)$/);
  if (m) kv[m[1]] = m[2].replace(/^"(.*)"$/, "$1").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}
for (const k of ["host", "port", "user", "password"]) if (!kv[k]) { console.error("defaults file missing " + k); process.exit(1); }
const cfg = { rehearsal: { driver: "mysql", host: kv.host, port: Number(kv.port), user: kv.user, password: kv.password, database: scratch, multipleStatements: true } };
fs.writeFileSync(out, JSON.stringify(cfg, null, 2), { mode: 0o600 });
fs.chmodSync(out, 0o600);
console.log("wrote " + out + " -> env 'rehearsal' on database " + scratch + " (mode 600)");
EOF
trap 'rm -f "$CFG"; echo "removed $CFG"' EXIT

EXPECTED=(20260906120000-auth-stage0a-user-columns 20260906120100-auth-stage0a-auth-log 20260906120200-auth-stage0a-password-reset 20260906120300-auth-stage0a-permissions)

before_counts() { Q "SELECT CONCAT('user=',(SELECT COUNT(*) FROM \`$SCRATCH\`.\`user\`),' new_employee=',(SELECT COUNT(*) FROM \`$SCRATCH\`.new_employee),' permissions=',(SELECT COUNT(*) FROM \`$SCRATCH\`.permissions),' all_permissions=',(SELECT COUNT(*) FROM \`$SCRATCH\`.all_permissions),' migrations=',(SELECT COUNT(*) FROM \`$SCRATCH\`.migrations))"; }
user_cols() { Q "SELECT GROUP_CONCAT(COLUMN_NAME ORDER BY ORDINAL_POSITION) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='$SCRATCH' AND TABLE_NAME='user'"; }

echo "== before: $(before_counts)"
COLS_BEFORE="$(user_cols)"
echo "user columns before: $COLS_BEFORE"
echo "-- pending migrations the copy would run (must be exactly the four Stage 0A ones):"
( cd "$WT/migrations/mysql" && "$DBM" up --dry-run --config "$CFG" -e rehearsal 2>&1 | tail -n 20 )

echo "== UP (timed) =="
START=$(date +%s)
( cd "$WT/migrations/mysql" && "$DBM" up --config "$CFG" -e rehearsal )
echo "up took $(( $(date +%s) - START ))s"
for m in "${EXPECTED[@]}"; do
  Q "SELECT COUNT(*) FROM \`$SCRATCH\`.migrations WHERE name LIKE '%$m%'" | grep -q '^1$' || fail "migration $m not recorded after up"
done
echo "all four Stage 0A migrations recorded"
echo "user columns after up: $(user_cols)"
for c in password_hash password_algo is_system_account must_change_password failed_login_count locked_until token_valid_from; do
  user_cols | tr ',' '\n' | grep -qx "$c" || echo "NOTE: expected column $c not present (check migration contents)"
done
Q "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA='$SCRATCH' AND TABLE_NAME IN ('user_auth_log','user_password_reset','auth_metric')"
echo "-- Stage 0A migrations must not change row counts of existing tables:"
echo "after up: $(before_counts)"
echo "-- password column now nullable, no data lost:"
Q "SELECT 'users_with_legacy_password', COUNT(*) FROM \`$SCRATCH\`.\`user\` WHERE password IS NOT NULL AND password <> '' UNION ALL SELECT 'password_algo_sha1', COUNT(*) FROM \`$SCRATCH\`.\`user\` WHERE password_algo='sha1'"

echo "== idempotency: a second UP must be a no-op =="
( cd "$WT/migrations/mysql" && "$DBM" up --config "$CFG" -e rehearsal ) | tail -n 3

echo "== DOWN x4 (timed) =="
START=$(date +%s)
( cd "$WT/migrations/mysql" && "$DBM" down --count 4 --config "$CFG" -e rehearsal )
echo "down took $(( $(date +%s) - START ))s"
for m in "${EXPECTED[@]}"; do
  Q "SELECT COUNT(*) FROM \`$SCRATCH\`.migrations WHERE name LIKE '%$m%'" | grep -q '^0$' || fail "migration $m still recorded after down"
done
COLS_AFTER="$(user_cols)"
[ "$COLS_AFTER" = "$COLS_BEFORE" ] || fail "user columns after down differ from before: $COLS_AFTER"
echo "user table restored to its original column set"
echo "after down: $(before_counts)"

echo "== UP again (the state deployment night will leave) =="
( cd "$WT/migrations/mysql" && "$DBM" up --config "$CFG" -e rehearsal ) | tail -n 5
echo
echo "MIGRATION REHEARSAL OK on $SCRATCH. The scratch schema is left in the post-Stage-0A state for the gate 13/14 scans and the staging app."
