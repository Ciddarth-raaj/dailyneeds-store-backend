/**
 * AADHAAR: WHO MAY READ THE STATUS, WHO MAY ATTACH ONE, AND FOR WHICH BRANCH.
 *
 *   node --test middlewares/employee_aadhaar_scope.test.js
 *
 * A REAL Express app with the REAL authentication, permission and branch-scope
 * middleware and the REAL `/hr` router. Only the database is stood in for.
 *
 * ============================== THE DEFECT THIS FIXES =====================
 *
 * `GET /hr/employee/:id/aadhaar` was gated on `view_employee_lifecycle` - the
 * EMPLOYMENT HISTORY key. A store manager does not hold it, so the profile
 * reported "Aadhaar status not available with your access" for employees the
 * manager had personally onboarded: they had run the verification under
 * `employee_create` and could attach one under `employee_edit`, but could not
 * see the result. Aadhaar identity and employment history are different
 * questions and one must not gate the other.
 *
 * ============================== WHAT MUST STAY TRUE =======================
 *
 * The fix must not become a widening. These tests exist as much to pin what a
 * store manager still CANNOT do as what they now can: no employment history,
 * no company-wide reach, no other branch's Aadhaar, no full number.
 *
 * NO REAL AADHAAR NUMBER APPEARS IN THIS FILE. The status surface never
 * carries one, and the fixtures use an obviously synthetic last-four.
 */
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dnds-aadhaar-"));
const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
});
fs.writeFileSync(path.join(dir, "priv.key"), privateKey);
fs.writeFileSync(path.join(dir, "pub.key"), publicKey);
process.env.JWT_PRIVATE_KEY_PATH = path.join(dir, "priv.key");
process.env.JWT_PUBLIC_KEYS = JSON.stringify({ legacy: path.join(dir, "pub.key") });
process.env.JWT_ACTIVE_KID = "legacy";
process.env.JWT_LEGACY_KID = "legacy";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const bodyParser = require("body-parser");

const auth = require("./auth");
const buildPermissions = require("./permissions");
const buildSensitive = require("./sensitive");
const buildBranchScope = require("./employee_branch_scope");
const { branchRepo } = require("../test_support/employee_branch_scope");
const jwtService = require("../services/jwt");
const P = require("../constants/hr_permissions");

/* ------------------------------------------------------------- the world */

const KATHIRKAMAM = 1;
const MOOLAKULAM = 2;

const OWN = 201;      // an employee in the manager's branch, Aadhaar VERIFIED
const OWN_NONE = 202; // an employee in the manager's branch, no Aadhaar
const OTHER = 203;    // an employee in a different branch, Aadhaar VERIFIED

const EMPLOYEES = [
  { employee_id: 100, employee_name: "Hema HR", store_id: KATHIRKAMAM, status: 1 },
  { employee_id: 101, employee_name: "Selva Manager", store_id: KATHIRKAMAM, status: 1 },
  { employee_id: 102, employee_name: "Vino ViewOnly", store_id: KATHIRKAMAM, status: 1 },
  { employee_id: 105, employee_name: "Anu Admin", store_id: MOOLAKULAM, status: 1 },
  { employee_id: OWN, employee_name: "Kavi Kathirkamam", store_id: KATHIRKAMAM, status: 1 },
  { employee_id: OWN_NONE, employee_name: "Nila Kathirkamam", store_id: KATHIRKAMAM, status: 1 },
  { employee_id: OTHER, employee_name: "Mohan Moolakulam", store_id: MOOLAKULAM, status: 1 },
];

/** Synthetic. The status surface never carries a full number, and nor does this. */
const LAST4 = "0000";
const VERIFIED_NAME = "KAVI K";

const D = { HR: 1, MANAGER: 2, VIEW_ONLY: 3, ADMIN: 4, ONBOARDER: 5 };

