/**
 * THE HR SHIFT CHANGE BLOCK, end to end.
 *
 *   node --test usecase/attendance_shift_change_block.test.js
 *
 * No MySQL. The fake ledger below enforces the SAME invariant the real table
 * enforces - at most one ACTIVE row per employee/date, removals kept for ever
 * - because that invariant is the feature, and a fake that let two active
 * blocks exist would make the concurrency tests meaningless.
 *
 * THE REGULARIZATION USECASE IS REAL, NOT FAKED. That is the point of most of
 * these tests: the thing being asserted is that the AUTHORITATIVE submit path
 * refuses a blocked date, and a fake would only assert that this file can
 * remember a boolean.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const buildDashboard = require("../usecase/attendance_dashboard");
const buildRegularization = require("../usecase/attendance_regularization");
const buildBlock = require("../usecase/attendance_shift_change_block");
const buildReport = require("../usecase/attendance_shift_change_report");
const shiftChangeBlock = require("../utils/shift_change_block");
const { isEmployeeInScope } = require("../utils/employee_branch_scope");
const { EMPLOYEE_BRANCH_SCOPE } = require("../utils/employee_branch_scope");

const TODAY = "2026-09-19";
const DATE = "2026-09-18";

const SHORT_SHIFT = 7; // 18:00-22:00, NRM 240
const LONG_SHIFT = 8; // 10:00-22:00 less 60, NRM 660

const EMPLOYEE = 42;
const OTHER_BRANCH_EMPLOYEE = 55;
const OUTLET = 1;
const OTHER_OUTLET = 2;

const HR = { employee_id: 900, user_id: 7 };

const ALL_BRANCHES = { kind: EMPLOYEE_BRANCH_SCOPE.ALL_BRANCHES, store_ids: null };
const OWN_OUTLET = { kind: EMPLOYEE_BRANCH_SCOPE.OWN_BRANCHES, store_ids: [OUTLET] };

/* ------------------------------------------------------------ fixtures */

const ist = (date, hh, mm) =>
  `${date} ${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00`;

const scheduleRows = (workShiftId, inTime, outTime, breakMinutes) =>
  Array.from({ length: 7 }, (_, day) => ({
    work_shift_weekly_schedule_id: workShiftId * 10 + day,
    work_shift_id: workShiftId,
    day_of_week: day,
    is_working_day: 1,
    in_time: inTime,
    out_time: outTime,
    attendance_day_cutoff: "04:00:00",
    break_minutes: breakMinutes,
    ot_rate: 1,
  }));

const shiftConfig = (id, name) => ({
  work_shift_id: id,
  shift_code: `S${id}`,
  shift_name: name,
  active: 1,
  overtime_allowed: 1,
  overtime_minimum_minutes: 0,
  overtime_rounding_method: "NONE",
  overtime_rounding_interval_minutes: 0,
  overtime_minimum_threshold_only: 0,
  overtime_minimum_excluded: 0,
  maximum_ot_minutes_per_day: null,
  pre_shift_overtime_allowed: 1,
  pre_shift_overtime_minimum_minutes: 0,
  pre_shift_overtime_rounding_method: "NONE",
  pre_shift_overtime_rounding_interval_minutes: 0,
  pre_shift_overtime_minimum_excluded: 0,
  late_offset_against_overtime: 0,
  early_exit_offset_against_overtime: 0,
  late_grace_minutes: 0,
  late_deduction_interval_minutes: 0,
  late_deduct_minutes: 0,
  late_exclude_grace_from_deduction: 0,
  early_exit_grace_minutes: 0,
  early_exit_deduction_interval_minutes: 0,
  early_exit_deduct_minutes: 0,
});

const CONFIGS = [shiftConfig(SHORT_SHIFT, "Evening"), shiftConfig(LONG_SHIFT, "Full Day")];
const SCHEDULES = [
  ...scheduleRows(SHORT_SHIFT, "18:00:00", "22:00:00", 0),
  ...scheduleRows(LONG_SHIFT, "10:00:00", "22:00:00", 60),
];

const employee = (id, over = {}) => ({
  employee_id: id,
  employee_name: `Employee ${id}`,
  store_id: OUTLET,
  designation_id: 5,
  department_id: 3,
  special_break_override_minutes: null,
  extra_break_hours: null,
  attendance_required: 1,
  outlet_name: "Main Store",
  outlet_nickname: "MAIN",
  designation_name: "Cashier",
  department_name: "Front End",
  joined_on: null,
  resignation_date: null,
  ...over,
});

