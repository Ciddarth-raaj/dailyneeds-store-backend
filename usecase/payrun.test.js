/**
 * Payrun Initialization - the rules this stage adds, and the ones it must
 * leave exactly as they were.
 *
 *   node --test usecase/payrun.test.js
 *
 * WHAT IS PROVED HERE. Every eligibility refusal, the pay type defaults and
 * the month-specific rule that goes with them, idempotency, the row-level
 * outcome of a bulk run, and the two refusals that would be most expensive to
 * get wrong: a locked month accepting work, and the Employee Master being
 * mutated by a payrun.
 *
 * NO DATABASE AND NO EXPRESS. The usecase is built over a fake repository and
 * the rules it defers to are pure, which is the whole reason they were put in
 * `utils/payrun_eligibility.js` rather than in a query.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const buildUsecase = require("./payrun");
const { ROW_RESULT } = require("./payrun");
const { BLOCK_REASON, STATUS_GROUP, PAY_TYPE, PAY_TYPE_SOURCE, PERIOD_STATUS } =
  require("../constants/payrun");

const YEAR = 2026;
const MONTH = 8;
const ACTOR = { employeeId: 7 };

/** An employee the rules have no complaint about. */
const employee = (over = {}) => ({
  employee_id: 42,
  employee_name: "Test Person",
  status: 1,
  store_id: 3,
  store_name: "Anna Nagar",
  designation_id: 5,
  designation_name: "Billing Staff",
  department_id: 2,
  payment_type: 1, // Bank, in the Employee Master's encoding
  pf_applicable: 1,
  esi_applicable: 0,
  uan: "100200300400",
  pf_number: null,
  esi_number: null,
  account_no: "9988776655",
  ifsc: "HDFC0000123",
  date_of_joining: "2019-06-01",
  resignation_date: null,
  ...over,
});

const salary = (over = {}) => ({
  employee_id: 42,
  salary_id: 900,
  monthly_gross: 26000,
  daily_salary: 1000,
  basic: 13000,
  conveyance: 1600,
  hra: 5200,
  special_allowance: 6200,
  effective_from: "2026-04-01",
  ...over,
});

const attendanceMonth = (over = {}) => ({
  employee_id: 42,
  attendance_monthly_payroll_id: 5001,
  is_final: 1,
  payroll_version: 1,
  calculated_at: "2026-09-01 04:00:00.000",
  ...over,
});

/**
 * The repository, faked - and it RECORDS every write, because several of the
 * assertions below are about writes that must NOT happen.
 */
function fakeRepo({
  population = [employee()],
  salaries = [salary()],
  attendance = [attendanceMonth()],
  pending = [],
  existing = [],
  period = null,
} = {}) {
  const inserts = [];
  const payTypeChanges = [];
  const store = existing.slice();
  return {
    inserts,
    payTypeChanges,
    store,
    async getPeriod() {
      return period;
    },
    async listPopulation() {
      return population;
    },
    async listApprovedSalaries() {
      return salaries;
    },
    async listAttendanceMonths() {
      return attendance;
    },
    async listPendingApprovals() {
      return pending;
    },
    /* Scoped by month, as the real statement is - a snapshot belongs to ONE
       month, and a fake that ignored that would hide the whole pay-type rule. */
    async listPayrunRows({ year, month }) {
      return store.filter((r) => r.period_year === year && r.period_month === month);
    },
    async insertSnapshots(rows) {
      rows.forEach((row) => {
        inserts.push(row);
        // The UNIQUE KEY, faked: a second insert for the same month and
        // employee does nothing, exactly as `INSERT IGNORE` does.
        if (!store.some((r) => r.employee_id === row.employee_id)) {
          store.push({
            ...row,
            payrun_employee_id: store.length + 1,
            initialized_at: "2026-09-01 10:00:00",
            initialized_by: row.initialized_by,
            salary_effective_from: row.salary_effective_from,
          });
        }
      });
      return store.map((r) => ({
        employee_id: r.employee_id,
        payrun_employee_id: r.payrun_employee_id,
        pay_type: r.pay_type,
        pay_type_source: r.pay_type_source,
      }));
    },
    async changePayType({ employee_id, pay_type, changed_by }) {
      const row = store.find((r) => r.employee_id === employee_id);
      if (!row) return null;
      const old = row.pay_type;
      if (old === pay_type) return { payrun_employee_id: row.payrun_employee_id, old_pay_type: old, new_pay_type: pay_type, changed: false };
      row.pay_type = pay_type;
      row.pay_type_source = PAY_TYPE_SOURCE.MANUAL;
      payTypeChanges.push({ employee_id, old_pay_type: old, new_pay_type: pay_type, changed_by });
      return { payrun_employee_id: row.payrun_employee_id, old_pay_type: old, new_pay_type: pay_type, changed: true };
    },
    async listPayTypeAudit() {
      return payTypeChanges.slice().reverse();
    },
  };
}

