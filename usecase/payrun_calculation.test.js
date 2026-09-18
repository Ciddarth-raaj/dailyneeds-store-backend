/**
 * Payrun Calculation & Review - the stage, driven with fake repositories.
 *
 *   node --test usecase/payrun_calculation.test.js
 *
 * The fakes below are an in-memory version of the two tables this stage owns
 * plus the reads it makes of initialization, attendance and adjustments. That
 * is enough to prove the things no pure test can reach:
 *
 *   only INITIALIZED employees take part
 *   a source that moved is DETECTED and changes no stored figure
 *   recalculation refreshes the sources and preserves the adjustments and the
 *     pay type
 *   a pending adjustment confirmation blocks approval
 *   approval is individual AND bulk by the same path
 *   approval locks ONE EMPLOYEE, and the rest of the month stays editable
 *   a locked employee cannot be recalculated, cannot have their adjustments
 *     edited and cannot have their pay type changed
 *   approved_locked => payslip_eligible, and nothing else is
 *
 * The FIGURES are proved as arithmetic in `utils/payrun_calculation.test.js`.
 */
const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const buildCalculation = require("./payrun_calculation");
const buildPayrun = require("./payrun");
const buildAdjustments = require("./payrun_adjustment");
const { CALC_STATUS, ROW_RESULT, NRM_SOURCE } = require("../constants/payrun_calculation");
const { COMPONENT } = require("../constants/payrun_adjustments");

/* ============================================================== the fakes */

/**
 * ONE IN-MEMORY WORLD BEHIND ALL THREE STAGES, so that "a locked employee's
 * adjustments cannot be edited" is proved against the SAME lock the
 * calculation stage took, rather than against a second mock of it.
 */
class World {
  constructor() {
    this.year = 2026;
    this.month = 8;
    this.employees = new Map();      // employee_id -> snapshot row
    this.attendance = new Map();     // employee_id -> monthly payroll row
    this.nrm = new Map();            // employee_id -> grouped day rows
    this.pending = new Map();        // employee_id -> { pending_regularizations, pending_ot }
    this.salaries = new Map();       // employee_id -> current approved salary
    this.amounts = new Map();        // employee_id -> { component: amount }
    this.states = new Map();         // employee_id -> { confirmed_no_adjustment }
    this.calculations = new Map();   // employee_id -> calculation row
    this.audit = [];
    this.period = null;
    this.nextId = 1;
  }

  /** An ordinary initialized employee with a clean, fully attended month. */
  add(employeeId, over = {}) {
    this.employees.set(employeeId, {
      payrun_employee_id: 100 + employeeId,
      employee_id: employeeId,
      employee_name: `Employee ${employeeId}`,
      store_id: 1,
      store_name: "Main",
      designation_name: "Assistant",
      date_of_joining: "2018-04-01",
      salary_id: 500 + employeeId,
      salary_effective_from: "2026-04-01",
      monthly_gross: 26000,
      basic: 13000,
      conveyance: 2500,
      hra: 5000,
      special_allowance: 5500,
      pf_applicable: 1,
      esi_applicable: 1,
      uan: "100200300400",
      esi_number: "3100000000",
      pay_type: "BANK",
      pay_type_source: "EMPLOYEE_MASTER",
      ...(over.employee || {}),
    });
    this.salaries.set(employeeId, {
      employee_id: employeeId,
      salary_id: 500 + employeeId,
      effective_from: "2026-04-01",
      monthly_gross: 26000,
      ...(over.salary || {}),
    });
    this.attendance.set(employeeId, {
      employee_id: employeeId,
      attendance_monthly_payroll_id: 900 + employeeId,
      payroll_version: 1,
      calculated_at: "2026-09-01 02:00:00.000",
      is_final: 1,
      salary_days: 26,
      extra_days: 0,
      salary_day_earnings: 26000,
      extra_day_earnings: 0,
      shortage_minutes: 0,
      missing_minute_deduction: 0,
      approved_ot_minutes: 0,
      approved_ot_earnings: 0,
      ...(over.attendance || {}),
    });
    /*
     * THE DAY-LEVEL NRM EVIDENCE, CARRYING THE SAME APPROVED OT the monthly
     * roll-up above reports. The two are one engine's two views of one fact
     * and the calculation refuses them when they disagree, so a fixture that
     * let them drift would be testing the wrong thing.
     *
     * The default is one 8-hour group carrying the whole month's approved OT;
     * a test that needs the overtime split across NRMs passes its own groups.
     */
    const monthlyOt = Number(this.attendance.get(employeeId).approved_ot_minutes || 0);
    this.nrm.set(
      employeeId,
      (over.nrm_groups || [
        {
          nrm_minutes: 480,
          break_allowance_source: NRM_SOURCE.SHIFT,
          day_count: 26,
          approved_ot_minutes: monthlyOt,
        },
      ]).map((g) => ({ employee_id: employeeId, ...g }))
    );

    // Confirmed as having no adjustment, so the ordinary employee is READY and
    // each test can take exactly one thing away.
    this.states.set(employeeId, { employee_id: employeeId, confirmed_no_adjustment: 1, remarks: null });
    return this;
  }
}

class FakeCalculationRepo {
  constructor(world) {
    this.world = world;
  }

  async listInitialized({ store_ids = null, employee_ids = null }) {
    return [...this.world.employees.values()]
      .filter((e) => (store_ids === null ? true : store_ids.includes(e.store_id)))
      .filter((e) => (employee_ids === null ? true : employee_ids.includes(e.employee_id)))
      .map((e) => ({ ...e }));
  }

  async listAttendanceMonths(ids) {
    return ids.map((id) => this.world.attendance.get(id)).filter(Boolean).map((r) => ({ ...r }));
  }

  async listEffectiveNrm(ids) {
    return ids.flatMap((id) => this.world.nrm.get(id) || []);
  }

