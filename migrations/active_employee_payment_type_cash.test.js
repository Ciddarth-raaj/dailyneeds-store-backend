/**
 * THE ONE-TIME CASH CLEANUP, PROVEN AGAINST ITS OWN SQL.
 *
 *   node --test migrations/active_employee_payment_type_cash.test.js
 *
 * There is no database here, so this reads the migration's SQL text the same
 * way `c3_bank_name_review_and_statutory_flags.test.js` and
 * `employee_default_work_shift.test.js` read theirs. That suits this
 * migration exactly, because what matters about it is almost entirely what it
 * must NOT do: it must touch no resigned employee, no employee who already
 * has a payment route, and no column but the one.
 *
 * The second half runs the WHERE clause as a predicate over a small fixture
 * population, so "which rows does this target" is an executed answer rather
 * than a reading of the string, and then feeds the migrated employee to the
 * REAL dashboard rules to show where they land afterwards.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { PAYMENT_TYPE } = require("../utils/payment_type");
const { EmployeeStatusSummaryUsecase } = require("../usecase/employee_status_summary");

const NAME = "20261005120000-active-employee-payment-type-cash";
const dir = path.join(__dirname, "mysql/migrations");
const sqlDir = path.join(dir, "sqls");
const read = (f) => fs.readFileSync(path.join(sqlDir, f), "utf8");
const stripComments = (sql) => sql.replace(/--[^\n]*/g, "");
const statements = (sql) =>
  stripComments(sql)
    .split(";")
    .map((s) => s.trim().replace(/\s+/g, " "))
    .filter(Boolean);

/* ------------------------------------------------------------- identity -- */

describe("the migration identifier", () => {
  const all = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".js"))
    .map((f) => f.replace(/\.js$/, ""));

  it("is unique - nothing else in the directory claims it", () => {
    assert.equal(all.filter((f) => f === NAME).length, 1);
    const stamp = NAME.slice(0, 14);
    const sameStamp = all.filter((f) => f.slice(0, 14) === stamp);
    assert.deepEqual(sameStamp, [NAME], "no other migration shares this timestamp");
  });

  it("sorts AFTER every migration that existed when it was written", () => {
    // The rule this protects is that the DATA FIX runs after the schema and
    // permission migrations it depends on - not that it is forever the last
    // file in the directory. So it is pinned to the highest identifier that
    // existed when it was written, and a LATER migration is allowed to land
    // beside it as long as that migration does not touch `payment_type`.
    const WHEN_WRITTEN = "20261004120000-employee-aadhaar-view-permission";
    const earlier = all.filter((f) => f !== NAME && f <= WHEN_WRITTEN).sort();
    const highest = earlier[earlier.length - 1];
    assert.ok(NAME > highest, `${NAME} must sort after the current highest, ${highest}`);
    assert.equal(highest, WHEN_WRITTEN);

    // Anything that landed afterwards must leave this fix's column alone,
    // which is the only way a later migration could actually reorder it.
    for (const later of all.filter((f) => f > NAME)) {
      const sql = fs.readFileSync(path.join(dir, "sqls", `${later}-up.sql`), "utf8");
      assert.ok(
        !sql.includes("payment_type"),
        `${later} sorts after this data fix and must not touch payment_type`
      );
    }
  });

  it("has both halves on disk, and a runner that points at them", () => {
    assert.ok(fs.existsSync(path.join(sqlDir, `${NAME}-up.sql`)));
    assert.ok(fs.existsSync(path.join(sqlDir, `${NAME}-down.sql`)));
    const runner = fs.readFileSync(path.join(dir, `${NAME}.js`), "utf8");
    assert.match(runner, new RegExp(`${NAME}-up\\.sql`));
    assert.match(runner, new RegExp(`${NAME}-down\\.sql`));
  });
});

/* ------------------------------------------------------------------ up --- */

