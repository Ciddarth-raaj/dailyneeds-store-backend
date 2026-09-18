/**
 * Payrun Adjustments V1 - the rules, and above all the CALCULATION CONTRACT.
 *
 *   node --test utils/payrun_adjustments.test.js
 *
 * Every rule this stage has is pure, so every rule is proved here without a
 * database. What matters most is the contract: the later calculation stage
 * will consume `computeContract`, and these tests are what stop its answer
 * changing quietly - in particular the three zeroes (PF, ESI, gross) that
 * nobody would notice going wrong until an annual return did not reconcile.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  parseAmount,
  computeContract,
  deriveState,
  summarizeStates,
  templateColumns,
  readHeader,
  parseEmployeeId,
  parseRemarks,
  isEmptyRow,
} = require("./payrun_adjustments");
const {
  COMPONENT,
  COMPONENTS,
  ADJUSTMENT_STATE,
  COMPONENT_KIND,
  PAY_AFFECTING_COMPONENT_KEYS,
  isPayAffecting,
} = require("../constants/payrun_adjustments");

/* ==================================================== V1 is exactly six */

describe("V1 is a closed list of six components", () => {
  it("has exactly the six the specification names, in order", () => {
    assert.deepEqual(
      COMPONENTS.map((c) => c.key),
      [
        "INCENTIVE",
        "BONUS",
        "ARREARS",
        "ADVANCE_RECOVERY",
        "SHORTAGE_RECOVERY",
        "BALANCE_ADVANCE",
      ]
    );
  });

  it("has no generic or custom component", () => {
    const keys = COMPONENTS.map((c) => c.key);
    for (const forbidden of ["LOAN_RECOVERY", "OTHER_ADDITION", "OTHER_DEDUCTION", "CUSTOM", "OTHER"]) {
      assert.ok(!keys.includes(forbidden), `${forbidden} must not exist in V1`);
    }
  });

  it("declares PF: NO and ESI: NO for every component", () => {
    COMPONENTS.forEach((c) => {
      assert.equal(c.pf, false, `${c.key} must not attract PF in V1`);
      assert.equal(c.esi, false, `${c.key} must not attract ESI in V1`);
    });
  });

  it("names the five PAY-AFFECTING components, and Balance Advance is not one", () => {
    // Derived from the kinds rather than listed by hand, so a seventh
    // component joins the set by declaring its kind.
    assert.deepEqual(PAY_AFFECTING_COMPONENT_KEYS, [
      "INCENTIVE",
      "BONUS",
      "ARREARS",
      "ADVANCE_RECOVERY",
      "SHORTAGE_RECOVERY",
    ]);
    assert.equal(isPayAffecting("BALANCE_ADVANCE"), false);
    PAY_AFFECTING_COMPONENT_KEYS.forEach((key) =>
      assert.equal(isPayAffecting(key), true, `${key} must be pay-affecting`)
    );
  });

  it("classifies the three additions, the two deductions and the one informational", () => {
    const byKind = (kind) => COMPONENTS.filter((c) => c.kind === kind).map((c) => c.key);
    assert.deepEqual(byKind(COMPONENT_KIND.ADDITION), ["INCENTIVE", "BONUS", "ARREARS"]);
    assert.deepEqual(byKind(COMPONENT_KIND.DEDUCTION), ["ADVANCE_RECOVERY", "SHORTAGE_RECOVERY"]);
    assert.deepEqual(byKind(COMPONENT_KIND.INFORMATIONAL), ["BALANCE_ADVANCE"]);
  });
});

/* ============================================ reading an amount from a cell */