  async listStatutoryContext(ids) {
    return ids.map((id) => ({
      employee_id: id,
      dob: "1990-06-15",
      previous_eps_member: 0,
      date_of_joining: "2018-04-01",
      pf_applicable: this.world.employees.get(id).pf_applicable,
      esi_applicable: this.world.employees.get(id).esi_applicable,
    }));
  }

  async listCalculations({ employee_ids = null }) {
    return [...this.world.calculations.values()]
      .filter((c) => employee_ids === null || employee_ids.includes(c.employee_id))
      .map((c) => ({ ...c }));
  }

  async listLockedEmployeeIds({ employee_ids = null }) {
    return [...this.world.calculations.values()]
      .filter((c) => c.status === "APPROVED_LOCKED")
      .filter((c) => employee_ids === null || employee_ids.includes(c.employee_id))
      .map((c) => Number(c.employee_id));
  }

  async listAudit({ employee_id }) {
    return this.world.audit.filter((a) => a.employee_id === employee_id).reverse();
  }

  /** The real one's ON DUPLICATE KEY UPDATE, including its locked-row guard. */
  async saveCalculations(rows) {
    const written = [];
    rows.forEach((row) => {
      const existing = this.world.calculations.get(row.employee_id);
      if (existing && existing.status === "APPROVED_LOCKED") {
        written.push({ ...existing });
        return;
      }
      const next = {
        ...row,
        payrun_calculation_id: existing ? existing.payrun_calculation_id : this.world.nextId++,
        calculation_revision: existing ? Number(existing.calculation_revision) + 1 : 1,
        status: "CALCULATED",
        approved_by: null,
        approved_at: null,
        locked_by: null,
        locked_at: null,
        calculated_at: "2026-09-05 10:00:00",
      };
      this.world.calculations.set(row.employee_id, next);
      this.world.audit.push({
        employee_id: row.employee_id,
        action: next.calculation_revision > 1 ? "RECALCULATE" : "CALCULATE",
        calculation_revision: next.calculation_revision,
        net_pay: row.net_pay,
      });
      written.push({ ...next });
    });
    return written;
  }

  async approve({ employees, approved_by }) {
    return employees.map((entry) => {
      const row = this.world.calculations.get(entry.employee_id);
      if (!row) return { employee_id: entry.employee_id, outcome: "NO_CALCULATION" };
      if (row.status === "APPROVED_LOCKED") {
        return { employee_id: entry.employee_id, outcome: "ALREADY_LOCKED" };
      }
      if (entry.calculation_hash && entry.calculation_hash !== row.calculation_hash) {
        return { employee_id: entry.employee_id, outcome: "CALCULATION_MOVED" };
      }
      row.status = "APPROVED_LOCKED";
      row.approved_by = approved_by;
      row.approved_at = "2026-09-05 11:00:00";
      row.locked_by = approved_by;
      row.locked_at = "2026-09-05 11:00:00";
      this.world.audit.push({
        employee_id: entry.employee_id,
        action: "APPROVE_LOCK",
        calculation_hash: row.calculation_hash,
        net_pay: row.net_pay,
      });
      return {
        employee_id: entry.employee_id,
        outcome: "APPROVED",
        net_pay: row.net_pay,
        calculation_hash: row.calculation_hash,
      };
    });
  }
}

/** Only the four methods the calculation stage borrows from initialization. */
class FakePayrunRepo {
  constructor(world) {
    this.world = world;
    this.payTypeAudit = [];
  }
  async getPeriod() {
    return this.world.period;
  }
  async listApprovedSalaries(ids) {
    return ids.map((id) => this.world.salaries.get(id)).filter(Boolean).map((s) => ({ ...s }));
  }
  async listPendingApprovals(ids) {
    return ids
      .map((id) => this.world.pending.get(id))
      .filter(Boolean)
      .map((p) => ({ ...p }));
  }
  async listPopulation() {
    return [...this.world.employees.values()].map((e) => ({ ...e }));
  }
  async changePayType({ employee_id, pay_type }) {
    const employee = this.world.employees.get(employee_id);
    if (!employee) return null;
    const old = employee.pay_type;
    employee.pay_type = pay_type;
    employee.pay_type_source = "MANUAL";
    this.payTypeAudit.push({ employee_id, old, pay_type });
    return { old_pay_type: old, new_pay_type: pay_type, changed: old !== pay_type };
  }
}

class FakeAdjustmentRepo {
  constructor(world) {
    this.world = world;
  }
  async listInitialized({ employee_ids = null }) {
    return [...this.world.employees.values()]
      .filter((e) => employee_ids === null || employee_ids.includes(e.employee_id))
      .map((e) => ({ ...e }));
  }
  async listAmounts({ employee_ids = null }) {
    const rows = [];
    this.world.amounts.forEach((byComponent, employeeId) => {
      if (employee_ids !== null && !employee_ids.includes(employeeId)) return;
      Object.keys(byComponent).forEach((component) =>
        rows.push({ employee_id: employeeId, component, amount: byComponent[component] })
      );
    });
    return rows;
  }
  async listStates({ employee_ids = null }) {
    return [...this.world.states.values()].filter(
      (s) => employee_ids === null || employee_ids.includes(s.employee_id)
    );
  }
  async saveAdjustments({ entries }) {
    entries.forEach((entry) => {
      const current = this.world.amounts.get(entry.employee_id) || {};
      Object.keys(entry.amounts || {}).forEach((key) => {
        if (entry.amounts[key] === null) delete current[key];
        else current[key] = entry.amounts[key];
      });
      this.world.amounts.set(entry.employee_id, current);
    });
    return { amounts_set: entries.length, amounts_cleared: 0, remarks_set: 0, confirmations_revoked: 0 };
  }
  async confirmNoAdjustment({ employees }) {
    return employees.map((e) => {
      this.world.states.set(e.employee_id, {
        employee_id: e.employee_id,
        confirmed_no_adjustment: 1,
      });
      return { employee_id: e.employee_id, result: "CONFIRMED" };
    });
  }
  async listAudit() {
    return [];
  }
}

