#!/usr/bin/env bash
# Stage 0A — Deployment A pre-flight (READ-ONLY). Run on the production host
# from ~/stage0a-rehearsal the day of the deployment, before the window.
#
#   scripts/auth/deployment-a-preflight.sh [gate5-stamp]
#
# Verifies, without printing any secret (no key material, no token, no
# database password — only names, counts, permissions and fingerprints):
#   1. ~/.stage0a/jwt.env has the four JWT entries and the key files it names
#      exist (600) and match the tracked key pair in the deploy clone
#   2. the deploy clone's .env has TELEGRAM_BOT_TOKEN (presence only)
#   3. the deploy clone is main-autodeploy at the expected commit, clean
#   4. the live schema has the expected migration count and NONE of the four
#      Stage 0A migrations (read-only SELECTs on information tables)
#   5. no Deployment-B-only auth flag is enabled in the deploy .env or in the
#      PM2 process environment
#   6. this rehearsal checkout is the backend deploy target; the remote heads
#      of both branches are what the runbook says
#   7. the fresh gate 5 artefacts for the given stamp are present, their
#      checksums match the manifest, and the log ended COMPLETE
# Nothing is written anywhere. Exit 0 = every check PASS.
set -uo pipefail

STAMP="${1:-}"
DEPLOY="${DEPLOY_DIR:-$HOME/dailyneeds-store-backend}"
WT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BIN="${MYSQL_BIN_DIR:-$HOME/mysql84/bin}"
DEFAULTS="${STAGE0A_DEFAULTS:-$HOME/.stage0a/app.cnf}"
OUT="${OUT:-$HOME/db-backups}"
JWTENV="$HOME/.stage0a/jwt.env"
EXPECT_PROD_HEAD="${EXPECT_PROD_HEAD:-9d92884}"
EXPECT_BACKEND_TARGET="${EXPECT_BACKEND_TARGET:-}"   # default: the branch head on origin
CODE_FROZEN_AT="${CODE_FROZEN_AT:-ffe6a4c}"           # last commit that changed application code
EXPECT_MIGRATIONS="${EXPECT_MIGRATIONS:-234}"
LIVE_DB="${LIVE_DB:-dnds_prod}"
BRANCH="claude/dnds-payroll-integration-proposal-3p6hen"
STAGE0A=(20260906120000-auth-stage0a-user-columns 20260906120100-auth-stage0a-auth-log 20260906120200-auth-stage0a-password-reset 20260906120300-auth-stage0a-permissions)
DEPLOYMENT_B_FLAGS=(AUTH_HASH_ON_LOGIN AUTH_REJECT_LEGACY_SHA1 AUTH_ENFORCE_PASSWORD_CHANGE AUTH_SECURE_PROVISIONING AUTH_LOCKOUT_ENABLED AUTH_TOKEN_VALID_FROM_ENABLED JWT_REQUIRE_KID AUTH_REQUIRE_HTTPS)

FAILS=0
pass() { echo "  PASS  $*"; }
fail() { echo "  FAIL  $*"; FAILS=$((FAILS + 1)); }
info() { echo "  info  $*"; }
check() { local msg="$1"; shift; if "$@" >/dev/null 2>&1; then pass "$msg"; else fail "$msg"; fi; }
section() { echo; echo "== $* =="; }
Q() { "$BIN/mysql" --defaults-extra-file="$DEFAULTS" -N -B -e "$1" 2>/dev/null; }
fp() { openssl pkey -pubin -in "$1" -outform DER 2>/dev/null | sha256sum | cut -c1-16; }

echo "Deployment A pre-flight (read-only) — $(date '+%Y-%m-%d %H:%M:%S') on $(hostname)"