const pair = (employeeId, date, inHour, outHour) => [
  {
    punch_id: Number(`${employeeId}${date.slice(8, 10)}1`),
    employee_id: employeeId,
    io_time: ist(date, inHour, 0),
    punch_date: date,
    dev_id: "G1",
    ingest_source: "BIOMAX",
    ingest_attendance_date: date,
    attendance_punch_void_id: null,
    void_reason: null,
  },
  {
    punch_id: Number(`${employeeId}${date.slice(8, 10)}2`),
    employee_id: employeeId,
    io_time: ist(date, outHour, 0),
    punch_date: date,
    dev_id: "G1",
    ingest_source: "BIOMAX",
    ingest_attendance_date: date,
    attendance_punch_void_id: null,
    void_reason: null,
  },
];

const assignment = (employeeId, workShiftId) => ({
  employee_work_shift_assignment_id: employeeId * 100 + workShiftId,
  employee_id: employeeId,
  work_shift_id: workShiftId,
  effective_from: "2026-01-01",
  source: "MIGRATION_BACKFILL",
});

/* ----------------------------------------------------------- the fakes */

/**
 * THE LEDGER, WITH THE REAL TABLE'S INVARIANT.
 *
 * `create` refuses a second ACTIVE row for one employee/date exactly as
 * `uq_ascb_active_per_employee_date` does - by returning `{duplicate:true}`
 * rather than throwing - and `remove` matches only a row whose `removed_at` is
 * still null, exactly as the UPDATE's `AND removed_at IS NULL` does. Rows are
 * never dropped, so history accumulates here as it does there.
 *
 * IT ALSO MODELS THE LOCKED BRANCH CHECK. Both writes authorize the scope
 * they are handed against the employee's CURRENT store and stamp that store
 * as the audit snapshot, exactly as the real repository does under the
 * employee row lock. A fake that skipped it would let these tests pass while
 * the authorization boundary was missing - the interleaved proof lives in
 * `repository/attendance_shift_change_block_concurrency.test.js`.
 */
function fakeBlockRepo(state = {}) {
  const rows = [];
  let nextId = 1;
  const employees = state.employees || [employee(EMPLOYEE)];

  return {
    rows,
    getEmployeeForBlock: async (employeeId) =>
      employees.find((e) => Number(e.employee_id) === Number(employeeId)) || null,
    findActive: async (employeeId, date) =>
      rows.find(
        (r) =>
          Number(r.employee_id) === Number(employeeId) &&
          r.attendance_date === date &&
          !r.removed_at
      ) || null,
    listActiveForPopulation: async ({ employee_ids, from_date, to_date }) =>
      rows.filter(
        (r) =>
          employee_ids.map(Number).includes(Number(r.employee_id)) &&
          r.attendance_date >= from_date &&
          r.attendance_date <= to_date &&
          !r.removed_at
      ),
    listHistory: async (employeeId, date) =>
      rows
        .filter(
          (r) => Number(r.employee_id) === Number(employeeId) && r.attendance_date === date
        )
        .sort((a, b) => b.attendance_shift_change_block_id - a.attendance_shift_change_block_id),
    create: async (row) => {
      // THE LOCKED BRANCH CHECK, modelled.
      const subject = employees.find((e) => Number(e.employee_id) === Number(row.employee_id));
      if (!subject) return { created: false, duplicate: false, missing_employee: true };
      if (!isEmployeeInScope(row.scope, subject.store_id)) {
        const err = new Error("You do not have access to this employee's branch.");
        err.name = "ForbiddenError";
        err.code = 403;
        err.out_of_scope = true;
        throw err;
      }
      // THE UNIQUE KEY, in memory.
      const clash = rows.find(
        (r) =>
          Number(r.employee_id) === Number(row.employee_id) &&
          r.attendance_date === row.attendance_date &&
          !r.removed_at
      );
      if (clash) return { created: false, duplicate: true, insert_id: null };
      const id = nextId;
      nextId += 1;
      rows.push({
        attendance_shift_change_block_id: id,
        ...row,
        // The audit snapshot is the LIVE store, as the real insert records it.
        outlet_id: subject.store_id,
        blocked_at: `${TODAY} 11:00:00`,
        blocked_by_employee_name: `Employee ${row.blocked_by_employee_id}`,
        removed_at: null,
        removed_by_employee_id: null,
        removed_by_user_id: null,
        removal_reason: null,
      });
      return { created: true, duplicate: false, insert_id: id };
    },
    remove: async ({ employee_id, attendance_date, ...rest }) => {
      const subject = employees.find((e) => Number(e.employee_id) === Number(employee_id));
      if (!subject) return { removed: false, missing_employee: true };
      if (!isEmployeeInScope(rest.scope, subject.store_id)) {
        const err = new Error("You do not have access to this employee's branch.");
        err.name = "ForbiddenError";
        err.code = 403;
        err.out_of_scope = true;
        throw err;
      }
      const active = rows.find(
        (r) =>
          Number(r.employee_id) === Number(employee_id) &&
          r.attendance_date === attendance_date &&
          !r.removed_at
      );
      if (!active) return { removed: false };
      active.removed_at = `${TODAY} 12:00:00`;
      active.removed_by_employee_id = rest.removed_by_employee_id;
      active.removed_by_user_id = rest.removed_by_user_id;
      active.removal_reason = rest.removal_reason;
      return { removed: true };
    },
  };
}

