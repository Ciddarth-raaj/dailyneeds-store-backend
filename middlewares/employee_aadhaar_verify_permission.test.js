/**
 * THE EXISTING-EMPLOYEE AADHAAR VERIFICATION PERMISSION.
 *
 *   node --test middlewares/employee_aadhaar_verify_permission.test.js
 *
 * A REAL Express app with the REAL authentication, permission, B3 sensitive
 * and branch-scope middleware, the REAL `/hr` routers mounted in the REAL
 * order. Only the database and the KYC provider are stood in for.
 *
 * ============================== THE DEFECT THIS FIXES =====================
 *
 * The Verify now button on the employee profile called the ONBOARDING
 * endpoints - `POST /hr/aadhaar/initiate` and `/hr/aadhaar/verify-otp` - which
 * require `employee_create` AND, because the initiate body carries
 * `aadhaar_number`, `edit_employee_sensitive` through B3's `guardWrite`. A
 * store manager holds neither, so the modal ended in "You do not have
 * permission to perform this action" for an employee they could see, could
 * edit, and whose Aadhaar badge they were entitled to read.
 *
 * ============================== WHAT MUST STAY TRUE =======================
 *
 * The fix must not become a widening. Half of this file pins what the new key
 * still does NOT grant: no sensitive write, no full Aadhaar, no employment
 * lifecycle, no company-wide reach, no re-verification of a VERIFIED Aadhaar,
 * and no change to the onboarding path or to the attach rule.
 *
 * NO REAL AADHAAR NUMBER OR OTP APPEARS IN THIS FILE, and none may appear in
 * anything the server logs - the last test asserts it against the real logger.
 */
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dnds-aadhaar-verify-"));
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

const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const bodyParser = require("body-parser");

const auth = require("./auth");
const buildPermissions = require("./permissions");
const buildSensitive = require("./sensitive");
const buildBranchScope = require("./employee_branch_scope");
const { branchRepo } = require("../test_support/employee_branch_scope");
const jwtService = require("../services/jwt");
const logger = require("../utils/logger");
const P = require("../constants/hr_permissions");

/* ------------------------------------------------------------- the world */

const KATHIRKAMAM = 1;
const MOOLAKULAM = 2;

const OWN_PENDING = 301;   // manager's branch, Aadhaar PENDING - the backlog case
const OWN_VERIFIED = 302;  // manager's branch, Aadhaar already VERIFIED
const OTHER_PENDING = 303; // ANOTHER branch, Aadhaar PENDING
const GHOST = 999;         // no such employee, anywhere

const EMPLOYEES = [
  { employee_id: 100, employee_name: "Hema HR", store_id: KATHIRKAMAM, status: 1 },
  { employee_id: 101, employee_name: "Selva Manager", store_id: KATHIRKAMAM, status: 1 },
  { employee_id: 102, employee_name: "Vino ViewOnly", store_id: KATHIRKAMAM, status: 1 },
  { employee_id: 105, employee_name: "Anu Admin", store_id: MOOLAKULAM, status: 1 },
  { employee_id: OWN_PENDING, employee_name: "Nila Kathirkamam", store_id: KATHIRKAMAM, status: 1 },
  { employee_id: OWN_VERIFIED, employee_name: "Kavi Kathirkamam", store_id: KATHIRKAMAM, status: 1 },
  { employee_id: OTHER_PENDING, employee_name: "Mohan Moolakulam", store_id: MOOLAKULAM, status: 1 },
];

/** Synthetic throughout. Nothing here is, or resembles, a real Aadhaar. */
const LAST4 = "0000";
const FAKE_AADHAAR = "000000000000";
const FAKE_OTP = "000000";

const D = { HR: 1, MANAGER: 2, VERIFIER: 3, ADMIN: 4, ONBOARDER: 5, SENSITIVE: 6, VERIFY_ONLY: 7 };