section "1. external JWT key environment ($JWTENV)"
if [ -r "$JWTENV" ]; then
  check "jwt.env is mode 600" [ "$(stat -c %a "$JWTENV")" = "600" ]
  for k in JWT_PRIVATE_KEY_PATH JWT_PUBLIC_KEYS JWT_ACTIVE_KID JWT_LEGACY_KID; do
    if grep -qE "^${k}=" "$JWTENV"; then pass "$k present"; else
      # JWT_LEGACY_KID defaults to "legacy" in config/auth.js (proven by config/auth.flags.test.js);
      # jwt-keys-setup.sh writes it from this commit on, earlier env files do not have it.
      if [ "$k" = "JWT_LEGACY_KID" ]; then pass "$k absent — defaults to 'legacy' (same value); not required"; else fail "$k missing"; fi
    fi
  done
  # source in a subshell; only derived, non-secret facts leave it
  (
    set -a; . "$JWTENV" 2>/dev/null; set +a
    [ -r "${JWT_PRIVATE_KEY_PATH:-/nonexistent}" ] && [ "$(stat -c %a "$JWT_PRIVATE_KEY_PATH")" = "600" ] && echo "PRIV_OK" || echo "PRIV_BAD"
    PUB="$(node -e 'try{const m=JSON.parse(process.env.JWT_PUBLIC_KEYS||"");process.stdout.write(m.legacy||"")}catch(e){}')"
    [ -n "$PUB" ] && [ -r "$PUB" ] && echo "PUB_OK $PUB" || echo "PUB_BAD"
    echo "KIDS ${JWT_ACTIVE_KID:-unset} ${JWT_LEGACY_KID:-legacy(default)}"
  ) | while read -r tag rest; do
    case "$tag" in
      PRIV_OK) pass "private key file exists, mode 600 (content not read)";;
      PRIV_BAD) fail "private key file missing or not mode 600";;
      PUB_OK)
        if [ "$(fp "$rest")" = "$(fp "$DEPLOY/keys/jwt/public.key")" ]; then pass "external public key == tracked public key (fingerprint $(fp "$rest"))"; else fail "external public key differs from the tracked key in the deploy clone"; fi;;
      PUB_BAD) fail "JWT_PUBLIC_KEYS is not a JSON object with a readable 'legacy' path";;
      KIDS) if [ "$rest" = "legacy legacy" ] || [ "$rest" = "legacy legacy(default)" ]; then pass "active kid / legacy kid = $rest"; else fail "unexpected kids: $rest (expected legacy legacy)"; fi;;
    esac
  done
else
  fail "$JWTENV missing — run scripts/auth/jwt-keys-setup.sh"
fi

section "2. production .env ($DEPLOY/.env) — presence only"
if [ -r "$DEPLOY/.env" ]; then
  info ".env mode $(stat -c '%a %U' "$DEPLOY/.env")"
  check "TELEGRAM_BOT_TOKEN present and non-empty" grep -qE '^TELEGRAM_BOT_TOKEN=.+' "$DEPLOY/.env"
  for k in JWT_PRIVATE_KEY_PATH JWT_PUBLIC_KEYS JWT_ACTIVE_KID JWT_LEGACY_KID; do
    if grep -qE "^${k}=" "$DEPLOY/.env"; then info "$k already in production .env (added early? the night's step 8 is then a no-op)"; else info "$k not yet in production .env (expected before the window; added at step 8)"; fi
  done
else
  fail "$DEPLOY/.env not readable"
fi

