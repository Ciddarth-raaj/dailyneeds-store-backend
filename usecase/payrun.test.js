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
const {
  BLOCK_REASON,
  BLOCK_REASON_LABEL,
  STATUS_GROUP,
  LIFECYCLE_FILTER,
  PAY_TYPE,
  PAY_TYPE_SOURCE,
  PERIOD_STATUS,
} = require("../constants/payrun");

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

describe("the compact blocking reason label", () => {
  it("every reason carries a code, a short label and the explaining sentence", async () => {
    const usecase = buildUsecase(fakeRepo({ salaries: [], attendance: [] }));
    const row = rowFor(await usecase.getMonth({ year: YEAR, month: MONTH }));

    row.blocking_reasons.forEach((reason) => {
      assert.ok(reason.code, "a reason with no code cannot be asserted or grouped");
      assert.ok(reason.label, "a reason with no label cannot go on a badge");
      assert.ok(reason.message, "a reason with no message cannot be acted on");
    });
  });

  it("the label is the BUSINESS NAME and carries no explanation", () => {
    assert.equal(BLOCK_REASON_LABEL[BLOCK_REASON.ATTENDANCE_INCOMPLETE], "Attendance incomplete");
    assert.equal(BLOCK_REASON_LABEL[BLOCK_REASON.SALARY_NOT_APPROVED], "Salary not approved");
    assert.equal(
      BLOCK_REASON_LABEL[BLOCK_REASON.PENDING_ATTENDANCE_REGULARIZATION],
      "Pending attendance request"
    );
    assert.equal(BLOCK_REASON_LABEL[BLOCK_REASON.PENDING_OT_APPROVAL], "Pending OT approval");
    assert.equal(
      BLOCK_REASON_LABEL[BLOCK_REASON.STATUTORY_SETUP_INCOMPLETE],
      "Statutory setup incomplete"
    );
    assert.equal(BLOCK_REASON_LABEL[BLOCK_REASON.MONTH_LOCKED], "Month locked");

    // No label explains itself - that is the message's job. A label with a
    // dash in it is a sentence that has crept into a badge.
    Object.values(BLOCK_REASON_LABEL).forEach((label) => {
      assert.ok(!label.includes(" - "), `"${label}" is a sentence, not a label`);
      assert.ok(label.length <= 30, `"${label}" is too long for a badge`);
    });
  });

  it("EVERY reason code has a label - a new blocker cannot ship unnamed", () => {
    Object.values(BLOCK_REASON).forEach((code) =>
      assert.ok(BLOCK_REASON_LABEL[code], `${code} has no compact label`)
    );
  });

  it("all of an employee's blockers are reported, not just the first", async () => {
    const usecase = buildUsecase(
      fakeRepo({
        salaries: [],
        attendance: [],
        pending: [{ employee_id: 42, pending_regularizations: 1, pending_ot: 1 }],
      })
    );
    const row = rowFor(await usecase.getMonth({ year: YEAR, month: MONTH }));
    const labels = row.blocking_reasons.map((r) => r.label);
    assert.ok(labels.includes("Salary not approved"));
    assert.ok(labels.includes("Attendance incomplete"));
    assert.ok(labels.includes("Pending attendance request"));
    assert.ok(labels.includes("Pending OT approval"));
  });
});