const rowFor = (view, employeeId = 42) =>
  view.rows.find((r) => r.employee_id === employeeId);

const reasonCodes = (row) => row.blocking_reasons.map((r) => r.code);

describe("the month's status groups", () => {
  it("an eligible active employee is READY", async () => {
    const usecase = buildUsecase(fakeRepo());
    const view = await usecase.getMonth({ year: YEAR, month: MONTH });
    const row = rowFor(view);
    assert.equal(row.status, STATUS_GROUP.READY);
    assert.deepEqual(row.blocking_reasons, []);
    assert.equal(view.summary.ready, 1);
    assert.equal(view.summary.total_eligible, 1);
  });

  it("an employee with no approved salary is BLOCKED, and says so", async () => {
    const usecase = buildUsecase(fakeRepo({ salaries: [] }));
    const row = rowFor(await usecase.getMonth({ year: YEAR, month: MONTH }));
    assert.equal(row.status, STATUS_GROUP.BLOCKED);
    assert.ok(reasonCodes(row).includes(BLOCK_REASON.SALARY_NOT_APPROVED));
  });

  it("a month the attendance engine has not calculated BLOCKS", async () => {
    const usecase = buildUsecase(fakeRepo({ attendance: [] }));
    const row = rowFor(await usecase.getMonth({ year: YEAR, month: MONTH }));
    assert.ok(reasonCodes(row).includes(BLOCK_REASON.ATTENDANCE_INCOMPLETE));
  });

  it("a calculated but UNSETTLED month blocks - is_final is the test, not existence", async () => {
    const usecase = buildUsecase(
      fakeRepo({ attendance: [attendanceMonth({ is_final: 0 })] })
    );
    const row = rowFor(await usecase.getMonth({ year: YEAR, month: MONTH }));
    assert.ok(reasonCodes(row).includes(BLOCK_REASON.ATTENDANCE_INCOMPLETE));
  });

  it("an unresolved regularization blocks", async () => {
    const usecase = buildUsecase(
      fakeRepo({ pending: [{ employee_id: 42, pending_regularizations: 1, pending_ot: 0 }] })
    );
    const row = rowFor(await usecase.getMonth({ year: YEAR, month: MONTH }));
    assert.ok(reasonCodes(row).includes(BLOCK_REASON.PENDING_ATTENDANCE_REGULARIZATION));
    assert.ok(!reasonCodes(row).includes(BLOCK_REASON.PENDING_OT_APPROVAL));
  });

  it("an unresolved OT approval blocks", async () => {
    const usecase = buildUsecase(
      fakeRepo({ pending: [{ employee_id: 42, pending_regularizations: 0, pending_ot: 2 }] })
    );
    const row = rowFor(await usecase.getMonth({ year: YEAR, month: MONTH }));
    assert.ok(reasonCodes(row).includes(BLOCK_REASON.PENDING_OT_APPROVAL));
  });

  it("an unanswered PF/ESI applicability blocks - NULL is not 'no'", async () => {
    const usecase = buildUsecase(
      fakeRepo({ population: [employee({ pf_applicable: null })] })
    );
    const row = rowFor(await usecase.getMonth({ year: YEAR, month: MONTH }));
    assert.ok(reasonCodes(row).includes(BLOCK_REASON.STATUTORY_SETUP_INCOMPLETE));
  });

  it("PF applicable with no UAN and no PF number blocks", async () => {
    const usecase = buildUsecase(
      fakeRepo({ population: [employee({ uan: null, pf_number: null })] })
    );
    const row = rowFor(await usecase.getMonth({ year: YEAR, month: MONTH }));
    assert.ok(reasonCodes(row).includes(BLOCK_REASON.STATUTORY_SETUP_INCOMPLETE));
  });

  it("somebody the schemes do not apply to needs no identifier", async () => {
    const usecase = buildUsecase(
      fakeRepo({
        population: [employee({ pf_applicable: 0, esi_applicable: 0, uan: null, esi_number: null })],
      })
    );
    const row = rowFor(await usecase.getMonth({ year: YEAR, month: MONTH }));
    assert.equal(row.status, STATUS_GROUP.READY);
  });

  it("a locked month blocks everybody in it", async () => {
    const usecase = buildUsecase(
      fakeRepo({ period: { status: PERIOD_STATUS.LOCKED } })
    );
    const view = await usecase.getMonth({ year: YEAR, month: MONTH });
    assert.equal(view.month_locked, true);
    assert.ok(reasonCodes(rowFor(view)).includes(BLOCK_REASON.MONTH_LOCKED));
  });

  it("somebody who left before the month starts is not in it", async () => {
    const usecase = buildUsecase(
      fakeRepo({ population: [employee({ resignation_date: "2026-05-31", status: 0 })] })
    );
    const row = rowFor(await usecase.getMonth({ year: YEAR, month: MONTH }));
    assert.ok(reasonCodes(row).includes(BLOCK_REASON.NOT_EMPLOYED_IN_MONTH));
  });

  it("somebody who joined mid-month IS in it - any part of the month counts", async () => {
    const usecase = buildUsecase(
      fakeRepo({ population: [employee({ date_of_joining: "2026-08-28" })] })
    );
    const row = rowFor(await usecase.getMonth({ year: YEAR, month: MONTH }));
    assert.equal(row.status, STATUS_GROUP.READY);
  });

  it("missing bank details are a WARNING and never a block", async () => {
    const usecase = buildUsecase(
      fakeRepo({ population: [employee({ account_no: null, ifsc: null })] })
    );
    const row = rowFor(await usecase.getMonth({ year: YEAR, month: MONTH }));
    assert.equal(row.status, STATUS_GROUP.READY);
    assert.equal(row.warnings[0].code, "BANK_DETAILS_MISSING");
  });

  it("the account number itself never leaves the server", async () => {
    const usecase = buildUsecase(fakeRepo());
    const row = rowFor(await usecase.getMonth({ year: YEAR, month: MONTH }));
    assert.equal(row.account_no, undefined);
    assert.equal(row.ifsc, undefined);
  });

  it("a status filter narrows the rows and never the summary", async () => {
    const usecase = buildUsecase(
      fakeRepo({
        population: [employee(), employee({ employee_id: 43, employee_name: "Second" })],
        salaries: [salary()], // 43 has none, so 43 is blocked
        attendance: [attendanceMonth(), attendanceMonth({ employee_id: 43 })],
      })
    );
    const view = await usecase.getMonth({ year: YEAR, month: MONTH, status: "READY" });
    assert.equal(view.rows.length, 1);
    assert.equal(view.summary.total_eligible, 2);
    assert.equal(view.summary.blocked, 1);
  });
});