section "3. deploy clone ($DEPLOY)"
if [ -d "$DEPLOY/.git" ]; then
  HEAD="$(git -C "$DEPLOY" rev-parse --short HEAD)"; BR="$(git -C "$DEPLOY" branch --show-current)"
  check "branch is main-autodeploy (is: $BR)" [ "$BR" = "main-autodeploy" ]
  check "HEAD is $EXPECT_PROD_HEAD (is: $HEAD)" [ "$HEAD" = "$EXPECT_PROD_HEAD" ]
  DIRTY="$(git -C "$DEPLOY" status --porcelain | grep -v 'package-lock.json' | wc -l)"
  check "working tree clean apart from package-lock.json ($DIRTY other dirty paths)" [ "$DIRTY" = "0" ]
  HOOKS="$(ls "$DEPLOY/.git/hooks" 2>/dev/null | grep -v '\.sample$' | wc -l)"
  check "no active server-side git hooks ($HOOKS)" [ "$HOOKS" = "0" ]
  info "PM2: $(pm2 jlist 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const l=JSON.parse(s);for(const p of l)console.log(`id=${p.pm_id} name=${p.name} status=${p.pm2_env.status} cwd=${p.pm2_env.pm_cwd} exec_mode=${p.pm2_env.exec_mode} restarts=${p.pm2_env.restart_time}`)}catch(e){console.log("(pm2 not readable)")}})' | tr '\n' ';')"
else
  fail "$DEPLOY is not a git checkout"
fi

