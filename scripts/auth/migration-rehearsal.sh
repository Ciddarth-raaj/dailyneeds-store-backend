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
if [ ! -d "$WT/node_modules/db-migrate-mysql" ]; then
  ( cd "$WT" && npm ci --ignore-scripts --no-audit --no-fund --silent ) || ( cd "$WT" && npm install --ignore-scripts --no-audit --no-fund --silent )
fi
# The deploy workflow runs a GLOBAL `db-migrate` (package.json lists only the
# mysql driver). Prefer the same binary production uses; fall back to a local one.
DBM="${DB_MIGRATE_BIN:-$(command -v db-migrate || true)}"
[ -n "$DBM" ] || DBM="$WT/node_modules/.bin/db-migrate"
[ -x "$DBM" ] || fail "db-migrate not found (global or $WT/node_modules/.bin). Production runs a global one: check 'command -v db-migrate'."
echo "db-migrate: $DBM ($("$DBM" --version 2>/dev/null | head -1))"
# db-migrate resolves the mysql driver relative to its own install; a global
# db-migrate needs db-migrate-mysql resolvable — the worktree's copy via NODE_PATH.
export NODE_PATH="$WT/node_modules${NODE_PATH:+:$NODE_PATH}"

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

# db-migrate uses the same `mysql` (v2) driver as the backend, which cannot
# speak caching_sha2_password. The production app user works with it by
# definition; prove the scratch config does too before touching the schema.
( cd "$WT" && node -e '
  const cfg = require(process.argv[1]).rehearsal;
  const c = require("mysql").createConnection({ host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password, database: cfg.database });
  c.connect((err) => { if (err) { console.error("driver connect failed: " + err.code + " (" + err.message.split("\n")[0] + ")"); process.exit(1); }
    c.query("SELECT DATABASE() AS db", (e, rows) => { if (e) { console.error(e.message); process.exit(1); } console.log("driver connect ok, database=" + rows[0].db); c.end(); }); });
' "$CFG" ) || fail "the mysql driver db-migrate uses cannot connect to $SCRATCH (see message above; a caching_sha2_password user needs mysql_native_password for this driver)"

EXPECTED=(20260906120000-auth-stage0a-user-columns 20260906120100-auth-stage0a-auth-log 20260906120200-auth-stage0a-password-reset 20260906120300-auth-stage0a-permissions)

cnt() { Q "SELECT COUNT(*) FROM \`$SCRATCH\`.\`$1\`"; }
before_counts() { echo "user=$(cnt user) new_employee=$(cnt new_employee) permissions=$(cnt permissions) all_permissions=$(cnt all_permissions) migrations=$(cnt migrations)"; }
user_cols() { Q "SELECT GROUP_CONCAT(COLUMN_NAME ORDER BY ORDINAL_POSITION) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='$SCRATCH' AND TABLE_NAME='user'"; }
# full definition of every user column (type, nullability, default) — down must restore this exactly
user_shape() { Q "SELECT GROUP_CONCAT(CONCAT(COLUMN_NAME,':',COLUMN_TYPE,':',IS_NULLABLE,':',IFNULL(COLUMN_DEFAULT,'<null>')) ORDER BY ORDINAL_POSITION SEPARATOR ' | ') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='$SCRATCH' AND TABLE_NAME='user'"; }
user_indexes() { Q "SELECT GROUP_CONCAT(DISTINCT INDEX_NAME ORDER BY INDEX_NAME) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA='$SCRATCH' AND TABLE_NAME='user'"; }

echo "== before: $(before_counts)"
U0=$(cnt user); E0=$(cnt new_employee); P0=$(cnt permissions); A0=$(cnt all_permissions)
NEWKEYS_ABSENT=$(Q "SELECT 3 - COUNT(DISTINCT permission_key) FROM \`$SCRATCH\`.all_permissions WHERE permission_key IN ('manage_user_accounts','unlock_user_accounts','view_auth_log')")
COLS_BEFORE="$(user_cols)"; SHAPE_BEFORE="$(user_shape)"; IDX_BEFORE="$(user_indexes)"
echo "user columns before: $COLS_BEFORE"
echo "user.password before: $(Q "SELECT CONCAT(COLUMN_TYPE,' ',IF(IS_NULLABLE='YES','NULL','NOT NULL')) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='$SCRATCH' AND TABLE_NAME='user' AND COLUMN_NAME='password'")   (migration assumes TEXT NOT NULL)"
echo "-- pending migrations (files in the checkout minus rows in $SCRATCH.migrations) — must be exactly the four Stage 0A ones:"
PENDING="$(comm -23 \
  <(ls "$WT/migrations/mysql/migrations"/*.js | xargs -n1 basename | sed 's/\.js$//' | sort) \
  <(Q "SELECT TRIM(LEADING '/' FROM name) FROM \`$SCRATCH\`.migrations" | sort))"
echo "$PENDING" | sed 's/^/   /'
EXPECTED_LIST="$(printf '%s\n' "${EXPECTED[@]}" | sort)"
[ "$PENDING" = "$EXPECTED_LIST" ] || fail "pending set is not exactly the four Stage 0A migrations. Either the restored copy's migrations table is behind production, or the checkout carries other migrations. Refusing to run 'up'."
echo "-- db-migrate dry run (SQL it would execute; nothing runs):"
( cd "$WT/migrations/mysql" && "$DBM" up --dry-run --config "$CFG" -e rehearsal 2>&1 | grep -E '^\[INFO\]|migrations. \(.name' | head -n 12 )

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
echo "-- Stage 0A migrations must not change row counts of existing tables (all_permissions gains exactly the new keys):"
echo "after up: $(before_counts)"
[ "$(cnt user)" = "$U0" ] && [ "$(cnt new_employee)" = "$E0" ] && [ "$(cnt permissions)" = "$P0" ] || fail "row counts of user/new_employee/permissions changed during up"
[ "$(cnt all_permissions)" = "$((A0 + NEWKEYS_ABSENT))" ] || fail "all_permissions expected $((A0 + NEWKEYS_ABSENT)) rows after up, got $(cnt all_permissions)"
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
SHAPE_AFTER="$(user_shape)"
[ "$SHAPE_AFTER" = "$SHAPE_BEFORE" ] || fail "user column definitions after down differ from before (type/nullability/default):
  before: $SHAPE_BEFORE
  after:  $SHAPE_AFTER"
[ "$(user_indexes)" = "$IDX_BEFORE" ] || fail "user indexes after down differ from before: $(user_indexes) vs $IDX_BEFORE"
echo "user table restored to its original column set, definitions and indexes"
echo "after down: $(before_counts)"
[ "$(cnt user)" = "$U0" ] && [ "$(cnt new_employee)" = "$E0" ] && [ "$(cnt permissions)" = "$P0" ] && [ "$(cnt all_permissions)" = "$A0" ] || fail "row counts after down differ from the original"
for t in user_auth_log user_password_reset auth_metric; do
  Q "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='$SCRATCH' AND TABLE_NAME='$t'" | grep -q '^0$' || fail "table $t still exists after down"
done
echo "Stage 0A tables removed by down"

echo "== UP again (the state deployment night will leave) =="
( cd "$WT/migrations/mysql" && "$DBM" up --config "$CFG" -e rehearsal ) | tail -n 5
echo
echo "MIGRATION REHEARSAL OK on $SCRATCH. The scratch schema is left in the post-Stage-0A state for the gate 13/14 scans and the staging app."
