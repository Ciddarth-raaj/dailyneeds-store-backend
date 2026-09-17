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
  resignedForMonth,
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
 * THE REGRESSION: A LATER RESIGNATION MUST NOT REWRITE AN EARLIER MONTH
 * ==========================================================================*/

describe("resignedForMonth is decided by the date, and only by the date", () => {
  /**
   * THE BUG, EXACTLY AS REPORTED. Worked all of August, resigned 10 September.
   * Viewed in October, `status` says resigned - and August must not care.
   */
  it("somebody who resigns in September is NOT resigned for August", () => {
    assert.equal(
      resignedForMonth({ year: 2026, month: 8, ended_on: "2026-09-10" }),
      false
    );
  });

  it("the same person IS resigned for their September payrun", () => {
    assert.equal(
      resignedForMonth({ year: 2026, month: 9, ended_on: "2026-09-10" }),
      true
    );
  });

  it("a resignation on the FINAL DAY of the month counts as resigned for it", () => {
    assert.equal(
      resignedForMonth({ year: 2026, month: 8, ended_on: "2026-08-31" }),
      true
    );
  });

  it("a resignation on the FIRST DAY of the NEXT month does not", () => {
    assert.equal(
      resignedForMonth({ year: 2026, month: 8, ended_on: "2026-09-01" }),
      false
    );
  });

  it("no exit date is NOT a resignation, whatever the current status says", () => {
    assert.equal(resignedForMonth({ year: 2026, month: 8, ended_on: null }), false);
    // Even when a caller passes the old `status` argument, which the rule no
    // longer reads: an undated exit cannot be placed in a month, and guessing
    // would silently rewrite every earlier month to Cash.
    assert.equal(
      resignedForMonth({ year: 2026, month: 8, ended_on: null, status: 0 }),
      false
    );
  });

  it("a long-past resignation stays resigned for every month after it", () => {
    assert.equal(resignedForMonth({ year: 2026, month: 8, ended_on: "2024-01-15" }), true);
  });

  it("a Date object and a timestamp string are read the same way as a date string", () => {
    assert.equal(
      resignedForMonth({ year: 2026, month: 8, ended_on: "2026-09-10 00:00:00" }),
      false
    );
    assert.equal(
      resignedForMonth({ year: 2026, month: 9, ended_on: new Date(Date.UTC(2026, 8, 10)) }),
      true
    );
  });
});

describe("the pay type default follows the DATED answer", () => {
  const employee = { payment_type: BANK };

  it("August defaults to BANK for somebody who resigned in September", () => {
    const resigned = resignedForMonth({ year: 2026, month: 8, ended_on: "2026-09-10" });
    assert.deepEqual(defaultPayType(employee, { resigned }), {
      pay_type: PAY_TYPE.BANK,
      pay_type_source: PAY_TYPE_SOURCE.EMPLOYEE_MASTER,
    });
  });

  it("their September defaults to CASH", () => {
    const resigned = resignedForMonth({ year: 2026, month: 9, ended_on: "2026-09-10" });
    assert.deepEqual(defaultPayType(employee, { resigned }), {
      pay_type: PAY_TYPE.CASH,
      pay_type_source: PAY_TYPE_SOURCE.RESIGNED_DEFAULT,
    });
  });

  it("a master set to Cash stays Cash, and is not relabelled as a resigned default", () => {
    assert.deepEqual(defaultPayType({ payment_type: CASH }, { resigned: false }), {
      pay_type: PAY_TYPE.CASH,
      pay_type_source: PAY_TYPE_SOURCE.EMPLOYEE_MASTER,
    });
  });

  it("an unrecorded payment type is Cash, the same default employee creation applies", () => {
    assert.equal(defaultPayType({}, { resigned: false }).pay_type, PAY_TYPE.CASH);
    assert.equal(defaultPayType({ payment_type: null }, {}).pay_type, PAY_TYPE.CASH);
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

describe("evaluateEmployee does not read the current status either", () => {
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

  it("August is READY and BANK for somebody whose record now says resigned", () => {
    const verdict = evaluateEmployee({
      year: 2026,
      month: 8,
      employee: employee({ status: 0, resignation_date: "2026-09-10" }),
      ...base,
    });
    assert.equal(verdict.status, "READY");
    assert.equal(verdict.resigned, false);
    assert.equal(verdict.pay_type, PAY_TYPE.BANK);
    assert.equal(verdict.pay_type_source, PAY_TYPE_SOURCE.EMPLOYEE_MASTER);
  });

  it("September for the same person is CASH", () => {
    const verdict = evaluateEmployee({
      year: 2026,
      month: 9,
      employee: employee({ status: 0, resignation_date: "2026-09-10" }),
      ...base,
    });
    assert.equal(verdict.resigned, true);
    assert.equal(verdict.pay_type, PAY_TYPE.CASH);
    assert.equal(verdict.pay_type_source, PAY_TYPE_SOURCE.RESIGNED_DEFAULT);
  });

  it("an inactive status with NO exit date never rewrites an earlier month", () => {
    const verdict = evaluateEmployee({
      year: 2026,
      month: 8,
      employee: employee({ status: 0, resignation_date: null }),
      ...base,
    });
    assert.equal(verdict.resigned, false);
    assert.equal(verdict.pay_type, PAY_TYPE.BANK, "the master's pay type still applies");
    assert.equal(
      verdict.status,
      "READY",
      "and an undated exit must not block the month either - only dates decide"
    );
  });

  it("the verdict for a past month does not change when the record changes later", () => {
    const august = {
      year: 2026,
      month: 8,
      employee: employee({ status: 1, resignation_date: null }),
      ...base,
    };
    const before = evaluateEmployee(august);
    // The same August, read after the person resigned in September.
    const after = evaluateEmployee({
      ...august,
      employee: employee({ status: 0, resignation_date: "2026-09-10" }),
    });
    assert.equal(before.pay_type, after.pay_type);
    assert.equal(before.resigned, after.resigned);
    assert.equal(before.status, after.status);
  });
});