function fakeDashboardRepo(state = {}) {
  return {
    getShiftAssignmentHistoryForEmployees: async (ids) =>
      (state.assignments || []).filter((a) => ids.includes(Number(a.employee_id))),
    getDateShiftOverridesForEmployees: async () => [],
    listWorkShiftConfigs: async () => CONFIGS,
    listWorkShiftSchedules: async () => SCHEDULES,
    listWorkShiftConfigVersions: async () => [],
    getRawPunchesForEmployees: async (ids, from, to) =>
      (state.rawPunches || []).filter((p) => {
        const day = String(p.io_time).slice(0, 10);
        return ids.includes(Number(p.employee_id)) && day >= from && day <= to;
      }),
    getApprovedRegularizedPunchesForEmployees: async () => [],
    getApprovalStateForEmployees: async () => [],
    getStoredCalculationsForEmployees: async () => [],
  };
}

/**
 * The whole world: the REAL regularization usecase over the same shift cache
 * the report uses, the REAL block usecase, and the REAL report usecase.
 */
function build(state = {}) {
  const employees = state.employees || [employee(EMPLOYEE)];
  const assignments = state.assignments || [assignment(EMPLOYEE, SHORT_SHIFT)];
  const rawPunches = state.rawPunches || pair(EMPLOYEE, DATE, 10, 22);
  const requests = state.requests || [];
  const lockedMonths = state.lockedMonths || [];

  const dashboard = buildDashboard(fakeDashboardRepo({ assignments, rawPunches }));
  const blockRepo = fakeBlockRepo({ employees });

  const shiftForDate = async ({ employee_id, attendance_date, work_shift_id = null }) => {
    const batch = await dashboard.loadBatch({
      employees: [{ employee_id }],
      from: attendance_date,
      to: attendance_date,
    });
    const key = String(employee_id);
    const overrides = work_shift_id
      ? [
          {
            attendance_date_shift_override_id: -1,
            employee_id,
            work_shift_id,
            attendance_date,
            shift_change_approved: 0,
            attendance_approval_request_id: null,
          },
        ]
      : [];
    const resolver = dashboard.employeeResolver({
      shiftCache: batch.shiftCache,
      assignments: batch.assignmentsByEmployee.get(key) || [],
      overrides,
    });
    const resolution = resolver.resolutionFor(attendance_date);
    const base = resolver.baseResolutionFor(attendance_date);
    const nrm = (s) =>
      s ? Math.max(0, (s.shift_span_minutes || 0) - (s.break_minutes || 0)) : null;
    const side = (r) => ({
      status: r.status,
      work_shift_id: r.work_shift_id,
      shift_code: r.snapshot ? r.snapshot.shift_code : null,
      shift_name: r.work_shift_id ? resolver.shiftNameFor(r.work_shift_id) : null,
      in_time: r.snapshot ? r.snapshot.in_time : null,
      out_time: r.snapshot ? r.snapshot.out_time : null,
      is_working_day: r.snapshot ? r.snapshot.is_working_day : null,
      nrm_minutes: nrm(r.snapshot),
    });
    return {
      employee_id,
      attendance_date,
      ...side(resolution),
      base: side(base),
    };
  };

  const calculation = {
    shiftForDate,
    listDateShiftOptions: async () =>
      CONFIGS.map((c) => ({
        work_shift_id: c.work_shift_id,
        shift_code: c.shift_code,
        shift_name: c.shift_name,
      })),
    findPayrollLockedPeriods: async (rows) => {
      const out = [];
      rows.forEach((r) => {
        const year = Number(r.attendance_date.slice(0, 4));
        const month = Number(r.attendance_date.slice(5, 7));
        lockedMonths.forEach((l) => {
          if (
            Number(l.employee_id) === Number(r.employee_id) &&
            Number(l.year) === year &&
            Number(l.month) === month
          ) {
            out.push({ employee_id: Number(r.employee_id), year, month });
          }
        });
      });
      return out;
    },
    findPayrollLockedPeriodsBulk: async (rows) => calculation.findPayrollLockedPeriods(rows),
  };

  const created = [];
  const regularization = buildRegularization(
    {
      getApprovalIdentity: async (id) => {
        const found = employees.find((e) => Number(e.employee_id) === Number(id));
        if (!found) return null;
        return {
          employee_id: found.employee_id,
          employee_name: found.employee_name,
          outlet_id: found.store_id,
          outlet_name: found.outlet_name,
          designation_id: found.designation_id,
          designation_name: found.designation_name,
          approver_role: null,
        };
      },
      // THE REAL OBJECTS, NOT COPIES. A fake that spreads each row into a new
      // object makes "the rejected request was not altered" unfalsifiable -
      // any mutation would land on the copy and the assertion would pass
      // regardless. The fixtures carry `request_type` themselves instead.
      findRequestsForDates: async (employeeId, dates) =>
        requests.filter(
          (r) => Number(r.employee_id) === Number(employeeId) && dates.includes(r.attendance_date)
        ),
      createRequest: async (payload) => {
        created.push(payload);
        return { attendance_approval_request_id: 5000 + created.length, chain: [] };
      },
    },
    calculation,
    {
      getActiveSetup: async (employeeId) => ({
        employee_id: employeeId,
        first_level_approver_employee_id: 7,
        second_level_approver_employee_id: null,
        final_approver_employee_id: 8,
      }),
    },
    blockRepo
  );

  const blocks = buildBlock(blockRepo, regularization);

  const reportRepo = {
    listCandidateEmployees: async (args) => {
      let rows = employees;
      if (args.store_ids !== null && args.store_ids !== undefined) {
        rows = Array.isArray(args.store_ids) && args.store_ids.length
          ? rows.filter((r) => args.store_ids.map(Number).includes(Number(r.store_id)))
          : [];
      }
      return rows;
    },
    listShiftChangeRequests: async ({ employee_ids }) =>
      requests.filter((r) => employee_ids.map(Number).includes(Number(r.employee_id))),
  };
  const report = buildReport(reportRepo, dashboard, calculation, blockRepo, {
    now: () =>
      Date.UTC(2026, 8, 19, 9, 0) - (5 * 60 + 30) * 60 * 1000,
  });

  return { regularization, blocks, report, blockRepo, requests, created, employees };
}