const GRANTS = {
  // HR, as the migrations leave it - company-wide, and granted the new key.
  [D.HR]: [
    P.VIEW_EMPLOYEES, P.EMPLOYEE_CREATE, P.EMPLOYEE_EDIT,
    P.VIEW_EMPLOYEE_LIFECYCLE, P.VIEW_EMPLOYEE_AADHAAR, P.VERIFY_EMPLOYEE_AADHAAR,
    P.EMPLOYEE_SCOPE_ALL_BRANCHES,
  ],
  // THE STORE MANAGER TODAY: can see the badge, can edit, CANNOT verify.
  [D.MANAGER]: [
    P.VIEW_EMPLOYEES, P.EMPLOYEE_EDIT, P.VIEW_EMPLOYEE_AADHAAR,
  ],
  // THE STORE MANAGER AFTER AN ADMINISTRATOR TICKS ONE BOX. Note what stays
  // absent and must stay absent: edit_employee_sensitive,
  // view_employee_sensitive, view_aadhaar_full, view_employee_lifecycle,
  // employee_scope_all_branches, employee_create.
  [D.VERIFIER]: [
    P.VIEW_EMPLOYEES, P.EMPLOYEE_EDIT, P.VIEW_EMPLOYEE_AADHAAR, P.VERIFY_EMPLOYEE_AADHAAR,
  ],
  // The onboarding designation, unchanged: what Add Employee has always
  // needed, and NOT the new key.
  [D.ONBOARDER]: [
    P.VIEW_EMPLOYEES, P.EMPLOYEE_CREATE, P.EMPLOYEE_EDIT, P.VIEW_EMPLOYEE_AADHAAR,
    P.EDIT_EMPLOYEE_SENSITIVE,
  ],
  // Holds the sensitive WRITE key but not the new one - for proving the two
  // are not substitutes in either direction.
  [D.SENSITIVE]: [
    P.VIEW_EMPLOYEES, P.EMPLOYEE_EDIT, P.VIEW_EMPLOYEE_AADHAAR,
    P.EDIT_EMPLOYEE_SENSITIVE, P.VIEW_EMPLOYEE_SENSITIVE,
  ],
  // The new key WITHOUT `employee_edit`: may run the check, may not attach
  // the result. That separation is what keeps the attach rule meaningful.
  [D.VERIFY_ONLY]: [
    P.VIEW_EMPLOYEES, P.VIEW_EMPLOYEE_AADHAAR, P.VERIFY_EMPLOYEE_AADHAAR,
  ],
  [D.ADMIN]: [],
};

/* ------------------------------------------------- the stub data layer  */

let calls;
const resetCalls = () => {
  calls = { initiate: [], verifyOtp: [], attach: [], reveal: [], edit: [], create: [] };
};
resetCalls();

const statusOf = (id) => {
  if (!EMPLOYEES.some((e) => e.employee_id === id)) {
    const err = new Error(`employee ${id} does not exist`);
    err.name = "NotFoundError";
    err.httpCode = 404;
    throw err;
  }
  return id === OWN_VERIFIED
    ? {
        employee_id: id, aadhaar_status: "VERIFIED", aadhaar_last4: LAST4,
        name_as_per_aadhaar: "KAVI K", verified_at: "2026-01-01T00:00:00Z",
        can_verify_now: false,
      }
    : {
        employee_id: id, aadhaar_status: "PENDING", aadhaar_last4: null,
        name_as_per_aadhaar: null, verified_at: null, can_verify_now: true,
        message: "No Aadhaar on record.",
      };
};

const usecase = {
  async getAadhaarStatus(employeeId) {
    return statusOf(Number(employeeId));
  },
  async attachAadhaar(employeeId, body, opts) {
    calls.attach.push({ employeeId: Number(employeeId), body, opts });
    return { code: 200, employee_id: Number(employeeId), aadhaar_status: "VERIFIED" };
  },
  async editEmployee(employeeId, body) {
    calls.edit.push({ employeeId: Number(employeeId), body });
    return { code: 200 };
  },
  async createEmployee(body) {
    calls.create.push({ body });
    return { code: 200, employee_id: 900 };
  },
  async getLifecycleHistory(employeeId) {
    return { code: 200, employee_id: Number(employeeId), periods: [], events: [] };
  },
  async findPossibleDuplicates() {
    return { code: 200, matches: [] };
  },
  async getReviewList() {
    return { code: 200, items: [] };
  },
};

