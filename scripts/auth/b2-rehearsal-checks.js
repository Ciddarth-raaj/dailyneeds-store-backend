#!/usr/bin/env node
/**
 * Stage 0B / B2 — API checks against a running instance on the scratch copy.
 *
 * Environment:
 *   BASE_URL   the staging instance (never production)
 *   ACCOUNTS   env file with B2_HR / B2_OTHER / B2_ADMIN as user_id|username|designation_id
 *   SECRETS    env file with the staging passwords (never printed)
 *
 * Proves, against the real app with the real policy in the database:
 *   * the HR user reaches employee, salary, document, resignation, designation
 *   * a non-HR user is refused on every HR endpoint
 *   * the admin bypass still works
 *   * both bootstrap routes work for the non-HR user
 *   * an anonymous caller is still refused (B1 unchanged)
 *
 * Two things this file is deliberate about:
 *
 *   1. It uses the built-in `http` module, not global `fetch`. The Lightsail
 *      host runs a Node old enough that `fetch` is undefined, and the first
 *      real run died on it. Nothing here needs a Node upgrade or a dependency.
 *
 *   2. It cannot print success unless every intended check ran. The expected
 *      count is computed up front, an unexpected throw or rejection is fatal,
 *      and the final line is only reached when passed + failed equals what was
 *      planned. A crash halfway through exits non-zero and says so.
 */
const fs = require("fs");
const http = require("http");
const { URL } = require("url");