describe("the lifecycle filter", () => {
  /** Two employees: one who left inside the month, one still working. */
  const twoEmployees = () =>
    fakeRepo({
      population: [
        employee({ employee_id: 42, employee_name: "Still Here", resignation_date: null }),
        employee({
          employee_id: 43,
          employee_name: "Has Left",
          status: 0,
          resignation_date: "2026-08-20",
        }),
      ],
      salaries: [salary(), salary({ employee_id: 43, salary_id: 901 })],
      attendance: [attendanceMonth(), attendanceMonth({ employee_id: 43, attendance_monthly_payroll_id: 5002 })],
    });

  const idsIn = (view) => view.rows.map((r) => r.employee_id);

  it("ALL, or no filter at all, is everybody", async () => {
    const usecase = buildUsecase(twoEmployees());
    assert.deepEqual(idsIn(await usecase.getMonth({ year: YEAR, month: MONTH })), [42, 43]);
    assert.deepEqual(
      idsIn(await usecase.getMonth({ year: YEAR, month: MONTH, lifecycle: LIFECYCLE_FILTER.ALL })),
      [42, 43]
    );
  });

  it("EXITED is only those who had left by the end of the month", async () => {
    const usecase = buildUsecase(twoEmployees());
    const view = await usecase.getMonth({ year: YEAR, month: MONTH, lifecycle: "EXITED" });
    assert.deepEqual(idsIn(view), [43]);
    assert.equal(view.rows[0].exited_in_month, true);
  });

  it("ACTIVE is everybody else", async () => {
    const usecase = buildUsecase(twoEmployees());
    const view = await usecase.getMonth({ year: YEAR, month: MONTH, lifecycle: "ACTIVE" });
    assert.deepEqual(idsIn(view), [42]);
    assert.equal(view.rows[0].exited_in_month, false);
  });

  /**
   * THE RULE THIS FILTER MUST NOT BREAK. Somebody who resigns in September is
   * ACTIVE in August, whatever the employee master says today - the same dated
   * answer the badge gives, because it is the same field.
   */
  it("EXITED is DATED and never the employee master's current status", async () => {
    const repo = fakeRepo({
      population: [
        employee({ employee_id: 42, status: 0, resignation_date: "2026-09-10" }),
      ],
    });
    const usecase = buildUsecase(repo);

    // August: they had not left yet, so ACTIVE finds them and EXITED does not.
    assert.deepEqual(idsIn(await usecase.getMonth({ year: YEAR, month: 8, lifecycle: "ACTIVE" })), [42]);
    assert.deepEqual(idsIn(await usecase.getMonth({ year: YEAR, month: 8, lifecycle: "EXITED" })), []);

    // September: the month they left in.
    assert.deepEqual(idsIn(await usecase.getMonth({ year: YEAR, month: 9, lifecycle: "EXITED" })), [42]);
    assert.deepEqual(idsIn(await usecase.getMonth({ year: YEAR, month: 9, lifecycle: "ACTIVE" })), []);
  });

  it("an inactive status with NO resignation date is never EXITED", async () => {
    const usecase = buildUsecase(
      fakeRepo({ population: [employee({ status: 0, resignation_date: null })] })
    );
    assert.deepEqual(idsIn(await usecase.getMonth({ year: YEAR, month: MONTH, lifecycle: "EXITED" })), []);
    assert.deepEqual(idsIn(await usecase.getMonth({ year: YEAR, month: MONTH, lifecycle: "ACTIVE" })), [42]);
  });

  it("IT COMPOSES WITH STATUS, and the two are independent", async () => {
    const repo = fakeRepo({
      population: [
        employee({ employee_id: 42, employee_name: "Active Ready" }),
        employee({ employee_id: 43, employee_name: "Exited Ready", status: 0, resignation_date: "2026-08-20" }),
        employee({ employee_id: 44, employee_name: "Exited Blocked", status: 0, resignation_date: "2026-08-21" }),
      ],
      // 44 has no salary, so 44 is the blocked one.
      salaries: [salary(), salary({ employee_id: 43, salary_id: 901 })],
      attendance: [
        attendanceMonth(),
        attendanceMonth({ employee_id: 43, attendance_monthly_payroll_id: 5002 }),
        attendanceMonth({ employee_id: 44, attendance_monthly_payroll_id: 5003 }),
      ],
    });
    const usecase = buildUsecase(repo);
    const month = { year: YEAR, month: MONTH };

    assert.deepEqual(
      idsIn(await usecase.getMonth({ ...month, lifecycle: "EXITED", status: "BLOCKED" })),
      [44]
    );
    assert.deepEqual(
      idsIn(await usecase.getMonth({ ...month, lifecycle: "EXITED", status: "READY" })),
      [43]
    );
    assert.deepEqual(
      idsIn(await usecase.getMonth({ ...month, lifecycle: "ACTIVE", status: "READY" })),
      [42]
    );
    assert.deepEqual(
      idsIn(await usecase.getMonth({ ...month, lifecycle: "ACTIVE", status: "BLOCKED" })),
      []
    );
  });

  it("EXITED + INITIALIZED finds the leavers whose pay type may need moving", async () => {
    const repo = twoEmployees();
    const usecase = buildUsecase(repo);
    await usecase.initialize({ year: YEAR, month: MONTH, employee_ids: [43], actor: ACTOR });

    const view = await usecase.getMonth({
      year: YEAR, month: MONTH, lifecycle: "EXITED", status: "INITIALIZED",
    });
    assert.deepEqual(idsIn(view), [43]);
    // And they are still on the Employee Master's pay type - nothing moved
    // them to CASH automatically. That is the manual act this filter exists
    // to make findable.
    assert.equal(view.rows[0].pay_type, PAY_TYPE.BANK);
  });

  it("the SUMMARY counts the whole month, never the filtered view", async () => {
    const usecase = buildUsecase(twoEmployees());
    const view = await usecase.getMonth({ year: YEAR, month: MONTH, lifecycle: "EXITED" });
    assert.equal(view.rows.length, 1);
    assert.equal(view.summary.total_eligible, 2, "a filter is a way of looking at the month");
  });

  it("an unrecognised lifecycle value narrows nothing rather than emptying the month", async () => {
    const usecase = buildUsecase(twoEmployees());
    assert.deepEqual(
      idsIn(await usecase.getMonth({ year: YEAR, month: MONTH, lifecycle: "RETIRED" })),
      [42, 43]
    );
  });

  it("initialization still sees the WHOLE month, whatever the screen was filtered to", async () => {
    const repo = twoEmployees();
    const usecase = buildUsecase(repo);
    // The filter is a reading device; it must not narrow what may be acted on.
    const out = await usecase.initialize({
      year: YEAR, month: MONTH, employee_ids: [42, 43], actor: ACTOR,
    });
    assert.equal(out.initialized_count, 2);
  });
});