const GRANTS = {
  // HR, as the migrations leave it - company-wide through the branch key.
  [D.HR]: [
    P.VIEW_EMPLOYEES, P.EMPLOYEE_CREATE, P.EMPLOYEE_EDIT,
    P.VIEW_EMPLOYEE_LIFECYCLE, P.VIEW_EMPLOYEE_AADHAAR,
    P.EMPLOYEE_SCOPE_ALL_BRANCHES,
  ],
  // THE STORE MANAGER, as an administrator configures them: the Aadhaar key
  // ticked deliberately on the rights screen. The migration does NOT grant it
  // to Store Managers - it neither infers from employee_create/employee_edit
  // nor guesses a designation name - so this fixture models the state after
  // that administrator action, which is the state the business rule describes.
  //
  // Note what is ABSENT and stays absent: view_employee_lifecycle,
  // employee_scope_all_branches, view_employee_sensitive, view_aadhaar_full.
  [D.MANAGER]: [
    P.VIEW_EMPLOYEES, P.EMPLOYEE_CREATE, P.EMPLOYEE_EDIT, P.VIEW_EMPLOYEE_AADHAAR,
  ],
  // Can see the staff list and nothing else - no Aadhaar key.
  [D.VIEW_ONLY]: [P.VIEW_EMPLOYEES],
  // THE ONBOARDING MANAGER. The same as MANAGER plus
  // `edit_employee_sensitive`, which stage 1 of Add Employee has ALWAYS
  // required and still does: the initiate body carries `aadhaar_number`, a B3
  // sensitive field, so B3's write guard refuses it without that key. That is
  // pre-existing and untouched here - it is modelled separately so MANAGER
  // stays the minimal designation the rest of this file reasons about.
  [D.ONBOARDER]: [
    P.VIEW_EMPLOYEES, P.EMPLOYEE_CREATE, P.EMPLOYEE_EDIT, P.VIEW_EMPLOYEE_AADHAAR,
    P.EDIT_EMPLOYEE_SENSITIVE,
  ],
  [D.ADMIN]: [],
};

/* ------------------------------------------------- the stub data layer  */

let lastAttach = null;

const aadhaarOf = (id) =>
  id === OWN || id === OTHER
    ? {
        employee_id: id,
        aadhaar_status: "VERIFIED",
        aadhaar_last4: LAST4,
        name_as_per_aadhaar: VERIFIED_NAME,
        verified_at: "2026-01-01T00:00:00Z",
        can_verify_now: false,
      }
    : {
        employee_id: id,
        aadhaar_status: "PENDING",
        aadhaar_last4: null,
        name_as_per_aadhaar: null,
        verified_at: null,
        can_verify_now: true,
        message: "No Aadhaar on record. It can be verified at any time and attached to this employee.",
      };

const usecase = {
  async getAadhaarStatus(employeeId) {
    return aadhaarOf(Number(employeeId));
  },
  async attachAadhaar(employeeId, body, opts) {
    lastAttach = { employeeId: Number(employeeId), body, opts };
    return { code: 200, employee_id: Number(employeeId), aadhaar_last4: LAST4 };
  },
  async getLifecycleHistory(employeeId) {
    return { code: 200, employee_id: Number(employeeId), periods: [], events: [] };
  },
  async editEmployee() {
    return { code: 200 };
  },
  async createEmployee() {
    return { code: 200 };
  },
  async findPossibleDuplicates() {
    return { code: 200, matches: [] };
  },
  async getReviewList() {
    return { code: 200, items: [] };
  },
};

let otpVerified = null;
const aadhaarUsecase = {
  async initiate(body, opts) {
    return { code: 200, verification_token: "tok", masked: "XXXX XXXX " + LAST4 };
  },
  async verifyOtp(body, opts) {
    otpVerified = { body, opts };
    return { code: 200, verification_id: 55, next_action: "create" };
  },
  async revealFullNumber() {
    throw new Error("revealFullNumber must not be reachable in these tests");
  },
};

/* ------------------------------------------------------------- the app  */

let server, port;

