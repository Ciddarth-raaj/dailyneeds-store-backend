/**
 * Payrun eligibility - the dated rules, on their own.
 *
 *   node --test utils/payrun_eligibility.test.js
 *
 * WHY THIS FILE EXISTS BESIDE `usecase/payrun.test.js`. The usecase suite
 * proves the rules through the month - which is the right level for "an
 * employee without an approved salary is blocked". This one exercises the
 * pure functions directly, because the thing most likely to go wrong in them
 * is a date comparison at a boundary, and a boundary is cheapest to pin down
 * one call at a time.
 *
 * MOST OF IT IS ABOUT ONE RULE: a payrun is an EFFECTIVE-DATED monthly record,
 * so every question it asks about employment is answered by dates and never by
 * the employee's CURRENT status. That was a real bug - a September resignation
 * retroactively turned August's pay type to Cash - and these are the tests
 * that would have caught it.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  monthWindow,
  daysInMonth,
  employedInMonth,
  exitedByMonthEnd,
  defaultPayType,
  statutorySetupComplete,
  evaluateEmployee,
} = require("./payrun_eligibility");
const { PAY_TYPE, PAY_TYPE_SOURCE } = require("../constants/payrun");

/** Employee-master encoding: 1 Bank, 2 Cash. */
const BANK = 1;
const CASH = 2;

describe("the month window", () => {
  it("is the whole calendar month, leap years included", () => {
    assert.deepEqual(monthWindow(2026, 8), { from: "2026-08-01", to: "2026-08-31" });
    assert.deepEqual(monthWindow(2026, 2), { from: "2026-02-01", to: "2026-02-28" });
    assert.deepEqual(monthWindow(2028, 2), { from: "2028-02-01", to: "2028-02-29" });
    assert.equal(daysInMonth(2026, 12), 31);
  });
});

/* ============================================================================
 * THE PAY TYPE DEFAULT: THE EMPLOYEE MASTER, AND NOTHING ELSE
 * ==========================================================================*/

describe("defaultPayType reads the Employee Master and nothing else", () => {
  it("BANK in the master initializes BANK", () => {
    assert.deepEqual(defaultPayType({ payment_type: BANK }), {
      pay_type: PAY_TYPE.BANK,
      pay_type_source: PAY_TYPE_SOURCE.EMPLOYEE_MASTER,
    });
  });

  it("CASH in the master initializes CASH", () => {
    assert.deepEqual(defaultPayType({ payment_type: CASH }), {
      pay_type: PAY_TYPE.CASH,
      pay_type_source: PAY_TYPE_SOURCE.EMPLOYEE_MASTER,
    });
  });

  it("an unrecorded payment type is CASH, the same default employee creation applies", () => {
    assert.equal(defaultPayType({}).pay_type, PAY_TYPE.CASH);
    assert.equal(defaultPayType({ payment_type: null }).pay_type, PAY_TYPE.CASH);
  });

  /**
   * THE RULE THAT REPLACED THE RESIGNED DEFAULT, PINNED SHUT.
   *
   * Initialization must not move a leaver to CASH: a final settlement paid by
   * bank transfer is ordinary, and HR moves the ones that need moving. So NO
   * employment fact may change the answer - not a resignation date, not
   * `status`, not any lifecycle field somebody adds later.
   */
  it("NO employment fact changes the answer, in any combination", () => {
    const employmentFacts = [
      {},
      { status: 0 },
      { status: 1 },
      { resignation_date: "2020-01-01" },
      { resignation_date: "2026-08-15" },
      { resignation_date: "2026-09-10" },
      { status: 0, resignation_date: "2024-06-30" },
      { lifecycle_state: "EXITED" },
      { employment_period_ended_on: "2024-06-30" },
    ];
    employmentFacts.forEach((facts) => {
      assert.deepEqual(
        defaultPayType({ payment_type: BANK, ...facts }),
        { pay_type: PAY_TYPE.BANK, pay_type_source: PAY_TYPE_SOURCE.EMPLOYEE_MASTER },
        `a BANK employee defaulted differently for ${JSON.stringify(facts)}`
      );
      assert.deepEqual(
        defaultPayType({ payment_type: CASH, ...facts }),
        { pay_type: PAY_TYPE.CASH, pay_type_source: PAY_TYPE_SOURCE.EMPLOYEE_MASTER },
        `a CASH employee defaulted differently for ${JSON.stringify(facts)}`
      );
    });
  });

  it("takes only the employee, so an employment fact has no shape to arrive in", () => {
    // `employee = {}` is a defaulted parameter, so the declared arity is 0.
    // What matters is that there is no SECOND one: that options object is how
    // the resigned default got in the first time.
    assert.equal(
      defaultPayType.length,
      0,
      "defaultPayType must take nothing beyond the employee record"
    );
    // And a caller that passes the old options object anyway changes nothing.
    assert.equal(defaultPayType({ payment_type: BANK }, { resigned: true }).pay_type, PAY_TYPE.BANK);
  });

  it("RESIGNED_DEFAULT is gone rather than left declared and unreachable", () => {
    assert.deepEqual(Object.keys(PAY_TYPE_SOURCE).sort(), ["EMPLOYEE_MASTER", "MANUAL"]);
  });
});