section "4. live schema $LIVE_DB — migrations (read-only)"
if [ -r "$DEFAULTS" ] && [ -x "$BIN/mysql" ]; then
  N="$(Q "SELECT COUNT(*) FROM \`$LIVE_DB\`.migrations")"
  check "migrations table has $EXPECT_MIGRATIONS rows (has: ${N:-unreadable})" [ "$N" = "$EXPECT_MIGRATIONS" ]
  S="$(Q "SELECT COUNT(*) FROM \`$LIVE_DB\`.migrations WHERE name LIKE '%auth-stage0a%'")"
  check "none of the Stage 0A migrations recorded (found: ${S:-unreadable})" [ "$S" = "0" ]
  C="$(Q "SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='$LIVE_DB' AND TABLE_NAME='user' AND COLUMN_NAME IN ('password_hash','password_algo','is_system_account')")"
  check "user table has none of the Stage 0A columns (found: ${C:-unreadable})" [ "$C" = "0" ]
  T="$(Q "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='$LIVE_DB' AND TABLE_NAME IN ('user_auth_log','user_password_reset','auth_metric')")"
  check "none of the Stage 0A tables exist (found: ${T:-unreadable})" [ "$T" = "0" ]
  info "server version $(Q 'SELECT VERSION()') ; base tables in $LIVE_DB: $(Q "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='$LIVE_DB' AND TABLE_TYPE='BASE TABLE'")"
  PENDING="$(comm -23 <(ls "$WT/migrations/mysql/migrations"/*.js | xargs -n1 basename | sed 's/\.js$//' | sort) <(Q "SELECT TRIM(LEADING '/' FROM name) FROM \`$LIVE_DB\`.migrations" | sort) | tr '\n' ' ')"
  EXPECTED="$(printf '%s\n' "${STAGE0A[@]}" | sort | tr '\n' ' ')"
  check "pending set for the deploy target is exactly the four Stage 0A migrations" [ "$PENDING" = "$EXPECTED" ]
  [ "$PENDING" = "$EXPECTED" ] || info "pending: $PENDING"
else
  fail "cannot query: $DEFAULTS or $BIN/mysql missing"
fi

section "5. Deployment-B-only flags must be OFF/absent (values are not secrets)"
for k in "${DEPLOYMENT_B_FLAGS[@]}"; do
  V="$(grep -E "^${k}=" "$DEPLOY/.env" 2>/dev/null | tail -1 | cut -d= -f2-)"
  if [ -z "$V" ]; then pass "$k absent in .env"; elif [ "$V" = "true" ] || [ "$V" = "1" ]; then fail "$k=$V in .env — must not be enabled for Deployment A"; else pass "$k=$V in .env (off)"; fi
done
PM2ENV="$(pm2 env 0 2>/dev/null | grep -E '^(AUTH_|JWT_)' | grep -vE '^(AUTH_FLAG_WEAK_ON_LOGIN|AUTH_EMPLOYEE_STATUS_CHECK)=' || true)"
if [ -n "$PM2ENV" ]; then
  echo "$PM2ENV" | while IFS='=' read -r k v; do
    case "$k" in JWT_*) info "PM2 env has $k (value not shown)";; *) if [ "$v" = "true" ] || [ "$v" = "1" ]; then case " ${DEPLOYMENT_B_FLAGS[*]} " in *" $k "*) fail "PM2 env: $k=$v enabled";; *) info "PM2 env: $k=$v";; esac; else info "PM2 env: $k=$v"; fi;; esac
  done
else
  pass "PM2 process 0 carries no AUTH_/JWT_ variables beyond the two default-ON detection flags"
fi

section "6. deploy targets"
RH="$(git -C "$WT" rev-parse --short HEAD)"; RB="$(git -C "$WT" branch --show-current)"
check "this checkout ($WT) is on $BRANCH (is: $RB)" [ "$RB" = "$BRANCH" ]
REMOTE_FEAT="$(git -C "$WT" ls-remote origin "refs/heads/$BRANCH" 2>/dev/null | cut -c1-7)"
REMOTE_MAIN="$(git -C "$WT" ls-remote origin refs/heads/main-autodeploy 2>/dev/null | cut -c1-7)"
TARGET="${EXPECT_BACKEND_TARGET:-$REMOTE_FEAT}"
check "this checkout is at the backend deploy target ${TARGET:-?} (is: $RH)" [ "$RH" = "${TARGET:-none}" ]
check "origin/$BRANCH is the same commit (is: ${REMOTE_FEAT:-unreachable})" [ "$REMOTE_FEAT" = "$RH" ]
check "this checkout has no modified tracked files" [ -z "$(git -C "$WT" status --porcelain -uno)" ]
check "application code unchanged since $CODE_FROZEN_AT (only docs/ and scripts/ differ)" git -C "$WT" diff --quiet "$CODE_FROZEN_AT" HEAD -- . ':(exclude)docs' ':(exclude)scripts'
check "origin/main-autodeploy is still $EXPECT_PROD_HEAD (is: ${REMOTE_MAIN:-unreachable})" [ "$REMOTE_MAIN" = "$EXPECT_PROD_HEAD" ]
info "frontend target 59f7ded on the same branch name is verified from the repository, not from this host"

section "7. fresh gate 5 artefacts${STAMP:+ (stamp $STAMP)}"
if [ -n "$STAMP" ]; then
  FILES=("$OUT"/*"$STAMP"*)
  if [ -e "${FILES[0]}" ]; then
    for f in "${FILES[@]}"; do info "$(stat -c '%a %s' "$f") $(basename "$f")"; done
    MAN="$(ls "$OUT"/*-manifest-"$STAMP".txt 2>/dev/null | head -1)"
    if [ -n "$MAN" ]; then
      if (cd "$OUT" && grep -E '^[0-9a-f]{64}  ' "$MAN" | sed 's#  .*/#  #' | sha256sum -c --quiet 2>/dev/null); then pass "manifest checksums match every artefact"; else fail "checksum mismatch against the manifest"; fi
    else fail "manifest for $STAMP missing"; fi
    LOG="$OUT/gate5-$STAMP.log"
    if [ -r "$LOG" ]; then
      check "gate 5 log ends COMPLETE" grep -q 'GATE 5 REHEARSAL COMPLETE' "$LOG"
      check "gate 5 log has no FAIL: line" bash -c "! grep -q '^FAIL:' '$LOG'"
      info "restore: $(grep -oE 'restore (took|completed in) [0-9]+ ?s' "$LOG" | tail -1)"
    else info "no gate5-$STAMP.log (the log stamp can differ from the artefact stamp on a --skip-backup run)"; fi
  else fail "no artefacts for stamp $STAMP in $OUT"; fi
else
  info "no stamp given — pass the fresh gate 5 stamp as the first argument"
fi

echo
if [ "$FAILS" = "0" ]; then echo "PRE-FLIGHT: ALL CHECKS PASS"; else echo "PRE-FLIGHT: $FAILS check(s) FAILED — do not open the window"; fi
exit "$FAILS"