describe("amounts", () => {
  it("reads plain numbers, thousands separators, currency symbols and numeric cells", () => {
    assert.equal(parseAmount("1250").amount, 1250);
    assert.equal(parseAmount("1,250.50").amount, 1250.5);
    assert.equal(parseAmount("₹ 1,250").amount, 1250);
    assert.equal(parseAmount(1250.5).amount, 1250.5);
    assert.equal(parseAmount("  900  ").amount, 900);
  });

  it("treats blank AND zero as no value - neither is a confirmation", () => {
    for (const blank of [null, undefined, "", "   ", 0, "0", "0.00", "0.0"]) {
      assert.equal(parseAmount(blank).status, "EMPTY", `${JSON.stringify(blank)} must be EMPTY`);
    }
  });

  it("REFUSES a negative amount - the sign is the component's job", () => {
    assert.equal(parseAmount("-500").status, "NEGATIVE");
    assert.equal(parseAmount(-500).status, "NEGATIVE");
    assert.equal(parseAmount("-0.01").status, "NEGATIVE");
  });

  it("refuses a malformed amount", () => {
    for (const bad of ["abc", "1.2.3", "12a", "--5", "1/2", true, "1e5", "NaN"]) {
      assert.notEqual(parseAmount(bad).status, "OK", `${JSON.stringify(bad)} must not parse`);
    }
  });

  it("refuses more than two decimal places rather than rounding somebody's pay", () => {
    assert.equal(parseAmount("100.005").status, "TOO_PRECISE");
  });

  it("sums in paise, so six amounts do not drift", () => {
    const c = computeContract({ INCENTIVE: 0.1, BONUS: 0.2 });
    assert.equal(c.additions, 0.3);
  });
});

/* ================================================ the calculation contract */