/* ============================================================================
 * THE BADGE: DATED, AND DISPLAY ONLY
 * ==========================================================================*/

describe("exitedByMonthEnd is dated, and decides nothing", () => {
  it("somebody who leaves in September had not left by the end of August", () => {
    assert.equal(exitedByMonthEnd({ year: 2026, month: 8, ended_on: "2026-09-10" }), false);
  });

  it("the same person HAS left by the end of September", () => {
    assert.equal(exitedByMonthEnd({ year: 2026, month: 9, ended_on: "2026-09-10" }), true);
  });

  it("an exit on the FINAL DAY of the month counts; the first of the next does not", () => {
    assert.equal(exitedByMonthEnd({ year: 2026, month: 8, ended_on: "2026-08-31" }), true);
    assert.equal(exitedByMonthEnd({ year: 2026, month: 8, ended_on: "2026-09-01" }), false);
  });

  it("no exit date is not an exit, whatever the current status says", () => {
    assert.equal(exitedByMonthEnd({ year: 2026, month: 8, ended_on: null }), false);
    assert.equal(
      exitedByMonthEnd({ year: 2026, month: 8, ended_on: null, status: 0 }),
      false,
      "the old status argument is not read even when a caller passes it"
    );
  });

  it("a long-past exit stays exited for every month after it", () => {
    assert.equal(exitedByMonthEnd({ year: 2026, month: 8, ended_on: "2024-01-15" }), true);
  });

  it("a Date object and a timestamp string read the same as a date string", () => {
    assert.equal(exitedByMonthEnd({ year: 2026, month: 8, ended_on: "2026-09-10 00:00:00" }), false);
    assert.equal(
      exitedByMonthEnd({ year: 2026, month: 9, ended_on: new Date(Date.UTC(2026, 8, 10)) }),
      true
    );
  });
});

describe("employedInMonth", () => {
  it("any part of the month counts, at both ends", () => {
    const august = { year: 2026, month: 8 };
    assert.equal(employedInMonth({ ...august, joined_on: "2026-08-31" }), true);
    assert.equal(employedInMonth({ ...august, joined_on: "2026-09-01" }), false);
    assert.equal(employedInMonth({ ...august, ended_on: "2026-08-01" }), true);
    assert.equal(employedInMonth({ ...august, ended_on: "2026-07-31" }), false);
  });

  it("an unknown joining date leaves the window open rather than excluding anybody", () => {
    assert.equal(employedInMonth({ year: 2026, month: 8, joined_on: null }), true);
  });
});

describe("statutorySetupComplete", () => {
  it("an unanswered applicability is not 'no'", () => {
    assert.equal(statutorySetupComplete({ pf_applicable: null, esi_applicable: 0 }), false);
    assert.equal(statutorySetupComplete({ pf_applicable: 0, esi_applicable: null }), false);
    assert.equal(statutorySetupComplete({ pf_applicable: 0, esi_applicable: 0 }), true);
  });

  it("an identifier is required only where the scheme applies", () => {
    assert.equal(statutorySetupComplete({ pf_applicable: 1, esi_applicable: 0 }), false);
    assert.equal(
      statutorySetupComplete({ pf_applicable: 1, esi_applicable: 0, uan: "100200300400" }),
      true
    );
    assert.equal(
      statutorySetupComplete({ pf_applicable: 1, esi_applicable: 0, pf_number: "TN/123" }),
      true,
      "a PF number stands in for a UAN"
    );
    assert.equal(statutorySetupComplete({ pf_applicable: 0, esi_applicable: 1 }), false);
    assert.equal(
      statutorySetupComplete({ pf_applicable: 0, esi_applicable: 1, esi_number: "31000123" }),
      true
    );
  });

  it("a blank string is not an identifier", () => {
    assert.equal(
      statutorySetupComplete({ pf_applicable: 1, esi_applicable: 0, uan: "   " }),
      false
    );
  });
});

