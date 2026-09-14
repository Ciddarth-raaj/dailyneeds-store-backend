/**
 * A NEW EMPLOYEE IS PAID IN CASH UNTIL SOMEBODY SAYS OTHERWISE.
 *
 *   node --test repository/employee_payment_type_default.test.js
 *
 * The default is enforced in the REPOSITORY layer - the last thing every
 * employee-creation path crosses before its INSERT - so this drives the two
 * real create functions (`repository/employee_master.createEmployee`, the C2
 * Add Employee path, and `repository/employee.create`, the legacy HR one)
 * against fake database handles and reads the SQL and the bound parameters
 * they actually produce. Nothing here mocks the thing under test.
 *
 * The second half checks that the HR Onboarding dashboard then classifies
 * such an employee correctly - WITHOUT changing a single dashboard rule.
 * The rules are the ones already in `usecase/employee_status_summary.js`;
 * what changed is that a new employee no longer arrives at them as NULL.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  PAYMENT_TYPE,
  DEFAULT_PAYMENT_TYPE_ON_CREATE,
  isValidPaymentType,
  paymentTypeForCreate,
  applyDefaultPaymentType,
} = require("../utils/payment_type");
const makeMasterRepo = require("./employee_master");
const makeLegacyRepo = require("./employee");
const { EmployeeStatusSummaryUsecase } = require("../usecase/employee_status_summary");

/* ----------------------------------------------------------- the fakes -- */

/** A transaction that records the INSERT the master repository builds. */
function fakeTx() {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      return { insertId: 2284 };
    },
  };
}

/** The legacy repository takes a callback-style `mysql` connection. */
function fakeDb() {
  const calls = [];
  return {
    calls,
    query(sql, params, cb) {
      calls.push({ sql, params });
      cb(null, { insertId: 2284 });
    },
  };
}

