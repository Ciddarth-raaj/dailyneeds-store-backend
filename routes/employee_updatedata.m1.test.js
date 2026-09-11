/**
 * M1 review fix — what /employee/updatedata accepts, and who may send it.
 *
 *   node --test routes/employee_updatedata.m1.test.js
 *
 * Real Express, the real auth middleware, the real permissions middleware and
 * the real B3 sensitive middleware over a stub usecase that records what
 * reached it — the same shape as `middlewares/hr_sensitive_fields.b3.test.js`,
 * because the three things under test here are all decided by the wiring
 * rather than by any one function:
 *
 *   1 SALARY IS NOT WRITABLE HERE. Removed from the Joi schema, which runs
 *     without `allowUnknown`, so a body naming it is refused. The assertion
 *     that matters is that NOTHING reached the usecase — a 422 that still
 *     wrote the column would be the bug this is guarding against.
 *
 *   2 ADD EMPLOYEE IS NOT REQUIRED FOR THE POST-ONBOARDING SECTIONS. Add
 *     Employee covers onboarding screens 1-4 and stops at Education. Payment
 *     Details is the sensitive pair plus `edit_payment_details`; Statutory
 *     Details is the sensitive pair plus `edit_statutory_details`. Neither
 *     key opens the other, and the legacy route keeps `add_employees` for
 *     everything else it has always carried.
 *
 * The negative half is the half worth having: a designation that may edit one
 * section must still be refused the other, and must still be refused the
 * ordinary columns that only Add Employee opens.
 */
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dnds-m1-updatedata-"));
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
const auth = require("../middlewares/auth");
const buildPermissions = require("../middlewares/permissions");
const buildSensitive = require("../middlewares/sensitive");
const jwtService = require("../services/jwt");
const P = require("../constants/hr_permissions");

const USER_ID = 7;
const EMPLOYEE_ID = 1003;

/**
 * The designations, and what each holds. The two section designations are the
 * point of the exercise: they hold the sensitive pair and ONE section key,
 * and deliberately NOT `add_employees`.
 */
const PAYMENT_ONLY = 21;
const STATUTORY_ONLY = 22;
const BOTH_SECTIONS = 23;
const LEGACY_ADD = 24; // add_employees + sensitive, no section keys
const NO_KEYS = 29;

const SENSITIVE_PAIR = [P.VIEW_EMPLOYEE_SENSITIVE, P.EDIT_EMPLOYEE_SENSITIVE];

const grantsFor = (designation_id, keys) =>
  keys.map((permission_key) => ({ designation_id, permission_key, is_active: 1 }));

const GRANTS = [
  ...grantsFor(PAYMENT_ONLY, [...SENSITIVE_PAIR, P.EDIT_PAYMENT_DETAILS, P.VIEW_EMPLOYEES]),
  ...grantsFor(STATUTORY_ONLY, [...SENSITIVE_PAIR, P.EDIT_STATUTORY_DETAILS, P.VIEW_EMPLOYEES]),
  ...grantsFor(BOTH_SECTIONS, [
    ...SENSITIVE_PAIR,
    P.EDIT_PAYMENT_DETAILS,
    P.EDIT_STATUTORY_DETAILS,
    P.VIEW_EMPLOYEES,
  ]),
  ...grantsFor(LEGACY_ADD, [...SENSITIVE_PAIR, P.ADD_EMPLOYEES, P.VIEW_EMPLOYEES]),
];

const designationUsecase = {
  getPermissionById: async (designationId) =>
    GRANTS.filter((g) => g.designation_id === Number(designationId)).map((g) => ({
      permission_key: g.permission_key,
    })),
};

/** What reached the usecase, or undefined when nothing did. */
let lastWrite;
const employeeUsecase = new Proxy(
  {},
  {
    get: (_t, name) => async (arg) => {
      if (name === "updateEmployeeDetails") {
        lastWrite = arg;
        return 200;
      }
      return [];
    },
  }
);