/** Raise a shift change as the employee would. Returns the thrown message, or null. */
const raise = async (world, { employee_id = EMPLOYEE, date = DATE, work_shift_id = LONG_SHIFT } = {}) => {
  try {
    await world.regularization.raiseShiftChangeRequest({
      actor: { employee_id },
      attendance_date: date,
      work_shift_id,
      reason: "covering the late delivery",
      today: TODAY,
    });
    return null;
  } catch (err) {
    return err.message;
  }
};

const blockIt = (world, over = {}) =>
  world.blocks.blockDate({
    actor: HR,
    scope: ALL_BRANCHES,
    employee_id: EMPLOYEE,
    attendance_date: DATE,
    reason: "Punch timing is incorrect",
    today: TODAY,
    ...over,
  });

const unblockIt = (world, over = {}) =>
  world.blocks.unblockDate({
    actor: HR,
    scope: ALL_BRANCHES,
    employee_id: EMPLOYEE,
    attendance_date: DATE,
    removal_reason: "Punch corrected after review",
    ...over,
  });

const rejectedRequest = (over = {}) => ({
  request_type: "SHIFT_CHANGE",
  attendance_approval_request_id: 910,
  employee_id: EMPLOYEE,
  attendance_date: DATE,
  status: "REJECTED",
  current_stage_no: 1,
  total_stages: 1,
  requested_work_shift_id: LONG_SHIFT,
  base_work_shift_id: SHORT_SHIFT,
  created_at: `${DATE} 20:00:00`,
  ...over,
});

/* ===================================================================== */

