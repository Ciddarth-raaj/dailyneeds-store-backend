/**
 * DN-TALLY-INTEGRATION-AUTH-FIX. Integration accounts and employee-wide
 * revocation.
 *
 * THE INCIDENT THIS FILE EXISTS FOR. `purchase_api` (user 198) is the login
 * the Tally bridge uses, and it was provisioned against `employee_id = 1` -
 * the same employee a human login already used. Every employee-wide
 * revocation in this system is keyed by that column:
 *
 *   UPDATE `user` SET token_valid_from = NOW()
 *    WHERE employee_id = ? AND is_system_account = 0
 *
 * so an HR action on employee 1 revoked the integration's token along with
 * the human's, and every protected `/tally/*` GET began answering
 * TOKEN_REVOKED.
 *
 * The rules asserted here, in both directions:
 *   - a human login attached to an employee IS still revoked;
 *   - an integration login (`is_service_account = 1`) is NOT;
 *   - resign / rejoin / edit revocation still reaches humans;
 *   - a joining-date correction revokes nobody at all;
 *   - `/tally/*` GETs still require a token; `POST /purchase-tally` does not.
 */
const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const userRepoFactory = require("../repository/user");
const masterRepoFactory = require("../repository/employee_master");
const authMiddleware = require("../middlewares/auth");

/* ------------------------------------------------------------------------ *
 * A `user` table small enough to reason about, and an executor that
 * understands exactly the statement shape these guards live in. It is
 * deliberately literal: the guards are SQL, so they are tested as SQL rather
 * than by asserting that some JavaScript branch was taken.
 * ------------------------------------------------------------------------ */
const ROWS = () => [
  // The human. employee_id 1, an ordinary login.
  { user_id: 1, username: "admin", employee_id: 1, is_system_account: 0, is_service_account: 0, token_valid_from: null, status: 1 },
  // The Tally integration, coupled to the same employee.
  { user_id: 198, username: "purchase_api", employee_id: 1, is_system_account: 0, is_service_account: 1, token_valid_from: null, status: 1 },
  // Break-glass: never employee-linked, never in scope.
  { user_id: 999, username: "breakglass", employee_id: null, is_system_account: 1, is_service_account: 0, token_valid_from: null, status: 1 },
  // A second human, on a different employee, to prove the WHERE is narrow.
  { user_id: 2, username: "other", employee_id: 2, is_system_account: 0, is_service_account: 0, token_valid_from: null, status: 1 },
];

const NOW = new Date("2026-09-17T14:04:26Z");

function makeTable() {
  const rows = ROWS();

  const run = (sql, params) => {
    const employeeKeyed = /WHERE\s+`?employee_id`?\s*=\s*\?/i.test(sql);
    const userKeyed = /WHERE\s+`?user_id`?\s*=\s*\?/i.test(sql);
    if (!employeeKeyed && !userKeyed) throw new Error(`unsupported statement: ${sql}`);

    const guardSystem = /`is_system_account`\s*=\s*0/.test(sql);
    const guardService = /`is_service_account`\s*=\s*0/.test(sql);
    const key = params[params.length - 1];

    const matched = rows.filter((r) => {
      if (employeeKeyed && r.employee_id !== key) return false;
      if (userKeyed && r.user_id !== key) return false;
      if (guardSystem && Number(r.is_system_account) !== 0) return false;
      if (guardService && Number(r.is_service_account) !== 0) return false;
      return true;
    });

    if (/SET\s+`token_valid_from`\s*=\s*NOW\(\)/i.test(sql)) {
      matched.forEach((r) => {
        r.token_valid_from = NOW;
      });
    } else if (/SET\s+`status`\s*=\s*\?/i.test(sql)) {
      matched.forEach((r) => {
        r.status = params[0];
      });
    } else {
      throw new Error(`unsupported statement: ${sql}`);
    }
    return { affectedRows: matched.length };
  };

  return {
    rows,
    of: (username) => rows.find((r) => r.username === username),
    // repository/user.js shape: a callback-style connection.
    connection: { query: (sql, params, cb) => cb(null, run(sql, params)) },
    // repository/employee_master.js shape: a promise-style `tx`.
    tx: { query: async (sql, params) => run(sql, params) },
  };
}

