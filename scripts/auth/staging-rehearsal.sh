#!/usr/bin/env bash
# Stage 0A / gates 9, 10, 18A, 19A — run the Stage 0A application against the
# restored rehearsal copy and exercise login, legacy-token transition, the
# break-glass account and its alert. Production is never touched:
#   * the app instance is started from THIS checkout (never the deploy clone)
#     on a private port, with CRON_DISABLED=true (no Digisme sync, no
#     Telegram poller, no GST/purchase jobs) and TRUST_PROXY default
#   * its config.json is a copy of the production one with ONLY the main
#     database name replaced by the scratch schema (the original copy is
#     kept as config.prod.json, 600, and restored on exit)
#   * the JWT key is the CURRENT key loaded externally (gate 17A env file)
#   * TELEGRAM_BOT_TOKEN is read from the deploy clone's .env into the
#     instance's environment only (never printed) so the break-glass alert
#     goes through the real new-bot path; with the poller disabled there is
#     no getUpdates race with production
#   * staging credentials (one admin, the break-glass) are generated into
#     ~/.stage0a/staging-secrets.env (600) and set ONLY on the scratch schema
#
# Usage (from ~/stage0a-rehearsal):
#   MYSQL_BIN_DIR="$HOME/mysql84/bin" scripts/auth/staging-rehearsal.sh [scratch_db]
# Optional env: PORT (default 18080), DEPLOY_DIR (default ~/dailyneeds-store-backend),
#               ALERT_CHAT_ID (Telegram chat id to receive the break-glass alert; default = app default),
#               SKIP_TELEGRAM=1 (run without the bot token; the alert is only logged)
set -euo pipefail

SCRATCH="${1:-dnds_rehearsal}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WT="$(cd "$HERE/../.." && pwd)"
DEPLOY="${DEPLOY_DIR:-$HOME/dailyneeds-store-backend}"
BIN="${MYSQL_BIN_DIR:-$HOME/mysql84/bin}"
DEFAULTS="${STAGE0A_DEFAULTS:-$HOME/.stage0a/app.cnf}"
PORT="${PORT:-18080}"
OUT="${OUT:-$HOME/db-backups}"; mkdir -p "$OUT"; chmod 700 "$OUT"
STAMP="$(date +%Y%m%d-%H%M%S)"
REPORT="$OUT/staging-$STAMP.txt"; APPLOG="$OUT/staging-app-$STAMP.log"
SECRETS="$HOME/.stage0a/staging-secrets.env"
JWTENV="$HOME/.stage0a/jwt.env"
fail() { echo "FAIL: $*" >&2; exit 1; }

case "$WT" in "$DEPLOY"|"$DEPLOY/"*) fail "run from the rehearsal checkout, not the deploy clone";; esac
case "$SCRATCH" in *rehearsal*|*scratch*|*restore_test*) ;; *) fail "'$SCRATCH' is not a scratch schema name";; esac
[ -x "$BIN/mysql" ] || fail "mysql client not found in $BIN"
[ -r "$DEFAULTS" ] || fail "$DEFAULTS missing (node scripts/auth/db-defaults-file.js app)"
[ -r "$WT/config.json" ] || fail "$WT/config.json missing (copy of the production config, 600)"
[ -d "$WT/node_modules" ] || fail "node_modules missing in $WT (npm ci)"
Q() { "$BIN/mysql" --defaults-extra-file="$DEFAULTS" -N -B -e "$1"; }
# a previous run that died before its cleanup leaves config.json pointing at the scratch schema; the kept
# production copy is authoritative, so put it back first
if [ -r "$WT/config.prod.json" ]; then cp "$WT/config.prod.json" "$WT/config.json"; chmod 600 "$WT/config.json"; fi
LIVE_DB="$(cd "$WT" && node scripts/auth/db-defaults-file.js show | awk -F= '$1=="database"{print $2}')"
[ "$SCRATCH" != "$LIVE_DB" ] || fail "scratch equals the live schema"
[ "$(Q "SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='$SCRATCH' AND TABLE_NAME='user' AND COLUMN_NAME='password_algo'")" = "1" ] || fail "$SCRATCH is not post-Stage-0A (run the migration rehearsal first)"

touch "$REPORT"; chmod 600 "$REPORT"
exec > >(tee -a "$REPORT") 2>&1
banner() { printf '\n==================== %s ====================\n' "$*"; }
banner "STAGING REHEARSAL $STAMP — checkout $(git -C "$WT" rev-parse --short HEAD) — scratch '$SCRATCH' — port $PORT — report $REPORT"

# ---- 1. JWT: the current key, externalised (gate 17A) --------------------------
if [ ! -r "$JWTENV" ]; then
  banner "1/7 gate 17A — externalising the current key (no key material is shown)"
  "$HERE/jwt-keys-setup.sh" "$DEPLOY"