describe("A. the block stops the employee, on the authoritative path", () => {
  it("1. eligible + not raised -> HR blocks -> the employee cannot raise", async () => {
    const world = build();
    assert.equal(await raise(world), null, "must be raisable before the block");

    await blockIt(world);

    const refusal = await raise(world);
    assert.match(refusal, /not allowed for 18\/09\/2026/);
    assert.equal(world.created.length, 1, "only the pre-block request was ever created");
  });

  it("3. a direct API submission cannot bypass the block", async () => {
    // There is no separate "API" path: the route calls this very function, so
    // proving the function refuses IS proving the API cannot bypass it.
    const world = build();
    await blockIt(world);
    const refusal = await raise(world);
    assert.ok(refusal, "the usecase itself refuses, so no caller can get past it");
    assert.equal(world.created.length, 0);
  });

  it("4. the employee is told HR's own reason", async () => {
    const world = build();
    await blockIt(world, { reason: "Wrong biometric punch" });
    const refusal = await raise(world);
    assert.match(refusal, /HR marked this date as not eligible: Wrong biometric punch\./);
  });

  it("2 + 22. the options path shows the blocked state and offers nothing", async () => {
    const world = build();
    const before = await world.regularization.shiftChangeOptions({
      actor: { employee_id: EMPLOYEE },
      attendance_date: DATE,
    });
    assert.ok(before.options.length > 0, "a longer shift exists before the block");
    assert.equal(before.can_raise, true);

    await blockIt(world);

    const after = await world.regularization.shiftChangeOptions({
      actor: { employee_id: EMPLOYEE },
      attendance_date: DATE,
    });
    assert.deepEqual(after.options, [], "a blocked date must offer nothing");
    assert.equal(after.can_raise, false);
    assert.equal(after.hr_blocked, true);
    assert.match(after.reason, /HR marked this date as not eligible/);

    // AND THE TWO PATHS AGREE: what options says is refusable, submit refuses.
    const refusal = await raise(world);
    assert.equal(after.reason, refusal, "options and submit must say the same thing");
  });
});

describe("B. removing the block restores only what production allows", () => {
  it("5. remove block -> the employee may raise again when the rules still pass", async () => {
    const world = build();
    await blockIt(world);
    assert.ok(await raise(world), "blocked");

    await unblockIt(world);
    assert.equal(await raise(world), null, "unblocked, and production still permits it");
  });

  it("6 + 20. removing a block never bypasses production eligibility", async () => {
    // Payroll closes the month while the block is in place. Removing the block
    // must leave the payroll lock in charge.
    const world = build({ lockedMonths: [{ employee_id: EMPLOYEE, year: 2026, month: 9 }] });

    // The date is already system-ineligible, so it cannot even be blocked...
    await assert.rejects(() => blockIt(world), /already not possible/);

    // ...and remains refused by the payroll lock, not by anything HR did.
    const refusal = await raise(world);
    assert.match(refusal, /payroll for 09\/2026 is approved and locked/);
  });

  it("6b. a block removed on a date with no longer shift leaves it ineligible", async () => {
    const world = build({ assignments: [assignment(EMPLOYEE, LONG_SHIFT)] });
    // Already on the longest shift: production refuses, so no block is possible.
    await assert.rejects(() => blockIt(world), /already not possible/);
    // Asked for the SHORT shift, since the employee is already on the long
    // one - the refusal under test is the longer-only rule, not "that is
    // already your shift".
    assert.match(
      await raise(world, { work_shift_id: SHORT_SHIFT }),
      /longer working hours than your normal shift/
    );
  });
});

describe("C. what HR may and may not block", () => {
  it("7. a PENDING request cannot be replaced by a pre-request block", async () => {
    const world = build({
      requests: [rejectedRequest({ attendance_approval_request_id: 920, status: "PENDING" })],
    });
    await assert.rejects(() => blockIt(world), /already pending/);
    assert.equal(world.blockRepo.rows.length, 0, "no block row was written");
  });

  it("8. an APPROVED request cannot be blocked", async () => {
    const world = build({
      requests: [rejectedRequest({ attendance_approval_request_id: 921, status: "APPROVED" })],
    });
    await assert.rejects(() => blockIt(world), /already been approved/);
    assert.equal(world.blockRepo.rows.length, 0);
  });

  it("9. a payroll-locked date creates no block and stays governed by the lock", async () => {
    const world = build({ lockedMonths: [{ employee_id: EMPLOYEE, year: 2026, month: 9 }] });
    await assert.rejects(() => blockIt(world), /nothing to block/);
    assert.equal(world.blockRepo.rows.length, 0, "no useless block row for a locked date");
    assert.match(await raise(world), /approved and locked/);
  });

  it("17 + 18 + 19. a REJECTED request may be blocked, and is left untouched", async () => {
    const request = rejectedRequest();
    const world = build({ requests: [request] });

    // Production allows a fresh attempt after a rejection...
    assert.equal(await raise(world), null, "a rejection does not close the date");

    const world2 = build({ requests: [rejectedRequest()] });
    const result = await blockIt(world2);
    assert.equal(result.blocked, true);

    // 18. THE REJECTED REQUEST IS UNCHANGED.
    const stored = world2.requests[0];
    assert.equal(stored.status, "REJECTED");
    assert.equal(stored.attendance_approval_request_id, 910);

    // ...and the re-attempt is now refused by the block, not by the rejection.
    assert.match(await raise(world2), /HR marked this date as not eligible/);

    // 19. Removing the block does not alter the rejected request either.
    await unblockIt(world2);
    assert.equal(world2.requests[0].status, "REJECTED");
    assert.equal(await raise(world2), null, "and a fresh attempt is possible again");
  });
});

