/**
 * THE MONTHLY SUMMARY FOLLOWS EVERY ATTENDANCE CHANGE - the real attendance
 * calculation and approval usecases over an in-memory store that keeps day
 * rows, monthly summaries and their fingerprints the way the database does.
 *
 *   node --test usecase/attendance_month_auto_refresh.test.js
 *
 * Before this change only a Permission decision re-persisted the month; an OT
 * or regularization approval, a revocation, a shift change, a recalculation
 * rewrote DAYS and left `attendance_monthly_payroll` stale - which is what put
 * employees into Payroll's Attendance Pending and made "eligible" employees
 * fail at Calculate. Every scenario below asserts the stored SUMMARY (approved
 * OT, finality, fingerprint) after an ordinary attendance action, with no
 * manual Process Attendance in between.
 */
const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const buildCalculation = require("./attendance_calculation");
const buildRegularization = require("./attendance_regularization");
const { REQUEST_TYPE, STEP_DECISION, APPROVER_ROLE } = require("../utils/attendance_approval_chain");
const { FINGERPRINT_FIELDS, dayRowsFingerprint, monthFreshness } = require("../utils/attendance_month_freshness");
const { evaluatePayrollReadiness } = require("../utils/payroll_readiness");

const weekly = (id, out, nrm) =>
  Array.from({ length: 7 }, (_, day) => ({
    work_shift_weekly_schedule_id: id * 100 + day, work_shift_id: id, day_of_week: day, is_working_day: 1,
    in_time: "10:00:00", out_time: out, attendance_day_cutoff: "04:00:00", break_minutes: 60,
    normal_work_minutes: nrm, ot_rate: 1,
  }));
const shift = (id, code, out, nrm) => ({
  config: {
    work_shift_id: id, shift_code: code, shift_name: code, active: 1, overtime_allowed: 1,
    overtime_minimum_minutes: 0, overtime_rounding_method: "NONE", overtime_rounding_interval_minutes: 0,
    overtime_minimum_threshold_only: 0, maximum_ot_minutes_per_day: null,
  },
  schedule: weekly(id, out, nrm),
});
const SHIFTS = { 7: shift(7, "LATE", "22:00:00", 660), 8: shift(8, "EARLY", "19:00:00", 480) };

const EMPLOYEES = {
  42: { employee_id: 42, employee_name: "Asha", outlet_id: 3, designation_id: 11, designation_name: "STAFF", approver_role: null, requester_class: null },
  43: { employee_id: 43, employee_name: "Bala", outlet_id: 3, designation_id: 11, designation_name: "STAFF", approver_role: null, requester_class: null },
  8: { employee_id: 8, employee_name: "HR", outlet_id: 1, designation_id: 3, designation_name: "HR", approver_role: APPROVER_ROLE.HR, requester_class: "MANAGER" },
};
const ALL = { kind: "ALL_BRANCHES", store_ids: null };
const HR = { employee_id: 8, user_type: 1, branch_scope: ALL };
const ADMIN = { employee_id: 1, user_id: 1, user_type: 2, branch_scope: ALL };
// Every September date has closed.
const NOW = Date.parse("2026-10-03T12:00:00+05:30");
const SEPT = Array.from({ length: 30 }, (_, i) => `2026-09-${String(i + 1).padStart(2, "0")}`);

let nextPunch = 1;
const punch = (employee, ioTime) => ({
  punch_id: nextPunch++, employee_id: employee, io_time: ioTime, punch_date: ioTime.slice(0, 10),
  ingest_attendance_date: ioTime.slice(0, 10), dev_id: "D", ingest_source: "LIVE",
});
/** A full LATE day on every date; 14 Sep worked to 23:30 (90 min candidate OT); 15 Sep missing its out punch. */
function monthOfPunches(employee) {
  const out = [];
  SEPT.forEach((d) => {
    out.push(punch(employee, `${d} 10:00:00`));
    if (d === "2026-09-15" && employee === 42) return;
    out.push(punch(employee, `${d} ${d === "2026-09-14" && employee === 42 ? "23:30:00" : "22:00:00"}`));
  });
  return out;
}