describe("employee-wide revocation excludes integration accounts", () => {
  let table;
  beforeEach(() => {
    table = makeTable();
  });

  it("revokes the human login attached to the employee", async () => {
    const repo = userRepoFactory(table.connection);
    await repo.bumpTokenValidFromByEmployeeId(1);
    assert.deepEqual(table.of("admin").token_valid_from, NOW);
  });

  it("does NOT revoke the integration account attached to the same employee", async () => {
    const repo = userRepoFactory(table.connection);
    await repo.bumpTokenValidFromByEmployeeId(1);
    assert.equal(table.of("purchase_api").token_valid_from, null, "purchase_api must survive an employee-wide revocation");
  });

  it("does not reach the break-glass account or another employee's login", async () => {
    const repo = userRepoFactory(table.connection);
    await repo.bumpTokenValidFromByEmployeeId(1);
    assert.equal(table.of("breakglass").token_valid_from, null);
    assert.equal(table.of("other").token_valid_from, null);
  });

  it("an employee-wide STATUS change leaves the integration account enabled", async () => {
    const repo = userRepoFactory(table.connection);
    await repo.updateStatus({ employee_id: 1, status: 0 });
    assert.equal(table.of("admin").status, 0);
    assert.equal(table.of("purchase_api").status, 1, "disabling a person must not disable the integration");
  });

  it("the HR employee-master revocation carries the same two exclusions", async () => {
    const master = masterRepoFactory(null);
    const affected = await master.bumpTokenValidFrom(table.tx, 1);
    assert.equal(affected, 1);
    assert.deepEqual(table.of("admin").token_valid_from, NOW);
    assert.equal(table.of("purchase_api").token_valid_from, null);
  });

  it("an explicit per-account revoke still revokes the integration account", async () => {
    const repo = userRepoFactory(table.connection);
    await repo.bumpTokenValidFrom(198);
    assert.deepEqual(
      table.of("purchase_api").token_valid_from,
      NOW,
      "naming the account is how an integration is revoked on purpose"
    );
  });
});

/* ------------------------------------------------------------------------ *
 * The HR actions, through the usecase, on fakes that record which
 * employee_id each revocation named. What matters here is WHICH path
 * revokes, not the SQL - the SQL is covered above.
 * ------------------------------------------------------------------------ */
const employeeMasterUsecaseFactory = require("./employee_master");
const employeeLifecycleUsecaseFactory = require("./employee_lifecycle");

function hrHarness({ status = 1, joinedOn = "2015-04-01", designationId = 3, storeId = 2 } = {}) {
  const revocations = [];
  const employee = {
    employee_id: 1,
    employee_name: "Human One",
    status,
    date_of_joining: joinedOn,
    resignation_date: status === 1 ? null : "2026-08-31",
    designation_id: designationId,
    store_id: storeId,
    department_id: 5,
  };
  const period = {
    period_id: 11,
    period_no: 1,
    period_state: status === 1 ? "open" : "closed",
    joined_on: joinedOn,
    ended_on: status === 1 ? null : "2026-08-31",
    prev_ended_on: null,
  };
  const events = [];

  const tx = { query: async () => ({ affectedRows: 1 }) };

  const masterRepo = {
    withTransaction: (fn) => fn(tx),
    lockEmployee: async () => ({ ...employee }),
    updateEmployee: async (_tx, _id, patch) => {
      Object.assign(employee, patch);
      return 1;
    },
    setJoiningDate: async (_tx, _id, date) => {
      employee.date_of_joining = date;
      return 1;
    },
    markResigned: async (_tx, _id, endedOn) => {
      employee.status = 0;
      employee.resignation_date = endedOn;
      return 1;
    },
    markRejoined: async (_tx, _id, joined) => {
      employee.status = 1;
      employee.resignation_date = null;
      employee.date_of_joining = joined;
      return 1;
    },
    createResignationRecord: async () => 1,
    bumpTokenValidFrom: async (_tx, employeeId) => {
      revocations.push(employeeId);
      return 1;
    },
  };

  const lifecycleRepo = {
    withTransaction: (fn) => fn(tx),
    assertDateLocale: async () => {},
    lockAndReadEmployee: async () => ({
      employee_id: 1,
      status: employee.status,
      resignation_date: employee.resignation_date,
      raw_date_of_joining: employee.date_of_joining,
      parsed_joined_on: employee.date_of_joining || null,
    }),
    closePeriod: async () => 1,
    insertPeriod: async () => 12,
    getLatestPeriod: async () => ({ ...period }),
    setJoinedOn: async (_tx, _pid, date) => {
      period.joined_on = date;
      return 1;
    },
    closePeriod: async () => 1,
    openPeriod: async () => 12,
    fillNullDate: async () => 1,
    insertEvent: async (_tx, e) => {
      events.push(e);
      return 1;
    },
  };

  const lifecycle = employeeLifecycleUsecaseFactory(lifecycleRepo, null);
  const hr = employeeMasterUsecaseFactory(masterRepo, lifecycle, lifecycleRepo, null, null);
  return { hr, revocations, employee, period, events };
}