/* ============================================================== the setup */

const ACTOR = { employeeId: 77 };
let world;
let calculation;
let payrun;
let adjustments;

function build() {
  world = new World();
  const calcRepo = new FakeCalculationRepo(world);
  const payrunRepo = new FakePayrunRepo(world);
  const adjustmentRepo = new FakeAdjustmentRepo(world);
  const locks = { listLockedEmployeeIds: (args) => calcRepo.listLockedEmployeeIds(args) };

  calculation = buildCalculation(calcRepo, payrunRepo, adjustmentRepo);
  payrun = buildPayrun(payrunRepo, locks);
  adjustments = buildAdjustments(adjustmentRepo, payrunRepo, locks);
  return { calcRepo, payrunRepo, adjustmentRepo };
}

const MONTH = { year: 2026, month: 8 };
const monthView = () => calculation.getMonth({ ...MONTH });
const rowOf = async (employeeId) =>
  (await monthView()).rows.find((r) => r.employee_id === employeeId);

beforeEach(() => {
  build();
});

/* ============================================================== the tests */

describe("calculating", () => {
  it("calculates from the initialized snapshot and stores the figures", async () => {
    world.add(1);
    const result = await calculation.calculate({ ...MONTH, employee_ids: [1], actor: ACTOR });

    assert.equal(result.calculated_count, 1);
    const row = await rowOf(1);
    assert.equal(row.status, CALC_STATUS.READY_FOR_APPROVAL);
    assert.equal(Number(row.net_pay), 24301); // 26,000 - PF 1,560 - ESI 139
    assert.equal(row.calculation_revision, 1);
  });

  it("takes in only employees who are initialized for the month", async () => {
    world.add(1);
    const result = await calculation.calculate({ ...MONTH, employee_ids: [1, 999], actor: ACTOR });
    assert.equal(result.calculated_count, 1);
    assert.equal(result.not_in_scope_count, 1);
  });

  /**
   * "CALCULATE ALL ELIGIBLE" MEANS THE ONES WITH NO CALCULATION, and it is
   * decided on the server. An employee somebody has already reviewed is not
   * silently recomputed.
   */
  it("calculates everybody eligible, and skips those already calculated", async () => {
    world.add(1).add(2);
    await calculation.calculate({ ...MONTH, employee_ids: [1], actor: ACTOR });

    const all = await calculation.calculate({ ...MONTH, all_eligible: true, actor: ACTOR });
    assert.equal(all.calculated_count, 1);
    assert.deepEqual(all.results.map((r) => r.employee_id), [2]);

    const again = await calculation.calculate({ ...MONTH, employee_ids: [1], actor: ACTOR });
    assert.equal(again.skipped_count, 1);
  });

  it("refuses employee_ids and all_eligible together rather than guessing", async () => {
    world.add(1);
    await assert.rejects(
      () => calculation.calculate({ ...MONTH, employee_ids: [1], all_eligible: true, actor: ACTOR }),
      /either employee_ids or all_eligible/
    );
  });
});

/* ------------------------------------------------- source change detection */

describe("a source that moves after the calculation", () => {
  /**
   * THE CENTRAL REQUIREMENT. A salary revision approved after the month was
   * calculated changes the STATUS and not one stored figure, and the employee
   * cannot be approved until somebody explicitly recalculates them.
   */
  it("is detected, changes no figure, and blocks approval", async () => {
    world.add(1);
    await calculation.calculate({ ...MONTH, employee_ids: [1], actor: ACTOR });
    const before = await rowOf(1);

    world.salaries.set(1, {
      employee_id: 1,
      salary_id: 9001,
      effective_from: "2026-08-01",
      monthly_gross: 30000,
    });

    const after = await rowOf(1);
    assert.equal(after.status, CALC_STATUS.RECALCULATION_REQUIRED);
    assert.equal(after.net_pay, before.net_pay, "the stored net pay must not have moved");
    assert.ok(after.recalculation_reasons.some((r) => r.code === "SALARY_CHANGED"));

    const approval = await calculation.approve({ ...MONTH, employee_ids: [1], actor: ACTOR });
    assert.equal(approval.approved_count, 0);
    assert.equal(approval.blocked_count, 1);
  });

  it("notices an attendance re-run and an OT approval separately", async () => {
    world.add(1).add(2);
    await calculation.calculate({ ...MONTH, all_eligible: true, actor: ACTOR });

    world.attendance.get(1).payroll_version = 2;
    world.attendance.get(2).approved_ot_minutes = 120;

    assert.ok((await rowOf(1)).recalculation_reasons.some((r) => r.code === "ATTENDANCE_CHANGED"));
    assert.ok((await rowOf(2)).recalculation_reasons.some((r) => r.code === "APPROVED_OT_CHANGED"));
  });

  it("notices an adjustment entered after the calculation", async () => {
    world.add(1);
    await calculation.calculate({ ...MONTH, employee_ids: [1], actor: ACTOR });

    await adjustments.saveEmployee({
      ...MONTH,
      employee_id: 1,
      amounts: { [COMPONENT.INCENTIVE]: 1500 },
      actor: ACTOR,
    });

    const row = await rowOf(1);
    assert.equal(row.status, CALC_STATUS.RECALCULATION_REQUIRED);
    assert.ok(row.recalculation_reasons.some((r) => r.code === "ADJUSTMENTS_CHANGED"));
  });
  /**
   * THE MONTHLY PAY TYPE IS AN INPUT LIKE ANY OTHER, and this is what makes it
   * safe to leave the control on the Calculation & Review screen: changing it
   * after the month was calculated does not quietly re-sign the calculation.
   * It goes through the SAME inputs hash the adjustments go through, so the
   * employee falls to RECALCULATION_REQUIRED, their stored figures stay
   * exactly as they were, and approval refuses until somebody recalculates.
   */
  it("notices a pay type changed after the calculation, and blocks approval", async () => {
    world.add(1);
    await calculation.calculate({ ...MONTH, employee_ids: [1], actor: ACTOR });
    const before = await rowOf(1);
    assert.equal(before.status, CALC_STATUS.READY_FOR_APPROVAL);

    await payrun.changePayType({ ...MONTH, employee_id: 1, pay_type: "CASH", actor: ACTOR });

    const row = await rowOf(1);
    assert.equal(row.pay_type, "CASH", "the live monthly pay type is what the screen shows");
    assert.equal(row.calculated_pay_type, "BANK", "the CALCULATION still holds the old one");
    assert.equal(row.status, CALC_STATUS.RECALCULATION_REQUIRED);
    assert.equal(row.net_pay, before.net_pay, "no stored figure moved");

    const approval = await calculation.approve({ ...MONTH, employee_ids: [1], actor: ACTOR });
    assert.equal(approval.approved_count, 0);
    assert.equal(approval.blocked_count, 1);

    // And an explicit Recalculate is what settles it.
    await calculation.calculate({ ...MONTH, employee_ids: [1], mode: "RECALCULATE", actor: ACTOR });
    const settled = await rowOf(1);
    assert.equal(settled.status, CALC_STATUS.READY_FOR_APPROVAL);
    assert.equal(settled.calculated_pay_type, "CASH");
  });

  it("CASH -> BANK moves it back the same way", async () => {
    world.add(1);
    await payrun.changePayType({ ...MONTH, employee_id: 1, pay_type: "CASH", actor: ACTOR });
    await calculation.calculate({ ...MONTH, employee_ids: [1], actor: ACTOR });
    assert.equal((await rowOf(1)).status, CALC_STATUS.READY_FOR_APPROVAL);

    await payrun.changePayType({ ...MONTH, employee_id: 1, pay_type: "BANK", actor: ACTOR });
    const row = await rowOf(1);
    assert.equal(row.pay_type, "BANK");
    assert.equal(row.status, CALC_STATUS.RECALCULATION_REQUIRED);
  });

  it("changing it writes only the payrun row - the adjustments are untouched", async () => {
    world.add(1);
    await adjustments.saveEmployee({
      ...MONTH,
      employee_id: 1,
      amounts: { [COMPONENT.INCENTIVE]: 1200, [COMPONENT.ADVANCE_RECOVERY]: 300 },
      actor: ACTOR,
    });
    await calculation.calculate({ ...MONTH, employee_ids: [1], actor: ACTOR });
    await payrun.changePayType({ ...MONTH, employee_id: 1, pay_type: "CASH", actor: ACTOR });

    assert.deepEqual(world.amounts.get(1), {
      [COMPONENT.INCENTIVE]: 1200,
      [COMPONENT.ADVANCE_RECOVERY]: 300,
    });
    const detail = await calculation.getEmployee({ ...MONTH, employee_id: 1 });
    assert.equal(Number(detail.breakup.adjustments.incentive), 1200);
  });
});

