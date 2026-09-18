/**
 * Payrun Adjustments V1 - the stage, driven with fake repositories.
 *
 *   node --test usecase/payrun_adjustment.test.js
 *
 * The fakes below are an in-memory version of the three tables this stage owns
 * plus the two reads it makes of the initialization stage's. That is enough to
 * prove the things that actually matter here and that no pure test can reach:
 *
 *   only INITIALIZED employees take part
 *   a newly initialized employee is pending WITHOUT anything being run
 *   a blank or zero import NEVER confirms anybody
 *   preview writes nothing at all
 *   an invalid row stops the whole save
 *   confirming is explicit, individual and bulk by the same path
 *   an adjustment after a confirmation revokes it
 */
const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const buildUsecase = require("./payrun_adjustment");
const { ADJUSTMENT_STATE, isPayAffecting } = require("../constants/payrun_adjustments");

/* ============================================================== the fakes */

/**
 * An in-memory stand-in for `repository/payrun_adjustment.js`, behaving as the
 * real one does in the ways the tests depend on: the unique keys hold, an
 * adjustment revokes a confirmation in the same call, and an employee with an
 * adjustment cannot be confirmed as having none.
 */
class FakeAdjustmentRepo {
  constructor() {
    this.initialized = [];
    this.amounts = new Map(); // employee_id -> { component: amount }
    this.states = new Map(); // employee_id -> state row
    this.audit = [];
    this.writes = 0;
  }

  async listInitialized({ store_ids = null, employee_ids = null }) {
    return this.initialized
      .filter((e) => (store_ids === null ? true : store_ids.includes(e.store_id)))
      .filter((e) => (employee_ids === null ? true : employee_ids.includes(e.employee_id)));
  }

  async listAmounts({ employee_ids = null }) {
    const rows = [];
    this.amounts.forEach((byComponent, employeeId) => {
      if (employee_ids !== null && !employee_ids.includes(employeeId)) return;
      Object.keys(byComponent).forEach((component) =>
        rows.push({ employee_id: employeeId, component, amount: byComponent[component] })
      );
    });
    return rows;
  }

  async listStates({ employee_ids = null }) {
    return [...this.states.values()].filter(
      (s) => employee_ids === null || employee_ids.includes(s.employee_id)
    );
  }

  async listAudit() {
    return this.audit;
  }

  async saveAdjustments({ entries, actor_id }) {
    this.writes += 1;
    const counts = { employees_written: 0, amounts_set: 0, amounts_cleared: 0, confirmations_revoked: 0 };
    entries.forEach((entry) => {
      const current = this.amounts.get(entry.employee_id) || {};
      let wrote = false;
      Object.keys(entry.amounts || {}).forEach((component) => {
        const next = entry.amounts[component];
        if (next === null) {
          if (current[component] !== undefined) {
            delete current[component];
            counts.amounts_cleared += 1;
            wrote = true;
          }
          return;
        }
        if (current[component] === next) return;
        current[component] = next;
        counts.amounts_set += 1;
        wrote = true;
      });
      this.amounts.set(entry.employee_id, current);

      const state = this.states.get(entry.employee_id) || null;
      if (Object.prototype.hasOwnProperty.call(entry, "remarks")) {
        this.states.set(entry.employee_id, {
          ...(state || { employee_id: entry.employee_id, confirmed_no_adjustment: 0 }),
          remarks: entry.remarks,
        });
        wrote = true;
      }
      // A PAY-AFFECTING ADJUSTMENT REVOKES A CONFIRMATION, in the same call.
      // An informational one never does - see `repository/payrun_adjustment.js`.
      if (Object.keys(current).some(isPayAffecting)) {
        const s = this.states.get(entry.employee_id);
        if (s && Number(s.confirmed_no_adjustment) === 1) {
          this.states.set(entry.employee_id, {
            ...s,
            confirmed_no_adjustment: 0,
            confirmed_by: null,
            confirmed_at: null,
          });
          counts.confirmations_revoked += 1;
        }
      }
      if (wrote) counts.employees_written += 1;
      this.audit.push({ employee_id: entry.employee_id, changed_by: actor_id });
    });
    return counts;
  }