describe("which HR actions revoke sessions at all", () => {
  it("a joining-date correction revokes NOTHING - not the human, not the integration", async () => {
    const h = hrHarness();
    const out = await h.hr.correctJoiningDate(1, { date_of_joining: "2013-05-27" }, { actorEmployeeId: 1 });
    assert.equal(out.code, 200);
    assert.equal(h.period.joined_on, "2013-05-27");
    assert.deepEqual(h.revocations, [], "correcting a typo in a date is not a security event");
    assert.equal(h.events.length, 1);
    assert.equal(h.events[0].detail.reason, "date_corrected");
  });

  it("a branch or designation change still revokes the employee's sessions", async () => {
    const h = hrHarness({ designationId: 3 });
    await h.hr.editEmployee(1, { designation_id: 9 }, { actorEmployeeId: 1 });
    assert.deepEqual(h.revocations, [1], "a designation change is security-relevant and must still revoke");
  });

  it("RESENDING an unchanged empty field is not a change, and revokes nobody", async () => {
    // The regression behind the incident's blast radius: `String(null)` is
    // "null" and `String("")` is "", so an editor that resends a field it
    // was given read as a change and revoked every session on the employee.
    const h = hrHarness({ designationId: null, storeId: null });
    const out = await h.hr.editEmployee(1, { designation_id: "", store_id: "" }, { actorEmployeeId: 1 });
    assert.equal(out.sessions_revoked, false);
    assert.deepEqual(h.revocations, []);
  });
});

describe("resignation and rejoin still end a human's session", () => {
  it("a resignation revokes", async () => {
    const h = hrHarness();
    await h.hr.resignEmployee(1, { resignation_date: "2026-08-31", reason_type: "personal", reason: "x" }, { actorEmployeeId: 1 });
    assert.deepEqual(h.revocations, [1]);
  });

  it("a rejoin revokes, so a pre-resignation token cannot come back to life", async () => {
    const h = hrHarness({ status: 0 });
    await h.hr.rejoinEmployee(1, { date_of_joining: "2026-09-15" }, { actorEmployeeId: 1 });
    assert.deepEqual(h.revocations, [1]);
  });

  it("the standalone reconciler revocation is the employee-scoped repository call", async () => {
    const calls = [];
    const lifecycleRepo = {
      withTransaction: (fn) => fn({ query: async () => ({ affectedRows: 1 }) }),
      assertDateLocale: async () => {},
      getLatestPeriod: async () => ({ period_id: 11, period_no: 1, period_state: "open", joined_on: "2015-04-01", ended_on: null, prev_ended_on: null }),
      lockAndReadEmployee: async () => ({
        employee_id: 1,
        status: 0,
        resignation_date: "2026-08-31",
        raw_date_of_joining: "2015-04-01",
        parsed_joined_on: "2015-04-01",
      }),
      closePeriod: async () => 1,
      insertEvent: async () => 1,
    };
    const userRepo = { bumpTokenValidFromByEmployeeId: async (id) => calls.push(id) };
    const lifecycle = employeeLifecycleUsecaseFactory(lifecycleRepo, userRepo);
    const out = await lifecycle.reconcileEmployee(1, { actorEmployeeId: 1 });
    assert.equal(out.action, "close");
    assert.deepEqual(calls, [1], "a resignation reconciled on its own still revokes the human");
  });
});