describe("the calculation contract", () => {
  it("Incentive + amount adds to net pay and to nothing else", () => {
    const c = computeContract({ [COMPONENT.INCENTIVE]: 1500 });
    assert.equal(c.additions, 1500);
    assert.equal(c.deductions, 0);
    assert.equal(c.net_pay_delta, 1500);
    assert.equal(c.gross_delta, 0);
    assert.equal(c.earned_gross_delta, 0);
  });

  it("Bonus + amount adds to net pay", () => {
    assert.equal(computeContract({ [COMPONENT.BONUS]: 2500 }).net_pay_delta, 2500);
  });

  it("Arrears + amount adds to net pay", () => {
    assert.equal(computeContract({ [COMPONENT.ARREARS]: 700.25 }).net_pay_delta, 700.25);
  });

  it("Advance Recovery REDUCES the payable amount", () => {
    const c = computeContract({ [COMPONENT.ADVANCE_RECOVERY]: 1000 });
    assert.equal(c.deductions, 1000);
    assert.equal(c.net_pay_delta, -1000);
  });

  it("Shortage Recovery REDUCES the payable amount", () => {
    const c = computeContract({ [COMPONENT.SHORTAGE_RECOVERY]: 250 });
    assert.equal(c.deductions, 250);
    assert.equal(c.net_pay_delta, -250);
  });

  it("Balance Advance has ZERO calculation effect", () => {
    const c = computeContract({ [COMPONENT.BALANCE_ADVANCE]: 12000 });
    assert.equal(c.additions, 0);
    assert.equal(c.deductions, 0);
    assert.equal(c.net_pay_delta, 0);
    assert.equal(c.gross_delta, 0);
    assert.equal(c.earned_gross_delta, 0);
    assert.equal(c.pf_wage_delta, 0);
    assert.equal(c.esi_wage_delta, 0);
    // It IS carried - that is the whole reason it is stored.
    assert.equal(c.informational, 12000);
    assert.equal(c.by_component[COMPONENT.BALANCE_ADVANCE], 12000);
  });

  it("adding Balance Advance to a populated month changes no total", () => {
    const base = { INCENTIVE: 1000, ADVANCE_RECOVERY: 400 };
    const without = computeContract(base);
    const with_ = computeContract({ ...base, BALANCE_ADVANCE: 25000 });
    assert.equal(with_.net_pay_delta, without.net_pay_delta);
    assert.equal(with_.additions, without.additions);
    assert.equal(with_.deductions, without.deductions);
    assert.equal(with_.pf_wage_delta, without.pf_wage_delta);
    assert.equal(with_.esi_wage_delta, without.esi_wage_delta);
  });

  it("is the whole formula: + Incentive + Bonus + Arrears - Advance - Shortage", () => {
    const c = computeContract({
      INCENTIVE: 1000,
      BONUS: 2000,
      ARREARS: 500,
      ADVANCE_RECOVERY: 900,
      SHORTAGE_RECOVERY: 100,
      BALANCE_ADVANCE: 7500,
    });
    assert.equal(c.additions, 3500);
    assert.equal(c.deductions, 1000);
    assert.equal(c.net_pay_delta, 2500);
    assert.equal(c.informational, 7500);
  });

  it("PF and ESI impact is ZERO for Incentive, Bonus and Arrears", () => {
    for (const key of [COMPONENT.INCENTIVE, COMPONENT.BONUS, COMPONENT.ARREARS]) {
      const c = computeContract({ [key]: 9999 });
      assert.equal(c.pf_wage_delta, 0, `${key} must not move the PF wage`);
      assert.equal(c.esi_wage_delta, 0, `${key} must not move the ESI wage`);
    }
  });

  it("the recovery fields do NOT reduce the PF or ESI wage", () => {
    for (const key of [COMPONENT.ADVANCE_RECOVERY, COMPONENT.SHORTAGE_RECOVERY]) {
      const c = computeContract({ [key]: 5000 });
      assert.equal(c.pf_wage_delta, 0, `${key} must not reduce the PF wage`);
      assert.equal(c.esi_wage_delta, 0, `${key} must not reduce the ESI wage`);
    }
  });

  it("never reports a statutory delta for any combination V1 can produce", () => {
    const every = COMPONENTS.reduce((map, c) => ({ ...map, [c.key]: 4321 }), {});
    const c = computeContract(every);
    assert.equal(c.pf_wage_delta, 0);
    assert.equal(c.esi_wage_delta, 0);
    assert.equal(c.gross_delta, 0);
    assert.equal(c.earned_gross_delta, 0);
  });

  it("HAS_ADJUSTMENT counts only the pay-affecting components", () => {
    // `has_adjustment` answers "does this change what they are paid";
    // `has_any_value` answers "is there anything to store". Balance Advance is
    // the one component where the two differ, and they must not be conflated -
    // the first decides the month's state, the second decides what is saved.
    const balanceOnly = computeContract({ [COMPONENT.BALANCE_ADVANCE]: 8500 });
    assert.equal(balanceOnly.has_adjustment, false);
    assert.equal(balanceOnly.has_any_value, true);
    assert.equal(balanceOnly.informational, 8500);

    for (const key of [
      COMPONENT.INCENTIVE,
      COMPONENT.BONUS,
      COMPONENT.ARREARS,
      COMPONENT.ADVANCE_RECOVERY,
      COMPONENT.SHORTAGE_RECOVERY,
    ]) {
      const c = computeContract({ [key]: 1 });
      assert.equal(c.has_adjustment, true, `${key} must count as an adjustment`);
      assert.equal(c.has_any_value, true);
    }
  });

  it("an empty month contributes nothing and is not 'has adjustment'", () => {
    const c = computeContract({});
    assert.equal(c.net_pay_delta, 0);
    assert.equal(c.has_adjustment, false);
    assert.equal(computeContract({ INCENTIVE: 0, BONUS: "" }).has_adjustment, false);
    assert.equal(computeContract({}).has_any_value, false);
  });
});

/* ================================================== the state machine */