function build() {
  const store = {
    raw: [...monthOfPunches(42), ...monthOfPunches(43)],
    days: new Map(),          // `${emp}|${date}` -> stored day row
    months: new Map(),        // `${emp}|${y}|${m}` -> stored monthly summary
    overrides: [],
    requests: [],
    steps: [],
    writes: [],               // every write method called, for "nothing else moved"
    persists: [],             // every month persist
    locked: new Set(),        // `${emp}|YYYY-MM` Approved & Locked
    periodLocked: new Set(),  // `YYYY-MM`
  };
  let nextRequest = 900;
  const keyOf = (e, d) => `${e}|${d}`;
  const writeDays = (rows) => rows.forEach((r) => store.days.set(keyOf(r.employee_id, r.attendance_date), { ...r }));
  /** The stored days of a month, projected exactly as `dayRowsSql` reads them. */
  const fingerprintRows = (e, y, m) => {
    const prefix = `${y}-${String(m).padStart(2, "0")}-`;
    return [...store.days.values()]
      .filter((d) => Number(d.employee_id) === Number(e) && String(d.attendance_date).startsWith(prefix))
      .sort((a, b) => String(a.attendance_date).localeCompare(String(b.attendance_date)))
      .map((d) => Object.fromEntries(FINGERPRINT_FIELDS.map((f) => [f, d[f] === undefined ? null : d[f]])));
  };
  const requestOf = (id) => store.requests.find((r) => r.attendance_approval_request_id === Number(id));

  const calcRepo = {
    getShiftAssignmentHistory: async (e) => [{ employee_work_shift_assignment_id: 1, employee_id: e, work_shift_id: 7, effective_from: "2026-01-01", source: "MIGRATION_BACKFILL" }],
    getWorkShiftWithSchedule: async (id) => SHIFTS[id] || null,
    getWorkShiftConfigVersions: async () => [],
    getRawPunchesByCalendarWindow: async (e, from, to) =>
      store.raw.filter((p) => p.employee_id === e && p.punch_date >= from && p.punch_date <= to),
    getApprovedRegularizedPunches: async (e, from, to) =>
      store.requests
        .filter((r) => r.requested_for_employee_id === e && r.status === "APPROVED" && r.finalization_state === "SETTLED" && r.regularized_punch)
        .filter((r) => r.attendance_date >= from && r.attendance_date <= to)
        .map((r) => ({
          punch_id: r.regularized_punch.attendance_regularized_punch_id, employee_id: e,
          attendance_date: r.attendance_date, io_time: r.regularized_punch.punch_time,
          punch_source: "REGULARIZATION", attendance_approval_request_id: r.attendance_approval_request_id,
        })),
    getBreakOverride: async () => null,
    getAttendanceCalculationModeHistory: async () => [],
    getApprovalStateByDate: async (e, from, to) =>
      store.requests.filter((r) => r.requested_for_employee_id === e && r.status !== "CANCELLED" && r.attendance_date >= from && r.attendance_date <= to),
    getPermissionsForRange: async () => [],
    getDateShiftOverrides: async (e, from, to) =>
      store.overrides.filter((o) => o.employee_id === e && o.attendance_date >= from && o.attendance_date <= to),
    getEmploymentWindow: async (e) => ({ employee_id: e, status: 1, date_of_joining: "2020-01-01", resignation_date: null }),
    getMonthlyGrossAsOf: async () => ({ salary_id: 1, monthly_gross: 26000, effective_from: "2026-04-01" }),
    getMonthlyPayroll: async ({ employee_id, period_year, period_month }) =>
      store.months.get(`${employee_id}|${period_year}|${period_month}`) || null,
    listMonthDayRowsForFingerprint: async ({ employee_id, from_date }) =>
      fingerprintRows(employee_id, Number(from_date.slice(0, 4)), Number(from_date.slice(5, 7))),
    isPayrollPeriodLocked: async ({ period_year, period_month }) =>
      store.periodLocked.has(`${period_year}-${String(period_month).padStart(2, "0")}`),
    findPayrollLockedPeriods: async (rows) =>
      rows
        .filter((r) => store.locked.has(`${r.employee_id}|${String(r.attendance_date).slice(0, 7)}`))
        .map((r) => ({ employee_id: r.employee_id, period: String(r.attendance_date).slice(0, 7) })),
    saveCalculations: async (rows) => {
      store.writes.push({ method: "saveCalculations", rows: rows.length });
      writeDays(rows);
      return { written: rows.length };
    },
    saveCalculationsWithReconciliation: async ({ rows }) => {
      store.writes.push({ method: "saveCalculationsWithReconciliation", rows: rows.length });
      writeDays(rows);
      return { written: rows.length, removed: 0 };
    },
    saveDateShiftOverrideWithCalculation: async ({ override, rows }) => {
      store.writes.push({ method: "saveDateShiftOverrideWithCalculation", rows: rows.length });
      store.overrides.push({ attendance_date_shift_override_id: store.overrides.length + 1, source: "MANAGEMENT_EDIT", shift_change_approved: 0, ...override });
      writeDays(rows);
      return { written: rows.length, attendance_date_shift_override_id: store.overrides.length };
    },
    /** The month persist: days and summary together, the fingerprint over the stored days. */
    saveMonthWithPayroll: async ({ employee_id, period_year, period_month, rows, monthly }) => {
      if (store.locked.has(`${employee_id}|${period_year}-${String(period_month).padStart(2, "0")}`)) {
        throw Object.assign(new Error("payroll month locked"), { code: "PAYROLL_MONTH_LOCKED" });
      }
      store.writes.push({ method: "saveMonthWithPayroll", employee_id, period_month });
      store.persists.push({ employee_id, period_year, period_month });
      writeDays(rows);
      const prior = store.months.get(`${employee_id}|${period_year}|${period_month}`);
      store.months.set(`${employee_id}|${period_year}|${period_month}`, {
        ...monthly,
        attendance_monthly_payroll_id: prior ? prior.attendance_monthly_payroll_id : store.months.size + 1,
        day_rows_fingerprint: dayRowsFingerprint(fingerprintRows(employee_id, period_year, period_month)),
      });
      return { written: rows.length, monthly_written: 1 };
    },
  };

  const regRepo = {
    getApprovalIdentity: async (id) => EMPLOYEES[id] || null,
    getRequest: async (id) => {
      const r = requestOf(id);
      return r ? { ...r, steps: store.steps.filter((s) => s.attendance_approval_request_id === r.attendance_approval_request_id) } : null;
    },
    findRequestsForDates: async (e, dates) =>
      store.requests.filter((r) => r.requested_for_employee_id === e && dates.includes(r.attendance_date) && r.status !== "CANCELLED"),
    decideStage: async (args) => {
      store.writes.push({ method: "decideStage", rows: args.calculations.length });
      const r = requestOf(args.requestId);
      const st = store.steps.find((s) => s.attendance_approval_request_id === args.requestId && s.stage_no === args.stageNo);
      st.decision = args.decision;
      r.status = args.next.status;
      r.current_stage_no = args.next.current_stage_no;
      r.approved_ot_minutes = args.next.approved_ot_minutes;
      r.finalization_state = args.next.status === "PENDING" ? "NOT_REQUIRED" : "SETTLED";
      if (args.shiftOverride) {
        store.overrides.push({
          attendance_date_shift_override_id: store.overrides.length + 1, source: "APPROVED_REQUEST",
          shift_change_approved: 1, attendance_approval_request_id: r.attendance_approval_request_id, ...args.shiftOverride,
        });
      }
      writeDays(args.calculations);
      return { code: 200, status: r.status, current_stage_no: r.current_stage_no, finalization_state: r.finalization_state };
    },
    getRevocationSnapshot: async (id) => {
      const r = requestOf(id);
      return r ? { request: { ...r }, steps: store.steps.filter((s) => s.attendance_approval_request_id === r.attendance_approval_request_id), fingerprint: "fp" } : null;
    },
    revokeRequest: async (args) => {
      store.writes.push({ method: "revokeRequest", rows: args.calculations.length });
      const r = requestOf(args.requestId);
      r.status = "CANCELLED";
      store.overrides = store.overrides.filter((o) => o.attendance_approval_request_id !== r.attendance_approval_request_id);
      writeDays(args.calculations);
      return { code: 200, new_request_status: "CANCELLED", calculations_written: args.calculations.length };
    },
    listPermissionsForRequests: async () => [],
  };

  const calculation = buildCalculation(calcRepo);
  const regularization = buildRegularization(regRepo, calculation);

  /** A request already raised and waiting at its one HR stage. */
  const seedRequest = (request) => {
    const id = nextRequest++;
    store.requests.push({
      attendance_approval_request_id: id, requested_for_employee_id: 42, requested_by_employee_id: 42,
      outlet_id: 3, requester_class: "STORE_EMPLOYEE", reason: "Seeded for the test", candidate_ot_minutes: 0,
      approved_ot_minutes: null, status: "PENDING", current_stage_no: 1, total_stages: 1,
      finalization_state: "NOT_REQUIRED", closure_reason: null, regularized_punch: null, ...request,
    });
    store.steps.push({ attendance_approval_request_id: id, stage_no: 1, approver_role: APPROVER_ROLE.HR, outlet_id: null, decision: "PENDING" });
    return id;
  };
  const monthOf = (e = 42) => store.months.get(`${e}|2026|9`);
  const freshness = (e = 42) => monthFreshness({ monthly: monthOf(e), dayRows: fingerprintRows(e, 2026, 9) }).state;
  const dayRow = (date, e = 42) => store.days.get(keyOf(e, date));

  return { store, calcRepo, calculation, regularization, seedRequest, monthOf, freshness, dayRow, fingerprintRows };
}