/* --------------------------------------------------------- recalculating */

describe("recalculating", () => {
  it("refreshes the source data and clears the stale status", async () => {
    world.add(1);
    await calculation.calculate({ ...MONTH, employee_ids: [1], actor: ACTOR });

    // A revision, and an attendance month that now carries two extra days.
    world.salaries.set(1, {
      employee_id: 1,
      salary_id: 9001,
      effective_from: "2026-08-01",
      monthly_gross: 30000,
    });
    Object.assign(world.attendance.get(1), {
      payroll_version: 2,
      extra_days: 2,
      extra_day_earnings: 2000,
    });

    const result = await calculation.calculate({
      ...MONTH,
      employee_ids: [1],
      mode: "RECALCULATE",
      actor: ACTOR,
    });
    assert.equal(result.recalculated_count, 1);

    const row = await rowOf(1);
    assert.equal(row.status, CALC_STATUS.READY_FOR_APPROVAL);
    assert.equal(row.extra_days, 2);
    assert.equal(row.calculation_revision, 2);
  });

  /**
   * A RECALCULATION PRESERVES EVERYTHING THE PAYRUN OWNS. The adjustments and
   * the monthly pay type are read from the tables that own them and are never
   * written by this stage - so they come through a refresh untouched.
   */
  it("preserves the adjustments and the monthly pay type", async () => {
    world.add(1);
    await adjustments.saveEmployee({
      ...MONTH,
      employee_id: 1,
      amounts: {
        [COMPONENT.INCENTIVE]: 1000,
        [COMPONENT.ADVANCE_RECOVERY]: 500,
        [COMPONENT.BALANCE_ADVANCE]: 7000,
      },
      actor: ACTOR,
    });
    await payrun.changePayType({ ...MONTH, employee_id: 1, pay_type: "CASH", actor: ACTOR });

    await calculation.calculate({ ...MONTH, employee_ids: [1], actor: ACTOR });
    world.attendance.get(1).payroll_version = 3;
    await calculation.calculate({ ...MONTH, employee_ids: [1], mode: "RECALCULATE", actor: ACTOR });

    const detail = await calculation.getEmployee({ ...MONTH, employee_id: 1 });
    assert.equal(Number(detail.breakup.adjustments.incentive), 1000);
    assert.equal(Number(detail.breakup.adjustments.advance_recovery), 500);
    assert.equal(Number(detail.breakup.adjustments.balance_advance), 7000);
    assert.equal(detail.breakup.final.pay_type, "CASH");
    assert.deepEqual(world.amounts.get(1), {
      [COMPONENT.INCENTIVE]: 1000,
      [COMPONENT.ADVANCE_RECOVERY]: 500,
      [COMPONENT.BALANCE_ADVANCE]: 7000,
    });
    assert.equal(world.states.get(1).confirmed_no_adjustment, 1);
  });

  it("will not recalculate somebody who has never been calculated", async () => {
    world.add(1);
    const result = await calculation.calculate({
      ...MONTH,
      employee_ids: [1],
      mode: "RECALCULATE",
      actor: ACTOR,
    });
    assert.equal(result.skipped_count, 1);
  });
});