  async confirmNoAdjustment({ employees, actor_id }) {
    this.writes += 1;
    return employees.map((employee) => {
      // Only a PAY-AFFECTING amount blocks the confirmation; a stored Balance
      // Advance must not, which is what the real statement's `component IN (?)`
      // predicate achieves.
      const amounts = this.amounts.get(employee.employee_id) || {};
      if (Object.keys(amounts).some(isPayAffecting)) {
        return { employee_id: employee.employee_id, result: "HAS_ADJUSTMENT" };
      }
      const state = this.states.get(employee.employee_id);
      if (state && Number(state.confirmed_no_adjustment) === 1) {
        return { employee_id: employee.employee_id, result: "ALREADY_CONFIRMED" };
      }
      this.states.set(employee.employee_id, {
        employee_id: employee.employee_id,
        remarks: state ? state.remarks : null,
        confirmed_no_adjustment: 1,
        confirmed_by: actor_id,
        confirmed_at: "2026-09-18 10:00:00",
      });
      return { employee_id: employee.employee_id, result: "CONFIRMED" };
    });
  }
}

/** Only the one method this stage is entitled to call. */
class FakePayrunRepo {
  constructor(period = null) {
    this.period = period;
  }
  async getPeriod() {
    return this.period;
  }
}

const employee = (id, name, storeId = 1, storeName = "Anna Nagar") => ({
  payrun_employee_id: 1000 + id,
  employee_id: id,
  employee_name: name,
  store_id: storeId,
  store_name: storeName,
  designation_name: "Cashier",
});

const HEADERS = [
  "Employee ID", "Employee Name", "Location",
  "Incentive", "Bonus", "Arrears",
  "Advance Recovery", "Shortage Recovery", "Balance Advance",
  "Remarks",
];

const row = (id, name, cells = {}) => ({
  "Employee ID": id,
  "Employee Name": name,
  Location: "Anna Nagar",
  Incentive: "",
  Bonus: "",
  Arrears: "",
  "Advance Recovery": "",
  "Shortage Recovery": "",
  "Balance Advance": "",
  Remarks: "",
  ...cells,
});

const MONTH = { year: 2026, month: 8 };
const ACTOR = { actor: { employeeId: 77 } };

/* ================================================================= tests */

describe("the population is the month's INITIALIZED employees, read fresh", () => {
  let repo;
  let usecase;

  beforeEach(() => {
    repo = new FakeAdjustmentRepo();
    repo.initialized = [employee(1, "Asha"), employee(2, "Bala")];
    usecase = buildUsecase(repo, new FakePayrunRepo());
  });

  it("shows only initialized employees - an employed but uninitialized one is absent", async () => {
    const view = await usecase.getMonth(MONTH);
    assert.deepEqual(view.rows.map((r) => r.employee_id), [1, 2]);
    assert.equal(view.summary.initialized_count, 2);
  });

  it("puts every untouched employee in PENDING CONFIRMATION with nothing run", async () => {
    const view = await usecase.getMonth(MONTH);
    view.rows.forEach((r) =>
      assert.equal(r.adjustment_state, ADJUSTMENT_STATE.NO_ADJUSTMENT_PENDING_CONFIRMATION)
    );
    assert.equal(view.summary.pending_adjustment_confirmation_count, 2);
    assert.equal(view.summary.is_complete, false);
  });

  it("A NEWLY INITIALIZED EMPLOYEE APPEARS AS PENDING AND RE-OPENS THE MONTH", async () => {
    await usecase.confirmNoAdjustment({ ...MONTH, employee_ids: [1, 2], ...ACTOR });
    let view = await usecase.getMonth(MONTH);
    assert.equal(view.summary.is_complete, true, "the month is finished for the two who exist");

    // Somebody initializes a third employee this afternoon.
    repo.initialized.push(employee(3, "Chitra"));

    view = await usecase.getMonth(MONTH);
    assert.equal(view.summary.initialized_count, 3);
    assert.equal(view.summary.no_adjustment_confirmed_count, 2, "the first two stay completed");
    assert.equal(view.summary.pending_adjustment_confirmation_count, 1);
    assert.equal(view.summary.is_complete, false);
  });

  it("applies the branch scope to the population", async () => {
    repo.initialized.push(employee(9, "Deepa", 5, "Velachery"));
    const view = await usecase.getMonth({ ...MONTH, store_ids: [5] });
    assert.deepEqual(view.rows.map((r) => r.employee_id), [9]);
  });

  it("the summary counts the whole month, never the filtered view", async () => {
    await usecase.saveEmployee({ ...MONTH, employee_id: 1, amounts: { INCENTIVE: 500 }, ...ACTOR });
    const view = await usecase.getMonth({ ...MONTH, state: ADJUSTMENT_STATE.HAS_ADJUSTMENT });
    assert.equal(view.rows.length, 1);
    assert.equal(view.summary.initialized_count, 2);
    assert.equal(view.summary.pending_adjustment_confirmation_count, 1);
  });
});