let w;
beforeEach(async () => {
  w = build();
  // The month as it stood when it was first processed: 15 Sep awaiting its
  // missing out punch, no OT approved.
  for (const e of [42, 43]) await w.calculation.calculateMonth({ employee_id: e, year: 2026, month: 9, persist: true, now: NOW });
  w.store.persists.length = 0;
  w.store.writes.length = 0;
});

const approve = (id) => w.regularization.decide({ actor: HR, request_id: id, decision: STEP_DECISION.APPROVED, now: NOW });
const revoke = (id) => w.regularization.revokeDecision({ actor: ADMIN, request_id: id, reason: "Approved in error", now: NOW });

describe("the starting month", () => {
  it("is stored, current, not final (15 Sep is unsettled) and has no approved OT", () => {
    assert.equal(w.freshness(), "CURRENT");
    assert.equal(Number(w.monthOf().is_final), 0);
    assert.equal(Number(w.monthOf().approved_ot_minutes), 0);
    assert.equal(Number(w.dayRow("2026-09-15").is_final), 0);
  });
});

describe("1-2. OT approve and revoke", () => {
  const otRequest = () =>
    w.seedRequest({ request_type: REQUEST_TYPE.OT, attendance_date: "2026-09-14", candidate_ot_minutes: 90 });

  it("1. an OT approval changes the day AND the monthly approved_ot_minutes, with no manual step", async () => {
    const out = await approve(otRequest());
    assert.equal(out.code, 200);
    assert.equal(Number(w.dayRow("2026-09-14").approved_ot_minutes), 90);
    assert.equal(Number(w.monthOf().approved_ot_minutes), 90);
    assert.equal(w.freshness(), "CURRENT");
    assert.equal(out.month_refresh.refreshed, 1);
    assert.deepEqual(w.store.persists, [{ employee_id: 42, period_year: 2026, period_month: 9 }]);
  });

  it("2. revoking it puts the monthly OT back to 0", async () => {
    const id = otRequest();
    await approve(id);
    w.store.persists.length = 0;
    const out = await revoke(id);
    assert.equal(out.code, 200);
    assert.equal(out.month_refresh.refreshed, 1, "the revocation itself re-persisted the month");
    assert.equal(w.store.persists.length, 1);
    assert.equal(Number(w.dayRow("2026-09-14").approved_ot_minutes), 0);
    assert.equal(Number(w.monthOf().approved_ot_minutes), 0);
    assert.equal(w.freshness(), "CURRENT");
  });
});

