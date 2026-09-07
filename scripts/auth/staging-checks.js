#!/usr/bin/env node
/**
 * Stage 0A staging checks (gates 9, 10, 18A, 19A) — HTTP against a running
 * Stage 0A instance that points at the SCRATCH schema, plus read-only
 * database assertions on that schema.
 *
 * Prints one PASS/FAIL line per check. Never prints a password or a token;
 * tokens are decoded only to their field names / small claims.
 *
 * Env: BASE_URL, SCRATCH_DB, STAGE0A_DEFAULTS (my.cnf with the app creds),
 *      ACCOUNTS (staging-accounts.env), SECRETS (staging-secrets.env),
 *      APP_LOG (the instance's log, for the alert evidence),
 *      JWT_PRIVATE_KEY_PATH (to mint legacy-shaped tokens with the current key),
 *      ENFORCE_ONLY=1 (only the forced-change checks, against an instance with enforcement on)
 */
const fs = require("fs");
const http = require("http");
const crypto = require("crypto");
const mysql = require("mysql");
const jwt = require("jsonwebtoken");

const env = (k, d) => (process.env[k] === undefined || process.env[k] === "" ? d : process.env[k]);
const BASE = env("BASE_URL", "http://127.0.0.1:18080");
const SCRATCH = env("SCRATCH_DB", "dnds_rehearsal");
const kv = (file) => Object.fromEntries(fs.readFileSync(file, "utf8").split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const accounts = kv(env("ACCOUNTS"));
const secrets = kv(env("SECRETS"));
const cnf = Object.fromEntries(fs.readFileSync(env("STAGE0A_DEFAULTS"), "utf8").split("\n").filter((l) => /^(host|port|user|password)=/.test(l)).map((l) => { const [k, ...v] = l.split("="); return [k, v.join("=").replace(/^"(.*)"$/, "$1").replace(/\\"/g, '"').replace(/\\\\/g, "\\")]; }));
const split = (s) => { const [id, username, emp] = String(s || "").split("|"); return { user_id: Number(id), username, employee_id: emp === "" || emp === undefined ? null : Number(emp) }; };
const OUTLET = split(accounts.STAGING_OUTLET), ADMIN = split(accounts.STAGING_ADMIN), INACTIVE = split(accounts.STAGING_INACTIVE), BG = split(accounts.STAGING_BG);
const privateKey = fs.readFileSync(env("JWT_PRIVATE_KEY_PATH"), "utf8");

let pass = 0, failCount = 0;
const ok = (name, cond, detail = "") => { if (cond) { pass++; console.log(`  PASS  ${name}${detail ? "   [" + detail + "]" : ""}`); } else { failCount++; console.log(`  FAIL  ${name}${detail ? "   [" + detail + "]" : ""}`); } return cond; };

const db = mysql.createConnection({ host: cnf.host, port: Number(cnf.port), user: cnf.user, password: cnf.password, database: SCRATCH });
const q = (sql, p = []) => new Promise((res, rej) => db.query(sql, p, (e, r) => (e ? rej(e) : res(r))));

function req(method, path, { body, token, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(path, BASE);
    const data = body === undefined ? null : JSON.stringify(body);
    const r = http.request({ method, hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers: { ...(data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}), ...(token ? { "x-access-token": token } : {}), ...headers } }, (res) => {
      let s = ""; res.on("data", (d) => (s += d)); res.on("end", () => { let j = null; try { j = JSON.parse(s); } catch (_) {} resolve({ status: res.statusCode, json: j, text: s }); });
    });
    r.on("error", reject); if (data) r.write(data); r.end();
  });
}
const login = async (username, password) => {
  const r = await req("POST", "/user/login", { body: { username, password } });
  // success is wrapped as { data: {...} } by the route; failures are { code, msg } with a real HTTP status
  if (r.json && r.json.data) r.json = r.json.data;
  return r;
};
const claims = (t) => jwt.decode(t) || {};
const legacyToken = (payload) => jwt.sign(payload, privateKey, { algorithm: "RS256", expiresIn: "1h" }); // no sub, no kid, no auth_ver — the deployed code's shape
const lastAudit = async (event, userId) => (await q("SELECT user_id, username_attempted, event, detail FROM user_auth_log WHERE event = ? AND (user_id = ? OR ? IS NULL) ORDER BY log_id DESC LIMIT 1", [event, userId, userId]))[0];
const userRow = async (id) => (await q("SELECT user_id, username, employee_id, status, user_type, is_system_account, password_algo, must_change_password, password_flag_reason, password IS NULL AS pw_null, password_hash LIKE '$scrypt$%' AS scrypt FROM `user` WHERE user_id = ?", [id]))[0];

async function gate9() {
  console.log("\n-- gate 9: login behaviour");
  const outletPw = `${OUTLET.employee_id}@123`;
  let r = await login(OUTLET.username, outletPw);
  ok("outlet user (active employee, default password, legacy SHA-1): correct password -> 200 + token", r.status === 200 && r.json && r.json.code === 200 && r.json.token, `code=${r.json && r.json.code}`);
  const outletToken = r.json && r.json.token;
  ok("  response reports must_change_password=true (weak default detected at login)", r.json && r.json.must_change_password === true);
  let row = await userRow(OUTLET.user_id);
  ok("  row flagged: must_change_password=1, password_flag_reason=weak_at_login, still sha1 (hash-on-login off)", row.must_change_password === 1 && row.password_flag_reason === "weak_at_login" && row.password_algo === "sha1");
  let a = await lastAudit("password_flagged", OUTLET.user_id);
  ok("  audited password_flagged with a category only", a && /^weak_at_login;[a-z_]+$/.test(a.detail), a && a.detail);
  let c = claims(outletToken);
  ok("  token: auth_ver=2, sub=user_id, employee_id present, no pwc (enforcement off)", c.auth_ver === 2 && c.sub === String(OUTLET.user_id) && c.employee_id === OUTLET.employee_id && c.pwc === undefined, `fields=${Object.keys(c).join(",")}`);

  r = await login(ADMIN.username, secrets.STAGING_ADMIN_PASSWORD);
  ok("admin (user_type 2, active employee): correct password -> 200", r.status === 200 && r.json.code === 200 && r.json.user_type === 2, `code=${r.json && r.json.code}`);
  ok("  strong password not flagged", r.json.must_change_password === false && (await userRow(ADMIN.user_id)).must_change_password === 0);
  const adminToken = r.json.token;

  r = await login(OUTLET.username, "definitely-wrong-password");
  ok("wrong password -> HTTP 400 'Incorrect credentials', no token (same answer as production)", r.status === 400 && r.json && r.json.code === 400 && !r.json.token, `status=${r.status}`);
  a = await lastAudit("login_failed", OUTLET.user_id);
  ok("  audited login_failed with wrong_password", a && /wrong_password/.test(a.detail), a && a.detail);

  if (INACTIVE.user_id) {
    r = await login(INACTIVE.username, `${INACTIVE.employee_id}@123`);
    ok("inactive employee (user.status=1, new_employee.status<>1) with the right password -> refused (400, indistinguishable from a wrong password)", r.status === 400 && r.json && r.json.code === 400 && !r.json.token, `status=${r.status}`);
    a = await lastAudit("login_inactive", INACTIVE.user_id);
    ok("  audited login_inactive;employee_inactive", a && a.detail === "employee_inactive", a && a.detail);
  } else console.log("  SKIP  inactive-employee login (no such row in the scratch copy)");

  r = await req("POST", "/user/logout", { token: outletToken });
  ok("protected route with the outlet's v2 token -> 200 (logout)", r.status === 200 && r.json && r.json.code === 200);
  a = await lastAudit("logout", OUTLET.user_id);
  ok("  audit shows the resolved account is the outlet user_id", a && a.user_id === OUTLET.user_id);
  return { outletToken, adminToken };
}

async function gate10(adminToken) {
  console.log("\n-- gate 10: legacy-token transition (tokens minted in the deployed shape with the CURRENT key)");
  const lt = legacyToken({ id: OUTLET.user_id, employee_id: OUTLET.employee_id, user_type: 1, store_id: 1, designation_id: 1 });
  let r = await req("POST", "/user/logout", { token: lt });
  ok("legacy token {id, employee_id} (no sub/kid/auth_ver) -> accepted", r.status === 200 && r.json && r.json.code === 200, `status=${r.status}`);
  let a = await lastAudit("logout", OUTLET.user_id);
  ok("  resolves to the SAME user_id as the v2 token (audit user_id)", a && a.user_id === OUTLET.user_id);

  const wrongEmp = legacyToken({ id: OUTLET.user_id, employee_id: OUTLET.employee_id + 1, user_type: 1 });
  r = await req("POST", "/user/logout", { token: wrongEmp });
  ok("legacy token whose employee_id does not match the account's row -> 403", r.status === 403 || (r.json && r.json.code === 403), `status=${r.status}`);

  if (INACTIVE.user_id) {
    const inact = legacyToken({ id: INACTIVE.user_id, employee_id: INACTIVE.employee_id, user_type: 1 });
    r = await req("POST", "/user/logout", { token: inact });
    ok("legacy token of an inactive employee -> refused (EMPLOYEE_INACTIVE)", (r.status === 403 || (r.json && r.json.code === 403)) && r.json && r.json.error === "EMPLOYEE_INACTIVE", `error=${r.json && r.json.error}`);
    const v2inact = jwt.sign({ auth_ver: 2, id: INACTIVE.user_id, employee_id: INACTIVE.employee_id, user_type: 1 }, privateKey, { algorithm: "RS256", expiresIn: "1h", subject: String(INACTIVE.user_id), keyid: "legacy" });
    r = await req("POST", "/user/logout", { token: v2inact });
    ok("v2 token of an inactive employee -> refused (EMPLOYEE_INACTIVE)", r.json && r.json.error === "EMPLOYEE_INACTIVE", `error=${r.json && r.json.error}`);
  }

  const bgLegacy = legacyToken({ id: BG.user_id, employee_id: null, user_type: 2 });
  r = await req("POST", "/user/logout", { token: bgLegacy });
  ok("legacy token naming the break-glass user_id (employee_id null) -> 403 (can never resolve to a system account)", r.status === 403 || (r.json && r.json.code === 403), `status=${r.status}`);
  const bgLegacyFake = legacyToken({ id: BG.user_id, employee_id: OUTLET.employee_id, user_type: 2 });
  r = await req("POST", "/user/logout", { token: bgLegacyFake });
  ok("legacy token naming the break-glass user_id with a borrowed employee_id -> 403", r.status === 403 || (r.json && r.json.code === 403), `status=${r.status}`);

  const c = claims(adminToken);
  ok("fresh v2 token: sub = admin user_id, id agrees, kid header present", c.sub === String(ADMIN.user_id) && c.id === ADMIN.user_id && JSON.parse(Buffer.from(adminToken.split(".")[0], "base64url").toString()).kid === "legacy", `fields=${Object.keys(c).join(",")}`);
}

async function gate18(adminToken) {
  console.log("\n-- gate 18A: break-glass account on the scratch copy");
  const row = await userRow(BG.user_id);
  ok("row: employee_id NULL, is_system_account=1, password NULL, scrypt hash", row && row.employee_id === null && row.is_system_account === 1 && row.pw_null === 1 && row.scrypt === 1 && row.password_algo === "scrypt");
  let r = await login(BG.username, secrets.STAGING_BREAKGLASS_PASSWORD);
  ok("break-glass login -> 200, is_system_account=true, employee_id null, must_change=false", r.json && r.json.code === 200 && r.json.is_system_account === true && r.json.employee_id === null && r.json.must_change_password === false, `code=${r.json && r.json.code}`);
  const bgToken = r.json && r.json.token;
  const c = claims(bgToken || "");
  ok("  token: sys=true, sub=user_id, NO employee_id claim", c.sys === true && c.sub === String(BG.user_id) && c.employee_id === undefined, `fields=${Object.keys(c).join(",")}`);
  let a = await lastAudit("break_glass_login", BG.user_id);
  ok("  audited break_glass_login", Boolean(a));

  r = await login(BG.username, "wrong-" + secrets.STAGING_BREAKGLASS_PASSWORD);
  ok("wrong break-glass password -> refused (400) and audited", r.status === 400 && Boolean(await lastAudit("break_glass_login_failed", BG.user_id)));

  r = await req("POST", "/user/forgot-password", { body: { username: BG.username } });
  ok("Telegram forgot-password for the break-glass username -> neutral answer", r.status === 200 && r.json && r.json.code === 200);
  const codes = await q("SELECT COUNT(*) AS n FROM password_reset_codes WHERE user_id = ?", [BG.user_id]);
  ok("  no reset code row was created for it", codes[0].n === 0);
  r = await req("POST", "/user/reset-password", { body: { username: BG.username, code: "123456", new_password: "totally-different-secret-99" } });
  ok("Telegram reset-password for it -> refused", r.status === 400 || (r.json && r.json.code !== 200), `status=${r.status}`);
  r = await req("POST", `/user/${BG.user_id}/reset-password`, { token: adminToken });
  ok("admin-issued reset for the break-glass id -> 403 SYSTEM_ACCOUNT", r.status === 403 && r.json && r.json.error === "SYSTEM_ACCOUNT", `status=${r.status} error=${r.json && r.json.error}`);
  r = await req("POST", `/user/${BG.user_id}/unlock`, { token: adminToken });
  ok("admin unlock of the break-glass id -> 403", r.status === 403);
  for (const m of ["GET", "POST", "DELETE"]) {
    r = await req(m, "/user/telegram-link", { token: bgToken, body: m === "GET" ? undefined : {} });
    ok(`break-glass session on ${m} /user/telegram-link -> 403 EMPLOYEE_REQUIRED`, r.status === 403 && r.json && r.json.error === "EMPLOYEE_REQUIRED");
  }
  const unchanged = await userRow(BG.user_id);
  ok("break-glass row unchanged by every refusal", unchanged.status === 1 && unchanged.is_system_account === 1 && unchanged.employee_id === null && unchanged.must_change_password === 0);
  return bgToken;
}

async function gate19() {
  console.log("\n-- gate 19A: break-glass alert through services/telegram (new bot)");
  const log = fs.readFileSync(env("APP_LOG"), "utf8");
  const missing = /TOKEN-MISSING/.test(log);
  const sendErr = log.match(/SERVICE\.TELEGRAM\.SEND-MESSAGE[^\n]*/);
  if (missing) { console.log("  INFO  instance ran WITHOUT a bot token — alert path exercised up to the transport only (SKIP_TELEGRAM or no token in the deploy .env)"); return; }
  ok("no Telegram send error logged after the break-glass login (the alert was delivered by the bot)", !sendErr, sendErr ? sendErr[0].slice(0, 160) : "");
  console.log("  CONFIRM in Telegram: a '🚨 BREAK-GLASS LOGIN' message for account '" + BG.username + "' from @DailyNeedsBot in the alerts chat (with sound).");
}

async function enforceOnly() {
  console.log("\n-- forced-change behaviour with AUTH_ENFORCE_PASSWORD_CHANGE=true (Deployment B posture) on " + BASE);
  const outletPw = `${OUTLET.employee_id}@123`;
  let r = await login(OUTLET.username, outletPw);
  ok("outlet login still succeeds (200) — enforcement never blocks the login itself", r.status === 200 && r.json && r.json.code === 200, `code=${r.json && r.json.code}`);
  const t = r.json && r.json.token; const c = claims(t || "");
  ok("  token carries pwc=true", c.pwc === true, `fields=${Object.keys(c).join(",")}`);
  r = await req("GET", "/user/telegram-link", { token: t });
  ok("  an ordinary protected route is refused for that session (PASSWORD_CHANGE_REQUIRED)", r.json && r.json.code === 403 && r.json.error === "PASSWORD_CHANGE_REQUIRED", `status=${r.status} body=${(r.text || "").slice(0, 80)}`);
  r = await req("GET", "/user/my-ip", { token: t });
  ok("  the allow-listed routes still answer for it (my-ip)", r.status === 200);
  r = await req("POST", "/user/change-password", { token: t, body: { current_password: outletPw, new_password: "short" } });
  ok("  change-password IS reachable for it, and the policy still applies (short password rejected)", r.status !== 403 && r.json && r.json.code !== 200, `status=${r.status} code=${r.json && r.json.code}`);
  const adminR = await login(ADMIN.username, secrets.STAGING_ADMIN_PASSWORD);
  const ac = claims(adminR.json.token || "");
  const am = await req("GET", "/user/auth-metrics", { token: adminR.json.token });
  ok("admin (not flagged) gets a token without pwc and is not confined", ac.pwc === undefined && am.status === 200 && am.json && am.json.code !== 403, `status=${am.status} code=${am.json && am.json.code}`);
}

(async () => {
  try {
    if (env("ENFORCE_ONLY", "0") === "1") { await enforceOnly(); }
    else {
      const { adminToken } = await gate9();
      await gate10(adminToken);
      await gate18(adminToken);
      await gate19();
    }
  } catch (e) { failCount++; console.log("  FAIL  unexpected error: " + (e && e.message)); }
  db.end();
  console.log(`\n${failCount === 0 ? "ALL CHECKS PASSED" : failCount + " CHECK(S) FAILED"}  (${pass} passed)`);
  process.exit(failCount === 0 ? 0 : 1);
})();
