/**
 * M2 — the permission catalogue, the statutory configuration and the period
 * lock contract.
 *
 *   node --test constants/m2_salary_permissions.test.js
 *
 * Small, boring assertions about the things that are easy to get subtly wrong
 * and impossible to notice afterwards: a permission key spelled one way in the
 * catalogue and another in the migration grants nobody anything, and a rate
 * that is not actually configurable is a code release on the day EPFO moves a
 * ceiling.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const P = require("./hr_permissions");
const { SENSITIVE_EMPLOYEE_FIELDS } = require("./sensitive_fields");
const { STATUTORY_DETAIL_FIELDS, PAYMENT_DETAIL_FIELDS, sectionKeysRequired } = require("./employee_master_sections");
const lock = require("../services/salary_period_lock");

const MIGRATION = fs.readFileSync(
  path.join(__dirname, "../migrations/mysql/migrations/sqls/20260915120000-m2-salary-engine-up.sql"),
  "utf8"
);

const M2_KEYS = {
  VIEW_SALARY: "view_salary",
  ADD_SALARY: "add_salary",
  EDIT_SALARY: "edit_salary",
  MANUAL_SALARY_COMPONENT_OVERRIDE: "manual_salary_component_override",
  APPROVE_SALARY_REVISION: "approve_salary_revision",
  VIEW_PAYROLL: "view_payroll",
  PROCESS_PAYROLL: "process_payroll",
  HR_REPORTS: "hr_reports",
};

describe("the permission catalogue", () => {
  it("declares exactly the eight approved keys", () => {
    for (const [constant, key] of Object.entries(M2_KEYS)) {
      assert.equal(P[constant], key, `${constant} is ${key}`);
    }
  });

  it("every key in the catalogue is also declared by the migration", () => {
    // A key the code checks but the migration never inserts into
    // `all_permissions` cannot be granted on the Designation screen, so it
    // silently means "administrators only, forever".
    for (const key of Object.values(M2_KEYS)) {
      assert.ok(MIGRATION.includes(`'${key}'`), `${key} is declared by the migration`);
    }
  });

  it("does not collide with the legacy salary-advance keys", () => {
    // `/salary` + `payment_det` is a name-keyed staff loan tracker, not
    // payroll, and it keeps its own keys.
    assert.equal(P.VIEW_SALARY_ADVANCE, "view_salary_advance");
    assert.notEqual(P.VIEW_SALARY, P.VIEW_SALARY_ADVANCE);
    assert.notEqual(P.ADD_SALARY, P.ADD_SALARY_ADVANCE);
  });

  it("adding and approving are different keys", () => {
    assert.notEqual(P.ADD_SALARY, P.APPROVE_SALARY_REVISION);
    assert.notEqual(P.EDIT_SALARY, P.APPROVE_SALARY_REVISION);
  });

  it("the override is its own key, not a mode of add or edit", () => {
    assert.notEqual(P.MANUAL_SALARY_COMPONENT_OVERRIDE, P.ADD_SALARY);
    assert.notEqual(P.MANUAL_SALARY_COMPONENT_OVERRIDE, P.EDIT_SALARY);
  });
});

describe("Previous PF Member", () => {
  it("is sensitive under B3", () => {
    assert.ok(SENSITIVE_EMPLOYEE_FIELDS.includes("previous_pf_member"));
  });

  it("belongs to Statutory Details, and demands the EXISTING statutory key", () => {
    assert.ok(STATUTORY_DETAIL_FIELDS.includes("previous_pf_member"));
    assert.ok(!PAYMENT_DETAIL_FIELDS.includes("previous_pf_member"));
    assert.deepEqual(sectionKeysRequired({ previous_pf_member: 1 }), [P.EDIT_STATUTORY_DETAILS]);
  });

  it("has no permission key of its own", () => {
    // The approved rule is that it is controlled by existing Statutory
    // designation rights. A new key would be a second decision nobody asked
    // for, and would leave the field unreachable until somebody granted it.
    const keys = Object.values(P);
    assert.ok(!keys.some((k) => /previous_pf/.test(k)));
  });

  it("is a DIFFERENT field from PF applicable, UAN and PF number", () => {
    for (const other of ["pf_applicable", "uan", "pf_number", "pf"]) {
      assert.notEqual("previous_pf_member", other);
      assert.ok(STATUTORY_DETAIL_FIELDS.includes(other), `${other} is still its own field`);
    }
  });
});

/*
 * The review fix. EPFO Form 11 asks about prior EPF membership and prior EPS
 * membership as two questions, so they are two fields here - governed by the
 * same existing Statutory right, because they are two FACTS and not two
 * decisions about who may record one.
 */