describe("3-4. regularization approve and revoke", () => {
  const regRequest = () =>
    w.seedRequest({
      request_type: REQUEST_TYPE.REGULARIZATION, attendance_date: "2026-09-15",
      regularized_punch: { attendance_regularized_punch_id: 5001, punch_time: "2026-09-15 22:00:00" },
    });

  it("3. settling the only unsettled day makes the monthly summary final", async () => {
    const out = await approve(regRequest());
    assert.equal(out.code, 200);
    assert.equal(Number(w.dayRow("2026-09-15").is_final), 1);
    assert.equal(Number(w.monthOf().is_final), 1);
    assert.equal(w.freshness(), "CURRENT");
  });

  it("4. revoking it reopens the month", async () => {
    const id = regRequest();
    await approve(id);
    assert.equal(Number(w.monthOf().is_final), 1);
    const out = await revoke(id);
    assert.equal(out.month_refresh.refreshed, 1);
    assert.equal(Number(w.dayRow("2026-09-15").is_final), 0);
    assert.equal(Number(w.monthOf().is_final), 0);
    assert.equal(w.freshness(), "CURRENT");
  });
});

describe("5. shift changes that move the NRM", () => {
  it("an approved SHIFT_CHANGE request re-persists the month on the new NRM, and its revocation restores it", async () => {
    const id = w.seedRequest({
      request_type: REQUEST_TYPE.SHIFT_CHANGE, attendance_date: "2026-09-16",
      requested_work_shift_id: 8, base_work_shift_id: 7,
    });
    const out = await approve(id);
    assert.equal(out.code, 200);
    assert.equal(Number(w.dayRow("2026-09-16").nrm_minutes), 480);
    assert.equal(w.freshness(), "CURRENT");
    assert.equal(w.store.persists.length, 1);
    await revoke(id);
    assert.equal(Number(w.dayRow("2026-09-16").nrm_minutes), 660);
    assert.equal(w.freshness(), "CURRENT");
  });

  it("a management Edit Shift for a date re-persists the month", async () => {
    const out = await w.calculation.setDateShift({ employee_id: 42, attendance_date: "2026-09-17", work_shift_id: 8, actor_employee_id: 8, now: NOW });
    assert.equal(Number(w.dayRow("2026-09-17").nrm_minutes), 480);
    assert.equal(out.month_refresh.refreshed, 1);
    assert.equal(w.freshness(), "CURRENT");
  });
});