describe("the import", () => {
  let repo;
  let usecase;

  beforeEach(() => {
    repo = new FakeAdjustmentRepo();
    repo.initialized = [employee(1, "Asha"), employee(2, "Bala")];
    usecase = buildUsecase(repo, new FakePayrunRepo());
  });

  it("separates and counts With Adjustments, Pending Confirmation and Invalid", async () => {
    const preview = await usecase.preview({
      ...MONTH,
      headers: HEADERS,
      rows: [
        row(1, "Asha", { Incentive: "1500" }),
        row(2, "Bala"),
        row(999, "Ghost", { Bonus: "100" }),
      ],
      filename: "adjustments.xlsx",
    });
    assert.equal(preview.with_adjustments, 1);
    assert.equal(preview.no_adjustment_pending_confirmation, 1);
    assert.equal(preview.invalid_rows, 1);
    assert.equal(preview.initialized_count, 2);
  });

  it("PREVIEW WRITES NOTHING", async () => {
    await usecase.preview({
      ...MONTH,
      headers: HEADERS,
      rows: [row(1, "Asha", { Incentive: "1500" })],
    });
    assert.equal(repo.writes, 0, "the preview reached a write");
    assert.equal(repo.amounts.size, 0);
    assert.equal(repo.states.size, 0);
  });

  it("refuses an employee who is not initialized for the month", async () => {
    const preview = await usecase.preview({
      ...MONTH,
      headers: HEADERS,
      rows: [row(4242, "Nobody", { Bonus: "100" })],
    });
    assert.equal(preview.invalid_rows, 1);
    assert.match(preview.rows[0].errors[0], /not initialized for this payroll month/);
  });

  it("refuses an employee outside the caller's branch scope, in the same words", async () => {
    repo.initialized.push(employee(9, "Deepa", 5, "Velachery"));
    const preview = await usecase.preview(
      { ...MONTH, headers: HEADERS, rows: [row(9, "Deepa", { Bonus: "100" })] },
      { store_ids: [1] }
    );
    assert.equal(preview.invalid_rows, 1);
    assert.match(preview.rows[0].errors[0], /not initialized for this payroll month, or is outside your branch scope/);
  });

  it("refuses a duplicate employee row and names the first one", async () => {
    const preview = await usecase.preview({
      ...MONTH,
      headers: HEADERS,
      rows: [row(1, "Asha", { Incentive: "100" }), row(1, "Asha", { Bonus: "200" })],
    });
    assert.equal(preview.invalid_rows, 1);
    assert.match(preview.rows[1].errors[0], /already appears on row 2/);
  });

  it("refuses a negative amount", async () => {
    const preview = await usecase.preview({
      ...MONTH,
      headers: HEADERS,
      rows: [row(1, "Asha", { "Advance Recovery": "-500" })],
    });
    assert.equal(preview.invalid_rows, 1);
    assert.match(preview.rows[0].errors[0], /negative/);
  });

  it("refuses a malformed amount", async () => {
    const preview = await usecase.preview({
      ...MONTH,
      headers: HEADERS,
      rows: [row(1, "Asha", { Bonus: "one thousand" })],
    });
    assert.equal(preview.invalid_rows, 1);
    assert.match(preview.rows[0].errors[0], /is not an amount/);
  });

  it("collects EVERY cell error on a row, not just the first", async () => {
    const preview = await usecase.preview({
      ...MONTH,
      headers: HEADERS,
      rows: [row(1, "Asha", { Bonus: "abc", Incentive: "-1" })],
    });
    assert.equal(preview.rows[0].errors.length, 2);
  });

  it("REFUSES THE WHOLE FILE for an unsupported column rather than ignoring it", async () => {
    await assert.rejects(
      () =>
        usecase.preview({
          ...MONTH,
          headers: [...HEADERS, "Loan Recovery"],
          rows: [row(1, "Asha", { Incentive: "100" })],
        }),
      /does not recognise: Loan Recovery/
    );
  });

  it("refuses a file with no Employee ID column", async () => {
    await assert.rejects(
      () => usecase.preview({ ...MONTH, headers: ["Employee Name", "Bonus"], rows: [] }),
      /no 'Employee ID' column/
    );
  });

  it("warns - but does not refuse - when the name in the file has drifted", async () => {
    const preview = await usecase.preview({
      ...MONTH,
      headers: HEADERS,
      rows: [row(1, "Asha Kumari", { Incentive: "100" })],
    });
    assert.equal(preview.invalid_rows, 0);
    assert.equal(preview.rows[0].warnings.length, 1);
    assert.match(preview.rows[0].warnings[0], /never saved/);
  });

  it("skips trailing empty rows instead of calling them invalid", async () => {
    const preview = await usecase.preview({
      ...MONTH,
      headers: HEADERS,
      rows: [
        row(1, "Asha", { Bonus: "100" }),
        // What a scrolled-through spreadsheet actually sends: every cell "".
        row("", "", { Location: "" }),
        row("", "", { Location: "" }),
      ],
    });
    assert.equal(preview.rows_uploaded, 1);
    assert.equal(preview.invalid_rows, 0);
  });

  it("CONFIRM SAVES ONLY VALID DATA - one bad row stops the whole file", async () => {
    const result = await usecase.confirm(
      {
        ...MONTH,
        headers: HEADERS,
        rows: [row(1, "Asha", { Incentive: "1500" }), row(2, "Bala", { Bonus: "-1" })],
      },
      ACTOR
    );
    assert.equal(result.code, 409);
    assert.equal(result.applied, false);
    assert.equal(repo.writes, 0, "a file with an invalid row reached a write");
    assert.equal(repo.amounts.size, 0);
  });

  it("confirm writes the valid file and reports what it did", async () => {
    const result = await usecase.confirm(
      {
        ...MONTH,
        headers: HEADERS,
        rows: [
          row(1, "Asha", { Incentive: "1500", "Advance Recovery": "500", Remarks: "Aug incentive" }),
          row(2, "Bala"),
        ],
        filename: "aug.xlsx",
      },
      ACTOR
    );
    assert.equal(result.applied, true);
    assert.deepEqual(repo.amounts.get(1), { INCENTIVE: 1500, ADVANCE_RECOVERY: 500 });

    const view = await usecase.getMonth(MONTH);
    const asha = view.rows.find((r) => r.employee_id === 1);
    assert.equal(asha.adjustment_state, ADJUSTMENT_STATE.HAS_ADJUSTMENT);
    assert.equal(asha.net_pay_delta, 1000);
  });

  it("A BLANK ROW DOES NOT CONFIRM ANYBODY - the whole point of the stage", async () => {
    await usecase.confirm(
      { ...MONTH, headers: HEADERS, rows: [row(1, "Asha", { Incentive: "1500" }), row(2, "Bala")] },
      ACTOR
    );
    const view = await usecase.getMonth(MONTH);
    const bala = view.rows.find((r) => r.employee_id === 2);
    assert.equal(bala.adjustment_state, ADJUSTMENT_STATE.NO_ADJUSTMENT_PENDING_CONFIRMATION);
    assert.equal(bala.confirmed_no_adjustment, false);
    assert.equal(view.summary.pending_adjustment_confirmation_count, 1);
  });

  it("A ZERO DOES NOT CONFIRM ANYBODY AND STORES NOTHING", async () => {
    await usecase.confirm(
      {
        ...MONTH,
        headers: HEADERS,
        rows: [row(1, "Asha", { Incentive: "500" }), row(2, "Bala", { Incentive: "0", Bonus: "0.00" })],
      },
      ACTOR
    );
    assert.equal(Object.keys(repo.amounts.get(2) || {}).length, 0);
    const view = await usecase.getMonth(MONTH);
    assert.equal(
      view.rows.find((r) => r.employee_id === 2).adjustment_state,
      ADJUSTMENT_STATE.NO_ADJUSTMENT_PENDING_CONFIRMATION
    );
  });

  it("refuses to save into a LOCKED month", async () => {
    usecase = buildUsecase(repo, new FakePayrunRepo({ status: "LOCKED" }));
    await assert.rejects(
      () =>
        usecase.confirm(
          { ...MONTH, headers: HEADERS, rows: [row(1, "Asha", { Bonus: "100" })] },
          ACTOR
        ),
      /is locked/
    );
    assert.equal(repo.writes, 0);
  });

  it("re-importing an untouched export changes nothing", async () => {
    await usecase.confirm(
      { ...MONTH, headers: HEADERS, rows: [row(1, "Asha", { Incentive: "1500" })] },
      ACTOR
    );
    const before = JSON.stringify([...repo.amounts]);
    await usecase.confirm(
      { ...MONTH, headers: HEADERS, rows: [row(1, "Asha", { Incentive: "1500" })] },
      ACTOR
    );
    assert.equal(JSON.stringify([...repo.amounts]), before);
  });
});