describe("the monthly pay type", () => {
  it("an active employee defaults from the Employee Master", async () => {
    const bank = buildUsecase(fakeRepo());
    assert.equal(rowFor(await bank.getMonth({ year: YEAR, month: MONTH })).pay_type, PAY_TYPE.BANK);

    const cash = buildUsecase(fakeRepo({ population: [employee({ payment_type: 2 })] }));
    assert.equal(rowFor(await cash.getMonth({ year: YEAR, month: MONTH })).pay_type, PAY_TYPE.CASH);
  });

  it("a resigned employee defaults to CASH even though the master says Bank", async () => {
    const usecase = buildUsecase(
      fakeRepo({
        population: [employee({ payment_type: 1, resignation_date: "2026-08-20", status: 0 })],
      })
    );
    const row = rowFor(await usecase.getMonth({ year: YEAR, month: MONTH }));
    assert.equal(row.pay_type, PAY_TYPE.CASH);
    assert.equal(row.pay_type_source, PAY_TYPE_SOURCE.RESIGNED_DEFAULT);
  });

  it("HOLD is not a pay type", async () => {
    const repo = fakeRepo();
    const usecase = buildUsecase(repo);
    await usecase.initialize({ year: YEAR, month: MONTH, employee_ids: [42], actor: ACTOR });
    await assert.rejects(
      () => usecase.changePayType({ year: YEAR, month: MONTH, employee_id: 42, pay_type: "HOLD", actor: ACTOR }),
      /pay_type must be one of BANK, CASH/
    );
  });

  it("changing it writes the payrun row, the audit, and NOTHING on the employee", async () => {
    const master = employee();
    const repo = fakeRepo({ population: [master] });
    const usecase = buildUsecase(repo);
    await usecase.initialize({ year: YEAR, month: MONTH, employee_ids: [42], actor: ACTOR });

    const out = await usecase.changePayType({
      year: YEAR, month: MONTH, employee_id: 42, pay_type: PAY_TYPE.CASH, actor: ACTOR,
    });

    assert.equal(out.old_pay_type, PAY_TYPE.BANK);
    assert.equal(out.pay_type, PAY_TYPE.CASH);
    assert.equal(repo.payTypeChanges.length, 1);
    assert.equal(repo.payTypeChanges[0].changed_by, ACTOR.employeeId);
    // THE WHOLE POINT: the Employee Master is untouched.
    assert.equal(master.payment_type, 1);
  });

  it("is MONTH-SPECIFIC: another month keeps the master's default", async () => {
    const repo = fakeRepo();
    const usecase = buildUsecase(repo);
    await usecase.initialize({ year: YEAR, month: MONTH, employee_ids: [42], actor: ACTOR });
    await usecase.changePayType({ year: YEAR, month: MONTH, employee_id: 42, pay_type: PAY_TYPE.CASH, actor: ACTOR });

    // A different month has no snapshot, so its row shows the default again.
    const september = await usecase.getMonth({ year: YEAR, month: 9 });
    const row = september.rows.find((r) => r.employee_id === 42);
    assert.equal(row.pay_type, PAY_TYPE.BANK);
    assert.equal(row.pay_type_source, PAY_TYPE_SOURCE.EMPLOYEE_MASTER);
  });

  it("an employee with no snapshot for the month cannot have one changed", async () => {
    const usecase = buildUsecase(fakeRepo());
    await assert.rejects(
      () => usecase.changePayType({ year: YEAR, month: MONTH, employee_id: 42, pay_type: PAY_TYPE.CASH, actor: ACTOR }),
      /no initialized payrun/
    );
  });

  it("a locked month refuses a pay type change", async () => {
    const repo = fakeRepo();
    const usecase = buildUsecase(repo);
    await usecase.initialize({ year: YEAR, month: MONTH, employee_ids: [42], actor: ACTOR });
    repo.getPeriod = async () => ({ status: PERIOD_STATUS.LOCKED });
    await assert.rejects(
      () => usecase.changePayType({ year: YEAR, month: MONTH, employee_id: 42, pay_type: PAY_TYPE.CASH, actor: ACTOR }),
      /locked/
    );
  });

  it("an employee outside the caller's branch scope cannot be changed", async () => {
    const repo = fakeRepo();
    const usecase = buildUsecase(repo);
    await usecase.initialize({ year: YEAR, month: MONTH, employee_ids: [42], actor: ACTOR });
    // The scope resolved to no branches, so the population comes back empty.
    repo.listPopulation = async () => [];
    await assert.rejects(
      () => usecase.changePayType({ year: YEAR, month: MONTH, employee_id: 42, pay_type: PAY_TYPE.CASH, store_ids: [], actor: ACTOR }),
      /outside your branch scope/
    );
  });
});