/* ------------------------------------------------------- the ready rules */

describe("readiness", () => {
  it("blocks approval while the adjustment stage is not complete for the employee", async () => {
    world.add(1);
    world.states.delete(1); // nobody has said anything about this person
    await calculation.calculate({ ...MONTH, employee_ids: [1], actor: ACTOR });

    const row = await rowOf(1);
    assert.equal(row.status, CALC_STATUS.CALCULATED);
    assert.ok(row.blockers.some((b) => b.code === "ADJUSTMENT_PENDING_CONFIRMATION"));

    const refused = await calculation.approve({ ...MONTH, employee_ids: [1], actor: ACTOR });
    assert.equal(refused.approved_count, 0);
    assert.equal(refused.blocked_count, 1);

    // ...and confirming it makes them ready, with nothing else changing.
    await adjustments.confirmNoAdjustment({ ...MONTH, employee_ids: [1], actor: ACTOR });
    await calculation.calculate({ ...MONTH, employee_ids: [1], mode: "RECALCULATE", actor: ACTOR });
    assert.equal((await rowOf(1)).status, CALC_STATUS.READY_FOR_APPROVAL);
  });

  /**
   * ==================================================================
   * THE ATTENDANCE GATES LIVE HERE, AND NOWHERE ELSE, AND THEY HOLD.
   *
   * Initialization stopped refusing on attendance: an unsettled month, an
   * open regularization and an open OT approval no longer keep somebody out
   * of the payrun. THIS is the gate that replaced it, and these tests exist
   * to prove the change did not quietly move the refusal to nowhere. Each one
   * asserts the BLOCKER **and** that `approve` actually refuses - a blocker
   * nobody enforces is a label.
   * ==================================================================
   */
  it("a pending attendance regularization still refuses Approve & Lock", async () => {
    world.add(1);
    world.pending.set(1, { employee_id: 1, pending_regularizations: 1, pending_ot: 0 });
    await calculation.calculate({ ...MONTH, employee_ids: [1], actor: ACTOR });

    assert.ok((await rowOf(1)).blockers.some((b) => b.code === "PENDING_ATTENDANCE_REGULARIZATION"));
    const refused = await calculation.approve({ ...MONTH, employee_ids: [1], actor: ACTOR });
    assert.equal(refused.approved_count, 0);
    assert.equal(refused.blocked_count, 1);
    assert.notEqual((await rowOf(1)).status, CALC_STATUS.APPROVED_LOCKED);
  });

  it("a pending OT approval still refuses Approve & Lock", async () => {
    world.add(1);
    world.pending.set(1, { employee_id: 1, pending_regularizations: 0, pending_ot: 1 });
    await calculation.calculate({ ...MONTH, employee_ids: [1], actor: ACTOR });

    assert.ok((await rowOf(1)).blockers.some((b) => b.code === "PENDING_OT_APPROVAL"));
    const refused = await calculation.approve({ ...MONTH, employee_ids: [1], actor: ACTOR });
    assert.equal(refused.approved_count, 0);
    assert.equal(refused.blocked_count, 1);
    assert.notEqual((await rowOf(1)).status, CALC_STATUS.APPROVED_LOCKED);
  });

  it("attendance that is not final still refuses Approve & Lock", async () => {
    world.add(1);
    world.attendance.get(1).is_final = 0;
    await calculation.calculate({ ...MONTH, employee_ids: [1], actor: ACTOR });

    assert.ok((await rowOf(1)).blockers.some((b) => b.code === "ATTENDANCE_INCOMPLETE"));
    const refused = await calculation.approve({ ...MONTH, employee_ids: [1], actor: ACTOR });
    assert.equal(refused.approved_count, 0);
    assert.equal(refused.blocked_count, 1);
    assert.notEqual((await rowOf(1)).status, CALC_STATUS.APPROVED_LOCKED);
  });

  it("an incomplete statutory setup still refuses Approve & Lock", async () => {
    world.add(2);
    world.employees.get(2).uan = null;
    world.employees.get(2).pf_number = null;
    await calculation.calculate({ ...MONTH, employee_ids: [2], actor: ACTOR });

    assert.ok((await rowOf(2)).blockers.some((b) => b.code === "STATUTORY_SETUP_INCOMPLETE"));
    const refused = await calculation.approve({ ...MONTH, employee_ids: [2], actor: ACTOR });
    assert.equal(refused.approved_count, 0);
  });
});

/* -------------------------------------------------------- approve & lock */

describe("approving and locking", () => {
  it("approves one employee, and records who and when", async () => {
    world.add(1);
    await calculation.calculate({ ...MONTH, employee_ids: [1], actor: ACTOR });

    const result = await calculation.approve({ ...MONTH, employee_ids: [1], actor: ACTOR });
    assert.equal(result.approved_count, 1);

    const row = await rowOf(1);
    assert.equal(row.status, CALC_STATUS.APPROVED_LOCKED);
    assert.equal(row.approved_by, 77);
    assert.ok(row.approved_at);
    assert.equal(row.locked_by, 77);
    assert.ok(row.locked_at);
    // THE APPROVAL IS RECORDED AGAINST A CALCULATION REFERENCE.
    assert.ok(row.calculation_hash);
    assert.ok(world.audit.some((a) => a.action === "APPROVE_LOCK" && a.employee_id === 1));
  });

  it("approves everybody ready in one act, by the same path", async () => {
    world.add(1).add(2).add(3);
    world.states.delete(3); // 3 is still pending confirmation
    await calculation.calculate({ ...MONTH, all_eligible: true, actor: ACTOR });

    const result = await calculation.approve({ ...MONTH, all_ready: true, actor: ACTOR });
    assert.equal(result.approved_count, 2);

    const view = await monthView();
    assert.equal(view.summary.approved_locked, 2);
    assert.equal(view.summary.calculated, 1);
  });

  it("says so rather than approving twice", async () => {
    world.add(1);
    await calculation.calculate({ ...MONTH, employee_ids: [1], actor: ACTOR });
    await calculation.approve({ ...MONTH, employee_ids: [1], actor: ACTOR });

    const again = await calculation.approve({ ...MONTH, employee_ids: [1], actor: ACTOR });
    assert.equal(again.approved_count, 0);
    assert.equal(again.already_locked_count, 1);
  });
});