before(async () => {
  const permissions = buildPermissions({
    getPermissionById: async (designationId) =>
      (GRANTS[designationId] || []).map((permission_key) => ({ permission_key, is_active: 1 })),
  });
  const sensitive = buildSensitive(permissions);
  const branchScope = buildBranchScope(permissions, branchRepo(EMPLOYEES));

  const app = express();
  app.use(bodyParser.json());
  app.use(
    auth.create({
      userUsecase: {
        getSessionState: async (userId) => ({
          user_id: userId, employee_id: userId, status: 1,
          token_valid_from: null, is_system_account: 0, employee_status: 1,
        }),
      },
    })
  );

  delete require.cache[require.resolve("../routes/employee_master")];
  app.use(
    "/hr",
    require("../routes/employee_master")(
      usecase, permissions, sensitive, aadhaarUsecase, null, null, null, branchScope
    ).getRouter()
  );

  server = await new Promise((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  port = server.address().port;
});

after(() => server && server.close());

const tokenFor = (employeeId, designationId, userType = 1) =>
  jwtService.sign(
    {
      auth_ver: 2, sub: String(employeeId), id: employeeId, employee_id: employeeId,
      user_type: userType, designation_id: designationId,
      // Deliberately the WRONG branch on every caller: the scope must come
      // from the live employee record, never from this claim.
      store_id: MOOLAKULAM,
    },
    "1d"
  );

const CALLERS = {
  hr: () => tokenFor(100, D.HR),
  manager: () => tokenFor(101, D.MANAGER),
  viewOnly: () => tokenFor(102, D.VIEW_ONLY),
  admin: () => tokenFor(105, D.ADMIN, 2),
  onboarder: () => tokenFor(101, D.ONBOARDER),
};

const call = async (method, url, token, body) => {
  const res = await fetch(`http://127.0.0.1:${port}${url}`, {
    method,
    headers: { "x-access-token": await token, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (err) { json = null; }
  return { status: res.status, body: json, text };
};
const get = (u, t) => call("GET", u, t);
const post = (u, t, b) => call("POST", u, t, b);

const assertRefused = (res, what) =>
  assert.ok(
    res.status === 403 || (res.body && res.body.code === 403),
    `${what}: expected a refusal, got ${res.status} ${res.text.slice(0, 160)}`
  );

/* ======================================================================= */
/*  1-2. THE STORE MANAGER, IN THEIR OWN BRANCH                            */
/* ======================================================================= */

describe("a store manager, in their own branch", () => {
  it("1. READS AADHAAR STATUS - the defect that was reported", async () => {
    const res = await get(`/hr/employee/${OWN}/aadhaar`, CALLERS.manager());
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.aadhaar_status, "VERIFIED");
    assert.equal(res.body.aadhaar_last4, LAST4);
  });

  it("1. and sees a genuine PENDING as PENDING, not as a refusal", async () => {
    const res = await get(`/hr/employee/${OWN_NONE}/aadhaar`, CALLERS.manager());
    assert.equal(res.status, 200);
    assert.equal(res.body.aadhaar_status, "PENDING");
    assert.equal(res.body.can_verify_now, true);
  });

  it("2. ATTACHES A VERIFIED AADHAAR - the edit half", async () => {
    lastAttach = null;
    const res = await post(`/hr/employee/${OWN}/aadhaar/attach`, CALLERS.manager(), {
      aadhaar_verification_id: 55,
    });
    assert.equal(res.status, 200, res.text);
    assert.equal(lastAttach.employeeId, OWN);
    // The acting employee is stamped on the write - see the audit section.
    assert.equal(lastAttach.opts.actorEmployeeId, 101);
  });

  it("13. and can still run the onboarding verification itself", async () => {
    // Stage 1 of Add Employee: `employee_create`, plus B3's
    // `edit_employee_sensitive` because the body carries an Aadhaar number.
    // No employee exists yet, so there is no branch to check - and none of
    // this is changed by this work.
    const initiated = await post("/hr/aadhaar/initiate", CALLERS.onboarder(), {
      aadhaar_number: "999999999999", consent: true,
    });
    assert.equal(initiated.status, 200, initiated.text);

    otpVerified = null;
    const verified = await post("/hr/aadhaar/verify-otp", CALLERS.onboarder(), {
      verification_token: "tok", otp: "123456",
    });
    assert.equal(verified.status, 200, verified.text);
    assert.ok(otpVerified, "the OTP step still reaches the usecase");
  });
});

/* ======================================================================= */
/*  3-4, 10-11. ANOTHER BRANCH                                             */
/* ======================================================================= */

describe("a store manager, reaching another branch", () => {
  it("3. AADHAAR STATUS IS DENIED", async () => {
    const res = await get(`/hr/employee/${OTHER}/aadhaar`, CALLERS.manager());
    assertRefused(res, "cross-branch Aadhaar read");
  });

  it("4. ATTACHING IS DENIED, and nothing reaches the usecase", async () => {
    lastAttach = null;
    const res = await post(`/hr/employee/${OTHER}/aadhaar/attach`, CALLERS.manager(), {
      aadhaar_verification_id: 55,
    });
    assert.equal(res.status, 403);
    assert.equal(lastAttach, null);
  });

  it("10. A DIRECT API CALL CANNOT BYPASS THE BRANCH SCOPE", async () => {
    // No browser, no screen: the request curl makes. And a non-existent id
    // gets the same answer, so ids cannot be enumerated.
    const foreign = await get(`/hr/employee/${OTHER}/aadhaar`, CALLERS.manager());
    const missing = await get(`/hr/employee/999999/aadhaar`, CALLERS.manager());
    assertRefused(foreign, "direct cross-branch call");
    assertRefused(missing, "an id that does not exist");
    assert.equal(foreign.status, missing.status);
    assert.deepEqual(foreign.body, missing.body);
  });

  it("11. THE REFUSAL DOES NOT REVEAL WHETHER AN AADHAAR EXISTS", async () => {
    // Employee OTHER has a VERIFIED Aadhaar; the refusal must be identical to
    // the one for an employee who has none, and must carry no Aadhaar detail.
    const verifiedElsewhere = await get(`/hr/employee/${OTHER}/aadhaar`, CALLERS.manager());
    const missingAltogether = await get(`/hr/employee/999999/aadhaar`, CALLERS.manager());

    assert.deepEqual(verifiedElsewhere.body, missingAltogether.body);
    for (const secret of ["VERIFIED", "PENDING", LAST4, VERIFIED_NAME, "Mohan"]) {
      assert.ok(
        !verifiedElsewhere.text.includes(secret),
        `a cross-branch refusal must not disclose ${secret}`
      );
    }
  });
});

/* ======================================================================= */
/*  5-6. WHAT THE STORE MANAGER STILL CANNOT DO                            */
/* ======================================================================= */

describe("the fix grants nothing else", () => {
  it("5. NO EMPLOYMENT LIFECYCLE ACCESS", async () => {
    // Their own branch, so only the missing key can refuse this.
    const own = await get(`/hr/employee/${OWN}/lifecycle`, CALLERS.manager());
    assertRefused(own, "lifecycle history");
    const review = await get("/hr/lifecycle/review", CALLERS.manager());
    assertRefused(review, "the lifecycle review queue");
  });

  it("5. the Aadhaar key is NOT the lifecycle key", () => {
    assert.notEqual(P.VIEW_EMPLOYEE_AADHAAR, P.VIEW_EMPLOYEE_LIFECYCLE);
    assert.ok(!GRANTS[D.MANAGER].includes(P.VIEW_EMPLOYEE_LIFECYCLE));
  });

  it("6. NO COMPANY-WIDE EMPLOYEE ACCESS", () => {
    assert.ok(!GRANTS[D.MANAGER].includes(P.EMPLOYEE_SCOPE_ALL_BRANCHES));
  });

  it("6. which is why the cross-branch reads above are refused at all", async () => {
    const res = await get(`/hr/employee/${OTHER}/aadhaar`, CALLERS.manager());
    assert.equal(res.body.error, "OUT_OF_BRANCH");
  });

  it("NO FULL AADHAAR NUMBER", async () => {
    // `view_aadhaar_full` + `view_employee_sensitive`, neither of which they
    // hold. The stub throws if it is ever reached, so a 403 is the only pass.
    const res = await get(`/hr/employee/${OWN}/aadhaar/full`, CALLERS.manager());
    assertRefused(res, "the full number");
  });
});

/* ======================================================================= */
/*  7-9. HR, ADMIN, AND A CALLER WITHOUT THE KEY                           */
/* ======================================================================= */

describe("HR and administrators are unchanged", () => {
  it("7. HR reads Aadhaar status in ANY branch", async () => {
    for (const id of [OWN, OTHER]) {
      const res = await get(`/hr/employee/${id}/aadhaar`, CALLERS.hr());
      assert.equal(res.status, 200, res.text);
      assert.equal(res.body.employee_id, id);
    }
  });

  it("7. and attaches in any branch", async () => {
    lastAttach = null;
    const res = await post(`/hr/employee/${OTHER}/aadhaar/attach`, CALLERS.hr(), {
      aadhaar_verification_id: 55,
    });
    assert.equal(res.status, 200, res.text);
    assert.equal(lastAttach.employeeId, OTHER);
  });

  it("8. an administrator reads and attaches in any branch, holding no key", async () => {
    // user_type 2: company-wide by user type, and every key by bypass.
    const read = await get(`/hr/employee/${OTHER}/aadhaar`, CALLERS.admin());
    assert.equal(read.status, 200, read.text);

    lastAttach = null;
    const attach = await post(`/hr/employee/${OTHER}/aadhaar/attach`, CALLERS.admin(), {
      aadhaar_verification_id: 55,
    });
    assert.equal(attach.status, 200, attach.text);
    assert.equal(lastAttach.employeeId, OTHER);
  });

  it("9. WITHOUT THE AADHAAR KEY, EVEN OWN-BRANCH IS DENIED", async () => {
    // Holds `view_employees` and nothing else. Being in the right branch is
    // not a permission: both halves of the rule must pass.
    const res = await get(`/hr/employee/${OWN}/aadhaar`, CALLERS.viewOnly());
    assertRefused(res, "no view_employee_aadhaar");
    for (const secret of ["VERIFIED", LAST4, VERIFIED_NAME]) {
      assert.ok(!res.text.includes(secret));
    }
  });

  it("9. and without employee_edit, attaching is denied in their own branch", async () => {
    lastAttach = null;
    const res = await post(`/hr/employee/${OWN}/aadhaar/attach`, CALLERS.viewOnly(), {
      aadhaar_verification_id: 55,
    });
    assertRefused(res, "no employee_edit");
    assert.equal(lastAttach, null);
  });
});

/* ======================================================================= */
/*  12. AUDIT                                                              */
/* ======================================================================= */

describe("the audit record", () => {
  /**
   * AADHAAR WRITES WERE ALREADY AUDITED, and this preserves rather than
   * replaces that. Two mechanisms, both pre-existing:
   *
   *   employee_aadhaar_identity   `created_by` / `updated_by` (the acting
   *                               employee), `verified_at`, `created_at`,
   *                               `updated_at`, and `employee_id` as the row's
   *                               unique key. The number is present only as
   *                               ciphertext.
   *   the application log         `AADHAAR-ATTACHED` and `FULL-NUMBER-READ`,
   *                               each carrying employeeId and actorEmployeeId.
   *
   * So the smallest appropriate record already exists: who, whom, what, when,
   * and that it succeeded. What follows is the regression test asked for.
   */
  it("12. the acting employee is recorded on every attach", async () => {
    lastAttach = null;
    await post(`/hr/employee/${OWN}/aadhaar/attach`, CALLERS.manager(), {
      aadhaar_verification_id: 55,
    });
    assert.equal(lastAttach.employeeId, OWN, "the TARGET employee");
    assert.equal(lastAttach.opts.actorEmployeeId, 101, "the ACTING employee");
  });

  it("12. NO AADHAAR NUMBER REACHES THE AUDIT RECORD", () => {
    // Asserted against the source: the identity row stores ciphertext, and
    // neither log line may carry a number or a decrypted value.
    const aadhaarUsecaseSrc = fs.readFileSync(
      path.join(__dirname, "../usecase/employee_aadhaar.js"), "utf8"
    );
    // THE LOG CALL ONLY. Sliced precisely, because the reveal endpoint's
    // RETURN value legitimately carries the number - that is what it is for.
    // What must not carry it is the audit record.
    const marker = '"FULL-NUMBER-READ"';
    const logStart = aadhaarUsecaseSrc.lastIndexOf("this._log(", aadhaarUsecaseSrc.indexOf(marker));
    const logEnd = aadhaarUsecaseSrc.indexOf(");", aadhaarUsecaseSrc.indexOf(marker));
    const revealLog = aadhaarUsecaseSrc.slice(logStart, logEnd + 2);

    assert.ok(revealLog.includes(marker), "the slice really is the log call");
    assert.ok(!/aadhaar_number/.test(revealLog), "the reveal log must not carry the number");
    assert.ok(
      !/\bnumber\b(?!s)/.test(revealLog),
      "nor the decrypted value under any name"
    );
    assert.match(revealLog, /actorEmployeeId/, "but it must record who read it");
    assert.match(revealLog, /employeeId/, "and whose record it was");
    // The last four ARE recorded, deliberately: they identify which Aadhaar
    // was read without disclosing it.
    assert.match(revealLog, /aadhaar_last4/);
  });

  it("12. the identity table stores the number only as ciphertext", () => {
    const migration = fs.readFileSync(
      path.join(__dirname, "../migrations/mysql/migrations/sqls/20260908140000-c2-aadhaar-identity-up.sql"),
      "utf8"
    );
    const table = migration.slice(migration.indexOf("CREATE TABLE IF NOT EXISTS `employee_aadhaar_identity`"));
    // Who and when, for the audit.
    for (const column of ["created_by", "updated_by", "created_at", "updated_at", "verified_at"]) {
      assert.ok(table.includes(`\`${column}\``), `${column} is part of the audit trail`);
    }
    // And no plaintext column to hold a number in.
    assert.ok(!/`aadhaar_number`/.test(table), "there is no plaintext number column");
    assert.match(table, /`aadhaar_ciphertext`\s+VARBINARY/);
  });
});

/* ======================================================================= */
/*  14. B3 SENSITIVE-FIELD PROTECTION IS INTACT                            */
/* ======================================================================= */

describe("B3 is untouched", () => {
  it("14. the status payload carries no B3 sensitive field", async () => {
    const res = await get(`/hr/employee/${OWN}/aadhaar`, CALLERS.manager());
    assert.equal(res.status, 200);

    const { SENSITIVE_EMPLOYEE_FIELDS } = require("../constants/sensitive_fields");
    for (const field of SENSITIVE_EMPLOYEE_FIELDS) {
      assert.ok(
        !Object.prototype.hasOwnProperty.call(res.body, field),
        `${field} is a B3 sensitive key and must not be in the Aadhaar status payload`
      );
    }
    // Specifically: the status surface carries the LAST FOUR and the verified
    // name, and never the number, the ciphertext or the fingerprint.
    for (const forbidden of ["aadhaar_number", "aadhaar_ciphertext", "aadhaar_fingerprint"]) {
      assert.ok(!res.text.includes(forbidden));
    }
  });

  it("14. the full-number route still demands BOTH of its keys", () => {
    // Unchanged by this work, and the store manager holds neither.
    const routes = fs.readFileSync(path.join(__dirname, "../routes/employee_master.js"), "utf8");
    assert.match(
      routes,
      /"\/employee\/:employee_id\/aadhaar\/full",\s*\n\s*this\.permissions\.requireAll\(P\.VIEW_EMPLOYEE_SENSITIVE, P\.VIEW_AADHAAR_FULL\)/
    );
  });

  it("14. and the status route still applies the branch scope beside its key", () => {
    const routes = fs.readFileSync(path.join(__dirname, "../routes/employee_master.js"), "utf8");
    const route = routes.slice(routes.indexOf('"/employee/:employee_id/aadhaar",'));
    const guards = route.slice(0, route.indexOf("async (req, res)"));
    assert.match(guards, /permissions\.require\(P\.VIEW_EMPLOYEE_AADHAAR\)/, "the key");
    assert.match(guards, /branchScope\.requireEmployeeInScope\(\)/, "AND the branch");
    assert.ok(
      !/VIEW_EMPLOYEE_LIFECYCLE/.test(guards),
      "employment history must no longer gate Aadhaar"
    );
  });
});