else
  echo "1/7 using existing $JWTENV"
fi
set -a; . "$JWTENV"; set +a

# ---- 2. config.json for the scratch schema ---------------------------------------
banner "2/7 app config: production copy -> scratch schema '$SCRATCH' (main DB only; gofrugal block untouched)"
[ -r "$WT/config.prod.json" ] || { cp "$WT/config.json" "$WT/config.prod.json"; chmod 600 "$WT/config.prod.json"; echo "kept original as config.prod.json (600)"; }
node - "$WT/config.prod.json" "$WT/config.json" "$SCRATCH" <<'EOF'
const fs = require("fs"); const [src, dst, scratch] = process.argv.slice(2);
const c = JSON.parse(fs.readFileSync(src, "utf8"));
const env = process.env.NODE_ENV === undefined ? "development" : process.env.NODE_ENV;
c.db.mysql[env].database = scratch;
fs.writeFileSync(dst, JSON.stringify(c, null, 2), { mode: 0o600 }); fs.chmodSync(dst, 0o600);
console.log(`config.json: db.mysql.${env}.database = ${scratch}  (host ${c.db.mysql[env].host})`);
EOF
restore_config() { if [ -r "$WT/config.prod.json" ]; then cp "$WT/config.prod.json" "$WT/config.json"; chmod 600 "$WT/config.json"; echo "config.json restored to the production copy"; fi; }
APP_PID=""; APP2_PID=""
# A staging instance is identified by exact process identity, never by a text match on a command line:
# executable is node, argv[1] is exactly "server.js", working directory is THIS checkout. The production
# process (cwd = deploy clone) and any shell can never match. The pid recorded at spawn can be a wrapper,
# which is why the pid alone is not trusted.
our_instances() {
  local p exe argv1 cwd
  for p in $(pgrep -x node 2>/dev/null); do
    argv1="$(tr '\0' '\n' < "/proc/$p/cmdline" 2>/dev/null | sed -n 2p)"
    cwd="$(readlink -f "/proc/$p/cwd" 2>/dev/null)"
    [ "$argv1" = "server.js" ] && [ "$cwd" = "$(readlink -f "$WT")" ] && echo "$p"
  done
}
stop_app() {
  for p in "${APP_PID:-}" "${APP2_PID:-}" $(our_instances); do [ -n "$p" ] && kill "$p" 2>/dev/null || true; done
  sleep 1
  for p in $(our_instances); do kill -9 "$p" 2>/dev/null || true; done
  rm -f "$OUT/staging-app.pid" "$OUT/staging-app2.pid"
}
trap 'stop_app; restore_config' EXIT

# ---- 3. staging credentials on the SCRATCH schema only -----------------------------
banner "3/7 staging accounts on '$SCRATCH' (identifiers only are printed)"
umask 077
if [ ! -r "$SECRETS" ]; then
  {
    echo "STAGING_ADMIN_PASSWORD=$(openssl rand -base64 24 | tr -d '=+/' | cut -c1-24)"
    echo "STAGING_BREAKGLASS_PASSWORD=$(openssl rand -base64 30 | tr -d '=+/' | cut -c1-30)"
  } > "$SECRETS"; chmod 600 "$SECRETS"
  echo "generated $SECRETS (600)"
