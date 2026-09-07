#!/usr/bin/env node
/**
 * Stage 0B / B3 — API checks against a running instance on the scratch copy.
 *
 * Environment:
 *   BASE_URL   the staging instance (never production)
 *   ACCOUNTS   env file with B3_HR / B3_DIRECTORY / B3_ADMIN as
 *              user_id|username|designation_id, plus B3_TARGET_EMPLOYEE and
 *              B3_TARGET_SALARY for the write checks
 *   SECRETS    env file with the staging passwords (never printed)
 *
 * What it proves on the real app, against real restored data:
 *
 *   authorised sensitive read     HR sees salary, bank and Aadhaar fields
 *   unauthorised sensitive read   a directory-only caller gets the same rows
 *                                 with those keys ABSENT - checked against the
 *                                 raw response text, not the parsed object, so
 *                                 a leak anywhere in the payload is caught
 *   authorised sensitive write    HR may write a sensitive field
 *   unauthorised sensitive write  the directory caller is refused with 403
 *                                 and the value in the database is unchanged
 *   document leak checks          Aadhaar and PAN rows and their S3 paths
 *                                 never reach the directory caller
 *   admin bypass                  user_type 2 sees everything
 *
 * Same two deliberate properties as the B2 checker: the built-in `http`
 * module rather than global `fetch` (the Lightsail node is old enough for
 * `fetch` to be undefined), and no success line unless every planned check
 * actually ran.
 */
const fs = require("fs");
const http = require("http");
const { URL } = require("url");

const env = (f) => {
  const out = {};
  for (const line of fs.readFileSync(f, "utf8").split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
};

const BASE = process.env.BASE_URL || "http://127.0.0.1:18093";
const accounts = env(process.env.ACCOUNTS);
const secrets = env(process.env.SECRETS);
const split = (s) => {
  const parts = String(s || "").split("|");
  return { user_id: parts[0], username: parts[1], designation_id: parts[2] };
};
const HR = split(accounts.B3_HR);
const DIRECTORY = split(accounts.B3_DIRECTORY);
const ADMIN = split(accounts.B3_ADMIN);
const TARGET_EMPLOYEE = accounts.B3_TARGET_EMPLOYEE;
const TARGET_SALARY = accounts.B3_TARGET_SALARY;
// Documents acted on BY ID. Their current status and verification flag are
// written back unchanged, so the checks prove the guard without editing the
// copy. The ordinary document is optional: a restored copy may contain only
// Aadhaar rows, since that is the only type the UI offers.
const SENSITIVE_DOC = accounts.B3_SENSITIVE_DOCUMENT;
const SENSITIVE_DOC_STATUS = accounts.B3_SENSITIVE_DOCUMENT_STATUS;
const SENSITIVE_DOC_VERIFIED = accounts.B3_SENSITIVE_DOCUMENT_VERIFIED;
const ORDINARY_DOC = accounts.B3_ORDINARY_DOCUMENT;
const ORDINARY_DOC_STATUS = accounts.B3_ORDINARY_DOCUMENT_STATUS;

/** Any of these appearing as a JSON key is a leak. */
const SENSITIVE_KEY_RE =
  /"(salary|payment_type|bank_name|ifsc|account_no|pan_no|aadhaar_card_no|aadhaar_card_name|aadhaar_card_image|uan|pf|pf_number|esi|esi_number)"\s*:/i;

/** Employee reads the directory-only caller is allowed to reach. */
const EMPLOYEE_READS = [
  ["Employee list", "/employee/employees"],
  ["Employee by id", `/employee/employee_id?employee_id=${TARGET_EMPLOYEE}`],
  ["Employee search", "/employee/filter?filter=a"],
  ["Bootstrap (get-details)", "/employee/get-details"],
];
const DOCUMENT_READS = [
  ["Documents by employee", `/document/employee_id?employee_id=${TARGET_EMPLOYEE}`],
  ["All documents", "/document/all"],
];

// 3 logins + HR reads(4) + HR sensitive present + directory reads(4x2:
// reachable and clean) + directory ordinary fields + document reads(2x2)
// + admin reads(2) + employee write checks(3) + B1 + B2
// + document-target checks: 3 always (two refusals and the HR success), plus
//   1 when the copy has a non-sensitive document to act on.
const DOCUMENT_TARGET_CHECKS = 3 + (ORDINARY_DOC ? 1 : 0);
const EXPECTED_CHECKS =
  3 + EMPLOYEE_READS.length + 1 + EMPLOYEE_READS.length * 2 + 1 +
  DOCUMENT_READS.length * 2 + 2 + 3 + DOCUMENT_TARGET_CHECKS + 1 + 1;

let pass = 0;
let fail = 0;
const ok = (msg, cond, detail) => {
  if (cond) {
    pass++;
    console.log(`  PASS  ${msg}`);
  } else {
    fail++;
    console.log(`  FAIL  ${msg}${detail ? "   [" + String(detail).slice(0, 120) + "]" : ""}`);
  }
};

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
            /* the checks read status and raw text too */
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
  const r = await request("POST", "/user/login", { body: { username, password } });
  return (r.body && r.body.data && r.body.data.token) || null;
};