/* -------------------------------------------------------------- the lock */

describe("what a lock refuses", () => {
  beforeEach(async () => {
    world.add(1).add(2);
    await calculation.calculate({ ...MONTH, all_eligible: true, actor: ACTOR });
    await calculation.approve({ ...MONTH, employee_ids: [1], actor: ACTOR });
  });

  it("refuses to recalculate a locked employee", async () => {
    const result = await calculation.calculate({
      ...MONTH,
      employee_ids: [1],
      mode: "RECALCULATE",
      actor: ACTOR,
    });
    assert.equal(result.locked_count, 1);
    assert.equal(result.recalculated_count, 0);
  });

  it("refuses to change a locked employee's pay type", async () => {
    await assert.rejects(
      () => payrun.changePayType({ ...MONTH, employee_id: 1, pay_type: "CASH", actor: ACTOR }),
      /approved and locked/
    );
    assert.equal(world.employees.get(1).pay_type, "BANK");
  });

  it("refuses to edit a locked employee's adjustments", async () => {
    await assert.rejects(
      () =>
        adjustments.saveEmployee({
          ...MONTH,
          employee_id: 1,
          amounts: { [COMPONENT.INCENTIVE]: 5000 },
          actor: ACTOR,
        }),
      /approved and locked/
    );
    assert.equal(world.amounts.get(1), undefined);
  });

  /**
   * THE LOCK IS PER EMPLOYEE AND NEVER PER MONTH. Employee 2 is in the same
   * month, was calculated in the same act, and is completely unaffected by
   * employee 1 being approved.
   */
  it("leaves every other employee in the month fully editable", async () => {
    await payrun.changePayType({ ...MONTH, employee_id: 2, pay_type: "CASH", actor: ACTOR });
    assert.equal(world.employees.get(2).pay_type, "CASH");

    await adjustments.saveEmployee({
      ...MONTH,
      employee_id: 2,
      amounts: { [COMPONENT.BONUS]: 750 },
      actor: ACTOR,
    });
    assert.equal(world.amounts.get(2)[COMPONENT.BONUS], 750);

    const refreshed = await calculation.calculate({
      ...MONTH,
      employee_ids: [2],
      mode: "RECALCULATE",
      actor: ACTOR,
    });
    assert.equal(refreshed.recalculated_count, 1);
  });

  /** THE PAYSLIP ELIGIBILITY CONTRACT, per employee and both ways round. */
  it("makes the approved employee payslip eligible and the other not", async () => {
    const view = await monthView();
    const one = view.rows.find((r) => r.employee_id === 1);
    const two = view.rows.find((r) => r.employee_id === 2);

    assert.equal(one.payslip_eligible, true);
    assert.equal(two.payslip_eligible, false);
    assert.equal(view.summary.payslip_eligible, 1);
  });
});

/* ------------------------------- the two rules the review pass corrected */

describe("the ESI contribution period, through the stage", () => {
  /**
   * THE EVIDENCE IS FETCHED BY THE SERVER, at the date the salary engine names
   * - which is a DIFFERENT date from the one the month is priced on, and
   * usually an earlier one. This proves the stage goes and gets it rather than
   * handing `calculateEsi` a wage and nothing else.
   */
  it("reads the approved salary in force at the contribution period's entry", async () => {
    world.add(1, {
      employee: {
        monthly_gross: 40000,
        basic: 20000,
        conveyance: 2500,
        hra: 10000,
        special_allowance: 7500,
      },
      attendance: { salary_day_earnings: 40000 },
    });
    /* Covered when the period began in April; well above the ceiling now. */
    world.salaries.set(1, {
      employee_id: 1,
      salary_id: 77,
      effective_from: "2026-04-01",
      monthly_gross: 20000,
      basic: 10000,
      conveyance: 2500,
      hra: 4000,
      special_allowance: 3500,
    });

    await calculation.calculate({ ...MONTH, employee_ids: [1], actor: ACTOR });
    const detail = await calculation.getEmployee({ ...MONTH, employee_id: 1 });

    assert.equal(detail.breakup.statutory.esi_coverage_basis, "COVERED_AT_ENTRY");
    assert.equal(detail.breakup.statutory.esi_contribution_period_continues, true);
    assert.equal(detail.breakup.statutory.esi_period_start, "2026-04-01");
    assert.ok(
      Number(detail.breakup.statutory.employee_esi) > 0,
      "a covered employee contributes even above the ceiling"
    );
  });

  /**
   * THE COVERAGE BASIS IS A SOURCE. A revision back-dated into the month the
   * period began changes whether this month is covered while every other
   * marker stays put, so it has to make the calculation stale - with its own
   * reason, because "a salary changed" would send somebody to look at this
   * month's revision rather than at last April's.
   */
  it("goes stale when the entry salary changes, with its own reason", async () => {
    world.add(1);
    await calculation.calculate({ ...MONTH, employee_ids: [1], actor: ACTOR });
    assert.equal((await rowOf(1)).status, CALC_STATUS.READY_FOR_APPROVAL);

    world.salaries.set(1, {
      employee_id: 1,
      salary_id: 999,
      effective_from: "2026-04-01",
      monthly_gross: 26000,
      basic: 13000,
      conveyance: 2500,
      hra: 5000,
      special_allowance: 5500,
    });

    const row = await rowOf(1);
    assert.equal(row.status, CALC_STATUS.RECALCULATION_REQUIRED);
    assert.ok(row.recalculation_reasons.some((r) => r.code === "ESI_COVERAGE_CHANGED"));
  });

  /** An unprovable position blocks the approval rather than zeroing quietly. */
  it("blocks approval when the position at entry cannot be established", async () => {
    world.add(1, {
      employee: {
        monthly_gross: 40000,
        basic: 20000,
        conveyance: 2500,
        hra: 10000,
        special_allowance: 7500,
      },
      attendance: { salary_day_earnings: 40000 },
    });
    world.salaries.delete(1); // nothing in force at entry

    await calculation.calculate({ ...MONTH, employee_ids: [1], actor: ACTOR });
    const row = await rowOf(1);

    assert.equal(row.employee_esi, null, "never a silent zero");
    assert.ok(row.blockers.some((b) => b.code === "CALCULATION_INCOMPLETE"));

    const refused = await calculation.approve({ ...MONTH, employee_ids: [1], actor: ACTOR });
    assert.equal(refused.approved_count, 0);
  });
});