/** Read a KEY=VALUE env file. Values are used, never printed. */
const env = (f) => {
  const out = {};
  for (const line of fs.readFileSync(f, "utf8").split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
};

const BASE = process.env.BASE_URL || "http://127.0.0.1:18090";
const accounts = env(process.env.ACCOUNTS);
const secrets = env(process.env.SECRETS);
const split = (s) => {
  const parts = String(s || "").split("|");
  return { user_id: parts[0], username: parts[1], designation_id: parts[2] };
};
const HR = split(accounts.B2_HR);
const OTHER = split(accounts.B2_OTHER);
const ADMIN = split(accounts.B2_ADMIN);

/** One endpoint per HR module the policy is supposed to open for HR. */
const HR_MODULES = [
  ["Employee", "GET", "/employee/employees"],
  ["Employee bank", "GET", "/employee/bank?employee_id=1"],
  ["Salary", "GET", "/salary"],
  ["Documents", "GET", "/document/all"],
  ["Documents (Aadhaar)", "GET", "/document/adhaar"],
  ["Resignation", "GET", "/resignation"],
  ["Designation", "GET", "/designation"],
  ["Department", "GET", "/department"],
  ["Shift", "GET", "/shift"],
  ["Outlet", "GET", "/outlet"],
];

// anonymous(10) + HR login + HR modules(10) + HR write
// + non-HR login + non-HR modules(10) + get-details + permissions + no-HR-keys
// + admin login + admin modules(10)
const EXPECTED_CHECKS = HR_MODULES.length * 4 + 3 + 4;

let pass = 0;
let fail = 0;
const ok = (msg, cond, detail) => {
  if (cond) {
    pass++;
    console.log(`  PASS  ${msg}`);
  } else {
    fail++;
    console.log(`  FAIL  ${msg}${detail ? "   [" + detail + "]" : ""}`);
  }
};

/**
 * Minimal HTTP client on the built-in module. Resolves with status and the
 * parsed body; rejects on transport failure or timeout, which the caller
 * treats as fatal rather than as a failed check.
 */
function request(method, path, options) {
  const opts = options || {};
  return new Promise((resolve, reject) => {
    const url = new URL(path.indexOf("http") === 0 ? path : BASE + path);
    const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const headers = { "content-type": "application/json" };
    if (opts.token) headers["x-access-token"] = opts.token;
    if (body !== undefined) headers["content-length"] = Buffer.byteLength(body);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname + url.search,
        method: method,
        headers: headers,
        timeout: 20000,
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (text += c));
        res.on("end", () => {
          let parsed = {};
          try {
            parsed = JSON.parse(text);
          } catch (e) {
            /* a non-JSON body is still a result; the checks read status too */
          }
          resolve({ status: res.statusCode, body: parsed, text: text });
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error(`timeout after 20s: ${method} ${path}`)));
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const login = async (username, password) => {
  const r = await request("POST", "/user/login", { body: { username: username, password: password } });
  return (r.body && r.body.data && r.body.data.token) || null;
};

/** Permission refusal: HTTP 403 with the permissions middleware's message. */
const permissionDenied = (r) =>
  r.status === 403 && r.body && r.body.code === 403 && /do not have permission/i.test(r.body.msg || "");
/** Authentication refusal (B1): body code 403 delivered with HTTP 200. */
const authDenied = (r) => r.status === 200 && r.body && r.body.code === 403;

async function run() {
  console.log(`\n== B2 rehearsal API checks against ${BASE}`);
  console.log(`   node ${process.version}, built-in http (no global fetch required)`);
  console.log(
    `   HR user: ${HR.username} (designation ${HR.designation_id}) | non-HR: ${OTHER.username} (designation ${OTHER.designation_id}) | admin: ${ADMIN.username}`
  );
  if (!HR.username || !OTHER.username || !ADMIN.username) {
    throw new Error("ACCOUNTS is missing one of B2_HR / B2_OTHER / B2_ADMIN");
  }

  console.log("\n-- anonymous (B1 must still hold)");
  for (const m of HR_MODULES) {
    const r = await request(m[1], m[2]);
    ok(`${m[0]}: anonymous refused`, authDenied(r), r.text.slice(0, 60));
  }

  console.log("\n-- HR user (designation with all 22 keys)");
  const hrToken = await login(HR.username, secrets.B2_HR_PASSWORD);
  ok("HR user can sign in", Boolean(hrToken));
  for (const m of HR_MODULES) {
    const r = await request(m[1], m[2], { token: hrToken });
    ok(`${m[0]}: reached (not permission-denied)`, !permissionDenied(r), `status=${r.status} ${r.text.slice(0, 60)}`);
  }
  const w = await request("POST", "/employee/updatedata", { token: hrToken, body: {} });
  ok("HR user is not permission-denied on an employee write", !permissionDenied(w));

  console.log("\n-- non-HR user (designation with zero HR keys)");
  const otherToken = await login(OTHER.username, secrets.B2_OTHER_PASSWORD);
  ok("non-HR user can sign in", Boolean(otherToken));
  for (const m of HR_MODULES) {
    const r = await request(m[1], m[2], { token: otherToken });
    ok(`${m[0]}: refused with 403`, permissionDenied(r), `status=${r.status} ${r.text.slice(0, 60)}`);
  }
  const gd = await request("GET", "/employee/get-details", { token: otherToken });
  ok("/employee/get-details still works for a non-HR user", !permissionDenied(gd) && !authDenied(gd), `status=${gd.status}`);
  const perms = await request("GET", "/designation/permissions", { token: otherToken });
  ok("/designation/permissions still works for a non-HR user", !permissionDenied(perms) && !authDenied(perms), `status=${perms.status}`);
  ok(
    "  and it reports no HR permission for that designation",
    !/view_employees|view_salary_advance|view_documents/.test(perms.text),
    perms.text.slice(0, 80)
  );

  console.log("\n-- admin (user_type 2) bypass");
  const adminToken = await login(ADMIN.username, secrets.B2_ADMIN_PASSWORD);
  ok("admin can sign in", Boolean(adminToken));
  for (const m of HR_MODULES) {
    const r = await request(m[1], m[2], { token: adminToken });
    ok(`${m[0]}: admin not permission-denied`, !permissionDenied(r), `status=${r.status}`);
  }
}

// An unexpected throw or a rejected promise is a failed run, never a silent
// one: the process must not exit 0 with checks left unrun.
process.on("unhandledRejection", (err) => {
  console.log(`\n  FATAL  unhandled rejection: ${(err && err.message) || err}`);
  process.exit(1);
});
process.on("uncaughtException", (err) => {
  console.log(`\n  FATAL  uncaught exception: ${(err && err.message) || err}`);
  process.exit(1);
});

run()
  .then(() => {
    const ran = pass + fail;
    if (ran !== EXPECTED_CHECKS) {
      console.log(`\nB2 API CHECKS INCOMPLETE: ${ran} of ${EXPECTED_CHECKS} checks ran`);
      process.exit(1);
    }
    if (fail === 0) {
      console.log(`\nALL B2 API CHECKS PASSED  (${pass} passed, 0 failed, ${EXPECTED_CHECKS} expected)`);
      process.exit(0);
    }
    console.log(`\nB2 API CHECKS FAILED  (${pass} passed, ${fail} failed, ${EXPECTED_CHECKS} expected)`);
    process.exit(1);
  })
  .catch((err) => {
    console.log(`\n  FATAL  ${(err && err.message) || err}`);
    console.log(`B2 API CHECKS DID NOT COMPLETE: ${pass + fail} of ${EXPECTED_CHECKS} checks ran`);
    process.exit(1);
  });
