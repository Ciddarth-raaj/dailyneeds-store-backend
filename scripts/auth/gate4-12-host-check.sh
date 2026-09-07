#!/usr/bin/env bash
# Stage 0A / gates 4 + 12 — READ-ONLY inspection of the production host.
#
# Prints the facts the two gates need and nothing else: no secrets, no
# passwords, no tokens, no key material. Every command here reads; nothing
# restarts, reloads, migrates, edits or writes outside the report file.
#
# Run on Lightsail from the rehearsal checkout:
#   MYSQL_BIN_DIR="$HOME/mysql84/bin" scripts/auth/gate4-12-host-check.sh
# Optional: PUBLIC_HOST=api.dnds.co.in  (default) for the local nginx probes.
#           PROBE_TOKEN=<a valid session token of YOUR OWN account> — in the
#           currently deployed code /user/my-ip requires a token (Stage 0A
#           makes it public). The token is sent as a header and never printed.
# Report: ~/db-backups/gate4-12-<stamp>.txt (600).
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WT="$(cd "$HERE/../.." && pwd)"
DEPLOY="$HOME/dailyneeds-store-backend"
BIN="${MYSQL_BIN_DIR:-$HOME/mysql84/bin}"
DEFAULTS="${STAGE0A_DEFAULTS:-$HOME/.stage0a/app.cnf}"
PUBLIC_HOST="${PUBLIC_HOST:-api.dnds.co.in}"
OUT="${OUT:-$HOME/db-backups}"; mkdir -p "$OUT"; chmod 700 "$OUT"
REPORT="$OUT/gate4-12-$(date +%Y%m%d-%H%M%S).txt"; touch "$REPORT"; chmod 600 "$REPORT"
exec > >(tee -a "$REPORT") 2>&1
section() { printf '\n==================== %s ====================\n' "$*"; }
redact_url() { sed -E 's#(https?://)[^@/]+@#\1<redacted>@#'; }

section "GATE 4 / A — deployment clone ($DEPLOY)"
if [ -d "$DEPLOY/.git" ]; then
  echo "remote:        $(git -C "$DEPLOY" remote get-url origin | redact_url)"
  echo "branch:        $(git -C "$DEPLOY" branch --show-current)"
  echo "HEAD:          $(git -C "$DEPLOY" rev-parse --short HEAD)  ($(git -C "$DEPLOY" log -1 --format=%cd --date=short))"
  echo "dirty files:   $(git -C "$DEPLOY" status --porcelain --untracked-files=no | wc -l)  $(git -C "$DEPLOY" status --porcelain --untracked-files=no | awk '{print $2}' | tr '\n' ' ')"
  echo "active hooks:  $(ls "$DEPLOY/.git/hooks" 2>/dev/null | grep -v '\.sample$' | tr '\n' ' ')(none = no server-side git hook fires on pull)"
  echo "migration files in deploy clone: $(ls "$DEPLOY"/migrations/mysql/migrations/*.js 2>/dev/null | wc -l)"
else
  echo "NOT FOUND — the workflow's cd would fail"