describe("initialization", () => {
  it("stores the snapshot from the SERVER's records, never from the request", async () => {
    const repo = fakeRepo();
    const usecase = buildUsecase(repo);
    await usecase.initialize({
      year: YEAR, month: MONTH,
      employee_ids: [42],
      // A body that tries to dictate the money. It is not even read.
      monthly_gross: 999999,
      actor: ACTOR,
    });
    const row = repo.inserts[0];
    assert.equal(row.monthly_gross, 26000);
    assert.equal(row.salary_id, 900);
    assert.equal(row.attendance_monthly_payroll_id, 5001);
    assert.equal(row.attendance_payroll_version, 1);
    assert.equal(row.initialized_by, ACTOR.employeeId);
    assert.equal(row.employee_name, "Test Person");
    assert.equal(row.designation_name, "Billing Staff");
    assert.equal(row.store_name, "Anna Nagar");
    assert.equal(row.date_of_joining, "2019-06-01");
    assert.equal(row.status, "INITIALIZED");
  });

  it("is idempotent: a repeated initialize creates no second snapshot", async () => {
    const repo = fakeRepo();
    const usecase = buildUsecase(repo);
    const first = await usecase.initialize({ year: YEAR, month: MONTH, employee_ids: [42], actor: ACTOR });
    const second = await usecase.initialize({ year: YEAR, month: MONTH, employee_ids: [42], actor: ACTOR });

    assert.equal(first.results[0].result, ROW_RESULT.INITIALIZED);
    assert.equal(second.results[0].result, ROW_RESULT.ALREADY_INITIALIZED);
    assert.equal(repo.store.filter((r) => r.employee_id === 42).length, 1);
    assert.equal(repo.inserts.length, 1, "the second run inserted nothing at all");
  });

  it("a repeat does not overwrite a pay type somebody changed by hand", async () => {
    const repo = fakeRepo();
    const usecase = buildUsecase(repo);
    await usecase.initialize({ year: YEAR, month: MONTH, employee_ids: [42], actor: ACTOR });
    await usecase.changePayType({ year: YEAR, month: MONTH, employee_id: 42, pay_type: PAY_TYPE.CASH, actor: ACTOR });
    await usecase.initialize({ year: YEAR, month: MONTH, employee_ids: [42], actor: ACTOR });

    assert.equal(repo.store.find((r) => r.employee_id === 42).pay_type, PAY_TYPE.CASH);
  });

  it("bulk: the eligible rows go through and the blocked ones come back named", async () => {
    const repo = fakeRepo({
      population: [
        employee(),
        employee({ employee_id: 43, employee_name: "No Salary" }),
        employee({ employee_id: 44, employee_name: "Pending OT" }),
      ],
      salaries: [salary(), salary({ employee_id: 44, salary_id: 901 })],
      attendance: [
        attendanceMonth(),
        attendanceMonth({ employee_id: 43, attendance_monthly_payroll_id: 5002 }),
        attendanceMonth({ employee_id: 44, attendance_monthly_payroll_id: 5003 }),
      ],
      pending: [{ employee_id: 44, pending_regularizations: 0, pending_ot: 1 }],
    });
    const usecase = buildUsecase(repo);

    const out = await usecase.initialize({
      year: YEAR, month: MONTH, employee_ids: [42, 43, 44], actor: ACTOR,
    });

    assert.equal(out.initialized_count, 1);
    assert.equal(out.blocked_count, 2);
    assert.equal(out.results[0].result, ROW_RESULT.INITIALIZED);
    assert.equal(out.results[1].result, ROW_RESULT.BLOCKED);
    assert.ok(out.results[1].message.match(/Salary not approved/));
    assert.equal(out.results[2].result, ROW_RESULT.BLOCKED);
    assert.ok(out.results[2].message.match(/Pending OT approval/));
    // Only the eligible row was written.
    assert.deepEqual(repo.inserts.map((r) => r.employee_id), [42]);
  });

  it("a blocked row never reaches the database, even alone", async () => {
    const repo = fakeRepo({ salaries: [] });
    const usecase = buildUsecase(repo);
    const out = await usecase.initialize({ year: YEAR, month: MONTH, employee_ids: [42], actor: ACTOR });
    assert.equal(out.results[0].result, ROW_RESULT.BLOCKED);
    assert.equal(repo.inserts.length, 0);
  });

  it("a locked month refuses the whole request", async () => {
    const repo = fakeRepo({ period: { status: PERIOD_STATUS.LOCKED } });
    const usecase = buildUsecase(repo);
    await assert.rejects(
      () => usecase.initialize({ year: YEAR, month: MONTH, employee_ids: [42], actor: ACTOR }),
      /locked/
    );
    assert.equal(repo.inserts.length, 0);
  });

  it("an employee outside the branch scope is refused without confirming they exist", async () => {
    const repo = fakeRepo({ population: [] });
    const usecase = buildUsecase(repo);
    const out = await usecase.initialize({
      year: YEAR, month: MONTH, employee_ids: [42], store_ids: [99], actor: ACTOR,
    });
    assert.equal(out.results[0].result, ROW_RESULT.NOT_IN_SCOPE);
    assert.equal(repo.inserts.length, 0);
  });

  it("refuses a month that is not a month", async () => {
    const usecase = buildUsecase(fakeRepo());
    await assert.rejects(() => usecase.getMonth({ year: YEAR, month: 13 }), /month 1-12/);
    await assert.rejects(
      () => usecase.initialize({ year: YEAR, month: MONTH, employee_ids: [], actor: ACTOR }),
      /employee_ids/
    );
  });

  it("an INITIALIZED employee stays initialized when their sources move afterwards", async () => {
    const repo = fakeRepo();
    const usecase = buildUsecase(repo);
    await usecase.initialize({ year: YEAR, month: MONTH, employee_ids: [42], actor: ACTOR });

    // A regularization is raised after the snapshot was taken.
    repo.listPendingApprovals = async () => [
      { employee_id: 42, pending_regularizations: 1, pending_ot: 0 },
    ];
    const row = rowFor(await usecase.getMonth({ year: YEAR, month: MONTH }));
    assert.equal(row.status, STATUS_GROUP.INITIALIZED);
    // The reason is still reported - a Recalculate will have to deal with it -
    // but it no longer decides the group.
    assert.ok(reasonCodes(row).includes(BLOCK_REASON.PENDING_ATTENDANCE_REGULARIZATION));
  });

  it("the snapshot is what the month is read from afterwards, not the live salary", async () => {
    const repo = fakeRepo();
    const usecase = buildUsecase(repo);
    await usecase.initialize({ year: YEAR, month: MONTH, employee_ids: [42], actor: ACTOR });

    // Somebody approves a revision back-dated into the month.
    repo.listApprovedSalaries = async () => [salary({ salary_id: 950, monthly_gross: 40000 })];

    const row = rowFor(await usecase.getMonth({ year: YEAR, month: MONTH }));
    assert.equal(Number(row.monthly_gross), 26000, "the snapshot did not silently move");
    assert.equal(row.salary_id, 900);
  });
});