describe("6-8. punch void, device-time correction and recalculation", () => {
  it("6/8. a recalculation after a punch is voided (the punch-void path) re-persists the month", async () => {
    // What a void leaves behind: the punch no longer counts.
    w.store.raw = w.store.raw.filter((p) => !(p.employee_id === 42 && p.io_time === "2026-09-20 22:00:00"));
    const out = await w.calculation.recalculateRange({ employee_id: 42, from_date: "2026-09-20", to_date: "2026-09-20", now: NOW });
    assert.equal(Number(w.dayRow("2026-09-20").is_final), 0);
    assert.equal(out.month_refresh.refreshed, 1);
    assert.equal(w.freshness(), "CURRENT");
    assert.equal(Number(w.monthOf().is_final), 0);
  });

  it("8. a recalculation that changes nothing re-persists nothing (no needless month persists)", async () => {
    const out = await w.calculation.recalculateRange({ employee_id: 42, from_date: "2026-09-01", to_date: "2026-09-30", now: NOW });
    assert.equal(out.month_refresh.refreshed, 0);
    assert.equal(out.month_refresh.months[0].reason, "UP_TO_DATE");
    assert.equal(w.store.persists.length, 0);
  });

  it("6/7. the punch-void and device-time-correction usecases reach a refresh after their write", () => {
    const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const voidCode = strip(fs.readFileSync(path.join(__dirname, "attendance_punch_void.js"), "utf8"));
    assert.match(voidCode, /attendanceCalculationUsecase\.recalculateRange\(/, "punch void recalculates through recalculateRange, which refreshes");
    const dtc = strip(fs.readFileSync(path.join(__dirname, "attendance_device_time_correction.js"), "utf8"));
    assert.match(dtc, /await repo\.applyCorrection\([\s\S]*?\}\);\s*const monthRefresh = await refreshMonthsFor\(rows, "a device time correction"\)/);
    assert.match(dtc, /await repo\.revertCorrection\([\s\S]*?\}\);\s*const monthRefresh = await refreshMonthsFor\(rows, "a device time correction revert"\)/);
  });
});