describe("the monthly pay type", () => {
  it("an active employee defaults from the Employee Master", async () => {
    const bank = buildUsecase(fakeRepo());
    assert.equal(rowFor(await bank.getMonth({ year: YEAR, month: MONTH })).pay_type, PAY_TYPE.BANK);

    const cash = buildUsecase(fakeRepo({ population: [employee({ payment_type: 2 })] }));
    assert.equal(rowFor(await cash.getMonth({ year: YEAR, month: MONTH })).pay_type, PAY_TYPE.CASH);
  });

  /*
   * ================================================================
   * THE PAY TYPE DEFAULT IS THE EMPLOYEE MASTER, AND NOTHING ELSE.
   *
   * Initialization used to move a leaver to CASH automatically. The business
   * decided against it: a final settlement paid by bank transfer is ordinary,
   * and a rule that decided otherwise was making a payment decision on HR's
   * behalf. Whoever works the month moves the ones that need moving, for the
   * month it applies to, and that records itself as MANUAL with an audit row.
   *
   * These prove the default at the level where a wrong answer would be STORED.
   * ================================================================
   */
  it("a RESIGNED employee whose master says BANK initializes BANK", async () => {
    const repo = fakeRepo({
      population: [employee({ payment_type: 1, status: 0, resignation_date: "2026-08-20" })],
    });
    const usecase = buildUsecase(repo);

    const row = rowFor(await usecase.getMonth({ year: YEAR, month: MONTH }));
    assert.equal(row.pay_type, PAY_TYPE.BANK);
    assert.equal(row.pay_type_source, PAY_TYPE_SOURCE.EMPLOYEE_MASTER);

    await usecase.initialize({ year: YEAR, month: MONTH, employee_ids: [42], actor: ACTOR });
    assert.equal(repo.inserts[0].pay_type, PAY_TYPE.BANK, "the STORED month is a Bank month");
    assert.equal(repo.inserts[0].pay_type_source, PAY_TYPE_SOURCE.EMPLOYEE_MASTER);
  });

  it("a RESIGNED employee whose master says CASH initializes CASH", async () => {
    const repo = fakeRepo({
      population: [employee({ payment_type: 2, status: 0, resignation_date: "2026-08-20" })],
    });
    const usecase = buildUsecase(repo);
    await usecase.initialize({ year: YEAR, month: MONTH, employee_ids: [42], actor: ACTOR });

    assert.equal(repo.inserts[0].pay_type, PAY_TYPE.CASH);
    assert.equal(
      repo.inserts[0].pay_type_source,
      PAY_TYPE_SOURCE.EMPLOYEE_MASTER,
      "inherited from the master - not a resigned default under another name"
    );
  });

  it("an ACTIVE employee whose master says BANK initializes BANK", async () => {
    const repo = fakeRepo();
    const usecase = buildUsecase(repo);
    await usecase.initialize({ year: YEAR, month: MONTH, employee_ids: [42], actor: ACTOR });
    assert.equal(repo.inserts[0].pay_type, PAY_TYPE.BANK);
    assert.equal(repo.inserts[0].pay_type_source, PAY_TYPE_SOURCE.EMPLOYEE_MASTER);
  });

  it("NO employment fact changes the default, in any combination", async () => {
    const facts = [
      { status: 1, resignation_date: null },
      { status: 0, resignation_date: null },
      { status: 0, resignation_date: "2026-08-01" },
      { status: 0, resignation_date: "2026-08-31" },
      { status: 0, resignation_date: "2020-01-01" },
      { status: 1, resignation_date: "2026-09-10" },
    ];
    for (const fact of facts) {
      const usecase = buildUsecase(
        fakeRepo({ population: [employee({ payment_type: 1, ...fact })] })
      );
      const row = rowFor(await usecase.getMonth({ year: YEAR, month: MONTH }));
      assert.equal(
        row.pay_type,
        PAY_TYPE.BANK,
        `a BANK employee defaulted differently for ${JSON.stringify(fact)}`
      );
      assert.equal(row.pay_type_source, PAY_TYPE_SOURCE.EMPLOYEE_MASTER);
    }
  });

  it("RESIGNED_DEFAULT no longer exists as a source at all", () => {
    assert.deepEqual(Object.keys(PAY_TYPE_SOURCE).sort(), ["EMPLOYEE_MASTER", "MANUAL"]);
  });

  /*
   * The exit badge survives as DISPLAY, because HR now has to move leavers by
   * hand and needs to see who they are. It is dated - the question is whether
   * they had left by the end of THIS month - and it moves no pay type.
   */
  it("the exit badge is dated, and the pay type ignores it", async () => {
    const usecase = buildUsecase(
      fakeRepo({
        population: [employee({ payment_type: 1, status: 0, resignation_date: "2026-09-10" })],
      })
    );
    const august = rowFor(await usecase.getMonth({ year: YEAR, month: 8 }));
    const september = rowFor(await usecase.getMonth({ year: YEAR, month: 9 }));

    assert.equal(august.exited_in_month, false);
    assert.equal(september.exited_in_month, true);
    assert.equal(august.pay_type, PAY_TYPE.BANK);
    assert.equal(september.pay_type, PAY_TYPE.BANK, "the badge changed; the pay type did not");
  });

  it("the snapshot still records the resignation date - settlement history needs it", async () => {
    const repo = fakeRepo({
      population: [employee({ payment_type: 1, status: 0, resignation_date: "2026-08-20" })],
    });
    const usecase = buildUsecase(repo);
    await usecase.initialize({ year: YEAR, month: MONTH, employee_ids: [42], actor: ACTOR });
    assert.equal(repo.inserts[0].resignation_date, "2026-08-20");
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

    // AND INITIALIZING IT STORES BANK. Reading the default back is not the
    // same claim as storing it: the override must not leak into the next
    // month's snapshot either.
    await usecase.initialize({ year: YEAR, month: 9, employee_ids: [42], actor: ACTOR });
    const stored = repo.inserts.find((r) => r.period_month === 9);
    assert.equal(stored.pay_type, PAY_TYPE.BANK);
    assert.equal(stored.pay_type_source, PAY_TYPE_SOURCE.EMPLOYEE_MASTER);
    // The month that was overridden is untouched by the later initialization.
    assert.equal(
      repo.store.find((r) => r.employee_id === 42 && r.period_month === MONTH).pay_type,
      PAY_TYPE.CASH
    );
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