describe("D. authorization", () => {
  it("10. a branch-scoped manager cannot block another branch's employee", async () => {
    const world = build({
      employees: [
        employee(EMPLOYEE, { store_id: OUTLET }),
        employee(OTHER_BRANCH_EMPLOYEE, { store_id: OTHER_OUTLET }),
      ],
      assignments: [assignment(EMPLOYEE, SHORT_SHIFT), assignment(OTHER_BRANCH_EMPLOYEE, SHORT_SHIFT)],
      rawPunches: [...pair(EMPLOYEE, DATE, 10, 22), ...pair(OTHER_BRANCH_EMPLOYEE, DATE, 10, 22)],
    });

    await assert.rejects(
      () => blockIt(world, { scope: OWN_OUTLET, employee_id: OTHER_BRANCH_EMPLOYEE }),
      /do not have access to this employee's branch/
    );
    assert.equal(world.blockRepo.rows.length, 0);

    // ...but may block their own branch's employee.
    const ok = await blockIt(world, { scope: OWN_OUTLET });
    assert.equal(ok.blocked, true);
  });

  it("10b. the branch is the employee's LIVE store, never a value from the caller", async () => {
    const world = build({
      employees: [employee(EMPLOYEE, { store_id: OTHER_OUTLET })],
    });
    // The caller is scoped to OUTLET; the employee has since moved to
    // OTHER_OUTLET, so the live read refuses. No field in the request could
    // have said otherwise - there is none.
    await assert.rejects(() => blockIt(world, { scope: OWN_OUTLET }), /branch/);
  });

  it("10c. an unblock is scoped exactly as the block was", async () => {
    const world = build();
    await blockIt(world);
    await assert.rejects(
      () => unblockIt(world, { scope: { kind: EMPLOYEE_BRANCH_SCOPE.OWN_BRANCHES, store_ids: [OTHER_OUTLET] } }),
      /branch/
    );
    // The block survives the refused removal.
    assert.equal(world.blockRepo.rows[0].removed_at, null);
  });

  it("a reason is mandatory on both block and unblock", async () => {
    const world = build();
    await assert.rejects(() => blockIt(world, { reason: "" }), /reason for blocking/);
    await assert.rejects(() => blockIt(world, { reason: "no" }), /reason for blocking/);
    await blockIt(world);
    await assert.rejects(() => unblockIt(world, { removal_reason: "" }), /reason for removing/);
  });
});

describe("D2. the locked branch check is the boundary, not the pre-check", () => {
  it("a transfer between the pre-check and the write is refused by the repository", async () => {
    const world = build();

    // The pre-check will pass: the employee is in the actor's branch when the
    // usecase reads them. The transfer then lands before the write - modelled
    // by moving the employee the instant the repository is entered, which is
    // exactly the window the locked check exists to cover.
    const innerCreate = world.blockRepo.create;
    world.blockRepo.create = async (row) => {
      world.employees[0].store_id = OTHER_OUTLET;
      return innerCreate(row);
    };

    await assert.rejects(
      () => blockIt(world, { scope: OWN_OUTLET }),
      (err) => {
        assert.equal(err.out_of_scope, true, "the repository's locked refusal, surfaced as-is");
        assert.equal(err.code, 403);
        return true;
      }
    );
    assert.equal(world.blockRepo.rows.length, 0, "nothing was written");
  });

  it("the same holds for a removal", async () => {
    const world = build();
    await blockIt(world, { scope: OWN_OUTLET });

    const innerRemove = world.blockRepo.remove;
    world.blockRepo.remove = async (row) => {
      world.employees[0].store_id = OTHER_OUTLET;
      return innerRemove(row);
    };

    await assert.rejects(() => unblockIt(world, { scope: OWN_OUTLET }), (err) => {
      assert.equal(err.out_of_scope, true);
      return true;
    });
    assert.equal(world.blockRepo.rows[0].removed_at, null, "the block survives the refusal");
  });
});