describe("the explicit No Adjustment confirmation", () => {
  let repo;
  let usecase;

  beforeEach(() => {
    repo = new FakeAdjustmentRepo();
    repo.initialized = [employee(1, "Asha"), employee(2, "Bala"), employee(3, "Chitra")];
    usecase = buildUsecase(repo, new FakePayrunRepo());
  });

  it("confirms ONE employee, and records who and when", async () => {
    const result = await usecase.confirmNoAdjustment({ ...MONTH, employee_ids: [2], ...ACTOR });
    assert.equal(result.confirmed_count, 1);

    const view = await usecase.getMonth(MONTH);
    const bala = view.rows.find((r) => r.employee_id === 2);
    assert.equal(bala.adjustment_state, ADJUSTMENT_STATE.NO_ADJUSTMENT_CONFIRMED);
    assert.equal(bala.confirmed_by, 77, "the SERVER's actor, never the browser's claim");
    assert.ok(bala.confirmed_at);
  });

  it("confirms a SELECTION by the same path", async () => {
    const result = await usecase.confirmNoAdjustment({ ...MONTH, employee_ids: [1, 2, 3], ...ACTOR });
    assert.equal(result.confirmed_count, 3);
    assert.equal((await usecase.getMonth(MONTH)).summary.is_complete, true);
  });

  it("refuses to confirm somebody who HAS an adjustment, without failing the batch", async () => {
    await usecase.saveEmployee({ ...MONTH, employee_id: 1, amounts: { BONUS: 1000 }, ...ACTOR });
    const result = await usecase.confirmNoAdjustment({ ...MONTH, employee_ids: [1, 2], ...ACTOR });
    assert.equal(result.has_adjustment_count, 1);
    assert.equal(result.confirmed_count, 1);
    assert.match(result.results[0].message, /cannot be confirmed as having none/);
  });

  it("refuses an employee who is not initialized, and never writes them", async () => {
    const result = await usecase.confirmNoAdjustment({ ...MONTH, employee_ids: [4242], ...ACTOR });
    assert.equal(result.not_initialized_count, 1);
    assert.equal(result.confirmed_count, 0);
    assert.equal(repo.states.size, 0);
  });

  it("re-confirming does not overwrite the original confirmer", async () => {
    await usecase.confirmNoAdjustment({ ...MONTH, employee_ids: [2], ...ACTOR });
    const again = await usecase.confirmNoAdjustment({
      ...MONTH,
      employee_ids: [2],
      actor: { employeeId: 99 },
    });
    assert.equal(again.already_confirmed_count, 1);
    assert.equal(repo.states.get(2).confirmed_by, 77);
  });

  it("refuses in a LOCKED month", async () => {
    usecase = buildUsecase(repo, new FakePayrunRepo({ status: "LOCKED" }));
    await assert.rejects(
      () => usecase.confirmNoAdjustment({ ...MONTH, employee_ids: [2], ...ACTOR }),
      /is locked/
    );
  });

  it("AN ADJUSTMENT AFTER A CONFIRMATION REVOKES IT", async () => {
    await usecase.confirmNoAdjustment({ ...MONTH, employee_ids: [2], ...ACTOR });
    assert.equal(
      (await usecase.getMonth(MONTH)).rows.find((r) => r.employee_id === 2).adjustment_state,
      ADJUSTMENT_STATE.NO_ADJUSTMENT_CONFIRMED
    );

    await usecase.saveEmployee({ ...MONTH, employee_id: 2, amounts: { INCENTIVE: 750 }, ...ACTOR });

    const after = (await usecase.getMonth(MONTH)).rows.find((r) => r.employee_id === 2);
    assert.equal(after.adjustment_state, ADJUSTMENT_STATE.HAS_ADJUSTMENT);
    assert.equal(after.confirmed_no_adjustment, false, "the stored flag itself must be cleared");
    assert.equal(after.confirmed_by, null);
  });
});

