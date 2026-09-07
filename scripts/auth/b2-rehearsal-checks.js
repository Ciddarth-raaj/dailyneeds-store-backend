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
 */
const fs = require("fs");

const env = (f) =>
  Object.fromEntries(
    fs
      .readFileSync(f, "utf8")
      .split("\n")
      .filter((l) => l.includes("="))
      .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
  );

const BASE = process.env.BASE_URL || "http://127.0.0.1:18090";
const accounts = env(process.env.ACCOUNTS);
const secrets = env(process.env.SECRETS);
const split = (s) => {
  const [user_id, username, designation_id] = String(s || "").split("|");
  return { user_id, username, designation_id };
};
const HR = split(accounts.B2_HR);
const OTHER = split(accounts.B2_OTHER);
const ADMIN = split(accounts.B2_ADMIN);

let pass = 0;
let fail = 0;
const ok = (msg, cond, detail = "") => {
  if (cond) {
    pass++;
    console.log(`  PASS  ${msg}`);
  } else {
    fail++;
    console.log(`  FAIL  ${msg}${detail ? "   [" + detail + "]" : ""}`);
  }
};

const req = async (method, path, token) => {
  const res = await fetch(BASE + path, {
    method,
    headers: { "content-type": "application/json", ...(token ? { "x-access-token": token } : {}) },
    ...(method === "POST" ? { body: "{}" } : {}),
  });
  const text = await res.text();
  let body = {};
  try {
    body = JSON.parse(text);
  } catch (e) {}
  return { status: res.status, body, text };
};

const login = async (username, password) => {
  const r = await req("POST", "/user/login");
  void r;
  const res = await fetch(BASE + "/user/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const j = await res.json().catch(() => ({}));
  return (j.data && j.data.token) || null;
};

/** Permission refusal: HTTP 403 with the permissions middleware's message. */
const permissionDenied = (r) =>
  r.status === 403 && r.body && r.body.code === 403 && /do not have permission/i.test(r.body.msg || "");
/** Authentication refusal (B1): body code 403 delivered with HTTP 200. */
const authDenied = (r) => r.status === 200 && r.body && r.body.code === 403;

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

(async () => {
  console.log(`\n== B2 rehearsal API checks against ${BASE}`);
  console.log(
    `   HR user: ${HR.username} (designation ${HR.designation_id}) | non-HR: ${OTHER.username} (designation ${OTHER.designation_id}) | admin: ${ADMIN.username}`
  );

  console.log("\n-- anonymous (B1 must still hold)");
  for (const [name, method, path] of HR_MODULES) {
    const r = await req(method, path);
    ok(`${name}: anonymous refused`, authDenied(r), r.text.slice(0, 60));
  }

  console.log("\n-- HR user (designation with all 22 keys)");
  const hrToken = await login(HR.username, secrets.B2_HR_PASSWORD);
  ok("HR user can sign in", Boolean(hrToken));
  if (hrToken) {
    for (const [name, method, path] of HR_MODULES) {
      const r = await req(method, path, hrToken);
      ok(`${name}: reached (not permission-denied)`, !permissionDenied(r), `status=${r.status} ${r.text.slice(0, 60)}`);
    }
    const w = await req("POST", "/employee/updatedata", hrToken);
    ok("HR user is not permission-denied on an employee write", !permissionDenied(w));
  }

  console.log("\n-- non-HR user (designation with zero HR keys)");
  const otherToken = await login(OTHER.username, secrets.B2_OTHER_PASSWORD);
  ok("non-HR user can sign in", Boolean(otherToken));
  if (otherToken) {
    for (const [name, method, path] of HR_MODULES) {
      const r = await req(method, path, otherToken);
      ok(`${name}: refused with 403`, permissionDenied(r), `status=${r.status} ${r.text.slice(0, 60)}`);
    }
    const gd = await req("GET", "/employee/get-details", otherToken);
    ok("/employee/get-details still works for a non-HR user", !permissionDenied(gd) && !authDenied(gd), `status=${gd.status}`);
    const perms = await req("GET", "/designation/permissions", otherToken);
    ok("/designation/permissions still works for a non-HR user", !permissionDenied(perms) && !authDenied(perms), `status=${perms.status}`);
    ok(
      "  and it reports no HR permission for that designation",
      !/view_employees|view_salary_advance|view_documents/.test(perms.text),
      perms.text.slice(0, 80)
    );
  }

  console.log("\n-- admin (user_type 2) bypass");
  const adminToken = await login(ADMIN.username, secrets.B2_ADMIN_PASSWORD);
  ok("admin can sign in", Boolean(adminToken));
  if (adminToken) {
    for (const [name, method, path] of HR_MODULES) {
      const r = await req(method, path, adminToken);
      ok(`${name}: admin not permission-denied`, !permissionDenied(r), `status=${r.status}`);
    }
  }

  console.log(`\n${fail === 0 ? "ALL B2 API CHECKS PASSED" : "B2 API CHECKS FAILED"}  (${pass} passed, ${fail} failed)`);
  process.exit(fail === 0 ? 0 : 1);
})();