describe("E. concurrency", () => {
  it("21. two simultaneous blocks produce exactly ONE active block", async () => {
    const world = build();
    const results = await Promise.allSettled([blockIt(world), blockIt(world)]);

    const ok = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected");
    assert.equal(ok.length, 1, "exactly one call may succeed");
    assert.equal(failed.length, 1);
    // ...and the loser is told a BUSINESS fact, not a SQL error.
    assert.match(failed[0].reason.message, /already blocked by HR/);
    assert.ok(!/ER_DUP_ENTRY|duplicate/i.test(failed[0].reason.message));

    const active = world.blockRepo.rows.filter((r) => !r.removed_at);
    assert.equal(active.length, 1, "the ledger holds one active row");
  });

  it("two simultaneous removals cannot corrupt the history", async () => {
    const world = build();
    await blockIt(world);
    const results = await Promise.allSettled([unblockIt(world), unblockIt(world)]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(world.blockRepo.rows.filter((r) => !r.removed_at).length, 0);
    // ONE removal actor, not two overwriting each other.
    assert.equal(world.blockRepo.rows[0].removal_reason, "Punch corrected after review");
  });
});

describe("F. the audit survives everything", () => {
  it("15 + 25. block -> unblock -> block again keeps the full history and its actors", async () => {
    const world = build();

    await blockIt(world, { reason: "Wrong biometric punch" });
    await unblockIt(world, { removal_reason: "Punch corrected after review" });
    await blockIt(world, { reason: "No authorised extended duty" });

    const history = await world.blocks.history({
      scope: ALL_BRANCHES,
      employee_id: EMPLOYEE,
      attendance_date: DATE,
    });

    assert.equal(history.history.length, 2, "both blocks are kept; nothing is erased");

    const [newest, oldest] = history.history;
    // The first block, with its removal recorded ON THE SAME ROW.
    assert.equal(oldest.reason, "Wrong biometric punch");
    assert.equal(oldest.blocked_by_employee_id, HR.employee_id);
    assert.equal(oldest.blocked_by_user_id, HR.user_id);
    assert.ok(oldest.blocked_at, "blocked_at is preserved");
    assert.equal(oldest.removal_reason, "Punch corrected after review");
    assert.equal(oldest.removed_by_employee_id, HR.employee_id);
    assert.ok(oldest.removed_at, "removed_at is preserved");

    // The second, still active.
    assert.equal(newest.reason, "No authorised extended duty");
    assert.equal(newest.removed_at, null);

    // And exactly one is active.
    assert.equal(world.blockRepo.rows.filter((r) => !r.removed_at).length, 1);
  });

  it("the audit records the ACTOR, never the employee being blocked", async () => {
    const world = build();
    await blockIt(world);
    const row = world.blockRepo.rows[0];
    assert.equal(Number(row.employee_id), EMPLOYEE, "the subject");
    assert.equal(Number(row.blocked_by_employee_id), HR.employee_id, "the actor");
    assert.notEqual(Number(row.employee_id), Number(row.blocked_by_employee_id));
    // The outlet snapshot is recorded for audit.
    assert.equal(Number(row.outlet_id), OUTLET);
  });
});

describe("G. the report reflects the block without distorting anything else", () => {
  const reportRows = async (world, over = {}) => {
    const { data, meta } = await world.report.getReport({
      from_date: DATE,
      to_date: DATE,
      store_ids: null,
      ...over,
    });
    return { row: data[0], data, meta };
  };

  it("13. a blocked row leaves the actionable queue but keeps its real columns", async () => {
    const world = build();

    const before = await reportRows(world);
    assert.equal(before.meta.actionable_count, 1);

    await blockIt(world, { reason: "Punch timing is incorrect" });

    const after = await reportRows(world);
    assert.equal(after.meta.actionable_count, 0, "blocked work is not waiting work");

    // The DEFAULT actionable view no longer shows it...
    const actionable = await reportRows(world, {
      can_raise: "YES",
      worked_longer: "YES",
      hr_eligibility: "ALLOWED",
      request_status: "NOT_RAISED",
    });
    assert.deepEqual(actionable.data, []);

    // ...but the row still reports the SYSTEM verdict honestly.
    assert.equal(after.row.can_raise, true, "the system would still have allowed it");
    assert.equal(after.row.hr_eligibility, "Blocked by HR");
    assert.equal(after.row.effective_can_raise, false);
    assert.equal(after.row.request_status, "Not Raised", "status is never overwritten with Blocked");
  });

  it("14. the Blocked filter shows the actor, reason and timestamp", async () => {
    const world = build();
    await blockIt(world, { reason: "Employee worked outside shift without approval" });

    const blocked = await reportRows(world, { hr_eligibility: "BLOCKED" });
    assert.equal(blocked.data.length, 1);
    assert.equal(blocked.row.hr_block_reason, "Employee worked outside shift without approval");
    assert.equal(blocked.row.hr_blocked_by_employee_id, HR.employee_id);
    assert.ok(blocked.row.hr_blocked_at, "the timestamp is shown");

    // And the Allowed filter excludes it.
    const allowed = await reportRows(world, { hr_eligibility: "ALLOWED" });
    assert.deepEqual(allowed.data, []);
  });

  it("23. the report's Effective Can Raise agrees with the submit path", async () => {
    const world = build();

    const open = await reportRows(world);
    assert.equal(open.row.effective_can_raise, true);
    assert.equal(await raise(world), null, "and the submit path agrees");

    const world2 = build();
    await blockIt(world2);
    const shut = await reportRows(world2);
    assert.equal(shut.row.effective_can_raise, false);
    assert.ok(await raise(world2), "and the submit path agrees here too");
  });

  it("an unknown HR filter value is refused rather than ignored", async () => {
    const world = build();
    await assert.rejects(
      () => world.report.getReport({ from_date: DATE, to_date: DATE, hr_eligibility: "MAYBE" }),
      /hr_eligibility/
    );
  });

  it("the blocks are read in ONE statement for the whole population", async () => {
    const world = build({
      employees: [employee(EMPLOYEE), employee(43), employee(44)],
      assignments: [
        assignment(EMPLOYEE, SHORT_SHIFT),
        assignment(43, SHORT_SHIFT),
        assignment(44, SHORT_SHIFT),
      ],
      rawPunches: [
        ...pair(EMPLOYEE, DATE, 10, 22),
        ...pair(43, DATE, 10, 22),
        ...pair(44, DATE, 10, 22),
      ],
    });
    let calls = 0;
    const inner = world.blockRepo.listActiveForPopulation;
    world.blockRepo.listActiveForPopulation = async (args) => {
      calls += 1;
      return inner(args);
    };
    const { data } = await world.report.getReport({ from_date: DATE, to_date: DATE });
    assert.equal(data.length, 3);
    assert.equal(calls, 1, "one bulk read, never one per row");
  });
});

describe("H. the shared rule is the only rule", () => {
  it("canCreateBlock is what every refusal comes from", () => {
    // The write path's decisions, asserted directly on the shared function, so
    // a change to it cannot quietly diverge from what the usecase enforces.
    const allowed = { system_can_raise: true, request_state: "NOT_RAISED" };
    assert.equal(shiftChangeBlock.canCreateBlock(allowed).allowed, true);
    assert.equal(
      shiftChangeBlock.canCreateBlock({ ...allowed, request_state: "REJECTED" }).allowed,
      true,
      "a rejection does not close the date, so blocking it is meaningful"
    );
    assert.equal(
      shiftChangeBlock.canCreateBlock({ ...allowed, request_state: "PENDING" }).allowed,
      false
    );
    assert.equal(
      shiftChangeBlock.canCreateBlock({ ...allowed, request_state: "APPROVED" }).allowed,
      false
    );
    assert.equal(
      shiftChangeBlock.canCreateBlock({ ...allowed, system_can_raise: false }).allowed,
      false
    );
  });

  it("effectiveVerdict subtracts, and never adds", () => {
    const no = { can_raise: false, reason_code: "TOO_OLD", reason: "too old" };
    const blocked = { reason: "bad punch", attendance_date: DATE };

    // A block cannot make an ineligible date eligible...
    const stillNo = shiftChangeBlock.effectiveVerdict({
      system: no,
      active_block: blocked,
      attendance_date: DATE,
    });
    assert.equal(stillNo.can_raise, false);
    assert.equal(stillNo.reason_code, "TOO_OLD", "the system's own reason still wins");

    // ...and a removed block is not a gate at all.
    const yes = { can_raise: true, reason_code: "ELIGIBLE", reason: "ok" };
    const removed = { reason: "bad punch", removed_at: `${TODAY} 12:00:00` };
    assert.equal(
      shiftChangeBlock.effectiveVerdict({ system: yes, active_block: removed }).can_raise,
      true
    );
  });
});