fi
set -a; . "$SECRETS"; set +a
# outlet user: active user_type 1, active employee, still on the provisioning default (the common case)
OUTLET="$(Q "SELECT CONCAT(u.user_id,'|',u.username,'|',u.employee_id) FROM \`$SCRATCH\`.\`user\` u JOIN \`$SCRATCH\`.new_employee ne ON ne.employee_id=u.employee_id WHERE u.status=1 AND ne.status=1 AND u.user_type=1 AND u.is_system_account=0 AND u.password=SHA1(CONCAT(u.employee_id,'@123')) ORDER BY u.user_id LIMIT 1")"
# admin: active user_type 2 with an active employee, not employee 1 (purchase_api / owner) — given a staging-only strong password (legacy SHA-1 column, so the legacy path is exercised too)
ADMIN="$(Q "SELECT CONCAT(u.user_id,'|',u.username,'|',u.employee_id) FROM \`$SCRATCH\`.\`user\` u JOIN \`$SCRATCH\`.new_employee ne ON ne.employee_id=u.employee_id WHERE u.status=1 AND ne.status=1 AND u.user_type=2 AND u.is_system_account=0 AND u.employee_id<>1 ORDER BY u.user_id LIMIT 1")"
# inactive employee with a still-active login (one of the 249), on the default
INACTIVE="$(Q "SELECT CONCAT(u.user_id,'|',u.username,'|',u.employee_id) FROM \`$SCRATCH\`.\`user\` u JOIN \`$SCRATCH\`.new_employee ne ON ne.employee_id=u.employee_id WHERE u.status=1 AND ne.status<>1 AND u.is_system_account=0 AND u.password=SHA1(CONCAT(u.employee_id,'@123')) ORDER BY u.user_id LIMIT 1")"
[ -n "$OUTLET" ] || fail "no active outlet user on the provisioning default found in $SCRATCH"
[ -n "$ADMIN" ] || fail "no active admin found in $SCRATCH"
echo "outlet user:      user_id=${OUTLET%%|*} employee_id=${OUTLET##*|}"
echo "admin user:       user_id=${ADMIN%%|*} employee_id=${ADMIN##*|}   (staging password set on the scratch copy)"
echo "inactive employee login: ${INACTIVE:-(none found)}"
ADMIN_ID="${ADMIN%%|*}"
"$BIN/mysql" --defaults-extra-file="$DEFAULTS" "$SCRATCH" -e "UPDATE \`user\` SET password = SHA1('$STAGING_ADMIN_PASSWORD'), password_hash = NULL, password_algo = 'sha1', must_change_password = 0, password_flag_reason = NULL WHERE user_id = $ADMIN_ID AND is_system_account = 0"
# reset the outlet/inactive rows' flags so the run is repeatable
"$BIN/mysql" --defaults-extra-file="$DEFAULTS" "$SCRATCH" -e "UPDATE \`user\` SET must_change_password = 0, password_flag_reason = NULL, failed_login_count = 0, locked_until = NULL WHERE user_id IN (${OUTLET%%|*}${INACTIVE:+,${INACTIVE%%|*}})"

# break-glass on the scratch copy (gate 18A) — the script reads config.json, which now points at the scratch schema
BG_USER="stage0a_breakglass"
PWF="$HOME/.stage0a/bg-staging.pw"; printf '%s\n' "$STAGING_BREAKGLASS_PASSWORD" > "$PWF"; chmod 600 "$PWF"
if [ "$(Q "SELECT COUNT(*) FROM \`$SCRATCH\`.\`user\` WHERE username='$BG_USER' AND is_system_account=1")" = "1" ]; then
  ( cd "$WT" && BREAK_GLASS_CONFIRM=yes node scripts/auth/break-glass.js rotate --username "$BG_USER" --password-file "$PWF" )
else
  ( cd "$WT" && BREAK_GLASS_CONFIRM=yes node scripts/auth/break-glass.js create --username "$BG_USER" --password-file "$PWF" )
fi
rm -f "$PWF"
BG_ID="$(Q "SELECT user_id FROM \`$SCRATCH\`.\`user\` WHERE username='$BG_USER' AND is_system_account=1")"
echo "break-glass:      user_id=$BG_ID username=$BG_USER  (scratch copy only)"
{ echo "STAGING_OUTLET=$OUTLET"; echo "STAGING_ADMIN=$ADMIN"; echo "STAGING_INACTIVE=$INACTIVE"; echo "STAGING_BG=$BG_ID|$BG_USER|"; } > "$HOME/.stage0a/staging-accounts.env"; chmod 600 "$HOME/.stage0a/staging-accounts.env"

# ---- 4. start the Stage 0A app against the scratch schema ------------------------------
banner "4/7 starting the Stage 0A app from $WT on 127.0.0.1:$PORT (crons disabled, external key, Deployment A flags)"
# A run that died before its cleanup leaves its instance alive on the port; a later run would then talk
# to STALE code. Kill only a process that this harness started (pid file + command line from this checkout).
for p in $(our_instances); do echo "killing stale staging instance pid $p left by a previous run"; kill "$p" 2>/dev/null || true; done
sleep 1; for p in $(our_instances); do kill -9 "$p" 2>/dev/null || true; done
rm -f "$OUT/staging-app.pid" "$OUT/staging-app2.pid"
for p in "$PORT" "$((PORT+1))"; do
  if curl -s -m 2 -o /dev/null "http://127.0.0.1:$p/user/my-ip" 2>/dev/null; then fail "port $p is already in use by something this harness did not start — refusing (choose another PORT)"; fi
done
TG=""
if [ "${SKIP_TELEGRAM:-0}" != "1" ] && [ -r "$DEPLOY/.env" ]; then
  TG="$(grep -E '^TELEGRAM_BOT_TOKEN=' "$DEPLOY/.env" | tail -n1 | cut -d= -f2- | tr -d '"'"'"' ')"
  [ -n "$TG" ] && echo "TELEGRAM_BOT_TOKEN: taken from $DEPLOY/.env for this instance (not shown)" || echo "TELEGRAM_BOT_TOKEN: not found in $DEPLOY/.env — alert will only be logged"
fi
APP_ENV=(PORT="$PORT" CRON_DISABLED=true IS_TEST= TELEGRAM_BOT_TOKEN="$TG" JWT_PRIVATE_KEY_PATH="$JWT_PRIVATE_KEY_PATH" JWT_PUBLIC_KEYS="$JWT_PUBLIC_KEYS" JWT_ACTIVE_KID="$JWT_ACTIVE_KID")
[ -n "${ALERT_CHAT_ID:-}" ] && APP_ENV+=(AUTH_SECURITY_ALERT_CHAT_ID="$ALERT_CHAT_ID")
touch "$APPLOG"; chmod 600 "$APPLOG"
( cd "$WT" && env -u NODE_ENV -u TRUST_PROXY -u AUTH_HASH_ON_LOGIN -u AUTH_ENFORCE_PASSWORD_CHANGE -u AUTH_REJECT_LEGACY_SHA1 -u AUTH_TOKEN_VALID_FROM_ENABLED -u AUTH_LOCKOUT_ENABLED "${APP_ENV[@]}" node server.js > "$APPLOG" 2>&1 & echo $! > "$OUT/staging-app.pid" )
APP_PID="$(cat "$OUT/staging-app.pid")"
for i in $(seq 1 60); do
  if curl -s -m 2 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/user/my-ip" 2>/dev/null | grep -q '^200$'; then break; fi
  kill -0 "$APP_PID" 2>/dev/null || { echo "app exited early — last log lines:"; tail -n 30 "$APPLOG"; fail "app did not start"; }
  sleep 1
done
curl -s -m 2 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/user/my-ip" | grep -q '^200$' || { tail -n 30 "$APPLOG"; fail "app not answering on $PORT"; }
sleep 2
echo "app up (pid $APP_PID). startup log excerpt:"; { grep -iE "CRON|jwt|telegram|TOKEN-MISSING|listening|trust proxy|fallback" "$APPLOG" || true; } | head -n 12 | sed 's/^/   /'
for i in 1 2 3 4 5; do grep -q "CRON_DISABLED=true" "$APPLOG" && break; sleep 1; done
grep -q "CRON_DISABLED=true" "$APPLOG" || fail "cron jobs were NOT disabled — refusing to continue"

# ---- 5. the checks (gates 9, 10, 18A, 19A) ------------------------------------------
banner "5/7 checks against http://127.0.0.1:$PORT (Deployment A flags)"
( cd "$WT" && BASE_URL="http://127.0.0.1:$PORT" SCRATCH_DB="$SCRATCH" STAGE0A_DEFAULTS="$DEFAULTS" APP_LOG="$APPLOG" ACCOUNTS="$HOME/.stage0a/staging-accounts.env" SECRETS="$SECRETS" node scripts/auth/staging-checks.js ) || CHECKS_FAILED=1

# ---- 6. forced-change behaviour with enforcement ON (second instance, Deployment B posture) ----
banner "6/7 second instance on port $((PORT+1)) with AUTH_ENFORCE_PASSWORD_CHANGE=true (forced-change confinement)"
( cd "$WT" && env -u NODE_ENV "${APP_ENV[@]}" PORT=$((PORT+1)) AUTH_ENFORCE_PASSWORD_CHANGE=true TELEGRAM_BOT_TOKEN= node server.js > "$APPLOG.enforce" 2>&1 & echo $! > "$OUT/staging-app2.pid" )
APP2_PID="$(cat "$OUT/staging-app2.pid")"
for i in $(seq 1 60); do curl -s -m 2 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$((PORT+1))/user/my-ip" 2>/dev/null | grep -q '^200$' && break; sleep 1; done
( cd "$WT" && BASE_URL="http://127.0.0.1:$((PORT+1))" SCRATCH_DB="$SCRATCH" STAGE0A_DEFAULTS="$DEFAULTS" APP_LOG="$APPLOG.enforce" ACCOUNTS="$HOME/.stage0a/staging-accounts.env" SECRETS="$SECRETS" ENFORCE_ONLY=1 node scripts/auth/staging-checks.js ) || CHECKS_FAILED=1
kill "$APP2_PID" 2>/dev/null || true; APP2_PID=""

# ---- 7. wrap up -----------------------------------------------------------------------
banner "7/7 done"
stop_app; APP_PID=""
restore_config
echo "report: $REPORT"; echo "app logs: $APPLOG, $APPLOG.enforce (600; contain no credentials)"
echo "scratch schema '$SCRATCH' kept; staging accounts remain on it only (admin password + break-glass '$BG_USER')."
[ "${CHECKS_FAILED:-0}" = "0" ] && echo "STAGING REHEARSAL: ALL CHECKS PASSED" || { echo "STAGING REHEARSAL: SOME CHECKS FAILED — see above"; exit 1; }