fi
echo "migration files in this checkout ($(git -C "$WT" rev-parse --short HEAD)): $(ls "$WT"/migrations/mysql/migrations/*.js | wc -l)"
echo "files only in this checkout (expected: exactly the four Stage 0A migrations):"
comm -13 <(ls "$DEPLOY"/migrations/mysql/migrations/*.js 2>/dev/null | xargs -n1 basename | sort) <(ls "$WT"/migrations/mysql/migrations/*.js | xargs -n1 basename | sort) | sed 's/^/   /'

section "GATE 4 / B — toolchain the workflow invokes"
echo "node:          $(node -v 2>/dev/null)   npm: $(npm -v 2>/dev/null)"
echo "db-migrate:    $(command -v db-migrate || echo 'NOT ON PATH — the workflow step would fail')  $(db-migrate --version 2>/dev/null)"
echo "pm2:           $(command -v pm2 || echo 'NOT ON PATH')  $(pm2 -v 2>/dev/null)"
echo "login shell PATH includes db-migrate dir: $(dirname "$(command -v db-migrate 2>/dev/null || echo /none)")"

section "GATE 4 / C — which database.json environment a bare 'db-migrate up' resolves to (keys only, no credentials)"
DBJSON="$DEPLOY/migrations/mysql/database.json"
if [ -r "$DBJSON" ]; then
  node - "$DBJSON" "$DEPLOY/config.json" <<'EOF'
const fs = require("fs");
const [dbjson, cfgjson] = process.argv.slice(2);
const c = JSON.parse(fs.readFileSync(dbjson, "utf8"));
const envs = Object.keys(c).filter((k) => typeof c[k] === "object" && c[k] !== null);
console.log("top-level keys:", Object.keys(c).join(", "));
let chosen = null, how = "";
if (c.default) { chosen = c.default; how = "'default' key"; }
else if (c.defaultEnv) { chosen = c.defaultEnv.ENV ? process.env[c.defaultEnv.ENV] : c.defaultEnv; how = "'defaultEnv' key"; }
else if (c.dev) { chosen = "dev"; how = "fallback order ['dev','development'] -> 'dev' exists"; }
else if (c.development) { chosen = "development"; how = "fallback order ['dev','development'] -> 'development' exists"; }
else { how = "NO RESOLVABLE ENV -> db-migrate would error"; }
console.log("NODE_ENV in this shell:", process.env.NODE_ENV === undefined ? "(unset)" : process.env.NODE_ENV, " (db-migrate 0.11 also honours -e; the workflow passes none)");
console.log("bare `db-migrate up` resolves to:", chosen || "(none)", "via", how);
let app = null;
try { app = JSON.parse(fs.readFileSync(cfgjson, "utf8")).db.mysql; } catch (e) { console.log("config.json not readable:", e.message); }
for (const e of envs) {
  const b = c[e] || {};
  const host = b.host || "(no host)", db = b.database || "(no database)";
  let same = "";
  if (app && app.development) same = (host === app.development.host && db === app.development.database) ? "  == app 'development' block (the live DB)" : "  != app 'development' block";
  console.log(`  env '${e}': host=${host} port=${b.port || "?"} database=${db} driver=${b.driver || "?"}${same}${e === chosen ? "   <== USED BY THE DEPLOY" : ""}`);
}
if (app) {
  const d = app.development, p = app.production;
  console.log("app config.json: development host/db =", d && d.host, "/", d && d.database, "; production host/db =", p && p.host, "/", p && p.database,
    p && d && p.host === d.host && p.database === d.database ? "(same as development)" : "(DIFFERENT — do not start the app with NODE_ENV=production until this block is corrected)");
}
EOF
else
  echo "$DBJSON not readable"
fi

section "GATE 4 / D — migrations recorded in the LIVE database vs files (read-only SELECT on the migrations table)"
if [ -x "$BIN/mysql" ] && [ -r "$DEFAULTS" ]; then
  LIVE_DB="$(cd "$WT" && node scripts/auth/db-defaults-file.js show | awk -F= '$1=="database"{print $2}')"
  Q() { "$BIN/mysql" --defaults-extra-file="$DEFAULTS" -N -B -e "$1"; }
  echo "live database: $LIVE_DB   rows in migrations: $(Q "SELECT COUNT(*) FROM \`$LIVE_DB\`.migrations")   head: $(Q "SELECT name FROM \`$LIVE_DB\`.migrations ORDER BY run_on DESC, id DESC LIMIT 1")"
  echo "pending if the DEPLOY clone (main-autodeploy) ran 'db-migrate up' now (expected: none):"
  comm -23 <(ls "$DEPLOY"/migrations/mysql/migrations/*.js 2>/dev/null | xargs -n1 basename | sed 's/\.js$//' | sort) <(Q "SELECT TRIM(LEADING '/' FROM name) FROM \`$LIVE_DB\`.migrations" | sort) | sed 's/^/   /'
  echo "pending if THIS checkout ran 'db-migrate up' (Deployment A; expected: exactly the four Stage 0A migrations):"
  comm -23 <(ls "$WT"/migrations/mysql/migrations/*.js | xargs -n1 basename | sed 's/\.js$//' | sort) <(Q "SELECT TRIM(LEADING '/' FROM name) FROM \`$LIVE_DB\`.migrations" | sort) | sed 's/^/   /'
else
  echo "skipped (mysql client or defaults file missing)"
fi

section "GATE 4 / E — PM2 process that 'pm2 reload 0' targets"
pm2 jlist 2>/dev/null | node -e '
let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{ let l=[]; try{l=JSON.parse(s);}catch(e){console.log("pm2 jlist unreadable");return;}
for (const p of l) { const e=p.pm2_env||{}; console.log(`  pm_id=${p.pm_id} name=${p.name} status=${e.status} exec_mode=${e.exec_mode} instances=${e.instances||1} cwd=${e.pm_cwd} script=${e.pm_exec_path} restarts=${e.restart_time} NODE_ENV=${e.NODE_ENV===undefined?"(unset)":e.NODE_ENV} PORT=${e.PORT===undefined?"(unset -> 8080)":e.PORT} TRUST_PROXY=${e.TRUST_PROXY===undefined?"(unset -> loopback)":e.TRUST_PROXY}`); } })'
echo "ecosystem.config.js in deploy clone sets NODE_ENV=production for 'pm2 start ecosystem.config.js' — NOT what is running if NODE_ENV shows (unset) above"

section "GATE 12 / A — nginx configuration (relevant lines only)"
if sudo -n true 2>/dev/null; then
  sudo -n nginx -T 2>/dev/null | grep -nE '^\s*(server_name|listen|return\s+30[0-9]|proxy_pass|proxy_set_header|ssl_certificate\s|ssl_protocols|if \(\$scheme|limit_req|client_max_body_size)' | sed 's/^/  /'
  echo "  nginx -t: $(sudo -n nginx -t 2>&1 | tail -n 1)"
else
  echo "  sudo not available without a password — run manually:  sudo nginx -T | grep -nE 'server_name|listen|return 30|proxy_pass|proxy_set_header|ssl_certificate '"
fi

section "GATE 12 / B — listening sockets (is the Node port bound publicly?)"
( command -v ss >/dev/null && (sudo -n ss -ltnp 2>/dev/null || ss -ltn) || netstat -ltn ) | grep -E ':(80|443|8080|3000)\b' | sed 's/^/  /'
echo "  (0.0.0.0:8080 or *:8080 = bound on all interfaces; whether it is REACHABLE from the internet is decided by the Lightsail firewall — see the external probe)"

section "GATE 12 / C — local probes through nginx (loopback) and direct to the app"
TOK=(); [ -n "${PROBE_TOKEN:-}" ] && TOK=(-H "x-access-token: $PROBE_TOKEN")
[ -n "${PROBE_TOKEN:-}" ] || echo "  (no PROBE_TOKEN: the deployed /user/my-ip answers 403 without a token — the redirect and reachability lines are still valid)"
PORT_GUESS="$(pm2 jlist 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const l=JSON.parse(s);const p=l.find(x=>x.pm_id===0);console.log((p&&p.pm2_env&&p.pm2_env.PORT)||8080);}catch(e){console.log(8080)}})')"
echo "  http://127.0.0.1/ with Host: $PUBLIC_HOST ->  $(curl -s -o /dev/null -m 8 -w 'HTTP %{http_code} redirect=%{redirect_url}' -H "Host: $PUBLIC_HOST" http://127.0.0.1/)"
echo "  via nginx, forged X-Forwarded-For (nginx must overwrite it; expect ip=127.0.0.1, the loopback caller):"
echo "     $(curl -s -m 8 "${TOK[@]}" -H "Host: $PUBLIC_HOST" -H 'X-Forwarded-For: 203.0.113.9' -H 'X-Forwarded-Proto: https' http://127.0.0.1/user/my-ip)"
echo "  direct to the app on 127.0.0.1:$PORT_GUESS, forged headers (loopback IS the trusted hop, so the app must believe them — this is by design and only nginx can reach this port from outside if the firewall closes it):"
echo "     $(curl -s -m 8 "${TOK[@]}" -H 'X-Forwarded-For: 203.0.113.9' -H 'X-Forwarded-Proto: https' "http://127.0.0.1:$PORT_GUESS/user/my-ip")"
echo "  direct to the app, no headers (expect ip=127.0.0.1 / ::1, secure=false):"
echo "     $(curl -s -m 8 "${TOK[@]}" "http://127.0.0.1:$PORT_GUESS/user/my-ip")"

section "DONE — report $REPORT (600). Then run the EXTERNAL probe from your laptop (readiness §5.11)."