/* ===================================================== the whole decision == */

describe("evaluateEmployee defaults the pay type from the master alone", () => {
  const base = {
    salary: { monthly_gross: 26000 },
    attendance: { is_final: 1 },
    pending_regularizations: 0,
    pending_ot: 0,
  };
  const employee = (over) => ({
    payment_type: BANK,
    pf_applicable: 0,
    esi_applicable: 0,
    account_no: "1",
    ifsc: "X",
    date_of_joining: "2019-06-01",
    ...over,
  });

  it("a resigned employee whose master says BANK initializes BANK", () => {
    const verdict = evaluateEmployee({
      year: 2026,
      month: 9,
      employee: employee({ payment_type: BANK, status: 0, resignation_date: "2026-09-10" }),
      ...base,
    });
    assert.equal(verdict.pay_type, PAY_TYPE.BANK);
    assert.equal(verdict.pay_type_source, PAY_TYPE_SOURCE.EMPLOYEE_MASTER);
    assert.equal(verdict.status, "READY");
  });

  it("a resigned employee whose master says CASH initializes CASH - as the MASTER's value", () => {
    const verdict = evaluateEmployee({
      year: 2026,
      month: 9,
      employee: employee({ payment_type: CASH, status: 0, resignation_date: "2026-09-10" }),
      ...base,
    });
    assert.equal(verdict.pay_type, PAY_TYPE.CASH);
    assert.equal(
      verdict.pay_type_source,
      PAY_TYPE_SOURCE.EMPLOYEE_MASTER,
      "CASH here is inherited, not a resigned default wearing a new name"
    );
  });

  it("an active employee whose master says BANK initializes BANK", () => {
    const verdict = evaluateEmployee({
      year: 2026,
      month: 8,
      employee: employee({ payment_type: BANK, status: 1, resignation_date: null }),
      ...base,
    });
    assert.equal(verdict.pay_type, PAY_TYPE.BANK);
    assert.equal(verdict.pay_type_source, PAY_TYPE_SOURCE.EMPLOYEE_MASTER);
  });

  it("the month an employee leaves in defaults exactly as every other month does", () => {
    const leaving = {
      year: 2026,
      month: 9,
      employee: employee({ payment_type: BANK, status: 0, resignation_date: "2026-09-10" }),
      ...base,
    };
    const august = {
      ...leaving,
      month: 8,
      employee: employee({ payment_type: BANK, status: 1, resignation_date: null }),
    };
    assert.equal(evaluateEmployee(leaving).pay_type, evaluateEmployee(august).pay_type);
  });

  it("the badge is dated, and does not follow the pay type", () => {
    const record = employee({ payment_type: BANK, status: 0, resignation_date: "2026-09-10" });
    assert.equal(evaluateEmployee({ year: 2026, month: 8, employee: record, ...base }).exited_in_month, false);
    assert.equal(evaluateEmployee({ year: 2026, month: 9, employee: record, ...base }).exited_in_month, true);
    // Both months still default to the master's BANK.
    assert.equal(evaluateEmployee({ year: 2026, month: 8, employee: record, ...base }).pay_type, PAY_TYPE.BANK);
    assert.equal(evaluateEmployee({ year: 2026, month: 9, employee: record, ...base }).pay_type, PAY_TYPE.BANK);
  });

  it("an undated exit with an inactive status still changes nothing", () => {
    const verdict = evaluateEmployee({
      year: 2026,
      month: 8,
      employee: employee({ payment_type: BANK, status: 0, resignation_date: null }),
      ...base,
    });
    assert.equal(verdict.pay_type, PAY_TYPE.BANK);
    assert.equal(verdict.exited_in_month, false);
    assert.equal(verdict.status, "READY");
  });

  it("the verdict for a past month does not change when the record changes later", () => {
    const august = {
      year: 2026,
      month: 8,
      employee: employee({ status: 1, resignation_date: null }),
      ...base,
    };
    const before = evaluateEmployee(august);
    const after = evaluateEmployee({
      ...august,
      employee: employee({ status: 0, resignation_date: "2026-09-10" }),
    });
    assert.equal(before.pay_type, after.pay_type);
    assert.equal(before.exited_in_month, after.exited_in_month);
    assert.equal(before.status, after.status);
  });
});