/* ------------------------------------------------------------------------ *
 * The routes themselves. The fix must not have made anything public, and
 * must not have made the one genuinely public POST private.
 * ------------------------------------------------------------------------ */
describe("Tally route protection is unchanged", () => {
  const TALLY_GETS = ["/tally/purchase", "/tally/debit-note", "/tally/sales-entry", "/tally/expenses", "/tally/card-to-bank"];

  it("every /tally/* GET requires a token", () => {
    for (const p of TALLY_GETS) {
      const entry = authMiddleware.unProtectedRoutes[p];
      assert.equal(entry === undefined || !entry.methods.get, true, `${p} must not be public`);
    }
  });

  it("an unauthenticated /tally/* GET is refused by the middleware", async () => {
    const mw = authMiddleware.create();
    for (const p of TALLY_GETS) {
      const result = await new Promise((resolve) => {
        const res = {
          statusCode: 200,
          json(b) {
            this.body = b;
            return this;
          },
          status(s) {
            this.statusCode = s;
            return this;
          },
          end() {
            resolve({ nexted: false, body: this.body });
          },
        };
        mw({ path: p, method: "GET", headers: {} }, res, () => resolve({ nexted: true }));
      });
      assert.equal(result.nexted, false, `${p} let an unauthenticated request through`);
      assert.equal(result.body.code, 403);
    }
  });

  it("POST /purchase-tally stays public, exactly as before", () => {
    assert.equal(authMiddleware.unProtectedRoutes["/purchase-tally"].methods.post, true);
  });
});

/* ------------------------------------------------------------------------ *
 * The migration that carries the column. Additive, reversible, and wired
 * the way db-migrate reads it.
 * ------------------------------------------------------------------------ */
describe("the is_service_account migration", () => {
  const fs = require("fs");
  const path = require("path");
  const dir = path.join(__dirname, "..", "migrations", "mysql", "migrations");
  const ID = "20261028120000-auth-service-account-flag";
  const read = (f) => fs.readFileSync(path.join(dir, f), "utf8");

  it("is wired the way db-migrate reads it", () => {
    const js = read(`${ID}.js`);
    assert.match(js, new RegExp(`'sqls', '${ID}-up\\.sql'`));
    assert.match(js, new RegExp(`'sqls', '${ID}-down\\.sql'`));
    assert.ok(fs.existsSync(path.join(dir, "sqls", `${ID}-up.sql`)));
    assert.ok(fs.existsSync(path.join(dir, "sqls", `${ID}-down.sql`)));
  });

  it("is additive: one defaulted column, and nothing dropped or rewritten", () => {
    const up = read(path.join("sqls", `${ID}-up.sql`));
    assert.match(up, /ADD COLUMN `is_service_account` TINYINT\(1\) NOT NULL DEFAULT 0/);
    assert.ok(!/DROP|MODIFY|UPDATE |DELETE/i.test(up.replace(/^--.*$/gm, "")), "the migration must not change data or existing columns");
  });

  it("flags NO account: which login is an integration is a reviewed data change", () => {
    const up = read(path.join("sqls", `${ID}-up.sql`));
    assert.ok(!/purchase_api|is_service_account`?\s*=\s*1/.test(up.replace(/^--.*$/gm, "")));
    assert.ok(fs.existsSync(path.join(__dirname, "..", "scripts", "auth", "service-accounts.sql")));
  });
});