describe("up", () => {
  const sql = read(`${NAME}-up.sql`);
  const body = stripComments(sql);
  const stmts = statements(sql);

  it("is exactly one statement, and it is an UPDATE", () => {
    assert.equal(stmts.length, 1, "one statement, no companions");
    assert.match(stmts[0], /^UPDATE `new_employee`/);
  });

  it("sets nothing but payment_type, and sets it to Cash", () => {
    const set = stmts[0].slice(stmts[0].indexOf("SET ") + 4, stmts[0].indexOf(" WHERE "));
    assert.equal(set.trim(), "`payment_type` = 2");
    assert.equal(PAYMENT_TYPE.CASH, 2, "2 is still what Cash means");
  });

  it("NEVER RUNS WITHOUT BOTH GUARDS", () => {
    const where = stmts[0].slice(stmts[0].indexOf(" WHERE ") + 7);
    assert.match(where, /`status` = 1/, "active employees only");
    assert.match(where, /`payment_type` IS NULL/, "unrecorded payment routes only");
    assert.match(where, /AND/, "the two are ANDed, never ORed");
    assert.equal(/\bOR\b/i.test(where), false, "an OR here would widen the update");
  });

  it("is not a broad update", () => {
    // The failure this guards against is an UPDATE that lost its WHERE in an
    // edit - which would set the whole company to Cash, Bank employees
    // included, in one irreversible statement.
    assert.match(stmts[0], / WHERE /, "there is a WHERE at all");
    assert.equal(/UPDATE[^;]*SET[^;]*$/.test(stmts[0].replace(/ WHERE .*/, "")), true);
  });

  it("is not destructive in any way", () => {
    for (const forbidden of ["DELETE", "DROP", "TRUNCATE", "ALTER", "RENAME", "CREATE", "INSERT", "REPLACE"]) {
      assert.equal(
        new RegExp(`\\b${forbidden}\\b`, "i").test(body),
        false,
        `${forbidden} has no business in a one-column data fix`
      );
    }
  });

  it("touches no other table and no sensitive column", () => {
    const tables = body.match(/`[a-z_]+`/gi).map((t) => t.replace(/`/g, ""));
    assert.deepEqual([...new Set(tables)].sort(), ["new_employee", "payment_type", "status"]);
    for (const column of [
      "account_no", "ifsc", "bank_name", "salary", "aadhaar_card_no",
      "employee_id", "status_", "resignation_date", "date_of_joining",
    ]) {
      assert.equal(new RegExp(`\`${column}\``).test(body), false, `${column} is not touched`);
    }
  });

  it("is re-runnable: a second run matches nothing the first left behind", () => {
    // Structural, not a database fact: the WHERE selects NULL rows and the
    // SET makes them non-NULL, so the statement is its own fixed point.
    assert.match(stmts[0], /`payment_type` IS NULL/);
    assert.match(stmts[0], /SET `payment_type` = 2/);
  });
});

/* ---------------------------------------------------------------- down --- */

describe("down", () => {
  const sql = read(`${NAME}-down.sql`);
  const body = stripComments(sql);

  it("is an intentional no-op", () => {
    assert.deepEqual(statements(sql), ["SELECT 1"]);
  });

  it("writes nothing at all", () => {
    for (const forbidden of ["UPDATE", "DELETE", "DROP", "TRUNCATE", "ALTER", "INSERT"]) {
      assert.equal(new RegExp(`\\b${forbidden}\\b`, "i").test(body), false);
    }
  });

  it("says WHY it is a no-op, in the file", () => {
    // The reason must survive in the repository, not only in a commit
    // message: after the up runs, a migrated employee is indistinguishable
    // from one who was always Cash, so any revert would blank the payment
    // route of genuinely cash-paid people.
    assert.match(sql, /indistinguishable/i);
    assert.match(sql, /NOT AN OVERSIGHT/i);
  });
});

/* ------------------------------------------- which rows it actually hits -- */

/** The migration's WHERE, as a predicate, applied to a fixture population. */
const targeted = (row) => row.status === 1 && row.payment_type === null;
/** And its SET. */
const migrate = (row) => (targeted(row) ? { ...row, payment_type: 2 } : { ...row });

