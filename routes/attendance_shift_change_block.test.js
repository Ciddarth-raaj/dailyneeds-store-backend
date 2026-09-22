/**
 * THE HR SHIFT CHANGE BLOCK API - AUTHORIZATION, over a real Express server.
 *
 *   node --test routes/attendance_shift_change_block.test.js
 *
 * This is a WRITE endpoint on somebody's eligibility, so the questions that
 * matter are who may call it and whose employees they may touch. A real `jwt`
 * and the real `auth`, `permissions` and `employee_branch_scope` middleware
 * are used; only the usecase is a stub, because what is under test is the
 * gate and the actor/scope it hands over - not the block rule, which
 * `usecase/attendance_shift_change_block.test.js` covers against the real
 * regularization usecase.
 */

const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dnds-scb-"));
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
const jwtService = require("../services/jwt");
const P = require("../constants/hr_permissions");
const { buildScopeFor } = require("../test_support/employee_branch_scope");
const { EMPLOYEE_BRANCH_SCOPE } = require("../utils/employee_branch_scope");

const USER_ID = 7;
const MOOLAKULAM = 1;
const ECR = 2;

/**
 *   HR_MANAGER    the WRITE key, company-wide branches.
 *   STORE_MANAGER the WRITE key, own branch only.
 *   REPORT_READER the report's READ key and NOT the write key - the split
 *                 this feature exists to make, so it is asserted.
 *   NOBODY        nothing at all.
 *   ADMIN         user_type 2, no explicit grants: the existing bypass.
 */
const HR_MANAGER = { designation: 31, employee: 901, store: MOOLAKULAM };
const STORE_MANAGER = { designation: 32, employee: 902, store: MOOLAKULAM };
const REPORT_READER = { designation: 33, employee: 903, store: MOOLAKULAM };
const NOBODY = { designation: 34, employee: 904, store: MOOLAKULAM };
const ADMIN = { designation: 35, employee: 905, store: MOOLAKULAM };

const TARGET_OWN = 42; // in MOOLAKULAM
const TARGET_OTHER = 55; // in ECR

const GRANTS = {
  [HR_MANAGER.designation]: [
    P.MANAGE_SHIFT_CHANGE_ELIGIBILITY,
    P.EMPLOYEE_SCOPE_ALL_BRANCHES,
  ],
  [STORE_MANAGER.designation]: [P.MANAGE_SHIFT_CHANGE_ELIGIBILITY],
  [REPORT_READER.designation]: [
    P.VIEW_SHIFT_CHANGE_ELIGIBILITY_REPORT,
    P.EXPORT_SHIFT_CHANGE_ELIGIBILITY_REPORT,
    P.EMPLOYEE_SCOPE_ALL_BRANCHES,
  ],
  [NOBODY.designation]: [],
  [ADMIN.designation]: [],
};

const EMPLOYEES = [
  { employee_id: HR_MANAGER.employee, store_id: MOOLAKULAM, status: 1 },
  { employee_id: STORE_MANAGER.employee, store_id: MOOLAKULAM, status: 1 },
  { employee_id: REPORT_READER.employee, store_id: MOOLAKULAM, status: 1 },
  { employee_id: NOBODY.employee, store_id: MOOLAKULAM, status: 1 },
  { employee_id: ADMIN.employee, store_id: MOOLAKULAM, status: 1 },
  { employee_id: TARGET_OWN, store_id: MOOLAKULAM, status: 1 },
  { employee_id: TARGET_OTHER, store_id: ECR, status: 1 },
];

/** What the usecase was handed, so a scope test can inspect it. */
const seen = { block: null, unblock: null, history: null };
const usecase = {
  blockDate: async (args) => {
    seen.block = args;
    return { blocked: true, employee_id: args.employee_id, attendance_date: args.attendance_date };
  },
  unblockDate: async (args) => {
    seen.unblock = args;
    return { blocked: false, employee_id: args.employee_id, attendance_date: args.attendance_date };
  },
  history: async (args) => {
    seen.history = args;
    return { employee_id: args.employee_id, attendance_date: args.attendance_date, history: [] };
  },
};