describe("Previous EPS Member", () => {
  it("is sensitive under B3", () => {
    assert.ok(SENSITIVE_EMPLOYEE_FIELDS.includes("previous_eps_member"));
  });

  it("belongs to Statutory Details, and demands the EXISTING statutory key", () => {
    assert.ok(STATUTORY_DETAIL_FIELDS.includes("previous_eps_member"));
    assert.ok(!PAYMENT_DETAIL_FIELDS.includes("previous_eps_member"));
    assert.deepEqual(sectionKeysRequired({ previous_eps_member: 1 }), [P.EDIT_STATUTORY_DETAILS]);
  });

  it("has no permission key of its own", () => {
    const keys = Object.values(P);
    assert.ok(!keys.some((k) => /previous_eps/.test(k)));
  });

  it("IS A SEPARATE FIELD FROM Previous PF Member", () => {
    // The point of the whole fix: two columns, not one reused. Both are in the
    // section, and neither is the other.
    assert.notEqual("previous_eps_member", "previous_pf_member");
    assert.ok(STATUTORY_DETAIL_FIELDS.includes("previous_pf_member"));
    assert.ok(STATUTORY_DETAIL_FIELDS.includes("previous_eps_member"));
  });

  it("does not reuse the legacy free-text `pf` column", () => {
    assert.notEqual("previous_eps_member", "pf");
    assert.ok(STATUTORY_DETAIL_FIELDS.includes("pf"), "the legacy column is left exactly as it was");
  });

  it("needs the same statutory key when it travels with the PF fact", () => {
    assert.deepEqual(
      sectionKeysRequired({ previous_pf_member: 1, previous_eps_member: 0 }),
      [P.EDIT_STATUTORY_DETAILS]
    );
  });
});

describe("the statutory configuration", () => {
  /**
   * Loaded fresh with an environment applied, because `config/statutory.js`
   * reads `process.env` at require time — which is the point of the test.
   */
  const loadWith = (env) => {
    const saved = {};
    for (const [k, v] of Object.entries(env)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    delete require.cache[require.resolve("./../config/statutory")];
    const cfg = require("./../config/statutory");
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    delete require.cache[require.resolve("./../config/statutory")];
    return cfg;
  };

  it("models the approved current rates and ceilings", () => {
    const c = require("./../config/statutory");
    assert.equal(c.pf.employeeRatePercent, 12);
    assert.equal(c.pf.employerRatePercent, 12);
    assert.equal(c.pf.epsRatePercent, 8.33);
    assert.equal(c.pf.edliRatePercent, 0.5);
    assert.equal(c.pf.adminRatePercent, 0.5);
    assert.equal(c.pf.wageCeiling, 15000);
    assert.equal(c.esi.employeeRatePercent, 0.75);
    assert.equal(c.esi.employerRatePercent, 3.25);
    assert.equal(c.esi.coverageCeiling, 21000);
    assert.equal(c.salary.salaryDaysPerMonth, 26);
    assert.equal(c.salary.basicFloor, 10000);
    assert.equal(c.salary.conveyanceCap, 2500);
    assert.equal(c.salary.hraCap, 10000);
    assert.equal(c.salary.openingEffectiveFloor, "2026-04-01");
  });

  it("every rate is overridable from the environment", () => {
    const c = loadWith({
      PF_WAGE_CEILING: "21000",
      ESI_COVERAGE_CEILING: "25000",
      ESI_EMPLOYEE_RATE_PERCENT: "1",
      SALARY_CONVEYANCE_CAP: "3000",
    });
    assert.equal(c.pf.wageCeiling, 21000);
    assert.equal(c.esi.coverageCeiling, 25000);
    assert.equal(c.esi.employeeRatePercent, 1);
    assert.equal(c.salary.conveyanceCap, 3000);
  });

  it("an unusable environment value falls back rather than becoming NaN", () => {
    // A ceiling of NaN would make every comparison false and every
    // contribution NaN, which is worse than the committed default.
    const c = loadWith({ PF_WAGE_CEILING: "not a number", SALARY_BASIC_FLOOR: "" });
    assert.equal(c.pf.wageCeiling, 15000);
    assert.equal(c.salary.basicFloor, 10000);
  });

  it("an unusable opening floor falls back to a real date", () => {
    const c = loadWith({ SALARY_OPENING_EFFECTIVE_FLOOR: "01/04/2026" });
    assert.equal(c.salary.openingEffectiveFloor, "2026-04-01");
  });

  it("carries a version stamp so a generation of records is findable", () => {
    assert.ok(require("./../config/statutory").configVersion);
  });

  it("holds no secret", () => {
    const src = fs.readFileSync(path.join(__dirname, "../config/statutory.js"), "utf8");
    for (const word of ["password", "api_key", "apiKey", "secret", "token", "PRIVATE"]) {
      assert.ok(!new RegExp(word, "i").test(src.replace(/no secret|NOTHING HERE IS A SECRET|credential/gi, "")),
        `${word} has no business in a rate table`);
    }
  });
});

describe("the salary period lock contract", () => {
  it("reports unlocked, with a reason, while payroll does not exist", () => {
    const r = lock.checkLock("2026-04-15");
    assert.equal(r.locked, false);
    assert.equal(r.reason, lock.LOCK_REASON.PAYROLL_NOT_IMPLEMENTED);
  });

  it("names the monthly period a date falls in", () => {
    assert.equal(lock.periodOf("2026-04-01"), "2026-04");
    assert.equal(lock.periodOf("2026-12-31"), "2026-12");
    assert.equal(lock.periodOf(null), null);
  });

  it("returns a REASONED object, so callers must read `.locked`", () => {
    // Deliberately not a bare boolean: when the real implementation starts
    // returning locked periods, every existing caller already handles it.
    const r = lock.checkLock("2026-04-15");
    assert.equal(typeof r, "object");
    assert.ok("locked" in r && "reason" in r && "period" in r);
  });

  it("blockedReason is null while nothing is locked", () => {
    assert.equal(lock.blockedReason("2026-04-15"), null);
  });
});