const aadhaarUsecase = {
  async initiate(body, opts) {
    calls.initiate.push({ body, opts });
    return {
      code: 200, verification_token: "f".repeat(64), aadhaar_last4: LAST4,
      masked_aadhaar: "XXXX XXXX " + LAST4, status: "initiated",
    };
  },
  async verifyOtp(body, opts) {
    calls.verifyOtp.push({ body, opts });
    return { code: 200, verification_id: 55, aadhaar_last4: LAST4, next_action: "create" };
  },
  async revealFullNumber(employeeId, opts) {
    calls.reveal.push({ employeeId, opts });
    return { employee_id: employeeId, aadhaar_number: FAKE_AADHAAR, aadhaar_last4: LAST4 };
  },
  async getIdentity(employeeId) {
    return Number(employeeId) === OWN_VERIFIED ? { aadhaar_last4: LAST4 } : null;
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

  // THE REAL MOUNT ORDER, and it is load-bearing: the verification router goes
  // first because the master router mounts B3's `guardWrite` with
  // `router.use`, which runs for every request that enters it.
  delete require.cache[require.resolve("../routes/employee_aadhaar_verification")];
  delete require.cache[require.resolve("../routes/employee_master")];
  app.use(
    "/hr",
    require("../routes/employee_aadhaar_verification")(
      usecase, aadhaarUsecase, permissions, sensitive, branchScope
    ).getRouter()
  );
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
beforeEach(() => resetCalls());

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
  verifier: () => tokenFor(101, D.VERIFIER),
  onboarder: () => tokenFor(101, D.ONBOARDER),
  sensitive: () => tokenFor(101, D.SENSITIVE),
  verifyOnly: () => tokenFor(101, D.VERIFY_ONLY),
  admin: () => tokenFor(105, D.ADMIN, 2),
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

const ok = (res, what) =>
  assert.ok(
    res.status === 200 && res.body && res.body.code === 200,
    `${what}: expected success, got ${res.status} ${res.text.slice(0, 200)}`
  );
const refused = (res, what) =>
  assert.ok(
    res.status === 403 || (res.body && res.body.code === 403),
    `${what}: expected a refusal, got ${res.status} ${res.text.slice(0, 200)}`
  );

const initiateUrl = (id) => `/hr/employee/${id}/aadhaar/initiate`;
const otpUrl = (id) => `/hr/employee/${id}/aadhaar/verify-otp`;
const INITIATE_BODY = { aadhaar_number: FAKE_AADHAAR, consent_given: true };
const OTP_BODY = { verification_token: "f".repeat(64), otp: FAKE_OTP };

/* ===================================================================== */
/*  1-7. THE NEW PATH                                                    */
/* ===================================================================== */

describe("the existing-employee verification path", () => {
  it("1. own-branch holder of verify_employee_aadhaar can INITIATE for a PENDING employee", async () => {
    const res = await post(initiateUrl(OWN_PENDING), CALLERS.verifier(), INITIATE_BODY);
    ok(res, "initiate in own branch");
    assert.equal(calls.initiate.length, 1, "the provider call was reached exactly once");
    assert.equal(calls.initiate[0].opts.actorEmployeeId, 101, "the actor is recorded for consent");
    // What comes back is a token and the last four; never the number.
    assert.equal(res.body.aadhaar_last4, LAST4);
    assert.ok(!JSON.stringify(res.body).includes(FAKE_AADHAAR), "the number never comes back");
  });

  it("2. the SAME user without the key is refused, and the provider is never called", async () => {
    const res = await post(initiateUrl(OWN_PENDING), CALLERS.manager(), INITIATE_BODY);
    refused(res, "initiate without verify_employee_aadhaar");
    assert.equal(calls.initiate.length, 0, "authorization runs BEFORE the provider call");
  });

  it("3. a holder cannot initiate for an employee in ANOTHER branch", async () => {
    const res = await post(initiateUrl(OTHER_PENDING), CALLERS.verifier(), INITIATE_BODY);
    refused(res, "initiate out of branch");
    assert.equal(calls.initiate.length, 0);
  });

  it("4. a non-existent target is refused exactly as an out-of-branch one - no leak", async () => {
    const ghost = await post(initiateUrl(GHOST), CALLERS.verifier(), INITIATE_BODY);
    const other = await post(initiateUrl(OTHER_PENDING), CALLERS.verifier(), INITIATE_BODY);
    refused(ghost, "initiate for a non-existent employee");
    assert.equal(ghost.status, other.status, "same status");
    assert.deepEqual(ghost.body, other.body, "and the same body, so existence cannot be probed");
    assert.ok(!ghost.text.toLowerCase().includes("does not exist"));
  });

  it("5. an ALREADY VERIFIED Aadhaar cannot be re-verified or replaced", async () => {
    for (const [what, res] of [
      ["initiate", await post(initiateUrl(OWN_VERIFIED), CALLERS.verifier(), INITIATE_BODY)],
      ["verify-otp", await post(otpUrl(OWN_VERIFIED), CALLERS.verifier(), OTP_BODY)],
      // Not even HR or an administrator: this path is PENDING-only by design.
      ["initiate as HR", await post(initiateUrl(OWN_VERIFIED), CALLERS.hr(), INITIATE_BODY)],
      ["initiate as admin", await post(initiateUrl(OWN_VERIFIED), CALLERS.admin(), INITIATE_BODY)],
    ]) {
      assert.equal(res.body && res.body.code, 409, `${what} on a VERIFIED employee must be refused`);
    }
    assert.equal(calls.initiate.length, 0, "no provider call for a verified employee");
    assert.equal(calls.verifyOtp.length, 0);
  });

  it("6. the OTP step requires the SAME narrow permission, branch and state", async () => {
    ok(await post(otpUrl(OWN_PENDING), CALLERS.verifier(), OTP_BODY), "otp in own branch");
    assert.equal(calls.verifyOtp.length, 1);

    refused(await post(otpUrl(OWN_PENDING), CALLERS.manager(), OTP_BODY), "otp without the key");
    refused(await post(otpUrl(OTHER_PENDING), CALLERS.verifier(), OTP_BODY), "otp out of branch");
    assert.equal(calls.verifyOtp.length, 1, "neither refusal reached the provider");
  });

  it("7. edit_employee_sensitive is NOT required - and is NOT a substitute", async () => {
    // The whole point. The verifier holds no B3 write key and succeeds...
    ok(await post(initiateUrl(OWN_PENDING), CALLERS.verifier(), INITIATE_BODY), "no B3 key needed");
    // ...and holding B3's write key without the new one does NOT let you in.
    refused(
      await post(initiateUrl(OWN_PENDING), CALLERS.sensitive(), INITIATE_BODY),
      "edit_employee_sensitive is not a way in"
    );
  });
});

/* ===================================================================== */
/*  8-11. WHAT THE KEY STILL DOES NOT GRANT                              */
/* ===================================================================== */

describe("the new key grants nothing else", () => {
  it("8. it grants no bank / PAN / PF / ESI sensitive write", async () => {
    // B3 is untouched everywhere else: an ordinary employee edit carrying a
    // sensitive field is still refused for this caller.
    for (const body of [
      { employee_id: OWN_PENDING, account_no: "1234" },
      { employee_id: OWN_PENDING, pan_no: "AAAAA0000A" },
      { employee_id: OWN_PENDING, pf_number: "PF1" },
      { employee_id: OWN_PENDING, esi_number: "ESI1" },
      { employee_id: OWN_PENDING, salary: 1 },
      // And the Aadhaar number itself, on the ordinary edit route.
      { employee_id: OWN_PENDING, aadhaar_number: FAKE_AADHAAR },
    ]) {
      const res = await post(`/hr/employee/${OWN_PENDING}`, CALLERS.verifier(), body);
      refused(res, `sensitive edit ${Object.keys(body)[1]}`);
    }
    assert.equal(calls.edit.length, 0, "no sensitive write ever reached the usecase");
  });

  it("9. it grants no full-Aadhaar read", async () => {
    refused(
      await get(`/hr/employee/${OWN_VERIFIED}/aadhaar/full`, CALLERS.verifier()),
      "the twelve digits"
    );
    assert.equal(calls.reveal.length, 0, "the decrypt path is never reached");
  });

  it("10. it grants no employment lifecycle", async () => {
    refused(
      await get(`/hr/employee/${OWN_PENDING}/lifecycle`, CALLERS.verifier()),
      "employment history"
    );
  });

  it("11. it grants no company-wide employee scope", async () => {
    // The branch scope is unchanged by the key: another branch stays refused
    // on every surface, not only on the new one.
    refused(await post(initiateUrl(OTHER_PENDING), CALLERS.verifier(), INITIATE_BODY), "verify");
    refused(await get(`/hr/employee/${OTHER_PENDING}/aadhaar`, CALLERS.verifier()), "status read");
    // HR, which holds employee_scope_all_branches, is company-wide as before.
    ok(await post(initiateUrl(OTHER_PENDING), CALLERS.hr(), INITIATE_BODY), "HR is unchanged");
  });
});

/* ===================================================================== */
/*  12-13. WHAT WAS ALREADY WORKING STILL WORKS                          */
/* ===================================================================== */

describe("the existing paths are untouched", () => {
  it("12. new-employee onboarding still verifies under its EXISTING authorization", async () => {
    // The onboarding designation - employee_create + edit_employee_sensitive,
    // and NOT the new key - still reaches the onboarding endpoints.
    ok(await post("/hr/aadhaar/initiate", CALLERS.onboarder(), INITIATE_BODY), "onboarding initiate");
    ok(await post("/hr/aadhaar/verify-otp", CALLERS.onboarder(), OTP_BODY), "onboarding verify-otp");
    assert.equal(calls.initiate.length, 1);

    // And its rules have not been relaxed: without edit_employee_sensitive,
    // B3 still refuses the onboarding body, exactly as before this change -
    // holding the NEW key does not open the OLD path.
    refused(
      await post("/hr/aadhaar/initiate", CALLERS.verifier(), INITIATE_BODY),
      "the onboarding path still needs its own keys"
    );
  });

  it("13. attach remains branch-scoped and keeps employee_edit, under B3", async () => {
    ok(
      await post(`/hr/employee/${OWN_PENDING}/aadhaar/attach`, CALLERS.verifier(), {
        aadhaar_verification_id: 55,
      }),
      "attach with employee_edit in own branch"
    );
    assert.equal(calls.attach.length, 1);

    refused(
      await post(`/hr/employee/${OTHER_PENDING}/aadhaar/attach`, CALLERS.verifier(), {
        aadhaar_verification_id: 55,
      }),
      "attach out of branch"
    );
    // A designation holding the new key but NOT `employee_edit` may run the
    // verification and may not attach its result: the write rule is preserved
    // exactly as it was, and the new key is no substitute for it.
    ok(await post(initiateUrl(OWN_PENDING), CALLERS.verifyOnly(), INITIATE_BODY), "may verify");
    refused(
      await post(`/hr/employee/${OWN_PENDING}/aadhaar/attach`, CALLERS.verifyOnly(), {
        aadhaar_verification_id: 55,
      }),
      "attach without employee_edit"
    );
    assert.equal(calls.attach.length, 1, "nothing else attached");
  });
});

/* ===================================================================== */
/*  14. NOTHING SECRET IS LOGGED                                          */
/* ===================================================================== */

describe("audit and logging", () => {
  it("14. no full Aadhaar, OTP, ciphertext or fingerprint reaches the log", async () => {
    const written = [];
    const original = logger.Log;
    logger.Log = (entry) => {
      written.push(JSON.stringify(entry));
      return undefined;
    };
    try {
      await post(initiateUrl(OWN_PENDING), CALLERS.verifier(), INITIATE_BODY);
      await post(otpUrl(OWN_PENDING), CALLERS.verifier(), OTP_BODY);
      refused(await post(initiateUrl(OTHER_PENDING), CALLERS.verifier(), INITIATE_BODY), "refusal");
    } finally {
      logger.Log = original;
    }
    const all = written.join("\n");
    for (const secret of [FAKE_AADHAAR, FAKE_OTP, "ciphertext", "fingerprint"]) {
      assert.ok(!all.includes(secret), `${secret} must never be logged`);
    }
  });

  it("the route file carries no Aadhaar-bearing log line of its own", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "../routes/employee_aadhaar_verification.js"),
      "utf8"
    );
    // The only thing it may pass on is the body it validated, to the usecase.
    assert.ok(!/console\.log\(\s*req\.body/.test(src), "the body must never be printed");
    assert.ok(!/logger\.Log/.test(src), "logging here would risk the number; the usecase does it");
  });
});