describe("the adjustment state", () => {
  it("a newly initialized employee with nothing stored is PENDING CONFIRMATION", () => {
    assert.equal(deriveState({}), ADJUSTMENT_STATE.NO_ADJUSTMENT_PENDING_CONFIRMATION);
  });

  it("blank and zero values are NOT a confirmation", () => {
    assert.equal(
      deriveState({ amounts: { INCENTIVE: 0, BONUS: "", ARREARS: null } }),
      ADJUSTMENT_STATE.NO_ADJUSTMENT_PENDING_CONFIRMATION
    );
  });

  it("an explicit confirmation, and only that, gives NO_ADJUSTMENT_CONFIRMED", () => {
    assert.equal(
      deriveState({ amounts: {}, confirmed_no_adjustment: true }),
      ADJUSTMENT_STATE.NO_ADJUSTMENT_CONFIRMED
    );
  });

  it("any stored amount gives HAS_ADJUSTMENT", () => {
    assert.equal(deriveState({ amounts: { BONUS: 1 } }), ADJUSTMENT_STATE.HAS_ADJUSTMENT);
  });

  it("BALANCE ADVANCE ALONE IS NOT AN ADJUSTMENT - it stays PENDING", () => {
    /*
     * The rule the whole informational kind exists for. A Balance Advance
     * changes no figure on the pay side, so recording one says nothing about
     * whether this employee has an adjustment this month - and leaving them
     * HAS_ADJUSTMENT over it would mean the month could never be finished
     * while advance balances were being maintained.
     */
    assert.equal(
      deriveState({ amounts: { BALANCE_ADVANCE: 8500 } }),
      ADJUSTMENT_STATE.NO_ADJUSTMENT_PENDING_CONFIRMATION
    );
  });

  it("a Balance Advance may coexist with a CONFIRMED no-adjustment", () => {
    // "This employee owes 8,500 and has no adjustment this month" is an
    // ordinary, true statement, and the state machine has to be able to hold
    // it.
    assert.equal(
      deriveState({ amounts: { BALANCE_ADVANCE: 8500 }, confirmed_no_adjustment: true }),
      ADJUSTMENT_STATE.NO_ADJUSTMENT_CONFIRMED
    );
  });

  it("a PAY-AFFECTING component beside a Balance Advance does make it an adjustment", () => {
    for (const key of [
      COMPONENT.INCENTIVE,
      COMPONENT.BONUS,
      COMPONENT.ARREARS,
      COMPONENT.ADVANCE_RECOVERY,
      COMPONENT.SHORTAGE_RECOVERY,
    ]) {
      assert.equal(
        deriveState({ amounts: { BALANCE_ADVANCE: 8500, [key]: 100 } }),
        ADJUSTMENT_STATE.HAS_ADJUSTMENT,
        `${key} beside a Balance Advance must be an adjustment`
      );
    }
  });

  it("AN ADJUSTMENT AFTER A CONFIRMATION LEAVES CONFIRMED - the transition", () => {
    // The repository also clears the flag in the same transaction as the
    // write; this proves the reported state is right even if a stale flag
    // survived, which is the belt to that braces.
    assert.equal(
      deriveState({ amounts: { INCENTIVE: 500 }, confirmed_no_adjustment: true }),
      ADJUSTMENT_STATE.HAS_ADJUSTMENT
    );
  });
});

/* ================================================== the month's completion */