describe("9. bulk flows deduplicate employee/months", () => {
  it("fifty entries for one employee/month are ONE month persist", async () => {
    const id = w.seedRequest({ request_type: REQUEST_TYPE.OT, attendance_date: "2026-09-14", candidate_ot_minutes: 90 });
    const collector = [];
    const out = await w.regularization.decide({ actor: HR, request_id: id, decision: STEP_DECISION.APPROVED, now: NOW, month_refresh_collector: collector });
    assert.deepEqual(out.month_refresh, { deferred: true });
    assert.equal(w.store.persists.length, 0, "deferred, not refreshed per request");
    const entries = [...collector, ...SEPT.slice(0, 25).map((d) => ({ employee_id: 42, attendance_date: d })), ...SEPT.slice(0, 24).map((d) => ({ employee_id: 42, attendance_date: d }))];
    assert.equal(entries.length, 50);
    const refreshed = await w.calculation.refreshAffectedMonths(entries, { now: NOW });
    assert.equal(refreshed.months.length, 1);
    assert.equal(w.store.persists.length, 1);
    assert.equal(Number(w.monthOf().approved_ot_minutes), 90);
  });

  it("several employees and months are each refreshed once", async () => {
    w.store.raw = w.store.raw.filter((p) => p.io_time !== "2026-09-21 22:00:00"); // both employees change
    const refreshed = await w.calculation.refreshAffectedMonths([
      { employee_id: 42, attendance_date: "2026-09-21" }, { employee_id: 43, attendance_date: "2026-09-21" },
      { employee_id: 42, year: 2026, month: 9 }, { employee_id: 43, attendance_date: "2026-09-02" },
    ], { now: NOW });
    assert.deepEqual(refreshed.months.map((m) => `${m.employee_id}|${m.month}`), ["42|9", "43|9"]);
  });

  it("Bulk Action defers to one refresh after the loop", () => {
    const src = fs.readFileSync(path.join(__dirname, "attendance_regularization.js"), "utf8");
    const body = src.slice(src.indexOf("const bulkAction = async"), src.indexOf("const listBulkTargets = async"));
    assert.match(body, /month_refresh_collector: monthRefreshEntries/);
    assert.match(body, /refreshMonthsAfter\(monthRefreshEntries, \{ now, source: `a bulk \$\{action\}` \}\)/);
    const loopEnd = body.indexOf("const monthRefresh =");
    assert.ok(loopEnd > body.lastIndexOf("for (const target of targets)"), "the refresh runs after the loop");
  });
});

describe("10. Permission behaviour is unchanged", () => {
  it("the Permission branches still call refreshMonthAfter with its original answer shape", () => {
    const src = fs.readFileSync(path.join(__dirname, "attendance_regularization.js"), "utf8");
    assert.match(src, /: permissionRefresh\s*\? await refreshMonthAfter\(request\.requested_for_employee_id, request\.attendance_date, now\)/);
    assert.match(src, /: isPermission\s*\? await refreshMonthAfter\(employeeId, request\.attendance_date, now\)/);
  });
});

describe("11. locked payroll is never refreshed", () => {
  it("an Approved & Locked employee/month is skipped, not re-persisted and not unlocked", async () => {
    w.store.locked.add("42|2026-09");
    const before = JSON.stringify(w.monthOf());
    const out = await w.calculation.refreshAffectedMonths([{ employee_id: 42, attendance_date: "2026-09-14" }], { now: NOW });
    assert.equal(out.months[0].reason, "PAYROLL_LOCKED");
    assert.equal(w.store.persists.length, 0);
    assert.equal(JSON.stringify(w.monthOf()), before);
    assert.ok(w.store.locked.has("42|2026-09"));
  });

  it("a locked payroll period is skipped", async () => {
    w.store.periodLocked.add("2026-09");
    const out = await w.calculation.refreshAffectedMonths([{ employee_id: 42, attendance_date: "2026-09-14" }], { now: NOW });
    assert.equal(out.months[0].reason, "PAYROLL_PERIOD_LOCKED");
    assert.equal(w.store.persists.length, 0);
  });

  it("a month with no summary is not created by a refresh", async () => {
    const out = await w.calculation.refreshAffectedMonths([{ employee_id: 42, attendance_date: "2026-08-14" }], { now: NOW });
    assert.equal(out.months[0].reason, "NO_SUMMARY");
    assert.equal(w.store.persists.length, 0);
  });

  it("a refresh that fails is reported, never thrown: the approval stands and Payroll sees the month as STALE", async () => {
    const id = w.seedRequest({ request_type: REQUEST_TYPE.OT, attendance_date: "2026-09-14", candidate_ot_minutes: 90 });
    // The month persist fails after the approval committed (a lock wait).
    w.calcRepo.saveMonthWithPayroll = async () => {
      throw Object.assign(new Error("Lock wait timeout exceeded"), { code: "ER_LOCK_WAIT_TIMEOUT" });
    };
    const out = await approve(id);
    assert.equal(out.code, 200, "the approval itself stands");
    assert.equal(Number(w.dayRow("2026-09-14").approved_ot_minutes), 90);
    assert.equal(out.month_refresh.failed, 1);
    assert.equal(out.month_refresh.months[0].reason, "ER_LOCK_WAIT_TIMEOUT");
    assert.match(out.month_refresh.months[0].message, /Lock wait timeout/);
    // Not silently stale: the fingerprint no longer matches, and Payroll says so.
    assert.equal(w.freshness(), "STALE");
    const verdict = evaluatePayrollReadiness({
      year: 2026, month: 9, snapshot: { monthly_gross: 26000, basic: 13000, date_of_joining: "2020-01-01" },
      monthly: w.monthOf(), day_rows: [...w.store.days.values()].filter((d) => d.employee_id === 42),
      latest_closed_date: "2026-10-02",
    });
    assert.ok(verdict.reasons.some((r) => r.code === "ATTENDANCE_STALE"));
    assert.equal(verdict.attendance_processable, true, "Process Attendance can recover it");
  });
});