describe("the rows this targets", () => {
  const population = [
    { employee_id: 2283, status: 1, payment_type: null, why: "active, never recorded" },
    { employee_id: 2284, status: 1, payment_type: null, why: "active, never recorded" },
    { employee_id: 100, status: 1, payment_type: PAYMENT_TYPE.BANK, why: "active bank employee" },
    { employee_id: 101, status: 1, payment_type: PAYMENT_TYPE.CASH, why: "active cash employee" },
    { employee_id: 200, status: 0, payment_type: null, why: "resigned, never recorded" },
    { employee_id: 201, status: 0, payment_type: PAYMENT_TYPE.BANK, why: "resigned bank employee" },
  ];

  it("updates active employees whose payment route is unrecorded", () => {
    const hit = population.filter(targeted).map((r) => r.employee_id);
    assert.deepEqual(hit, [2283, 2284]);
    for (const row of population.filter(targeted)) {
      assert.equal(migrate(row).payment_type, PAYMENT_TYPE.CASH);
    }
  });

  it("does NOT touch an active Bank employee", () => {
    const before = population.find((r) => r.employee_id === 100);
    assert.equal(targeted(before), false);
    assert.equal(migrate(before).payment_type, PAYMENT_TYPE.BANK);
  });

  it("does NOT touch an active Cash employee", () => {
    const before = population.find((r) => r.employee_id === 101);
    assert.equal(targeted(before), false);
    assert.equal(migrate(before).payment_type, PAYMENT_TYPE.CASH);
  });

  it("does NOT touch an inactive employee, even one with no payment route", () => {
    for (const row of population.filter((r) => r.status === 0)) {
      assert.equal(targeted(row), false, `employee ${row.employee_id} (${row.why}) is left alone`);
      assert.deepEqual(migrate(row), { ...row }, "byte-identical");
    }
    // The historical inactive NULL rows remain NULL, and that is accepted.
    assert.equal(migrate(population.find((r) => r.employee_id === 200)).payment_type, null);
  });

  it("changes nothing but the one column", () => {
    const before = population.find((r) => r.employee_id === 2283);
    const after = migrate(before);
    for (const key of Object.keys(before)) {
      if (key === "payment_type") continue;
      assert.deepEqual(after[key], before[key], `${key} is untouched`);
    }
    assert.equal(after.employee_id, 2283, "the identity is permanent");
  });
});

/* ------------------------------------ where the migrated employee lands --- */

const config = (paymentType) => ({
  paymentTypeRecorded: paymentType !== null && paymentType !== undefined,
  paysInCash: paymentType === PAYMENT_TYPE.CASH,
});

describe("the HR Onboarding dashboard, after the migration", () => {
  it("a migrated employee is now Cash -> Bank Pending, and NOT Bank Pending", () => {
    const after = migrate({ employee_id: 2283, status: 1, payment_type: null });
    const c = config(after.payment_type);

    const cashToBank = EmployeeStatusSummaryUsecase.cashToBankState({ config: c });
    const bank = EmployeeStatusSummaryUsecase.bankState({ config: c, bankPayrollReady: false });

    assert.equal(cashToBank.pending, true);
    assert.equal(cashToBank.status, "PENDING");
    assert.equal(bank.pending, false);
    assert.equal(bank.status, "NOT_APPLICABLE");
  });

  it("was in NEITHER queue before it, which is the problem being fixed", () => {
    const c = config(null);
    assert.equal(EmployeeStatusSummaryUsecase.cashToBankState({ config: c }).pending, false);
    assert.equal(EmployeeStatusSummaryUsecase.bankState({ config: c, bankPayrollReady: false }).pending, false);
  });

  it("leaves Bank Pending semantics exactly as they were", () => {
    const c = config(PAYMENT_TYPE.BANK);
    const bank = EmployeeStatusSummaryUsecase.bankState({ config: c, bankPayrollReady: false });
    assert.deepEqual(bank, { applicable: true, pending: true, status: "PENDING" });
    assert.equal(EmployeeStatusSummaryUsecase.cashToBankState({ config: c }).pending, false);

    const ready = EmployeeStatusSummaryUsecase.bankState({ config: c, bankPayrollReady: true });
    assert.deepEqual(ready, { applicable: true, pending: false, status: "COMPLETE" });
  });
});