describe("overtime across two NRMs, through the stage", () => {
  it("stores the per-group breakdown and the summed amount", async () => {
    world.add(1, {
      attendance: { approved_ot_minutes: 180 },
      nrm_groups: [
        { nrm_minutes: 660, break_allowance_source: "SHIFT", day_count: 10, approved_ot_minutes: 120 },
        { nrm_minutes: 480, break_allowance_source: "SHIFT", day_count: 16, approved_ot_minutes: 60 },
      ],
    });

    await calculation.calculate({ ...MONTH, employee_ids: [1], actor: ACTOR });
    const detail = await calculation.getEmployee({ ...MONTH, employee_id: 1 });

    assert.equal(Number(detail.breakup.ot.ot_amount), 306.82);
    assert.equal(detail.breakup.ot.ot_groups.length, 2);
    assert.equal(detail.breakup.ot.ot_hourly_rate, null, "no single rate is claimed");
    assert.deepEqual(
      detail.breakup.ot.ot_groups.map((g) => [g.nrm_minutes, g.ot_amount]),
      [[480, 125], [660, 181.82]]
    );
  });

  /**
   * MOVING OT BETWEEN NRMS IS A SOURCE CHANGE, even when the total minutes and
   * the headline NRM are unchanged. Without the split in the markers it would
   * be invisible - and the amount would be different.
   */
  it("goes stale when the same total OT moves to a different NRM", async () => {
    world.add(1, {
      attendance: { approved_ot_minutes: 120 },
      nrm_groups: [
        { nrm_minutes: 480, break_allowance_source: "SHIFT", day_count: 20, approved_ot_minutes: 120 },
        { nrm_minutes: 660, break_allowance_source: "SHIFT", day_count: 6, approved_ot_minutes: 0 },
      ],
    });
    await calculation.calculate({ ...MONTH, employee_ids: [1], actor: ACTOR });
    const before = await rowOf(1);
    assert.equal(before.status, CALC_STATUS.READY_FOR_APPROVAL);

    world.nrm.set(1, [
      { employee_id: 1, nrm_minutes: 480, break_allowance_source: "SHIFT", day_count: 20, approved_ot_minutes: 0 },
      { employee_id: 1, nrm_minutes: 660, break_allowance_source: "SHIFT", day_count: 6, approved_ot_minutes: 120 },
    ]);

    const after = await rowOf(1);
    assert.equal(after.status, CALC_STATUS.RECALCULATION_REQUIRED);
    assert.ok(after.recalculation_reasons.some((r) => r.code === "EFFECTIVE_NRM_CHANGED"));

    await calculation.calculate({ ...MONTH, employee_ids: [1], mode: "RECALCULATE", actor: ACTOR });
    const detail = await calculation.getEmployee({ ...MONTH, employee_id: 1 });
    assert.equal(Number(detail.breakup.ot.ot_amount), 181.82, "repriced on the NRM it moved to");
  });
});

/* ------------------------------------------------------------ the detail */

describe("one employee's breakup", () => {
  it("returns the stored calculation grouped as the review screen reads it", async () => {
    world.add(1, { attendance: { approved_ot_minutes: 120, extra_days: 1, extra_day_earnings: 1000 } });
    await calculation.calculate({ ...MONTH, employee_ids: [1], actor: ACTOR });

    const detail = await calculation.getEmployee({ ...MONTH, employee_id: 1 });
    assert.equal(detail.breakup.salary.daily_rate, 1000);
    assert.equal(detail.breakup.salary.extra_day_amount, 1000);
    assert.equal(detail.breakup.ot.approved_ot_hours, 2);
    assert.equal(detail.breakup.ot.effective_nrm_minutes, 480);
    assert.equal(detail.breakup.ot.ot_hourly_rate, 125);
    assert.equal(detail.breakup.ot.ot_amount, 250);
    assert.equal(detail.breakup.statutory.pf_wage, 13000);
    assert.ok(detail.breakup.final.net_pay);
  });

  it("refuses an employee who is not initialized for the month", async () => {
    await assert.rejects(
      () => calculation.getEmployee({ ...MONTH, employee_id: 4242 }),
      /no initialized payrun/
    );
  });
});

/* ===================================================================== */
/*  the month an initialized employee has no attendance for              */
/* ===================================================================== */

/**
 * SEPTEMBER 2026, PRODUCTION: one employee initialized, no attendance month,
 * no final day rows, no approved OT, no adjustment - and Calculation & Review
 * showed a read failure with every counter at zero.
 *
 * THE FAILURE ITSELF WAS SCHEMA DRIFT, not this assembly path: the deployed
 * `payrun_employee_calculation` was missing eight columns the repository
 * selects, so the month's SELECT died in MySQL before any of this ran. That is
 * repaired by `migrations/.../20261024120000-payrun-calculation-column-drift`
 * and guarded by `migrations/payrun_calculation_column_drift.test.js`.
 *
 * THESE TESTS GUARD THE OTHER HALF: that the state itself - an initialized
 * employee with NOTHING from attendance - is a MONTH THAT LOADS, with the
 * employee in it, and never an API failure. Initialization stopped refusing on
 * attendance, so this state is now ordinary rather than impossible, and every
 * empty collection below has to be a valid input.
 *
 * NO RULE MOVES HERE. The employee is NOT_CALCULATED before anybody calculates
 * them, attendance that is missing is an approval blocker exactly as
 * attendance that is not final is, and Approve & Lock still refuses.
 */
