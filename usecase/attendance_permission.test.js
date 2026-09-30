/**
 * DIRECT (management) PERMISSION - preview, apply, revoke - through the real
 * calculation usecase over in-memory repositories.
 *
 * The festival case end to end: preview shows who is reached and who is left
 * out and why; apply grants exactly the previewed set, one employee per
 * transaction, and reports partial failures per employee; the grantor never
 * grants themselves; revoke withdraws a grant and recalculates the day.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const buildCalculation = require("./attendance_calculation");
const buildPermission = require("./attendance_permission");

const DATE = "2026-09-14"; // closed by the time the tests run
const TODAY = "2026-09-20";

const schedule = (id, inTime, outTime) =>
  Array.from({ length: 7 }, (_, day) => ({
    work_shift_weekly_schedule_id: id * 100 + day,
    work_shift_id: id,
    day_of_week: day,
    is_working_day: 1,
    in_time: inTime,
    out_time: outTime,
    attendance_day_cutoff: "04:00:00",
    break_minutes: 60,
    normal_work_minutes: 660,
    ot_rate: 1,
  }));
const config = (id) => ({
  work_shift_id: id, shift_code: `S${id}`, shift_name: `Shift ${id}`, active: 1, overtime_allowed: 1,
  overtime_minimum_minutes: 0, overtime_rounding_method: "NONE", overtime_rounding_interval_minutes: 0,
  overtime_minimum_threshold_only: 0, maximum_ot_minutes_per_day: null,
});
// 7 = 10:00-22:00, 8 = 06:00-15:00 (ends before a 19:00 release)
const SHIFTS = {
  7: { config: config(7), schedule: schedule(7, "10:00:00", "22:00:00") },
  8: { config: config(8), schedule: schedule(8, "06:00:00", "15:00:00") },
};

// 1-4 at outlet 3, 5 at outlet 5. 2 is on the morning shift, 3 is exempt
// from punching, 4 joined after the date. 9 is the grantor, at outlet 3.
const EMPLOYEES = [
  { employee_id: 1, employee_name: "Anu", store_id: 3, outlet_name: "Main", attendance_required: 1, date_of_joining: "2020-01-01", resignation_date: null, shift: 7 },
  { employee_id: 2, employee_name: "Babu", store_id: 3, outlet_name: "Main", attendance_required: 1, date_of_joining: "2020-01-01", resignation_date: null, shift: 8 },
  { employee_id: 3, employee_name: "Chitra", store_id: 3, outlet_name: "Main", attendance_required: 0, date_of_joining: "2020-01-01", resignation_date: null, shift: 7 },
  { employee_id: 4, employee_name: "Devi", store_id: 3, outlet_name: "Main", attendance_required: 1, date_of_joining: "2026-10-01", resignation_date: null, shift: 7 },
  { employee_id: 5, employee_name: "Elan", store_id: 5, outlet_name: "East", attendance_required: 1, date_of_joining: "2020-01-01", resignation_date: null, shift: 7 },
  { employee_id: 9, employee_name: "Grantor", store_id: 3, outlet_name: "Main", attendance_required: 1, date_of_joining: "2020-01-01", resignation_date: null, shift: 7 },
];
const punch = (id, employee_id, ioTime) => ({
  punch_id: id, employee_id, io_time: ioTime, punch_date: ioTime.slice(0, 10),
  ingest_attendance_date: ioTime.slice(0, 10), dev_id: "D", ingest_source: "LIVE",
});
// Everybody on the late shift leaves at 19:00.
const PUNCHES = [1, 5, 9].flatMap((e) => [punch(e * 10, e, `${DATE} 10:00:00`), punch(e * 10 + 1, e, `${DATE} 19:00:00`)]);

function build({ locked = [], existing = [], failFor = [], summaries = false } = {}) {
  const store = { permissions: [...existing], operations: [], items: [], grants: [], revokes: [], months: [] };
  let nextId = 100;
  const empOf = (id) => EMPLOYEES.find((e) => e.employee_id === Number(id));

  const calcRepo = {
    getShiftAssignmentHistory: async (e) => [{ employee_work_shift_assignment_id: 1, employee_id: e, work_shift_id: empOf(e).shift, effective_from: "2026-09-01", source: "MIGRATION_BACKFILL" }],
    getWorkShiftWithSchedule: async (id) => SHIFTS[id],
    getWorkShiftConfigVersions: async () => [],
    getRawPunchesByCalendarWindow: async (e, from, to) => PUNCHES.filter((p) => p.employee_id === e && p.punch_date >= from && p.punch_date <= to),
    getApprovedRegularizedPunches: async () => [],
    getBreakOverride: async (e) => ({ attendance_required: empOf(e).attendance_required }),
    getApprovalStateByDate: async () => [],
    getPermissionsForRange: async (e, from, to) => store.permissions.filter((p) => p.employee_id === e && p.attendance_date >= from && p.attendance_date <= to),
    getEmploymentWindow: async (e) => ({ ...empOf(e), status: 1 }),
    getMonthlyGrossAsOf: async () => null,
    getMonthlyPayroll: async () => (summaries ? { attendance_monthly_payroll_id: 1 } : null),
    saveMonthWithPayroll: async (args) => {
      store.months.push(args);
      return { written: args.rows.length, monthly_written: 1 };
    },
    findPayrollLockedPeriods: async (rows) => rows.filter((r) => locked.includes(Number(r.employee_id))).map((r) => ({ employee_id: r.employee_id, year: 2026, month: 9 })),
    findPayrollLockedPeriodsBulk: async (rows) => rows.filter((r) => locked.includes(Number(r.employee_id))).map((r) => ({ employee_id: r.employee_id, year: 2026, month: 9 })),
  };

  const permissionRepo = {
    listCandidates: async ({ store_ids, employee_ids }) =>
      EMPLOYEES.filter((e) => (!Array.isArray(store_ids) || store_ids.includes(e.store_id)) && (!Array.isArray(employee_ids) || employee_ids.includes(e.employee_id))),
    listForEmployeesOnDate: async (ids, date) => store.permissions.filter((p) => ids.includes(p.employee_id) && p.attendance_date === date),
    createBulkOperation: async (op) => store.operations.push(op),
    finishBulkOperation: async (id, counts) => Object.assign(store.operations.find((o) => o.bulk_operation_id === id), { counts }),
    recordBulkItem: async (item) => store.items.push(item),
    grant: async ({ employee_id, attendance_date, windows, header, calculations }) => {
      if (failFor.includes(employee_id)) throw new Error("ER_LOCK_WAIT_TIMEOUT");
      store.grants.push({ employee_id, calculations });
      const ids = windows.map((w) => {
        const id = nextId++;
        store.permissions.push({ attendance_permission_id: id, employee_id, attendance_date, ...w, ...header, source: "DIRECT", revoked_at: null });
        return id;
      });
      return { code: 200, attendance_permission_ids: ids };
    },
    getPermission: async (id) => {
      const p = store.permissions.find((x) => x.attendance_permission_id === Number(id));
      return p ? { ...p, employee_store_id: empOf(p.employee_id).store_id } : null;
    },
    listActiveInBulkOperation: async (op) =>
      store.permissions.filter((p) => p.bulk_operation_id === op && !p.revoked_at).map((p) => ({ ...p, employee_store_id: empOf(p.employee_id).store_id })),
    revoke: async (args) => {
      store.revokes.push(args);
      Object.assign(store.permissions.find((p) => p.attendance_permission_id === args.attendance_permission_id), {
        revoked_at: "2026-09-20 10:00:00",
        revoke_reason: args.reason,
        revoked_by_employee_id: args.actor.employee_id,
      });
      return { code: 200, calculations_written: args.calculations.length };
    },
  };

  const calculation = buildCalculation(calcRepo);
  return { store, calculation, permission: buildPermission(permissionRepo, calculation) };
}

const GRANTOR = { employee_id: 9, user_id: 90, user_type: 1 };
const FESTIVAL = {
  attendance_date: DATE,
  from_time: "19:00",
  to_shift_end: true,
  target_mode: "ALL",
  reason: "Deepavali early closing",
  today: TODAY,
};

describe("preview - who a festival grant reaches, before anything is written", () => {
  it("lists the eligible employees with their own windows, and everybody left out with a reason", async () => {
    const { permission, store } = build();
    const p = await permission.preview({ actor: GRANTOR, scope_store_ids: null, ...FESTIVAL });
    assert.deepEqual(p.eligible.map((e) => e.employee_id).sort(), [1, 5]);
    assert.equal(p.eligible.find((e) => e.employee_id === 1).permission_from, `${DATE} 19:00:00`);
    assert.equal(p.eligible.find((e) => e.employee_id === 1).permission_to, `${DATE} 22:00:00`);
    const why = Object.fromEntries(p.excluded.map((e) => [e.employee_id, e.code]));
    assert.deepEqual(why, {
      2: "OUTSIDE_SHIFT", // 06:00-15:00 ends before 19:00
      3: "ATTENDANCE_NOT_REQUIRED",
      4: "BEFORE_JOINING_DATE",
      9: "SELF",
    });
    assert.equal(p.counts.eligible, 2);
    assert.equal(p.counts.considered, 6);
    assert.equal(p.fingerprint.length, 64);
    assert.equal(store.permissions.length, 0, "a preview writes nothing");
  });

  it("is confined to the caller's outlet scope", async () => {
    const { permission } = build();
    const p = await permission.preview({ actor: GRANTOR, scope_store_ids: [3], ...FESTIVAL });
    assert.deepEqual(p.eligible.map((e) => e.employee_id), [1]);
    assert.ok(!p.excluded.some((e) => e.employee_id === 5), "an employee outside the scope is not even named");
  });

  it("an employee named outside the scope reads as not in scope - one answer, no enumeration", async () => {
    const { permission } = build();
    const p = await permission.preview({ actor: GRANTOR, scope_store_ids: [3], ...FESTIVAL, target_mode: "EMPLOYEES", employee_ids: [5, 999] });
    assert.equal(p.eligible.length, 0);
    assert.deepEqual(p.excluded.map((e) => e.code), ["NOT_IN_SCOPE", "NOT_IN_SCOPE"]);
  });

  it("skips a payroll-locked employee and one who already holds an overlapping permission", async () => {
    const existing = [{ attendance_permission_id: 7, employee_id: 5, attendance_date: DATE, permission_from: `${DATE} 20:00:00`, permission_to: `${DATE} 22:00:00`, source: "DIRECT", revoked_at: null }];
    const { permission } = build({ locked: [1], existing });
    const p = await permission.preview({ actor: GRANTOR, scope_store_ids: null, ...FESTIVAL });
    const why = Object.fromEntries(p.excluded.map((e) => [e.employee_id, e.code]));
    assert.equal(why[1], "PAYROLL_LOCKED");
    assert.equal(why[5], "OVERLAP");
    assert.equal(p.can_apply, false);
  });
});

describe("apply - exactly what was previewed", () => {
  it("grants each eligible employee, stores the closed day with the permission applied, and logs every employee", async () => {
    const { permission, store } = build();
    const p = await permission.preview({ actor: GRANTOR, scope_store_ids: null, ...FESTIVAL });
    const r = await permission.apply({ actor: GRANTOR, scope_store_ids: null, fingerprint: p.fingerprint, ...FESTIVAL });
    assert.equal(r.code, 200);
    assert.ok(r.bulk_operation_id, "a company grant is a bulk operation");
    assert.deepEqual(r.summary, { considered: 6, succeeded: 2, skipped: 4, failed: 0 });
    assert.equal(store.operations[0].reason, "Deepavali early closing");
    assert.equal(store.items.length, 6, "one item per employee considered, skips included");

    const anu = store.grants.find((g) => g.employee_id === 1);
    assert.equal(anu.calculations.length, 1);
    assert.equal(anu.calculations[0].permission_minutes, 180);
    assert.equal(anu.calculations[0].shortage_minutes, 0);
    assert.equal(anu.calculations[0].worked_minutes, 480, "10:00-19:00 less the break - what was worked");
    assert.equal(anu.calculations[0].candidate_ot_minutes, 0, "no OT");

    const row = store.permissions.find((x) => x.employee_id === 1);
    assert.equal(row.source, "DIRECT");
    assert.equal(row.created_by_employee_id, 9);
    assert.equal(row.bulk_operation_id, r.bulk_operation_id);
  });

  it("one employee named is an individual grant: no bulk operation", async () => {
    const { permission, store } = build();
    const one = { ...FESTIVAL, target_mode: "EMPLOYEES", employee_ids: [1] };
    const p = await permission.preview({ actor: GRANTOR, scope_store_ids: null, ...one });
    const r = await permission.apply({ actor: GRANTOR, scope_store_ids: null, fingerprint: p.fingerprint, ...one });
    assert.equal(r.bulk_operation_id, null);
    assert.equal(store.operations.length, 0);
    assert.equal(store.permissions[0].bulk_operation_id, null);
  });

  it("refuses a stale preview and hands back the new one", async () => {
    const { permission, store } = build();
    const p = await permission.preview({ actor: GRANTOR, scope_store_ids: null, ...FESTIVAL });
    store.permissions.push({ attendance_permission_id: 1, employee_id: 5, attendance_date: DATE, permission_from: `${DATE} 21:00:00`, permission_to: `${DATE} 22:00:00`, source: "DIRECT", revoked_at: null });
    const r = await permission.apply({ actor: GRANTOR, scope_store_ids: null, fingerprint: p.fingerprint, ...FESTIVAL });
    assert.equal(r.code, 409);
    assert.equal(r.reason, "PREVIEW_CHANGED");
    assert.equal(r.preview.counts.eligible, 1);
    assert.equal(store.grants.length, 0, "nothing was granted");
  });

  it("one employee's failure does not stop the others", async () => {
    const { permission } = build({ failFor: [1] });
    const p = await permission.preview({ actor: GRANTOR, scope_store_ids: null, ...FESTIVAL });
    const r = await permission.apply({ actor: GRANTOR, scope_store_ids: null, fingerprint: p.fingerprint, ...FESTIVAL });
    assert.equal(r.summary.failed, 1);
    assert.equal(r.summary.succeeded, 1);
    assert.equal(r.results.find((x) => x.employee_id === 5).outcome, "SUCCEEDED");
  });

  it("the stored day reads the permission afterwards, through the ordinary read", async () => {
    const { permission, calculation } = build();
    const p = await permission.preview({ actor: GRANTOR, scope_store_ids: null, ...FESTIVAL });
    await permission.apply({ actor: GRANTOR, scope_store_ids: null, fingerprint: p.fingerprint, ...FESTIVAL });
    const [day] = await calculation.calculateRange({ employee_id: 5, from_date: DATE, to_date: DATE });
    assert.equal(day.permission_minutes, 180);
    assert.equal(day.shortage_minutes, 0);
    assert.equal(day.permissions[0].source, "DIRECT");
    assert.equal(day.permissions[0].state, "APPROVED");
  });
});

describe("revoke", () => {
  const granted = async (opts) => {
    const world = build(opts);
    const p = await world.permission.preview({ actor: GRANTOR, scope_store_ids: null, ...FESTIVAL });
    const r = await world.permission.apply({ actor: GRANTOR, scope_store_ids: null, fingerprint: p.fingerprint, ...FESTIVAL });
    return { ...world, op: r.bulk_operation_id };
  };

  it("withdraws one grant and stores the day without it, recording who and why", async () => {
    const { permission, store } = await granted();
    const row = store.permissions.find((p) => p.employee_id === 1);
    const r = await permission.revoke({ actor: GRANTOR, scope_store_ids: null, attendance_permission_id: row.attendance_permission_id, reason: "Store stayed open after all" });
    assert.equal(r.code, 200);
    assert.equal(store.revokes[0].calculations[0].permission_minutes, 0);
    assert.equal(store.revokes[0].calculations[0].shortage_minutes, 180);
    assert.equal(row.revoke_reason, "Store stayed open after all");
  });

  it("outside the caller's scope reads as not found", async () => {
    const { permission, store } = await granted();
    const row = store.permissions.find((p) => p.employee_id === 5);
    const r = await permission.revoke({ actor: GRANTOR, scope_store_ids: [3], attendance_permission_id: row.attendance_permission_id, reason: "Not mine to revoke" });
    assert.equal(r.code, 404);
  });

  it("a payroll-locked month refuses the revoke", async () => {
    const world = await granted();
    const row = world.store.permissions.find((p) => p.employee_id === 1);
    const locked = build({ locked: [1], existing: world.store.permissions });
    await assert.rejects(
      locked.permission.revoke({ actor: GRANTOR, scope_store_ids: null, attendance_permission_id: row.attendance_permission_id, reason: "Too late now" }),
      /locked/i
    );
  });

  it("a whole bulk grant is revoked employee by employee, each row recording the operation", async () => {
    const { permission, store, op } = await granted();
    const r = await permission.revokeBulkOperation({ actor: GRANTOR, scope_store_ids: null, bulk_operation_id: op, reason: "Festival moved" });
    assert.equal(r.summary.succeeded, 2);
    assert.ok(store.revokes.every((x) => x.revoke_bulk_operation_id === op));
    assert.ok(store.permissions.every((p) => p.revoked_at));
  });
});

describe("THE MONTHLY SUMMARY FOLLOWS A DIRECT GRANT OR REVOKE", () => {
  it("each granted employee's existing summary is re-persisted with the permission", async () => {
    const { permission, store } = build({ summaries: true });
    const p = await permission.preview({ actor: GRANTOR, scope_store_ids: null, ...FESTIVAL });
    const r = await permission.apply({ actor: GRANTOR, scope_store_ids: null, fingerprint: p.fingerprint, ...FESTIVAL });
    const granted = r.results.filter((x) => x.outcome === "SUCCEEDED");
    assert.ok(granted.every((x) => x.month_refresh && x.month_refresh.refreshed));
    assert.deepEqual(store.months.map((m) => m.employee_id).sort(), [1, 5]);
    store.months.forEach((m) => assert.equal(m.monthly.shortage_minutes, 0));
  });

  it("a direct revoke re-persists the month without the grant", async () => {
    const { permission, store } = build({ summaries: true });
    const p = await permission.preview({ actor: GRANTOR, scope_store_ids: null, ...FESTIVAL });
    await permission.apply({ actor: GRANTOR, scope_store_ids: null, fingerprint: p.fingerprint, ...FESTIVAL });
    store.months.length = 0;
    const row = store.permissions.find((x) => x.employee_id === 1);
    const out = await permission.revoke({ actor: GRANTOR, scope_store_ids: null, attendance_permission_id: row.attendance_permission_id, reason: "Store stayed open" });
    assert.equal(out.month_refresh.refreshed, true);
    assert.equal(store.months[0].monthly.shortage_minutes, 180);
  });
});