describe("BALANCE ADVANCE IS INFORMATIONAL, NOT AN ADJUSTMENT", () => {
  let repo;
  let usecase;

  beforeEach(() => {
    repo = new FakeAdjustmentRepo();
    repo.initialized = [employee(1, "Asha"), employee(2, "Bala")];
    usecase = buildUsecase(repo, new FakePayrunRepo());
  });

  const stateOf = async (employeeId) =>
    (await usecase.getMonth(MONTH)).rows.find((r) => r.employee_id === employeeId).adjustment_state;

  it("a Balance Advance alone leaves the employee PENDING CONFIRMATION", async () => {
    const saved = await usecase.saveEmployee({
      ...MONTH, employee_id: 1, amounts: { BALANCE_ADVANCE: 8500 }, ...ACTOR,
    });
    // It is stored...
    assert.equal(repo.amounts.get(1).BALANCE_ADVANCE, 8500);
    assert.equal(saved.row.amounts.BALANCE_ADVANCE, 8500);
    // ...and it is not an adjustment.
    assert.equal(saved.row.adjustment_state, ADJUSTMENT_STATE.NO_ADJUSTMENT_PENDING_CONFIRMATION);
    assert.equal((await usecase.getMonth(MONTH)).summary.has_adjustment_count, 0);
  });

  it("an employee with a Balance Advance CAN be confirmed as having no adjustment", async () => {
    await usecase.saveEmployee({ ...MONTH, employee_id: 1, amounts: { BALANCE_ADVANCE: 8500 }, ...ACTOR });

    const result = await usecase.confirmNoAdjustment({ ...MONTH, employee_ids: [1], ...ACTOR });
    assert.equal(result.confirmed_count, 1);
    assert.equal(result.has_adjustment_count, 0, "a Balance Advance must not block the confirmation");

    const row = (await usecase.getMonth(MONTH)).rows.find((r) => r.employee_id === 1);
    assert.equal(row.adjustment_state, ADJUSTMENT_STATE.NO_ADJUSTMENT_CONFIRMED);
    // The balance is still there afterwards - the point of the whole rule.
    assert.equal(row.amounts.BALANCE_ADVANCE, 8500);
    assert.equal(row.informational, 8500);
  });

  it("EDITING A BALANCE ADVANCE DOES NOT REVOKE A CONFIRMATION", async () => {
    await usecase.confirmNoAdjustment({ ...MONTH, employee_ids: [1], ...ACTOR });
    assert.equal(await stateOf(1), ADJUSTMENT_STATE.NO_ADJUSTMENT_CONFIRMED);

    await usecase.saveEmployee({ ...MONTH, employee_id: 1, amounts: { BALANCE_ADVANCE: 8500 }, ...ACTOR });
    assert.equal(await stateOf(1), ADJUSTMENT_STATE.NO_ADJUSTMENT_CONFIRMED);

    // And changing it again, and clearing it, leave the confirmation alone.
    await usecase.saveEmployee({ ...MONTH, employee_id: 1, amounts: { BALANCE_ADVANCE: 6000 }, ...ACTOR });
    assert.equal(await stateOf(1), ADJUSTMENT_STATE.NO_ADJUSTMENT_CONFIRMED);
    await usecase.saveEmployee({ ...MONTH, employee_id: 1, amounts: { BALANCE_ADVANCE: null }, ...ACTOR });
    assert.equal(await stateOf(1), ADJUSTMENT_STATE.NO_ADJUSTMENT_CONFIRMED);

    const row = (await usecase.getMonth(MONTH)).rows.find((r) => r.employee_id === 1);
    assert.equal(row.confirmed_no_adjustment, true);
    assert.equal(row.confirmed_by, 77, "the original confirmer is untouched");
  });

  it("A PAY-AFFECTING COMPONENT STILL REVOKES A CONFIRMATION", async () => {
    await usecase.confirmNoAdjustment({ ...MONTH, employee_ids: [1], ...ACTOR });
    await usecase.saveEmployee({ ...MONTH, employee_id: 1, amounts: { BALANCE_ADVANCE: 8500 }, ...ACTOR });
    assert.equal(await stateOf(1), ADJUSTMENT_STATE.NO_ADJUSTMENT_CONFIRMED);

    await usecase.saveEmployee({ ...MONTH, employee_id: 1, amounts: { INCENTIVE: 500 }, ...ACTOR });

    const row = (await usecase.getMonth(MONTH)).rows.find((r) => r.employee_id === 1);
    assert.equal(row.adjustment_state, ADJUSTMENT_STATE.HAS_ADJUSTMENT);
    assert.equal(row.confirmed_no_adjustment, false, "the stored flag must be cleared");
    assert.equal(row.confirmed_by, null);
    // The balance survived the revocation; it was never what was in question.
    assert.equal(row.amounts.BALANCE_ADVANCE, 8500);
  });

  it("each of the five pay-affecting components revokes a confirmation", async () => {
    for (const key of [
      "INCENTIVE", "BONUS", "ARREARS", "ADVANCE_RECOVERY", "SHORTAGE_RECOVERY",
    ]) {
      /* eslint-disable no-await-in-loop */
      repo = new FakeAdjustmentRepo();
      repo.initialized = [employee(1, "Asha")];
      usecase = buildUsecase(repo, new FakePayrunRepo());
      await usecase.confirmNoAdjustment({ ...MONTH, employee_ids: [1], ...ACTOR });
      await usecase.saveEmployee({ ...MONTH, employee_id: 1, amounts: { [key]: 100 }, ...ACTOR });
      const row = (await usecase.getMonth(MONTH)).rows.find((r) => r.employee_id === 1);
      assert.equal(row.adjustment_state, ADJUSTMENT_STATE.HAS_ADJUSTMENT, `${key} must revoke`);
      assert.equal(row.confirmed_no_adjustment, false, `${key} must clear the flag`);
      /* eslint-enable no-await-in-loop */
    }
  });

  it("an IMPORT row with only a Balance Advance is PENDING, not With Adjustments", async () => {
    const preview = await usecase.preview({
      ...MONTH,
      headers: HEADERS,
      rows: [row(1, "Asha", { "Balance Advance": "8500" })],
    });
    assert.equal(preview.with_adjustments, 0);
    assert.equal(preview.no_adjustment_pending_confirmation, 1);
    assert.equal(preview.invalid_rows, 0);
    assert.equal(preview.rows[0].outcome, "NO_ADJUSTMENT_PENDING");
    assert.equal(preview.rows[0].informational, 8500);
    assert.equal(preview.rows[0].net_pay_delta, 0);
  });

  it("an IMPORT row with a Balance Advance AND a recovery is With Adjustments", async () => {
    const preview = await usecase.preview({
      ...MONTH,
      headers: HEADERS,
      rows: [row(1, "Asha", { "Balance Advance": "8500", "Advance Recovery": "1500" })],
    });
    assert.equal(preview.with_adjustments, 1);
    assert.equal(preview.no_adjustment_pending_confirmation, 0);
    assert.equal(preview.rows[0].outcome, "WITH_ADJUSTMENT");
    assert.equal(preview.rows[0].net_pay_delta, -1500);
    assert.equal(preview.rows[0].informational, 8500);
  });

  it("A BALANCE-ADVANCE-ONLY IMPORT ROW IS STILL SAVED, and still leaves them pending", async () => {
    /*
     * The classification decides what the month SAYS; it must not decide what
     * is WRITTEN. Dropping this row would silently discard the balance.
     */
    const result = await usecase.confirm(
      {
        ...MONTH,
        headers: HEADERS,
        rows: [
          row(1, "Asha", { "Balance Advance": "8500" }),
          row(2, "Bala", { Incentive: "1000" }),
        ],
      },
      ACTOR
    );
    assert.equal(result.applied, true);
    assert.equal(repo.amounts.get(1).BALANCE_ADVANCE, 8500, "the balance must reach the database");

    const view = await usecase.getMonth(MONTH);
    assert.equal(
      view.rows.find((r) => r.employee_id === 1).adjustment_state,
      ADJUSTMENT_STATE.NO_ADJUSTMENT_PENDING_CONFIRMATION
    );
    assert.equal(view.summary.has_adjustment_count, 1, "only Bala has an adjustment");
    assert.equal(view.summary.pending_adjustment_confirmation_count, 1);
  });

  it("the completion summary follows the same rule", async () => {
    await usecase.saveEmployee({ ...MONTH, employee_id: 1, amounts: { BALANCE_ADVANCE: 8500 }, ...ACTOR });
    await usecase.saveEmployee({ ...MONTH, employee_id: 2, amounts: { BALANCE_ADVANCE: 200 }, ...ACTOR });

    let summary = (await usecase.getMonth(MONTH)).summary;
    assert.equal(summary.has_adjustment_count, 0);
    assert.equal(summary.pending_adjustment_confirmation_count, 2);
    assert.equal(summary.is_complete, false, "balances alone do not finish a month");

    await usecase.confirmNoAdjustment({ ...MONTH, employee_ids: [1, 2], ...ACTOR });
    summary = (await usecase.getMonth(MONTH)).summary;
    assert.equal(summary.no_adjustment_confirmed_count, 2);
    assert.equal(summary.pending_adjustment_confirmation_count, 0);
    assert.equal(summary.is_complete, true);
  });

  it("the CALCULATION CONTRACT is unchanged - a balance moves no money", async () => {
    const saved = await usecase.saveEmployee({
      ...MONTH,
      employee_id: 1,
      amounts: { BALANCE_ADVANCE: 8500, INCENTIVE: 1000, ADVANCE_RECOVERY: 400 },
      ...ACTOR,
    });
    assert.equal(saved.row.net_pay_delta, 600, "1000 - 400, with the 8500 contributing nothing");
    assert.equal(saved.row.additions, 1000);
    assert.equal(saved.row.deductions, 400);
    assert.equal(saved.row.informational, 8500);
    assert.equal(saved.row.pf_wage_delta, 0);
    assert.equal(saved.row.esi_wage_delta, 0);
  });
});