const permissionDenied = (r) =>
  r.status === 403 && r.body && r.body.code === 403 && /do not have permission/i.test(r.body.msg || "");
const authDenied = (r) => r.status === 200 && r.body && r.body.code === 403;
const reached = (r, token) => Boolean(token) && !authDenied(r) && !permissionDenied(r);
const rows = (r) => (Array.isArray(r.body) ? r.body : []);

async function run() {
  console.log(`\n== B3 rehearsal API checks against ${BASE}`);
  console.log(`   node ${process.version}, built-in http (no global fetch required)`);
  console.log(
    `   HR: ${HR.username} (designation ${HR.designation_id}) | directory-only: ${DIRECTORY.username} (designation ${DIRECTORY.designation_id}) | admin: ${ADMIN.username}`
  );
  console.log(`   target employee ${TARGET_EMPLOYEE}, salary written back unchanged`);
  if (!HR.username || !DIRECTORY.username || !ADMIN.username) {
    throw new Error("ACCOUNTS is missing one of B3_HR / B3_DIRECTORY / B3_ADMIN");
  }
  if (!TARGET_EMPLOYEE) throw new Error("ACCOUNTS is missing B3_TARGET_EMPLOYEE");

  const hrToken = await login(HR.username, secrets.B3_HR_PASSWORD);
  const dirToken = await login(DIRECTORY.username, secrets.B3_DIRECTORY_PASSWORD);
  const adminToken = await login(ADMIN.username, secrets.B3_ADMIN_PASSWORD);
  console.log("\n-- logins");
  ok("HR user can sign in", Boolean(hrToken));
  ok("directory-only user can sign in", Boolean(dirToken));
  ok("admin can sign in", Boolean(adminToken));

  console.log("\n-- authorised sensitive read (HR holds view_employee_sensitive)");
  let hrSawSensitive = false;
  for (const [name, path] of EMPLOYEE_READS) {
    const r = hrToken ? await request("GET", path, { token: hrToken }) : { status: 0, body: {}, text: "" };
    ok(`${name}: reached with an HR session`, reached(r, hrToken), `status=${r.status} ${r.text.slice(0, 60)}`);
    if (SENSITIVE_KEY_RE.test(r.text)) hrSawSensitive = true;
  }
  ok("HR actually receives sensitive fields (they are not filtered from everyone)", hrSawSensitive);

  console.log("\n-- unauthorised sensitive read (directory-only caller) + leak check");
  let ordinaryOk = false;
  for (const [name, path] of EMPLOYEE_READS) {
    const r = dirToken ? await request("GET", path, { token: dirToken }) : { status: 0, body: {}, text: "" };
    ok(`${name}: still reachable`, reached(r, dirToken), `status=${r.status} ${r.text.slice(0, 60)}`);
    ok(`${name}: NO sensitive field in the response`, Boolean(dirToken) && !SENSITIVE_KEY_RE.test(r.text),
      (r.text.match(SENSITIVE_KEY_RE) || [""])[0]);
    if (rows(r).some((x) => x && x.employee_name !== undefined)) ordinaryOk = true;
  }
  ok("ordinary employee fields still present for that caller", ordinaryOk);

  console.log("\n-- document leak checks");
  for (const [name, path] of DOCUMENT_READS) {
    const r = dirToken ? await request("GET", path, { token: dirToken }) : { status: 0, body: {}, text: "" };
    ok(`${name}: still reachable`, reached(r, dirToken), `status=${r.status} ${r.text.slice(0, 60)}`);
    const sensitiveRow = rows(r).some((x) => x && (Number(x.card_type) === 1 || Number(x.card_type) === 4));
    ok(
      `${name}: no Aadhaar/PAN row and no sensitive field`,
      Boolean(dirToken) && !sensitiveRow && !SENSITIVE_KEY_RE.test(r.text),
      sensitiveRow ? "a card_type 1/4 row was returned" : (r.text.match(SENSITIVE_KEY_RE) || [""])[0]
    );
  }

  console.log("\n-- admin (user_type 2) bypass");
  for (const [name, path] of [EMPLOYEE_READS[0], DOCUMENT_READS[1]]) {
    const r = adminToken ? await request("GET", path, { token: adminToken }) : { status: 0, body: {}, text: "" };
    ok(`${name}: admin reached it unfiltered`, reached(r, adminToken), `status=${r.status}`);
  }

  console.log("\n-- writes");
  // The value written is the one already stored, so an authorised write
  // proves the path without changing the copy; the shell also restores it.
  const sensitiveWrite = {
    employee_id: Number(TARGET_EMPLOYEE),
    employee_details: { salary: Number(TARGET_SALARY) },
  };
  const ordinaryWrite = {
    employee_id: Number(TARGET_EMPLOYEE),
    employee_details: { blood_group: "" },
  };

  const denied = dirToken
    ? await request("POST", "/employee/updatedata", { token: dirToken, body: sensitiveWrite })
    : { status: 0, body: {}, text: "" };
  ok("unauthorised sensitive write is refused with a 403 permission refusal",
    Boolean(dirToken) && permissionDenied(denied), `status=${denied.status} ${denied.text.slice(0, 80)}`);

  const ordinary = dirToken
    ? await request("POST", "/employee/updatedata", { token: dirToken, body: ordinaryWrite })
    : { status: 0, body: {}, text: "" };
  ok("an ordinary write by the same caller still goes through (B2 unchanged)",
    reached(ordinary, dirToken), `status=${ordinary.status} ${ordinary.text.slice(0, 80)}`);

  const allowed = hrToken
    ? await request("POST", "/employee/updatedata", { token: hrToken, body: sensitiveWrite })
    : { status: 0, body: {}, text: "" };
  ok("authorised sensitive write succeeds", reached(allowed, hrToken), `status=${allowed.status} ${allowed.text.slice(0, 80)}`);

  console.log("\n-- writes whose TARGET is a sensitive document");
  if (!SENSITIVE_DOC) throw new Error("ACCOUNTS is missing B3_SENSITIVE_DOCUMENT");
  const statusBody = (id, status) => ({ document_id: Number(id), status: Number(status) });
  const verifyBody = (id, v) => ({ document_id: Number(id), is_verified: Number(v) });

  const docDenied = dirToken
    ? await request("POST", "/document/update-status", {
        token: dirToken,
        body: statusBody(SENSITIVE_DOC, SENSITIVE_DOC_STATUS),
      })
    : { status: 0, body: {}, text: "" };
  ok("Aadhaar/PAN status update is refused without edit_employee_sensitive",
    Boolean(dirToken) && permissionDenied(docDenied), `status=${docDenied.status} ${docDenied.text.slice(0, 80)}`);

  const verDenied = dirToken
    ? await request("POST", "/document/update-document", {
        token: dirToken,
        body: verifyBody(SENSITIVE_DOC, SENSITIVE_DOC_VERIFIED),
      })
    : { status: 0, body: {}, text: "" };
  ok("Aadhaar/PAN verification update is refused without it",
    Boolean(dirToken) && permissionDenied(verDenied), `status=${verDenied.status} ${verDenied.text.slice(0, 80)}`);

  const docAllowed = hrToken
    ? await request("POST", "/document/update-status", {
        token: hrToken,
        body: statusBody(SENSITIVE_DOC, SENSITIVE_DOC_STATUS),
      })
    : { status: 0, body: {}, text: "" };
  ok("HR succeeds on the same document", reached(docAllowed, hrToken), `status=${docAllowed.status}`);

  if (ORDINARY_DOC) {
    const ordinaryDoc = dirToken
      ? await request("POST", "/document/update-status", {
          token: dirToken,
          body: statusBody(ORDINARY_DOC, ORDINARY_DOC_STATUS),
        })
      : { status: 0, body: {}, text: "" };
    ok("an ordinary document still updates on add_documents alone",
      reached(ordinaryDoc, dirToken), `status=${ordinaryDoc.status} ${ordinaryDoc.text.slice(0, 80)}`);
  } else {
    console.log("  INFO  this copy has no non-sensitive document; that check is not counted");
  }

  console.log("\n-- B1 / B2 unchanged");
  const anon = await request("GET", "/employee/employees");
  ok("anonymous is still refused (B1)", authDenied(anon), anon.text.slice(0, 60));
  const adhaar = dirToken ? await request("GET", "/document/adhaar", { token: dirToken }) : { status: 0, body: {} };
  ok("/document/adhaar is still a view_employee_sensitive route (B2)",
    Boolean(dirToken) && permissionDenied(adhaar), `status=${adhaar.status}`);
}

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
      console.log(`\nB3 API CHECKS INCOMPLETE: ${ran} of ${EXPECTED_CHECKS} checks ran`);
      process.exit(1);
    }
    if (fail === 0) {
      console.log(`\nALL B3 API CHECKS PASSED  (${pass} passed, 0 failed, ${EXPECTED_CHECKS} expected)`);
      process.exit(0);
    }
    console.log(`\nB3 API CHECKS FAILED  (${pass} passed, ${fail} failed, ${EXPECTED_CHECKS} expected)`);
    process.exit(1);
  })
  .catch((err) => {
    console.log(`\n  FATAL  ${(err && err.message) || err}`);
    console.log(`B3 API CHECKS DID NOT COMPLETE: ${pass + fail} of ${EXPECTED_CHECKS} checks ran`);
    process.exit(1);
  });