describe("the month's completion is counted over the CURRENT population", () => {
  const row = (state) => ({ adjustment_state: state });

  it("counts the four numbers and derives completed from them", () => {
    const summary = summarizeStates([
      row(ADJUSTMENT_STATE.HAS_ADJUSTMENT),
      row(ADJUSTMENT_STATE.HAS_ADJUSTMENT),
      row(ADJUSTMENT_STATE.NO_ADJUSTMENT_CONFIRMED),
      row(ADJUSTMENT_STATE.NO_ADJUSTMENT_PENDING_CONFIRMATION),
    ]);
    assert.equal(summary.initialized_count, 4);
    assert.equal(summary.has_adjustment_count, 2);
    assert.equal(summary.no_adjustment_confirmed_count, 1);
    assert.equal(summary.pending_adjustment_confirmation_count, 1);
    assert.equal(summary.completed_count, 3);
    assert.equal(summary.is_complete, false);
  });

  it("is complete only when NOTHING is pending", () => {
    assert.equal(
      summarizeStates([
        row(ADJUSTMENT_STATE.HAS_ADJUSTMENT),
        row(ADJUSTMENT_STATE.NO_ADJUSTMENT_CONFIRMED),
      ]).is_complete,
      true
    );
  });

  it("THREE NEWLY INITIALIZED EMPLOYEES RE-OPEN A FINISHED MONTH BY THEMSELVES", () => {
    // 220 done. Nothing is stored about the three who arrive afterwards, so
    // `deriveState` puts them straight into pending and the month stops being
    // complete - no job, no backfill, no re-export.
    const finished = Array.from({ length: 220 }, () => row(ADJUSTMENT_STATE.HAS_ADJUSTMENT));
    assert.equal(summarizeStates(finished).is_complete, true);

    const newcomers = Array.from({ length: 3 }, () => row(deriveState({})));
    const now = summarizeStates([...finished, ...newcomers]);
    assert.equal(now.initialized_count, 223);
    assert.equal(now.has_adjustment_count, 220);
    assert.equal(now.pending_adjustment_confirmation_count, 3);
    assert.equal(now.is_complete, false);
  });
});

/* ============================================================ the template */

describe("the export template", () => {
  it("is one employee per row, with the components as COLUMNS", () => {
    assert.deepEqual(
      templateColumns().map((c) => c.label),
      [
        "Employee ID",
        "Employee Name",
        "Location",
        "Incentive",
        "Bonus",
        "Arrears",
        "Advance Recovery",
        "Shortage Recovery",
        "Balance Advance",
        "Remarks",
      ]
    );
  });
});

describe("reading an uploaded header row", () => {
  const labels = templateColumns().map((c) => c.label);

  it("accepts the template's own header, however it was cased or spaced", () => {
    const header = readHeader(["employee id", " Employee Name", "LOCATION", "Incentive"]);
    assert.equal(header.unknown.length, 0);
    assert.equal(header.hasEmployeeId, true);
    assert.deepEqual(header.componentColumns.map((c) => c.key), ["INCENTIVE"]);
  });

  it("REPORTS an unsupported column rather than ignoring it", () => {
    const header = readHeader([...labels, "Loan Recovery"]);
    assert.deepEqual(header.unknown, ["Loan Recovery"]);
  });

  it("reports a repeated column", () => {
    const header = readHeader(["Employee ID", "Bonus", "Bonus"]);
    assert.deepEqual(header.duplicated, ["Bonus"]);
  });

  it("notices a missing Employee ID column", () => {
    assert.equal(readHeader(["Employee Name", "Bonus"]).hasEmployeeId, false);
  });
});

describe("the small readers", () => {
  it("reads an employee id out of a text or numeric cell", () => {
    assert.equal(parseEmployeeId("1234"), 1234);
    assert.equal(parseEmployeeId(1234), 1234);
    assert.equal(parseEmployeeId("1234.0"), 1234);
    assert.equal(parseEmployeeId(""), null);
    assert.equal(parseEmployeeId("E1234"), null);
    assert.equal(parseEmployeeId("-2"), null);
  });

  it("trims remarks, treats empty as none, and bounds the length", () => {
    assert.equal(parseRemarks("  festival bonus ").value, "festival bonus");
    assert.equal(parseRemarks("   ").value, null);
    assert.equal(parseRemarks("x".repeat(501)).status, "TOO_LONG");
  });

  it("skips a completely empty spreadsheet row", () => {
    const header = readHeader(["Employee ID", "Bonus"]);
    assert.equal(isEmptyRow({ "Employee ID": "", Bonus: "  " }, header), true);
    assert.equal(isEmptyRow({ "Employee ID": "7", Bonus: "" }, header), false);
  });
});