describe("manual editing", () => {
  let repo;
  let usecase;

  beforeEach(() => {
    repo = new FakeAdjustmentRepo();
    repo.initialized = [employee(1, "Asha")];
    usecase = buildUsecase(repo, new FakePayrunRepo());
  });

  it("adds, then edits, then clears an adjustment", async () => {
    await usecase.saveEmployee({ ...MONTH, employee_id: 1, amounts: { INCENTIVE: 1000 }, ...ACTOR });
    assert.deepEqual(repo.amounts.get(1), { INCENTIVE: 1000 });

    await usecase.saveEmployee({ ...MONTH, employee_id: 1, amounts: { INCENTIVE: 1200 }, ...ACTOR });
    assert.deepEqual(repo.amounts.get(1), { INCENTIVE: 1200 });

    const cleared = await usecase.saveEmployee({
      ...MONTH, employee_id: 1, amounts: { INCENTIVE: null }, ...ACTOR,
    });
    assert.deepEqual(repo.amounts.get(1), {});
    assert.equal(cleared.row.adjustment_state, ADJUSTMENT_STATE.NO_ADJUSTMENT_PENDING_CONFIRMATION);
  });

  it("uses the SAME validation as the import", async () => {
    await assert.rejects(
      () => usecase.saveEmployee({ ...MONTH, employee_id: 1, amounts: { ADVANCE_RECOVERY: -5 }, ...ACTOR }),
      /negative/
    );
    await assert.rejects(
      () => usecase.saveEmployee({ ...MONTH, employee_id: 1, amounts: { BONUS: "abc" }, ...ACTOR }),
      /is not an amount/
    );
  });

  it("refuses a component V1 does not have", async () => {
    await assert.rejects(
      () => usecase.saveEmployee({ ...MONTH, employee_id: 1, amounts: { LOAN_RECOVERY: 100 }, ...ACTOR }),
      /not a component this payroll stage supports/
    );
  });

  it("stores Balance Advance but leaves the net pay delta at zero", async () => {
    const saved = await usecase.saveEmployee({
      ...MONTH, employee_id: 1, amounts: { BALANCE_ADVANCE: 18000 }, ...ACTOR,
    });
    assert.equal(saved.row.amounts.BALANCE_ADVANCE, 18000);
    assert.equal(saved.row.net_pay_delta, 0);
    assert.equal(saved.row.informational, 18000);
    // And it does not make them an employee with an adjustment.
    assert.equal(saved.row.adjustment_state, ADJUSTMENT_STATE.NO_ADJUSTMENT_PENDING_CONFIRMATION);
  });

  it("refuses an employee who is not initialized for the month", async () => {
    await assert.rejects(
      () => usecase.saveEmployee({ ...MONTH, employee_id: 4242, amounts: { BONUS: 1 }, ...ACTOR }),
      /not initialized for the selected payroll month/
    );
  });

  it("refuses in a LOCKED month", async () => {
    usecase = buildUsecase(repo, new FakePayrunRepo({ status: "LOCKED" }));
    await assert.rejects(
      () => usecase.saveEmployee({ ...MONTH, employee_id: 1, amounts: { BONUS: 1 }, ...ACTOR }),
      /is locked/
    );
  });

  it("supports remarks", async () => {
    const saved = await usecase.saveEmployee({
      ...MONTH, employee_id: 1, amounts: { BONUS: 500 }, remarks: "Diwali", ...ACTOR,
    });
    assert.equal(saved.row.remarks, "Diwali");
  });
});

describe("the export template", () => {
  it("carries only the month's initialized employees, pre-filled, one row each", async () => {
    const repo = new FakeAdjustmentRepo();
    repo.initialized = [employee(1, "Asha"), employee(2, "Bala")];
    const usecase = buildUsecase(repo, new FakePayrunRepo());
    await usecase.saveEmployee({ ...MONTH, employee_id: 1, amounts: { BONUS: 1000 }, ...ACTOR });

    const sheet = await usecase.buildExport(MONTH);
    assert.equal(sheet.rows.length, 2);
    assert.deepEqual(
      sheet.columns.map((c) => c.label),
      [
        "Employee ID", "Employee Name", "Location",
        "Incentive", "Bonus", "Arrears",
        "Advance Recovery", "Shortage Recovery", "Balance Advance",
        "Remarks",
      ]
    );
    assert.equal(sheet.rows[0].BONUS, 1000);
    assert.equal(sheet.rows[0].INCENTIVE, "", "a zero is an empty cell, not 0.00");
    assert.equal(sheet.rows[1].BONUS, "");
  });
});