/** What the master repository's INSERT bound for one column. */
function boundValue({ sql, params }, column) {
  const columns = sql
    .slice(sql.indexOf("(") + 1, sql.indexOf(")"))
    .split(",")
    .map((c) => c.trim().replace(/`/g, ""));
  const i = columns.indexOf(column);
  assert.notEqual(i, -1, `the INSERT names ${column}`);
  return params[i];
}

/** The legacy INSERT is a fixed column list; find the position the same way. */
function legacyBoundValue({ sql, params }, column) {
  const columns = sql
    .slice(sql.indexOf("(") + 1, sql.indexOf(")"))
    .split(",")
    .map((c) => c.trim());
  const i = columns.indexOf(column);
  assert.notEqual(i, -1, `the INSERT names ${column}`);
  return params[i];
}

const PERSON = {
  employee_name: "New Joiner",
  date_of_joining: "2026-09-14",
  store_id: 3,
  designation_id: 7,
  department_id: 2,
  status: 1,
};

/* ------------------------------------------------------------ the rule -- */

describe("the default itself", () => {
  it("is Cash, which is 2", () => {
    assert.equal(DEFAULT_PAYMENT_TYPE_ON_CREATE, PAYMENT_TYPE.CASH);
    assert.equal(DEFAULT_PAYMENT_TYPE_ON_CREATE, 2);
  });

  it("recognises only Bank and Cash as explicitly supplied", () => {
    assert.equal(isValidPaymentType(1), true);
    assert.equal(isValidPaymentType(2), true);
    assert.equal(isValidPaymentType("1"), true, "the legacy screens post strings");
    for (const nothing of [null, undefined, "", "   ", 0, 3, -1, 1.5, "bank", {}, []]) {
      assert.equal(isValidPaymentType(nothing), false, `${JSON.stringify(nothing)} is not a payment route`);
    }
  });

  it("falls back to Cash for anything that is not a payment route", () => {
    for (const nothing of [null, undefined, "", 0, 3, "bank"]) {
      assert.equal(paymentTypeForCreate(nothing), PAYMENT_TYPE.CASH);
    }
  });

  it("preserves an explicit Bank, as a number", () => {
    assert.equal(paymentTypeForCreate(PAYMENT_TYPE.BANK), PAYMENT_TYPE.BANK);
    assert.equal(paymentTypeForCreate("1"), PAYMENT_TYPE.BANK);
  });

  it("never rewrites the caller's own object", () => {
    const body = Object.freeze({ employee_name: "Somebody" });
    const out = applyDefaultPaymentType(body);
    assert.equal(out.payment_type, PAYMENT_TYPE.CASH);
    assert.equal("payment_type" in body, false);
  });
});

/* ---------------------------------------------- C2 Add Employee create -- */

describe("repository/employee_master.createEmployee", () => {
  it("stores Cash when the create says nothing about the payment route", async () => {
    const repo = makeMasterRepo({});
    const tx = fakeTx();
    const id = await repo.createEmployee(tx, { ...PERSON });
    assert.equal(id, 2284);
    assert.equal(boundValue(tx.calls[0], "payment_type"), PAYMENT_TYPE.CASH);
  });

  it("stores Cash rather than NULL when the payment route is sent as null", async () => {
    const repo = makeMasterRepo({});
    const tx = fakeTx();
    await repo.createEmployee(tx, { ...PERSON, payment_type: null });
    assert.equal(boundValue(tx.calls[0], "payment_type"), PAYMENT_TYPE.CASH);
  });

  it("PRESERVES an explicitly supplied Bank", async () => {
    const repo = makeMasterRepo({});
    const tx = fakeTx();
    await repo.createEmployee(tx, { ...PERSON, payment_type: PAYMENT_TYPE.BANK });
    assert.equal(boundValue(tx.calls[0], "payment_type"), PAYMENT_TYPE.BANK);
  });

  it("still refuses a client-supplied employee_id", async () => {
    const repo = makeMasterRepo({});
    await assert.rejects(
      () => repo.createEmployee(fakeTx(), { ...PERSON, employee_id: 5 }),
      /must not be given an employee_id/
    );
  });

  it("leaves every other field exactly as it was given", async () => {
    const repo = makeMasterRepo({});
    const tx = fakeTx();
    await repo.createEmployee(tx, { ...PERSON, salary: 18000 });
    assert.equal(boundValue(tx.calls[0], "employee_name"), "New Joiner");
    assert.equal(boundValue(tx.calls[0], "store_id"), 3);
    assert.equal(boundValue(tx.calls[0], "salary"), 18000);
  });
});

/* ------------------------------------------------- legacy HR create ----- */

describe("repository/employee.create (legacy)", () => {
  it("stores Cash when the payment route arrives empty", async () => {
    const db = fakeDb();
    const repo = makeLegacyRepo(db);
    const res = await repo.create({ ...PERSON, employee_id: 2284, payment_type: "" });
    assert.equal(res.code, 200);
    assert.equal(legacyBoundValue(db.calls[0], "payment_type"), PAYMENT_TYPE.CASH);
  });

  it("PRESERVES an explicitly supplied Bank", async () => {
    const db = fakeDb();
    const repo = makeLegacyRepo(db);
    await repo.create({ ...PERSON, employee_id: 2284, payment_type: PAYMENT_TYPE.BANK });
    assert.equal(legacyBoundValue(db.calls[0], "payment_type"), PAYMENT_TYPE.BANK);
  });
});

/* ------------------------------------------ NOTHING ELSE IS TOUCHED ----- */

describe("no existing row is rewritten", () => {
  it("the C2 master UPDATE has no payment-route opinion at all", async () => {
    const repo = makeMasterRepo({});
    const tx = fakeTx();
    // An ordinary edit of an unrelated column on an employee whose payment
    // type is NULL - employee 2283, say. The default belongs to CREATES
    // only: opening or saving a profile must never decide a payment route
    // on somebody's behalf, and no backfill happens anywhere.
    await repo.updateEmployee(tx, 2283, { qualification: "B.Com" });
    assert.equal(/payment_type/.test(tx.calls[0].sql), false, "the UPDATE never names payment_type");
    assert.equal(tx.calls[0].params.includes(PAYMENT_TYPE.CASH), false);
  });

  it("an explicit Cash -> Bank edit still works normally", async () => {
    // The payment route is edited through the legacy Payment Details save
    // (`/employee/updatedata` -> `updateEmployeeDetails`), which is
    // untouched by this change: what it is handed is what it writes.
    const db = fakeDb();
    const repo = makeLegacyRepo(db);
    await repo.updateEmployeeDetails({ payment_type: PAYMENT_TYPE.BANK, bank_name: "HDFC" }, 2284);
    assert.match(db.calls[0].sql, /^UPDATE new_employee SET \? WHERE employee_id = \?$/);
    assert.deepEqual(db.calls[0].params[0], { payment_type: PAYMENT_TYPE.BANK, bank_name: "HDFC" });
    assert.equal(db.calls[0].params[1], 2284);
  });

  it("an edit that says nothing about the payment route does not invent one", async () => {
    const db = fakeDb();
    const repo = makeLegacyRepo(db);
    await repo.updateEmployeeDetails({ qualification: "B.Com" }, 2283);
    assert.equal("payment_type" in db.calls[0].params[0], false);
  });
});

/* ------------------------------------- the dashboard, rules unchanged --- */

const config = (paymentType) => ({
  paymentTypeRecorded: paymentType !== null && paymentType !== undefined,
  paysInCash: paymentType === PAYMENT_TYPE.CASH,
});

describe("HR Onboarding dashboard, for the employee this create now produces", () => {
  it("a newly created Cash employee is Cash -> Bank Pending and NOT Bank Pending", () => {
    const c = config(PAYMENT_TYPE.CASH);
    const bank = EmployeeStatusSummaryUsecase.bankState({ config: c, bankPayrollReady: false });
    const cashToBank = EmployeeStatusSummaryUsecase.cashToBankState({ config: c });

    assert.equal(cashToBank.pending, true);
    assert.equal(cashToBank.status, "PENDING");
    assert.equal(bank.pending, false);
    assert.equal(bank.status, "NOT_APPLICABLE");
    assert.equal(bank.applicable, false);
  });

  it("a Bank employee without a verified account is still Bank Pending", () => {
    const c = config(PAYMENT_TYPE.BANK);
    const bank = EmployeeStatusSummaryUsecase.bankState({ config: c, bankPayrollReady: false });
    assert.equal(bank.applicable, true);
    assert.equal(bank.pending, true);
    assert.equal(bank.status, "PENDING");
    assert.equal(EmployeeStatusSummaryUsecase.cashToBankState({ config: c }).pending, false);
  });

  it("an existing NULL employee is UNKNOWN on both, exactly as before", () => {
    const c = config(null);
    assert.deepEqual(EmployeeStatusSummaryUsecase.bankState({ config: c, bankPayrollReady: false }), {
      applicable: null,
      pending: false,
      status: "UNKNOWN",
    });
    assert.deepEqual(EmployeeStatusSummaryUsecase.cashToBankState({ config: c }), {
      pending: false,
      status: "UNKNOWN",
    });
  });

  it("payroll semantics are unchanged: NULL is payroll pending, Cash is not held up by an account", () => {
    const salary = { hasLiveSalary: true, ctcApplied: true };

    const unknown = EmployeeStatusSummaryUsecase.payrollState({
      salary,
      config: config(null),
      bankPayrollReady: false,
    });
    assert.deepEqual(unknown, { pending: true, missing: ["payment_type"] });

    const cash = EmployeeStatusSummaryUsecase.payrollState({
      salary,
      config: config(PAYMENT_TYPE.CASH),
      bankPayrollReady: false,
    });
    assert.deepEqual(cash, { pending: false, missing: [] });

    const bank = EmployeeStatusSummaryUsecase.payrollState({
      salary,
      config: config(PAYMENT_TYPE.BANK),
      bankPayrollReady: false,
    });
    assert.deepEqual(bank, { pending: true, missing: ["payment_account"] });
  });
});