const sessionState = {
  user_id: USER_ID,
  employee_id: EMPLOYEE_ID,
  status: 1,
  token_valid_from: null,
  must_change_password: 0,
  is_system_account: 0,
  employee_status: 1,
};

let server;
let port;
let permissions;

before(async () => {
  permissions = buildPermissions(designationUsecase);
  const sensitive = buildSensitive(permissions);

  const app = express();
  app.use(bodyParser.json());
  app.use(auth.create({ userUsecase: { getSessionState: async () => sessionState } }));

  delete require.cache[require.resolve("./employee")];
  const routes = require("./employee")(employeeUsecase, permissions, sensitive);
  app.use("/employee", routes.getRouter());

  server = await new Promise((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  port = server.address().port;
});

after(() => server && server.close());

const tokenFor = ({ userType = 1, designationId = NO_KEYS } = {}) =>
  jwtService.sign(
    {
      auth_ver: 2,
      sub: String(USER_ID),
      id: USER_ID,
      employee_id: EMPLOYEE_ID,
      user_type: userType,
      designation_id: designationId,
      store_id: 2,
    },
    "1d"
  );

/** POST a body of employee_details and report what came back and what stuck. */
const save = async (token, employee_details) => {
  lastWrite = undefined;
  const res = await fetch(`http://127.0.0.1:${port}/employee/updatedata`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-access-token": await token },
    body: JSON.stringify({ employee_id: EMPLOYEE_ID, employee_details }),
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch (e) {}
  return { status: res.status, body, text, wrote: lastWrite };
};

/** The middleware's refusal — the route gate, i.e. `add_employees`. */
const isRouteRefusal = (r) =>
  r.status === 403 &&
  r.body &&
  r.body.code === 403 &&
  r.body.msg === "You do not have permission to perform this action";

/** The handler's refusal — a section key the caller does not hold. */
const isSectionRefusal = (r) =>
  r.status === 403 &&
  r.body &&
  r.body.code === 403 &&
  /change these employee details/.test(r.body.msg || "");

/** Joi refused the body: code 422, and the write never happened. */
const isValidationRefusal = (r) => r.body && r.body.code === 422;

const PAYMENT_BODY = { payment_type: 1, bank_name: "Test Bank", ifsc: "TEST0001234", account_no: "12345" };
const STATUTORY_BODY = { pan_no: "ABCDE1234F", pf_number: "PF-9", pf_applicable: 1 };

const AS = (designationId) => tokenFor({ designationId });
const ADMIN = () => tokenFor({ userType: 2, designationId: NO_KEYS });

/* ------------------------------------------------ 1. salary is not writable */

describe("M1 review fix 1 — salary cannot be written through the legacy Employee Master route", () => {
  it("a body naming salary is REFUSED and nothing reaches the usecase", async () => {
    // The caller holds every key that could possibly matter, so a refusal
    // here can only be the schema — not a missing permission.
    const r = await save(ADMIN(), { salary: 45000 });
    assert.ok(isValidationRefusal(r), `expected 422, got ${r.text}`);
    assert.equal(r.wrote, undefined, "salary must never reach updateEmployeeDetails");
  });

  it("salary cannot ride along beside fields that ARE accepted", async () => {
    // The route refuses a body as a whole; a partially applied write that
    // silently dropped salary would be the worse outcome, because the screen
    // would report success.
    const r = await save(ADMIN(), { ...PAYMENT_BODY, salary: 45000 });
    assert.ok(isValidationRefusal(r), `expected 422, got ${r.text}`);
    assert.equal(r.wrote, undefined, "the whole body is refused, not trimmed");
  });

  it("every spelling of salary is unknown to the schema", async () => {
    for (const details of [{ salary: "45000" }, { salary: null }, { salary: "" }]) {
      const r = await save(ADMIN(), details);
      assert.ok(isValidationRefusal(r), `${JSON.stringify(details)} should be refused`);
      assert.equal(r.wrote, undefined);
    }
  });

  it("the schema does not mention salary at all", () => {
    const src = fs.readFileSync(require.resolve("./employee"), "utf8");
    const route = src.slice(src.indexOf('router.post("/updatedata"'), src.indexOf('router.post("/sync"'));
    assert.ok(
      !/^\s*salary:\s*Joi\./m.test(route),
      "salary must not be a writable key in the updatedata schema"
    );
  });

  it("the rest of the legacy body still validates, so the route stays compatible", async () => {
    const r = await save(AS(LEGACY_ADD), { employee_name: "Renamed", uniform_qty: 2 });
    assert.equal(r.body && r.body.code, 200, r.text);
    assert.ok(r.wrote, "an ordinary edit still reaches the usecase");
    assert.equal(r.wrote.employee_details.employee_name, "Renamed");
  });
});

/* ------------------------------- 2. the sections do not require Add Employee */

describe("M1 review fix 2 — Payment / Statutory Details do not require Add Employee", () => {
  it("sensitive + edit_payment_details saves Payment Details WITHOUT add_employees", async () => {
    const r = await save(AS(PAYMENT_ONLY), PAYMENT_BODY);
    assert.equal(r.body && r.body.code, 200, `expected the save to succeed, got ${r.text}`);
    assert.deepEqual(r.wrote.employee_details, PAYMENT_BODY);
  });

  it("sensitive + edit_statutory_details saves Statutory Details WITHOUT add_employees", async () => {
    const r = await save(AS(STATUTORY_ONLY), STATUTORY_BODY);
    assert.equal(r.body && r.body.code, 200, `expected the save to succeed, got ${r.text}`);
    assert.deepEqual(r.wrote.employee_details, STATUTORY_BODY);
  });

  it("one section key does NOT open the other", async () => {
    const payment = await save(AS(PAYMENT_ONLY), STATUTORY_BODY);
    assert.ok(isSectionRefusal(payment), `expected a section refusal, got ${payment.text}`);
    assert.deepEqual(payment.body.required_permissions, [P.EDIT_STATUTORY_DETAILS]);
    assert.equal(payment.wrote, undefined);

    const statutory = await save(AS(STATUTORY_ONLY), PAYMENT_BODY);
    assert.ok(isSectionRefusal(statutory), `expected a section refusal, got ${statutory.text}`);
    assert.deepEqual(statutory.body.required_permissions, [P.EDIT_PAYMENT_DETAILS]);
    assert.equal(statutory.wrote, undefined);
  });

  it("a body naming both sections demands BOTH keys (AND, not OR)", async () => {
    const one = await save(AS(PAYMENT_ONLY), { ...PAYMENT_BODY, ...STATUTORY_BODY });
    assert.ok(isSectionRefusal(one), `holding one key must not pass a two-section body: ${one.text}`);
    assert.equal(one.wrote, undefined);

    const both = await save(AS(BOTH_SECTIONS), { ...PAYMENT_BODY, ...STATUTORY_BODY });
    assert.equal(both.body && both.body.code, 200, both.text);
    assert.ok(both.wrote);
  });

  it("the section keys do NOT become a way to edit ordinary columns", async () => {
    // The relaxation is scoped to the two sections. Anything Add Employee has
    // always gated stays gated, which is what keeps the legacy route intact.
    const r = await save(AS(BOTH_SECTIONS), { employee_name: "Renamed" });
    assert.ok(isRouteRefusal(r), `expected the route gate to refuse, got ${r.text}`);
    assert.equal(r.wrote, undefined);
  });

  it("an ordinary column mixed into a section body still demands add_employees", async () => {
    // The escape hatch that would matter: smuggling a name change through a
    // Payment Details save.
    const r = await save(AS(PAYMENT_ONLY), { ...PAYMENT_BODY, employee_name: "Renamed" });
    assert.ok(isRouteRefusal(r), `expected the route gate to refuse, got ${r.text}`);
    assert.equal(r.wrote, undefined);
  });

  it("documents and files still demand add_employees", async () => {
    const r = await save(AS(BOTH_SECTIONS), {
      ...PAYMENT_BODY,
      docupdate: [{ card_type: "1", card_no: "111122223333" }],
    });
    assert.ok(isRouteRefusal(r), `expected the route gate to refuse, got ${r.text}`);
    assert.equal(r.wrote, undefined);
  });

  it("add_employees WITHOUT the section key still cannot write the sections", async () => {
    // The change removed a requirement; it added no bypass. A legacy
    // designation is exactly as able to write these columns as M1 left it.
    const r = await save(AS(LEGACY_ADD), PAYMENT_BODY);
    assert.ok(isSectionRefusal(r), `expected a section refusal, got ${r.text}`);
    assert.deepEqual(r.body.required_permissions, [P.EDIT_PAYMENT_DETAILS]);
    assert.equal(r.wrote, undefined);
  });

  it("B3 still refuses a section body from a caller without edit_employee_sensitive", async () => {
    // Every column in both sections is sensitive, so `guardWrite` is the
    // first thing that answers — before the route gate and before the
    // handler's section check.
    const r = await save(AS(NO_KEYS), PAYMENT_BODY);
    assert.equal(r.status, 403);
    assert.equal(r.wrote, undefined);
  });

  it("a caller with nothing at all is still refused", async () => {
    const r = await save(AS(NO_KEYS), { employee_name: "Renamed" });
    assert.equal(r.status, 403);
    assert.equal(r.wrote, undefined);
  });

  it("admin bypass is unchanged — both sections, no grants needed", async () => {
    const r = await save(ADMIN(), { ...PAYMENT_BODY, ...STATUTORY_BODY });
    assert.equal(r.body && r.body.code, 200, r.text);
    assert.ok(r.wrote);
  });
});

/* ------------------------------ M2. Existing / Previous PF Member ---------- */

describe("M2 — Previous PF Member is a Statutory Details field", () => {
  it("is accepted by the schema in all three states", async () => {
    // Tri-state, and the third state is not cosmetic: `null` means "nobody has
    // said", and the engine reports an unrecorded membership as UNRESOLVED
    // rather than picking a side. A schema that refused null would force HR to
    // record 0 - a filed statutory position nobody took.
    for (const value of [1, 0, null]) {
      const r = await save(ADMIN(), { previous_pf_member: value });
      assert.equal(r.body && r.body.code, 200, `previous_pf_member=${value}: ${r.text}`);
      assert.equal(r.wrote.employee_details.previous_pf_member, value);
    }
  });

  it("is governed by the EXISTING statutory right, not a new key", async () => {
    const r = await save(AS(STATUTORY_ONLY), { previous_pf_member: 1 });
    assert.equal(r.body && r.body.code, 200, r.text);
    assert.ok(r.wrote);
  });

  it("Payment Details rights do not open it", async () => {
    const r = await save(AS(PAYMENT_ONLY), { previous_pf_member: 1 });
    assert.ok(isSectionRefusal(r), `expected a section refusal, got ${r.text}`);
    assert.deepEqual(r.body.required_permissions, [P.EDIT_STATUTORY_DETAILS]);
    assert.equal(r.wrote, undefined);
  });

  it("is SENSITIVE under B3 — a caller without the sensitive pair is refused", async () => {
    const r = await save(AS(NO_KEYS), { previous_pf_member: 1 });
    assert.equal(r.status, 403);
    assert.equal(r.wrote, undefined);
  });

  it("a legacy add_employees designation cannot write it", async () => {
    const r = await save(AS(LEGACY_ADD), { previous_pf_member: 1 });
    assert.ok(isSectionRefusal(r), `expected a section refusal, got ${r.text}`);
    assert.equal(r.wrote, undefined);
  });

  it("out-of-range values are refused", async () => {
    for (const value of [2, -1, "yes"]) {
      const r = await save(ADMIN(), { previous_pf_member: value });
      assert.ok(isValidationRefusal(r), `previous_pf_member=${value} must be refused: ${r.text}`);
      assert.equal(r.wrote, undefined);
    }
  });

  it("is NOT the legacy `pf` column — both can be sent and stay distinct", async () => {
    // The approved rule is explicit that `pf` must not be reused for this.
    const r = await save(ADMIN(), { pf: "legacy text", previous_pf_member: 0 });
    assert.equal(r.body && r.body.code, 200, r.text);
    assert.equal(r.wrote.employee_details.pf, "legacy text");
    assert.equal(r.wrote.employee_details.previous_pf_member, 0);
  });

  it("SALARY IS STILL NOT WRITABLE ALONGSIDE IT", async () => {
    // M2 added a statutory field to this route; it must not have reopened the
    // salary column while doing so.
    const r = await save(ADMIN(), { previous_pf_member: 1, salary: 45000 });
    assert.ok(isValidationRefusal(r), `expected 422, got ${r.text}`);
    assert.equal(r.wrote, undefined, "salary must never reach updateEmployeeDetails");
  });
});

/* ----------------------------- M2. Existing / Previous EPS Member ---------- */

/*
 * The review fix. The pension question is asked and stored separately from the
 * provident-fund one, because Form 11 asks it separately and the two answers
 * differ. Same section, same existing right, its own column.
 */
describe("M2 — Previous EPS Member is its own Statutory Details field", () => {
  it("is accepted by the schema in all three states", async () => {
    for (const value of [1, 0, null]) {
      const r = await save(ADMIN(), { previous_eps_member: value });
      assert.equal(r.body && r.body.code, 200, `previous_eps_member=${value}: ${r.text}`);
      assert.equal(r.wrote.employee_details.previous_eps_member, value);
    }
  });

  it("is governed by the EXISTING statutory right, not a new key", async () => {
    const r = await save(AS(STATUTORY_ONLY), { previous_eps_member: 1 });
    assert.equal(r.body && r.body.code, 200, r.text);
    assert.ok(r.wrote);
  });

  it("Payment Details rights do not open it", async () => {
    const r = await save(AS(PAYMENT_ONLY), { previous_eps_member: 1 });
    assert.ok(isSectionRefusal(r), `expected a section refusal, got ${r.text}`);
    assert.deepEqual(r.body.required_permissions, [P.EDIT_STATUTORY_DETAILS]);
    assert.equal(r.wrote, undefined);
  });

  it("is SENSITIVE under B3 — a caller without the sensitive pair is refused", async () => {
    const r = await save(AS(NO_KEYS), { previous_eps_member: 1 });
    assert.equal(r.status, 403);
    assert.equal(r.wrote, undefined);
  });

  it("out-of-range values are refused", async () => {
    for (const value of [2, -1, "yes"]) {
      const r = await save(ADMIN(), { previous_eps_member: value });
      assert.ok(isValidationRefusal(r), `previous_eps_member=${value} must be refused: ${r.text}`);
      assert.equal(r.wrote, undefined);
    }
  });

  it("TRAVELS SEPARATELY FROM THE PF FACT — one can be Yes while the other is No", async () => {
    // The whole point. Somebody may have been in a previous employer's EPF
    // without ever having been in EPS, and the route must be able to record
    // exactly that rather than collapsing it to one answer.
    const r = await save(ADMIN(), { previous_pf_member: 1, previous_eps_member: 0 });
    assert.equal(r.body && r.body.code, 200, r.text);
    assert.equal(r.wrote.employee_details.previous_pf_member, 1);
    assert.equal(r.wrote.employee_details.previous_eps_member, 0);
  });

  it("is NOT the legacy `pf` column either", async () => {
    const r = await save(ADMIN(), { pf: "legacy text", previous_eps_member: 1 });
    assert.equal(r.body && r.body.code, 200, r.text);
    assert.equal(r.wrote.employee_details.pf, "legacy text");
    assert.equal(r.wrote.employee_details.previous_eps_member, 1);
  });

  it("SALARY IS STILL NOT WRITABLE ALONGSIDE IT", async () => {
    const r = await save(ADMIN(), { previous_eps_member: 1, salary: 45000 });
    assert.ok(isValidationRefusal(r), `expected 422, got ${r.text}`);
    assert.equal(r.wrote, undefined, "salary must never reach updateEmployeeDetails");
  });
});