describe("an initialized employee whose attendance does not exist yet", () => {
  /** Initialized, and nothing whatever from the attendance engine. */
  const addWithNoAttendance = (employeeId) => {
    world.add(employeeId);
    world.attendance.delete(employeeId);  // no attendance_monthly_payroll row
    world.nrm.delete(employeeId);         // no final attendance_day_calculation rows
    world.pending.delete(employeeId);     // no approved and no pending OT
  };

  it("loads the month, and the employee is in it", async () => {
    addWithNoAttendance(1952);

    const month = await monthView();
    assert.equal(month.rows.length, 1);
    assert.equal(month.rows[0].employee_id, 1952);
    assert.equal(month.period_year, 2026);
    assert.equal(month.period_month, 8);
  });

  it("counts the employee as initialized and not calculated", async () => {
    addWithNoAttendance(1952);

    const month = await monthView();
    assert.equal(month.summary.initialized, 1);
    assert.equal(month.summary.not_calculated, 1);
    assert.equal(month.summary.ready_for_approval, 0);
    assert.equal(month.summary.approved_locked, 0);
  });

  it("is NOT_CALCULATED before the first calculation, and says so rather than failing", async () => {
    addWithNoAttendance(1952);

    const row = await rowOf(1952);
    assert.equal(row.status, CALC_STATUS.NOT_CALCULATED);
    assert.ok(row.blockers.some((b) => b.code === "NOT_CALCULATED"));
    assert.equal(row.net_pay, null);
    assert.equal(row.payslip_eligible, false);
  });

  it("loads with no NRM groups at all", async () => {
    world.add(1952);
    world.nrm.set(1952, []);  // nothing final, so no NRM evidence

    const month = await monthView();
    assert.equal(month.summary.initialized, 1);
    assert.ok(month.rows.some((r) => r.employee_id === 1952));
  });

  it("loads with no approved OT anywhere in the month", async () => {
    world.add(1952);
    world.attendance.get(1952).approved_ot_minutes = 0;
    world.nrm.set(1952, []);

    const month = await monthView();
    assert.equal(month.summary.initialized, 1);
    assert.equal((await rowOf(1952)).status, CALC_STATUS.NOT_CALCULATED);
  });

  it("loads for NO_ADJUSTMENT_CONFIRMED with no attendance", async () => {
    addWithNoAttendance(1952);
    world.states.set(1952, { employee_id: 1952, confirmed_no_adjustment: 1 });

    const row = await rowOf(1952);
    assert.equal(row.adjustment_state, "NO_ADJUSTMENT_CONFIRMED");
    assert.equal(row.status, CALC_STATUS.NOT_CALCULATED);
  });

  /**
   * THE GATE DID NOT MOVE. A missing attendance month is exactly as much of a
   * refusal at Approve & Lock as a non-final one - and the refusal is proved
   * by `approve` declining, not by the blocker being listed.
   */
  it("still refuses Approve & Lock once the month has been calculated", async () => {
    addWithNoAttendance(1952);
    await calculation.calculate({ ...MONTH, employee_ids: [1952], actor: ACTOR });

    const row = await rowOf(1952);
    // The month WAS calculated - the refusal below is the approval gate
    // refusing a calculated employee, not the absence of a calculation.
    assert.equal(row.status, CALC_STATUS.CALCULATED);
    assert.ok(row.calculation_hash);
    assert.ok(row.blockers.some((b) => b.code === "ATTENDANCE_INCOMPLETE"));

    const refused = await calculation.approve({ ...MONTH, employee_ids: [1952], actor: ACTOR });
    assert.equal(refused.approved_count, 0);
    assert.equal(refused.blocked_count, 1);
    assert.notEqual((await rowOf(1952)).status, CALC_STATUS.APPROVED_LOCKED);
  });

  /**
   * ONE EMPLOYEE'S MISSING DATA IS ONE EMPLOYEE'S PROBLEM. A month is six
   * hundred people; one of them with no attendance row must not take the other
   * five hundred and ninety-nine off the screen.
   */
  it("does not take the rest of the month down with it", async () => {
    world.add(1);                 // ordinary, fully attended
    addWithNoAttendance(1952);    // nothing from attendance at all
    world.add(2);
    world.attendance.get(2).is_final = 0;   // settled by the engine, but not final

    const month = await monthView();
    assert.equal(month.summary.initialized, 3);
    assert.deepEqual(month.rows.map((r) => r.employee_id).sort((a, b) => a - b), [1, 2, 1952]);
    month.rows.forEach((row) => assert.equal(row.status, CALC_STATUS.NOT_CALCULATED));
  });

  it("leaves an employee with final attendance behaving exactly as before", async () => {
    world.add(1);
    addWithNoAttendance(1952);
    await calculation.calculate({ ...MONTH, all_eligible: true, actor: ACTOR });

    const ordinary = await rowOf(1);
    assert.equal(ordinary.status, CALC_STATUS.READY_FOR_APPROVAL);
    assert.deepEqual(ordinary.blockers, []);
    assert.equal(ordinary.salary_days, 26);
    assert.ok(Number(ordinary.net_pay) > 0);

    const approved = await calculation.approve({ ...MONTH, employee_ids: [1], actor: ACTOR });
    assert.equal(approved.approved_count, 1);
    assert.equal((await rowOf(1)).status, CALC_STATUS.APPROVED_LOCKED);
    assert.equal((await rowOf(1)).payslip_eligible, true);

    // ...and the one with no attendance is still there, still refused.
    assert.notEqual((await rowOf(1952)).status, CALC_STATUS.APPROVED_LOCKED);
  });
});