const sessionFor = (who) => ({
  user_id: USER_ID,
  employee_id: who.employee,
  status: 1,
  token_valid_from: null,
  must_change_password: 0,
  is_system_account: 0,
  employee_status: 1,
});

let server;
let port;
let router;
let current = HR_MANAGER;

before(async () => {
  const permissions = buildPermissions({
    getPermissionById: async (designationId) =>
      (GRANTS[designationId] || []).map((permission_key) => ({ permission_key, is_active: 1 })),
  });

  const app = express();
  app.use(bodyParser.json());
  app.use(
    auth.create({ userUsecase: { getSessionState: async () => sessionFor(current) } })
  );
  delete require.cache[require.resolve("./attendance_shift_change_block")];
  const branchScope = buildScopeFor(permissions, EMPLOYEES);
  const routes = require("./attendance_shift_change_block")(usecase, permissions, null, branchScope);
  router = routes.getRouter();
  app.use("/", router);

  server = await new Promise((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  port = server.address().port;
});

after(() => server && server.close());

const tokenFor = (who, { userType = 1, expiry = "1d" } = {}) =>
  jwtService.sign(
    {
      auth_ver: 2,
      sub: String(USER_ID),
      id: USER_ID,
      employee_id: who.employee,
      user_type: userType,
      designation_id: who.designation,
      // The token claims a branch the actor is NOT in, deliberately: the
      // resolver must go to the database and ignore this.
      store_id: ECR,
    },
    expiry
  );

const call = async (method, p, who, body) => {
  current = who || HR_MANAGER;
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(who ? { "x-access-token": await tokenFor(who, who.opts || {}) } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    parsed = { raw: text };
  }
  return { status: res.status, body: parsed };
};

const assertRefused = (res, what) => {
  assert.ok(
    res.body && (res.body.code === 401 || res.body.code === 403),
    `${what}: expected a 401/403 refusal, got HTTP ${res.status} ${JSON.stringify(res.body).slice(0, 160)}`
  );
  assert.notEqual(res.body.code, 200, `${what}: must not answer with data`);
};

const BLOCK = "/attendance/shift-change-eligibility/block";
const UNBLOCK = `${BLOCK}/remove`;
const body = (employee_id = TARGET_OWN) => ({
  employee_id,
  attendance_date: "2026-09-18",
  reason: "Punch timing is incorrect",
});
const removeBody = (employee_id = TARGET_OWN) => ({
  employee_id,
  attendance_date: "2026-09-18",
  removal_reason: "Punch corrected after review",
});

describe("the write key gates both actions", () => {
  it("declares only the routes this feature needs", () => {
    const declared = router.stack
      .filter((layer) => layer.route)
      .map((layer) => ({ path: layer.route.path, methods: Object.keys(layer.route.methods) }));
    assert.deepEqual(
      declared.map((r) => `${r.methods[0].toUpperCase()} ${r.path}`).sort(),
      [
        `GET ${BLOCK}/history`,
        `POST ${BLOCK}`,
        `POST ${UNBLOCK}`,
      ].sort()
    );
  });

  it("refuses a signed-out caller", async () => {
    assertRefused(await call("POST", BLOCK, null, body()), "block, signed out");
    assertRefused(await call("POST", UNBLOCK, null, removeBody()), "unblock, signed out");
  });

  it("11. refuses a caller without manage_shift_change_eligibility", async () => {
    assertRefused(await call("POST", BLOCK, NOBODY, body()), "block, no grants");
    assertRefused(await call("POST", UNBLOCK, NOBODY, removeBody()), "unblock, no grants");
  });

  it("11b. the REPORT's read key grants nothing here - the split is real", async () => {
    assertRefused(
      await call("POST", BLOCK, REPORT_READER, body()),
      "block with only the report read key"
    );
    assertRefused(
      await call("POST", UNBLOCK, REPORT_READER, removeBody()),
      "unblock with only the report read key"
    );
  });

  it("answers a caller holding the write key", async () => {
    const res = await call("POST", BLOCK, HR_MANAGER, body());
    assert.equal(res.body.code, 200);
    assert.equal(seen.block.employee_id, TARGET_OWN);
  });

  it("12. the administrator bypass still works, with no explicit grant", async () => {
    const res = await call("POST", BLOCK, { ...ADMIN, opts: { userType: 2 } }, body());
    assert.equal(res.body.code, 200, "user_type 2 holds every permission");
  });
});

describe("the branch scope is the server's, and only narrows", () => {
  it("10. a branch-scoped manager is handed their OWN branch, not the token's", async () => {
    await call("POST", BLOCK, STORE_MANAGER, body());
    // The token claimed ECR. The resolver used the employee's real branch.
    assert.equal(seen.block.scope.kind, EMPLOYEE_BRANCH_SCOPE.OWN_BRANCHES);
    assert.deepEqual(seen.block.scope.store_ids, [MOOLAKULAM]);
  });

  it("a company-wide caller is handed ALL_BRANCHES", async () => {
    await call("POST", BLOCK, HR_MANAGER, body());
    assert.equal(seen.block.scope.kind, EMPLOYEE_BRANCH_SCOPE.ALL_BRANCHES);
  });

  it("the actor is the SESSION's employee and user, never the body's", async () => {
    await call("POST", BLOCK, STORE_MANAGER, { ...body(), employee_id: TARGET_OWN });
    assert.equal(seen.block.actor.employee_id, STORE_MANAGER.employee);
    assert.equal(seen.block.actor.user_id, USER_ID);
  });

  it("there is no field by which a caller could name an outlet", () => {
    const schemas = require("./attendance_shift_change_block");
    assert.deepEqual(Object.keys(schemas.BLOCK_SCHEMA).sort(), [
      "attendance_date",
      "employee_id",
      "reason",
    ]);
    assert.deepEqual(Object.keys(schemas.UNBLOCK_SCHEMA).sort(), [
      "attendance_date",
      "employee_id",
      "removal_reason",
    ]);
  });
});

describe("the payload is validated on the server", () => {
  it("refuses a block with no reason", async () => {
    const res = await call("POST", BLOCK, HR_MANAGER, {
      employee_id: TARGET_OWN,
      attendance_date: "2026-09-18",
    });
    assert.notEqual(res.body.code, 200);
  });

  it("refuses a removal with no removal reason", async () => {
    const res = await call("POST", UNBLOCK, HR_MANAGER, {
      employee_id: TARGET_OWN,
      attendance_date: "2026-09-18",
    });
    assert.notEqual(res.body.code, 200);
  });

  it("refuses a malformed date", async () => {
    const res = await call("POST", BLOCK, HR_MANAGER, {
      ...body(),
      attendance_date: "18-09-2026",
    });
    assert.notEqual(res.body.code, 200);
  });

  it("refuses an unknown field rather than ignoring it", async () => {
    const res = await call("POST", BLOCK, HR_MANAGER, { ...body(), outlet_id: ECR });
    assert.notEqual(res.body.code, 200, "an outlet_id must not be quietly accepted");
  });
});

/**
 * EMPLOYEE-ID ENUMERATION, on all three employee-targeted endpoints.
 *
 * `middlewares/employee_branch_scope.js#requireEmployeeInScope` exists so a
 * branch-scoped caller gets the SAME answer for "an employee you may not see"
 * and "an employee that does not exist". Without it, a Moolakulam manager
 * could walk the id space and learn exactly which ids are real by watching
 * "No such employee" turn into "not your branch".
 *
 * These endpoints are employee-targeted writes and reads, so they carry the
 * guard like every other employee route. The assertions below compare the two
 * refusals to EACH OTHER rather than to a fixed string: what matters is that
 * they are indistinguishable, not what they happen to say.
 *
 * The guard is an OUTER check only. The authoritative branch decision is
 * still taken inside the write transaction under `FOR UPDATE`, and
 * `repository/attendance_shift_change_block_concurrency.test.js` continues to
 * prove that; nothing here replaces it.
 */
const MISSING = 99999; // no row in EMPLOYEES at all

describe("employee ids cannot be enumerated through the block endpoints", () => {
  const cases = [
    { what: "block", method: "POST", path: BLOCK, make: body, seenKey: "block" },
    { what: "unblock", method: "POST", path: UNBLOCK, make: removeBody, seenKey: "unblock" },
    {
      what: "history",
      method: "GET",
      path: (id) => `${BLOCK}/history?employee_id=${id}&attendance_date=2026-09-18`,
      seenKey: "history",
    },
  ];

  const request = (c, who, id) =>
    c.method === "GET"
      ? call("GET", c.path(id), who)
      : call(c.method, c.path, who, c.make(id));

  for (const c of cases) {
    it(`A+B. ${c.what}: another branch and a non-existent id are indistinguishable`, async () => {
      seen[c.seenKey] = null;
      const other = await request(c, STORE_MANAGER, TARGET_OTHER);
      assert.equal(other.status, 403, `${c.what}: an employee in ECR must be 403`);
      assert.equal(
        seen[c.seenKey],
        null,
        `${c.what}: the guard must refuse BEFORE the usecase is reached`
      );

      seen[c.seenKey] = null;
      const missing = await request(c, STORE_MANAGER, MISSING);
      assert.equal(missing.status, 403, `${c.what}: a non-existent id must be 403 too`);
      assert.equal(seen[c.seenKey], null, `${c.what}: and must not reach the usecase either`);

      // THE POINT: byte-identical answers. A difference of any kind - status,
      // code, message or error key - is an enumeration oracle.
      assert.equal(missing.status, other.status, `${c.what}: same HTTP status`);
      assert.deepEqual(
        missing.body,
        other.body,
        `${c.what}: the two refusals must be indistinguishable`
      );
      assert.doesNotMatch(
        JSON.stringify(missing.body),
        /no such employee/i,
        `${c.what}: existence must not be disclosed to a branch-scoped caller`
      );
    });

    it(`C. ${c.what}: an own-branch employee reaches the usecase normally`, async () => {
      seen[c.seenKey] = null;
      const res = await request(c, STORE_MANAGER, TARGET_OWN);
      assert.equal(res.body.code, 200, `${c.what}: own branch is allowed through`);
      assert.ok(seen[c.seenKey], `${c.what}: the usecase was reached`);
      assert.equal(Number(seen[c.seenKey].employee_id), TARGET_OWN);
      assert.equal(
        seen[c.seenKey].scope.kind,
        EMPLOYEE_BRANCH_SCOPE.OWN_BRANCHES,
        `${c.what}: and still carries the caller's own scope to the locked re-check`
      );
    });

    it(`D. ${c.what}: an ALL_BRANCHES caller still reaches the usecase for a missing id`, async () => {
      seen[c.seenKey] = null;
      const res = await request(c, HR_MANAGER, MISSING);
      assert.ok(
        seen[c.seenKey],
        `${c.what}: the guard must not refuse a company-wide caller - the ` +
          `handler owns "No such employee" for them`
      );
      assert.equal(Number(seen[c.seenKey].employee_id), MISSING);
      assert.equal(seen[c.seenKey].scope.kind, EMPLOYEE_BRANCH_SCOPE.ALL_BRANCHES);
      assert.notEqual(res.status, 403, `${c.what}: not a scope refusal for an admin-class caller`);
    });
  }

  it("D2. a user_type administrator is unaffected on every endpoint", async () => {
    for (const c of cases) {
      seen[c.seenKey] = null;
      /* eslint-disable no-await-in-loop */
      await request(c, { ...ADMIN, opts: { userType: 2 } }, MISSING);
      /* eslint-enable no-await-in-loop */
      assert.ok(seen[c.seenKey], `${c.what}: the administrator bypass still reaches the usecase`);
      assert.equal(seen[c.seenKey].scope.kind, EMPLOYEE_BRANCH_SCOPE.ALL_BRANCHES);
    }
  });
});