describe("12-13. nothing else moves", () => {
  it("an approval writes only attendance day rows and that employee's monthly summary", async () => {
    const other = JSON.stringify(w.monthOf(43));
    const otherDays = JSON.stringify(w.fingerprintRows(43, 2026, 9));
    await approve(w.seedRequest({ request_type: REQUEST_TYPE.OT, attendance_date: "2026-09-14", candidate_ot_minutes: 90 }));
    assert.deepEqual([...new Set(w.store.writes.map((x) => x.method))].sort(), ["decideStage", "saveMonthWithPayroll"]);
    assert.ok(w.store.persists.every((p) => p.employee_id === 42 && p.period_month === 9));
    assert.equal(JSON.stringify(w.monthOf(43)), other, "the unrelated employee's month is untouched");
    assert.equal(JSON.stringify(w.fingerprintRows(43, 2026, 9)), otherDays);
  });

  it("the refresh path names no salary, employee-master or payroll-calculation write", () => {
    const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const src = strip(fs.readFileSync(path.join(__dirname, "attendance_calculation.js"), "utf8"));
    const body = src.slice(src.indexOf("const refreshAffectedMonths = async"), src.indexOf("const refreshPersistedMonth = async"));
    const calls = [...body.matchAll(/attendanceCalculationRepo\.([a-zA-Z]+)\(/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(calls)].sort(), [
      "findPayrollLockedPeriods", "getMonthlyPayroll", "isPayrollPeriodLocked", "listMonthDayRowsForFingerprint",
    ]);
    assert.match(body, /await calculateMonth\(\{ employee_id: employeeId, year, month, persist: true, now \}\)/);
  });
});

describe("14. Payroll readiness reflects the change immediately", () => {
  it("after an OT approval the month is current and reconciled - no Process Attendance needed", async () => {
    await approve(w.seedRequest({
      request_type: REQUEST_TYPE.REGULARIZATION, attendance_date: "2026-09-15",
      regularized_punch: { attendance_regularized_punch_id: 5002, punch_time: "2026-09-15 22:00:00" },
    }));
    await approve(w.seedRequest({ request_type: REQUEST_TYPE.OT, attendance_date: "2026-09-14", candidate_ot_minutes: 90 }));
    const days = [...w.store.days.values()].filter((d) => d.employee_id === 42);
    const verdict = evaluatePayrollReadiness({
      year: 2026, month: 9, snapshot: { monthly_gross: 26000, basic: 13000, date_of_joining: "2020-01-01" },
      monthly: w.monthOf(), day_rows: days, latest_closed_date: "2026-10-02",
    });
    assert.deepEqual(verdict.reasons.map((r) => r.code), []);
    assert.equal(verdict.attendance_ready, true);
  });

  it("without the refresh (the old behaviour) the same approval would have left Payroll ATTENDANCE_STALE", async () => {
    const id = w.seedRequest({ request_type: REQUEST_TYPE.OT, attendance_date: "2026-09-14", candidate_ot_minutes: 90 });
    const collector = []; // defer and never flush: what used to happen
    await w.regularization.decide({ actor: HR, request_id: id, decision: STEP_DECISION.APPROVED, now: NOW, month_refresh_collector: collector });
    const days = [...w.store.days.values()].filter((d) => d.employee_id === 42);
    const verdict = evaluatePayrollReadiness({
      year: 2026, month: 9, snapshot: { monthly_gross: 26000, basic: 13000, date_of_joining: "2020-01-01" },
      monthly: w.monthOf(), day_rows: days, latest_closed_date: "2026-10-02",
    });
    const codes = verdict.reasons.map((r) => r.code);
    assert.ok(codes.includes("ATTENDANCE_STALE"));
    assert.ok(codes.includes("APPROVED_OT_MISMATCH"));
  });
});

describe("COVERAGE GUARD: every day-row write is followed by a month refresh", () => {
  const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const WRITERS = /\.(saveCalculations|saveCalculationsWithReconciliation|saveDateShiftOverrideWithCalculation|decideStage|revokeRequest|createRequest|applyCorrection|revertCorrection|grant|revoke)\(/g;
  /** The usecase function each writer call sits in, and whether it refreshes. */
  const sites = (file) => {
    const code = strip(fs.readFileSync(path.join(__dirname, file), "utf8"));
    return [...code.matchAll(WRITERS)].map((m) => {
      const before = code.slice(0, m.index);
      const fnStart = before.lastIndexOf(" = async (");
      const nameStart = before.lastIndexOf("const ", fnStart);
      const name = before.slice(nameStart + 6, fnStart).trim();
      const end = code.indexOf("\n  };\n", m.index);
      const body = code.slice(m.index, end);
      return { file, name, writer: m[1], refreshes: /refresh(AffectedMonths|MonthsAfter|MonthAfter|PersistedMonth|MonthsFor|Month)\(/.test(body) };
    });
  };

  /*
   * EVERY CALL SITE, CLASSIFIED. A new writer call fails this test until it
   * is added here - with a refresh, or with the reason it needs none.
   */
  const NO_DAY_WRITE = {
    // A request raised without auto-approval writes no day row.
    "attendance_regularization.js:raiseOtRequest:createRequest": true,
    "attendance_regularization.js:raiseShiftChangeRequest:createRequest": true,
    "attendance_regularization.js:raisePermissionRequest:createRequest": true,
    // Automatic pending OT raises a PENDING request: no day row, nothing payable.
    "attendance_regularization.js:syncAutoOt:createRequest": true,
  };

  it("every site refreshes, or is listed as writing no day row", () => {
    const all = [
      ...sites("attendance_calculation.js"),
      ...sites("attendance_regularization.js"),
      ...sites("attendance_device_time_correction.js"),
      ...sites("attendance_permission.js"),
    ].filter((s) => !(s.file === "attendance_calculation.js" && s.name === "calculateMonth"));
    const missing = all.filter((s) => !s.refreshes && !NO_DAY_WRITE[`${s.file}:${s.name}:${s.writer}`]);
    assert.deepEqual(missing.map((s) => `${s.file}:${s.name}:${s.writer}`), []);
    // And the inventory itself is pinned, so nothing slips in unreviewed.
    assert.deepEqual(all.map((s) => `${s.file}:${s.name}:${s.writer}`).sort(), [
      "attendance_calculation.js:recalculateRange:saveCalculationsWithReconciliation",
      "attendance_calculation.js:setDateShift:saveCalculations",
      "attendance_calculation.js:setDateShift:saveDateShiftOverrideWithCalculation",
      "attendance_device_time_correction.js:apply:applyCorrection",
      "attendance_device_time_correction.js:revert:revertCorrection",
      "attendance_permission.js:record:grant",
      "attendance_permission.js:revoke:revoke",
      "attendance_regularization.js:decide:decideStage",
      "attendance_regularization.js:raiseOtRequest:createRequest",
      "attendance_regularization.js:raisePermissionRequest:createRequest",
      "attendance_regularization.js:raiseRequest:createRequest",
      "attendance_regularization.js:raiseShiftChangeRequest:createRequest",
      "attendance_regularization.js:revokeDecision:revokeRequest",
      "attendance_regularization.js:syncAutoOt:createRequest",
    ]);
  });
});
