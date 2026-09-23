/**
 * NO WRITER STORES AN ATTENDANCE DAY THAT HAS NOT CLOSED - including the four
 * decision paths that used to store the day in the same transaction as the
 * decision.
 *
 *   node --test usecase/attendance_open_day_decisions.test.js
 *
 * An `attendance_day_calculation` row written while the date's attendance day
 * is still open is a snapshot of a half-finished day; once the date closes,
 * every read returns it as history (the 22-Sep-2026 production case). The
 * general recalculation already obeys that. These are the paths that record a
 * BUSINESS DECISION about a date and used to freeze the day with it:
 *
 *   setDateShift              override saved; day row only once closed
 *   missing-punch regularization
 *     - auto-approve          refused until the day closes (nothing written)
 *     - approval required     may be raised and progressed while open; its
 *                             FINAL approval is refused until the day closes
 *   OT                        not requestable, not finally approvable, until
 *                             the day closes - FINAL + even punches is not
 *                             enough
 *   SHIFT_CHANGE              future/open requests still supported; final
 *                             approval commits approval + override with NO
 *                             day row; the date reads live under the approved
 *                             shift and is stored after it closes
 *
 * The fake database below is deliberately FAITHFUL where it matters: the
 * regularized-punch and override reads JOIN the request state exactly as the
 * SQL does, every multi-statement write runs in a transaction that is rolled
 * back on any throw, and the payroll lock gate is enforced on every write
 * that the real `FOR UPDATE` gate covers.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const buildCalculation = require("./attendance_calculation");
const buildRegularization = require("./attendance_regularization");
const { CALCULATION_SOURCE } = require("../utils/attendance_stored_read");
const { ADMIN_USER_TYPE, STEP_DECISION } = require("../utils/attendance_approval_chain");

const EMP = 1952;
const ADMIN = 1;
const DAY = 7; // 09:30-18:30, NRM 480, cutoff 04:00
const LONG = 9; // 08:00-20:00, NRM 660, cutoff 04:00 - "longer", so a shift change to it is allowed

const ist = (date, hh, mm = 0) =>
  Date.parse(`${date}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00+05:30`);

const weekly = (id, inTime, outTime, nrm) =>
  Array.from({ length: 7 }, (_, day) => ({
    work_shift_weekly_schedule_id: id * 10 + day,
    work_shift_id: id,
    day_of_week: day,
    is_working_day: 1,
    in_time: inTime,
    out_time: outTime,
    attendance_day_cutoff: "04:00:00",
    break_minutes: 60,
    normal_work_minutes: nrm,
    ot_rate: 1,
  }));
const shiftConfig = (id, code) => ({
  work_shift_id: id,
  shift_code: code,
  shift_name: code,
  active: 1,
  overtime_allowed: 1,
  overtime_minimum_minutes: 0,
  overtime_rounding_method: "NONE",
  overtime_rounding_interval_minutes: 0,
  overtime_minimum_threshold_only: 0,
  maximum_ot_minutes_per_day: null,
});
const SHIFTS = {
  [DAY]: { config: shiftConfig(DAY, "DAY"), schedule: weekly(DAY, "09:30:00", "18:30:00", 480) },
  [LONG]: { config: shiftConfig(LONG, "LONG"), schedule: weekly(LONG, "08:00:00", "20:00:00", 660) },
};

const punch = (id, ioTime) => ({
  punch_id: id,
  employee_id: EMP,
  io_time: ioTime,
  punch_date: ioTime.slice(0, 10),
  ingest_attendance_date: ioTime.slice(0, 10),
  dev_id: "BIOMAX1",
  ingest_source: "LIVE",
});

const clone = (value) => JSON.parse(JSON.stringify(value));
const monthOf = (date) => String(date).slice(0, 7);

/**
 * One in-memory "database" shared by both repositories, with transactions.
 */
function world({ rawPunches = [], policy = null, lockedMonths = [], startAt } = {}) {
  const db = {
    requests: [],
    steps: [],
    regularizedPunches: [],
    overrides: [],
    calculations: {}, // `${employee}|${date}` -> row
  };
  const raw = [...rawPunches];
  const locked = new Set(lockedMonths);
  const faults = { failAt: null, blindPrecheck: false };
  let nextId = 5000;

  /** BEGIN ... COMMIT, or ROLLBACK on any throw. */
  const tx = async (fn) => {
    const before = clone(db);
    try {
      return await fn();
    } catch (err) {
      Object.keys(before).forEach((k) => {
        db[k] = before[k];
      });
      throw err;
    }
  };
  const fault = (point) => {
    if (faults.failAt === point) throw new Error(`injected failure at ${point}`);
  };
  /** The `FOR UPDATE` payroll gate, as `assertMonthsNotPayrollLocked` applies it. */
  const lockGate = (rows) => {
    const hit = (rows || []).find((r) => locked.has(monthOf(r.attendance_date)));
    if (hit) {
      const err = new Error("Attendance cannot be changed because payroll for this month is approved and locked.");
      err.name = "ValidationError";
      err.code = "PAYROLL_MONTH_LOCKED";
      throw err;
    }
  };
  const writeRows = (rows) => {
    if (!rows || rows.length === 0) return { written: 0 };
    lockGate(rows);
    fault("calculations");
    rows.forEach((row) => {
      db.calculations[`${row.employee_id}|${row.attendance_date}`] = { ...row };
    });
    return { written: rows.length };
  };
  const requestById = (id) => db.requests.find((r) => r.attendance_approval_request_id === Number(id));
  const settledApproved = (r) => r && r.status === "APPROVED" && r.finalization_state === "SETTLED";

  const calcRepo = {
    getShiftAssignmentHistory: async () => [
      { employee_work_shift_assignment_id: 1, employee_id: EMP, work_shift_id: DAY, effective_from: "2026-01-01" },
    ],
    getWorkShiftWithSchedule: async (id) => SHIFTS[id] || null,
    getWorkShiftConfigVersions: async () => [],
    getRawPunchesByCalendarWindow: async (_e, from, to) =>
      raw.filter((p) => p.punch_date >= from && p.punch_date <= to),
    // THE JOIN the SQL makes: only a FINALLY APPROVED and SETTLED request's punch.
    getApprovedRegularizedPunches: async (_e, from, to) =>
      db.regularizedPunches
        .filter((p) => p.attendance_date >= from && p.attendance_date <= to)
        .filter((p) => settledApproved(requestById(p.attendance_approval_request_id)))
        .map((p) => ({ punch_id: p.id, attendance_date: p.attendance_date, io_time: p.punch_time })),
    getBreakOverride: async () => null,
    getApprovalStateByDate: async (_e, from, to) =>
      db.requests
        .filter((r) => r.attendance_date >= from && r.attendance_date <= to && r.status !== "CANCELLED")
        .map((r) => ({ ...r })),
    // THE JOIN the SQL makes for `shift_change_approved`.
    getDateShiftOverrides: async (_e, from, to) =>
      db.overrides
        .filter((o) => o.attendance_date >= from && o.attendance_date <= to)
        .map((o) => {
          const r = o.attendance_approval_request_id ? requestById(o.attendance_approval_request_id) : null;
          return {
            ...o,
            shift_change_approved: r && r.request_type === "SHIFT_CHANGE" && settledApproved(r) ? 1 : 0,
          };
        }),
    getEmploymentWindow: async (id) => ({
      employee_id: id,
      status: 1,
      attendance_required: 1,
      date_of_joining: "2020-01-01",
      resignation_date: null,
    }),
    getMonthlyGrossAsOf: async () => null,
    listCalculations: async ({ from_date, to_date }) =>
      Object.values(db.calculations).filter((r) => r.attendance_date >= from_date && r.attendance_date <= to_date),
    saveCalculations: async (rows) => tx(async () => writeRows(rows)),
    saveCalculationsWithReconciliation: async ({ rows }) =>
      tx(async () => ({ ...writeRows(rows), stale_removed: 0 })),
    saveDateShiftOverrideWithCalculation: async ({ override, rows }) =>
      tx(async () => {
        lockGate([override]);
        fault("override");
        const id = nextId++;
        db.overrides.push({ attendance_date_shift_override_id: id, ...override, attendance_approval_request_id: null });
        const stored = writeRows(rows);
        return { attendance_date_shift_override_id: id, ...stored };
      }),
    findPayrollLockedPeriods: async (rows) =>
      faults.blindPrecheck
        ? []
        : (rows || [])
            .filter((r) => locked.has(monthOf(r.attendance_date)))
            .map((r) => ({
              employee_id: Number(r.employee_id),
              year: Number(r.attendance_date.slice(0, 4)),
              month: Number(r.attendance_date.slice(5, 7)),
            })),
    listActiveWorkShiftOptions: async () =>
      Object.values(SHIFTS).map((s) => ({ work_shift_id: s.config.work_shift_id, shift_code: s.config.shift_code, shift_name: s.config.shift_name })),
  };

  const regRepo = {
    getApprovalIdentity: async (id) =>
      Number(id) === EMP
        ? { employee_id: EMP, employee_name: "Priyanga", outlet_id: 3, designation_id: 11, approver_role: null, requester_class: "HEAD" }
        : { employee_id: Number(id), employee_name: "Admin", outlet_id: 1, designation_id: 1, approver_role: null, requester_class: "HEAD" },
    findOpenRequest: async (_e, date) =>
      db.requests.find((r) => r.attendance_date === date && r.status === "PENDING") || null,
    getRegularizationPolicy: async () => policy,
    countRegularizationsInMonth: async () => 0,
    findRequestsForDates: async (_e, dates) =>
      db.requests.filter((r) => dates.includes(r.attendance_date) && r.status !== "CANCELLED"),
    createRequest: async ({ request, chain, punch: manual, auto_approve = null }) =>
      tx(async () => {
        const id = nextId++;
        const auto = Boolean(auto_approve);
        db.requests.push({
          attendance_approval_request_id: id,
          ...request,
          status: auto ? "APPROVED" : "PENDING",
          current_stage_no: 1,
          total_stages: chain.length,
          finalization_state: auto ? "SETTLED" : "NOT_REQUIRED",
          approved_ot_minutes: auto ? 0 : null,
          closure_reason: null,
        });
        chain.forEach((s) =>
          db.steps.push({
            attendance_approval_request_id: id,
            stage_no: s.stage_no,
            approver_role: s.approver_role,
            outlet_id: s.outlet_id,
            decision: auto ? "APPROVED" : "PENDING",
          })
        );
        if (manual) {
          db.regularizedPunches.push({
            id: nextId++,
            attendance_approval_request_id: id,
            attendance_date: request.attendance_date,
            punch_time: manual.punch_time,
          });
        }
        const stored = auto ? writeRows(auto_approve.calculations) : { written: 0 };
        return {
          attendance_approval_request_id: id,
          total_stages: chain.length,
          status: auto ? "APPROVED" : "PENDING",
          finalization_state: auto ? "SETTLED" : "NOT_REQUIRED",
          calculations_written: stored.written,
        };
      }),
    getRequest: async (id) => {
      const r = requestById(id);
      if (!r) return null;
      const p = db.regularizedPunches.find((x) => x.attendance_approval_request_id === r.attendance_approval_request_id);
      return {
        ...clone(r),
        steps: clone(db.steps.filter((s) => s.attendance_approval_request_id === r.attendance_approval_request_id)),
        regularized_punch: p ? { attendance_regularized_punch_id: p.id, punch_time: p.punch_time } : null,
      };
    },
    // `decideStage`, statement for statement, in one transaction.
    decideStage: async ({ requestId, stageNo, decision, next, calculations, shiftOverride, attendanceLock }) =>
      tx(async () => {
        const step = db.steps.find((s) => s.attendance_approval_request_id === requestId && s.stage_no === stageNo);
        if (!step || step.decision !== "PENDING") return { code: 409, msg: "decided already" };
        step.decision = decision;
        fault("step");
        const r = requestById(requestId);
        const finalization = next.status === "APPROVED" || next.status === "REJECTED" ? "SETTLED" : "NOT_REQUIRED";
        Object.assign(r, {
          status: next.status,
          current_stage_no: next.current_stage_no,
          approved_ot_minutes: next.approved_ot_minutes,
          finalization_state: finalization,
        });
        if (attendanceLock) lockGate([attendanceLock]);
        let overrideId = null;
        if (shiftOverride) {
          fault("override");
          overrideId = nextId++;
          db.overrides.push({
            attendance_date_shift_override_id: overrideId,
            ...shiftOverride,
            attendance_approval_request_id: requestId,
            source: "APPROVED_REQUEST",
          });
        }
        const stored = writeRows(calculations || []);
        return {
          code: 200,
          status: next.status,
          current_stage_no: next.current_stage_no,
          finalization_state: finalization,
          calculations_written: stored.written,
          attendance_date_shift_override_id: overrideId,
        };
      }),
  };

  const clock = { now: startAt };
  const calculation = buildCalculation(calcRepo, { now: () => clock.now });
  const regularization = buildRegularization(regRepo, calculation);
  calculation.setOtRequestService(regularization);

  const read = async (date) =>
    (await calculation.readRange({ employee_id: EMP, from_date: date, to_date: date, now: clock.now }))[0];
  const row = (date) => db.calculations[`${EMP}|${date}`] || null;

  return { db, raw, clock, faults, locked, calculation, regularization, read, row };
}

const ADMIN_ACTOR = { employee_id: ADMIN, user_type: ADMIN_USER_TYPE };
const EMPLOYEE_ACTOR = { employee_id: EMP, user_type: 1 };
const approve = (w, id) =>
  w.regularization.decide({ actor: ADMIN_ACTOR, request_id: id, decision: STEP_DECISION.APPROVED });

/* ================================================================= A */

describe("A. setDateShift on an OPEN date", () => {
  const today = "2026-09-22";

  it("saves the override, writes NO day row, reads LIVE_PREVIEW under the new shift; after close + recalc it is STORED", async () => {
    const w = world({ rawPunches: [punch(1, `${today} 08:05:00`)], startAt: ist(today, 12) });

    const result = await w.calculation.setDateShift({
      employee_id: EMP,
      attendance_date: today,
      work_shift_id: LONG,
      actor_employee_id: ADMIN,
    });
    assert.equal(result.changed, true);
    assert.equal(w.db.overrides.length, 1, "the override - the decision - is saved");
    assert.equal(w.db.overrides[0].work_shift_id, LONG);
    assert.equal(w.row(today), null, "no attendance_day_calculation row for the open date");
    assert.equal(result.attendance_persisted, false);
    assert.deepEqual(result.attendance_deferred, { reason: "DAY_OPEN", closes_at: "2026-09-23 04:00" });

    const live = await w.read(today);
    assert.equal(live.calculation_source, CALCULATION_SOURCE.LIVE_PREVIEW);
    assert.equal(live.work_shift_id, LONG, "the open day already resolves the new shift");

    w.raw.push(punch(2, `${today} 20:00:00`));
    w.clock.now = ist("2026-09-23", 4, 0);
    await w.calculation.recalculateRange({ employee_id: EMP, from_date: today, to_date: today });
    const stored = await w.read(today);
    assert.equal(stored.calculation_source, CALCULATION_SOURCE.STORED);
    assert.equal(stored.work_shift_id, LONG);
    assert.equal(stored.punch_count, 2, "with the punch that arrived after the edit");
  });

  it("a FUTURE date is allowed too (the screen offers it): override only, reason FUTURE_DATE", async () => {
    const w = world({ startAt: ist(today, 12) });
    const result = await w.calculation.setDateShift({
      employee_id: EMP,
      attendance_date: "2026-09-25",
      work_shift_id: LONG,
      actor_employee_id: ADMIN,
    });
    assert.equal(w.db.overrides.length, 1);
    assert.equal(w.row("2026-09-25"), null);
    assert.equal(result.attendance_deferred.reason, "FUTURE_DATE");
  });

  it("a CLOSED date is unchanged: override and day row in one commit", async () => {
    const w = world({ rawPunches: [punch(1, "2026-09-20 08:00:00"), punch(2, "2026-09-20 20:00:00")], startAt: ist(today, 12) });
    const result = await w.calculation.setDateShift({
      employee_id: EMP,
      attendance_date: "2026-09-20",
      work_shift_id: LONG,
      actor_employee_id: ADMIN,
    });
    assert.equal(result.attendance_persisted, true);
    assert.equal(w.db.overrides.length, 1);
    assert.equal(w.row("2026-09-20").work_shift_id, LONG);
  });
});

/* ================================================================= B */

describe("B. an AUTO-APPROVED missing-punch regularization on an open day", () => {
  const today = "2026-09-22";
  const noApproval = { regularization_allowed: 1, regularization_requires_approval: 0 };

  it("is refused with ATTENDANCE_DAY_OPEN and writes nothing - no request, no punch, no day row", async () => {
    const w = world({ rawPunches: [punch(1, `${today} 09:38:00`)], policy: noApproval, startAt: ist(today, 12) });
    await assert.rejects(
      w.regularization.raiseRequest({
        actor: EMPLOYEE_ACTOR,
        requested_for_employee_id: EMP,
        attendance_date: today,
        reason: "Forgot to punch out",
        punch_time: `${today} 18:30:00`,
      }),
      (err) => err.code === "ATTENDANCE_DAY_OPEN" && err.name === "ValidationError" && /closes at 2026-09-23 04:00/.test(err.message)
    );
    assert.equal(w.db.requests.length, 0);
    assert.equal(w.db.regularizedPunches.length, 0);
    assert.equal(w.row(today), null);
    assert.equal((await w.read(today)).calculation_source, CALCULATION_SOURCE.LIVE_PREVIEW, "the day still reads live");
  });

  it("the same request after the day closes is auto-approved and stored, as before", async () => {
    const w = world({ rawPunches: [punch(1, `${today} 09:38:00`)], policy: noApproval, startAt: ist("2026-09-23", 4, 0) });
    const created = await w.regularization.raiseRequest({
      actor: EMPLOYEE_ACTOR,
      requested_for_employee_id: EMP,
      attendance_date: today,
      reason: "Forgot to punch out",
      punch_time: `${today} 18:30:00`,
    });
    assert.equal(created.auto_approved, true);
    assert.equal(w.db.requests[0].status, "APPROVED");
    assert.equal(w.db.requests[0].finalization_state, "SETTLED");
    assert.equal(w.row(today).punch_count, 2, "request, punch and corrected day committed together");
  });
});

describe("B/E. a regularization that NEEDS approval", () => {
  const today = "2026-09-22";
  const withApproval = { regularization_allowed: 1, regularization_requires_approval: 1 };

  it("may be raised on an open day, but its FINAL approval waits for the close; then decision + day commit together", async () => {
    const w = world({ rawPunches: [punch(1, `${today} 09:38:00`)], policy: withApproval, startAt: ist(today, 12) });
    const created = await w.regularization.raiseRequest({
      actor: EMPLOYEE_ACTOR,
      requested_for_employee_id: EMP,
      attendance_date: today,
      reason: "Forgot to punch out",
      punch_time: `${today} 18:30:00`,
    });
    assert.equal(created.status, "PENDING");

    await assert.rejects(approve(w, created.attendance_approval_request_id), (err) => err.code === "ATTENDANCE_DAY_OPEN");
    assert.equal(w.db.requests[0].status, "PENDING", "the request stays pending");
    assert.equal(w.db.steps[0].decision, "PENDING");
    assert.equal(w.row(today), null);

    // E. After the close: approval and the corrected day, one commit.
    w.clock.now = ist("2026-09-23", 9, 0);
    const decided = await approve(w, created.attendance_approval_request_id);
    assert.equal(decided.status, "APPROVED");
    assert.equal(decided.attendance_persisted, true);
    assert.equal(w.db.requests[0].finalization_state, "SETTLED");
    assert.equal(w.row(today).punch_count, 2);
    assert.equal((await w.read(today)).calculation_source, CALCULATION_SOURCE.STORED);
  });

  it("E. closed-date approval is atomic: a failure storing the day rolls the approval back", async () => {
    const w = world({ rawPunches: [punch(1, "2026-09-20 09:38:00")], policy: withApproval, startAt: ist(today, 12) });
    const created = await w.regularization.raiseRequest({
      actor: EMPLOYEE_ACTOR,
      requested_for_employee_id: EMP,
      attendance_date: "2026-09-20",
      reason: "Forgot to punch out",
      punch_time: "2026-09-20 18:30:00",
    });
    w.faults.failAt = "calculations";
    await assert.rejects(approve(w, created.attendance_approval_request_id), /injected failure at calculations/);
    assert.equal(w.db.requests[0].status, "PENDING");
    assert.equal(w.db.steps[0].decision, "PENDING");
    assert.equal(w.row("2026-09-20"), null);
  });

  it("a REJECTION on an open day is recorded, with no day row", async () => {
    const w = world({ rawPunches: [punch(1, `${today} 09:38:00`)], policy: withApproval, startAt: ist(today, 12) });
    const created = await w.regularization.raiseRequest({
      actor: EMPLOYEE_ACTOR,
      requested_for_employee_id: EMP,
      attendance_date: today,
      reason: "Forgot to punch out",
      punch_time: `${today} 18:30:00`,
    });
    const decided = await w.regularization.decide({
      actor: ADMIN_ACTOR,
      request_id: created.attendance_approval_request_id,
      decision: STEP_DECISION.REJECTED,
      remarks: "Not supported by CCTV",
    });
    assert.equal(decided.status, "REJECTED");
    assert.equal(decided.attendance_persisted, false);
    assert.equal(w.row(today), null);
  });
});

/* ================================================================= C / F */

describe("C/F. OT", () => {
  const today = "2026-09-22";
  // 09:30-20:30 on a 09:30-18:30 shift: an even, FINAL day with 120 minutes of candidate OT.
  const otDay = (date) => [punch(1, `${date} 09:30:00`), punch(2, `${date} 20:30:00`)];

  it("C. a same-day, FINAL, even-punch day before its cutoff: OT cannot be requested", async () => {
    const w = world({ rawPunches: otDay(today), startAt: ist(today, 21, 0) });
    const [live] = await w.calculation.calculateRange({ employee_id: EMP, from_date: today, to_date: today });
    assert.equal(live.status, "FINAL", "it LOOKS finished");
    assert.ok(live.candidate_ot_minutes > 0);

    await assert.rejects(
      w.regularization.raiseOtRequest({ actor: EMPLOYEE_ACTOR, attendance_date: today, reason: "Stock count ran late" }),
      (err) => err.code === "ATTENDANCE_DAY_OPEN"
    );
    assert.equal(w.db.requests.length, 0);
    assert.equal(w.row(today), null);
  });

  it("C. an OT request that already exists (raised before this rule) cannot be FINALLY approved while the day is open", async () => {
    const w = world({ rawPunches: otDay(today), startAt: ist(today, 21, 0) });
    w.db.requests.push({
      attendance_approval_request_id: 77,
      request_type: "OT",
      requested_for_employee_id: EMP,
      requested_by_employee_id: EMP,
      attendance_date: today,
      outlet_id: 3,
      requester_class: "HEAD",
      reason: "Stock count ran late",
      candidate_ot_minutes: 120,
      status: "PENDING",
      current_stage_no: 1,
      total_stages: 1,
      finalization_state: "NOT_REQUIRED",
      approved_ot_minutes: null,
    });
    w.db.steps.push({ attendance_approval_request_id: 77, stage_no: 1, approver_role: "ADMIN", outlet_id: null, decision: "PENDING" });

    await assert.rejects(approve(w, 77), (err) => err.code === "ATTENDANCE_DAY_OPEN" && /Overtime can be finally approved once the day has closed/.test(err.message));
    assert.equal(w.db.requests[0].status, "PENDING");
    assert.equal(w.row(today), null);

    // After the cutoff it settles exactly as before.
    w.clock.now = ist("2026-09-23", 4, 0);
    const decided = await approve(w, 77);
    assert.equal(decided.status, "APPROVED");
    assert.equal(decided.approved_ot_minutes, 120);
    assert.equal(w.row(today).approved_ot_minutes, 120);
  });

  it("F. closed-date OT is unchanged: requested, approved, and stored with the decision", async () => {
    const w = world({ rawPunches: otDay("2026-09-20"), startAt: ist(today, 12) });
    const created = await w.regularization.raiseOtRequest({
      actor: EMPLOYEE_ACTOR,
      attendance_date: "2026-09-20",
      reason: "Stock count ran late",
    });
    assert.equal(created.candidate_ot_minutes, 120);
    const decided = await approve(w, created.attendance_approval_request_id);
    assert.equal(decided.attendance_persisted, true);
    assert.equal(w.row("2026-09-20").approved_ot_minutes, 120);
    assert.equal(w.db.requests[0].finalization_state, "SETTLED");
  });
});

/* ================================================================= D / G */

describe("D/G. one-day SHIFT_CHANGE", () => {
  const raise = (w, date, today) =>
    w.regularization.raiseShiftChangeRequest({
      actor: EMPLOYEE_ACTOR,
      attendance_date: date,
      work_shift_id: LONG,
      reason: "Covering the evening delivery",
      today,
    });

  it("D. a FUTURE request: raised as before; final approval stores decision + override, NO day row; live on the day; stored after close", async () => {
    const w = world({ startAt: ist("2026-09-21", 12) });
    const created = await raise(w, "2026-09-23", "2026-09-21");
    assert.equal(w.db.requests[0].status, "PENDING", "future shift-change requests are still supported");

    const decided = await approve(w, created.attendance_approval_request_id);
    assert.equal(decided.code, 200);
    assert.equal(decided.status, "APPROVED");
    assert.equal(decided.attendance_persisted, false);
    assert.equal(decided.attendance_deferred.reason, "FUTURE_DATE");
    assert.equal(w.db.requests[0].finalization_state, "SETTLED", "the DECISION is final");
    assert.equal(w.db.overrides.length, 1);
    assert.equal(w.db.overrides[0].attendance_approval_request_id, created.attendance_approval_request_id, "audit link kept");
    assert.equal(w.row("2026-09-23"), null, "no attendance_day_calculation for the future date");

    // The date arrives; punches come in; it is open.
    w.clock.now = ist("2026-09-23", 21, 0);
    w.raw.push(punch(1, "2026-09-23 08:00:00"), punch(2, "2026-09-23 20:45:00"));
    const live = await w.read("2026-09-23");
    assert.equal(live.calculation_source, CALCULATION_SOURCE.LIVE_PREVIEW);
    assert.equal(live.work_shift_id, LONG, "the approved shift");
    assert.ok(live.shift_authorised_ot_minutes >= 0);

    // An ordinary recalculation while it is still open stores nothing ...
    await w.calculation.recalculateRange({ employee_id: EMP, from_date: "2026-09-23", to_date: "2026-09-23" });
    assert.equal(w.row("2026-09-23"), null);

    // ... and after the cutoff it stores the day under the approved shift.
    w.clock.now = ist("2026-09-24", 4, 0);
    await w.calculation.recalculateRange({ employee_id: EMP, from_date: "2026-09-23", to_date: "2026-09-23" });
    const stored = await w.read("2026-09-23");
    assert.equal(stored.calculation_source, CALCULATION_SOURCE.STORED);
    assert.equal(stored.work_shift_id, LONG);
    assert.equal(stored.punch_count, 2);
  });

  it("G. a CLOSED date is unchanged: approval, override and the day row commit together", async () => {
    const w = world({
      rawPunches: [punch(1, "2026-09-20 08:00:00"), punch(2, "2026-09-20 20:00:00")],
      startAt: ist("2026-09-22", 12),
    });
    const created = await raise(w, "2026-09-20", "2026-09-22");
    const decided = await approve(w, created.attendance_approval_request_id);
    assert.equal(decided.attendance_persisted, true);
    assert.equal(w.db.overrides.length, 1);
    assert.equal(w.row("2026-09-20").work_shift_id, LONG);
  });
});

/* ================================================================= H */

describe("H. the payroll lock is unchanged", () => {
  it("setDateShift on an open date in a locked month is refused - the override is gated on its own", async () => {
    const w = world({ lockedMonths: ["2026-09"], startAt: ist("2026-09-22", 12) });
    await assert.rejects(
      w.calculation.setDateShift({ employee_id: EMP, attendance_date: "2026-09-22", work_shift_id: LONG, actor_employee_id: ADMIN }),
      (err) => err.code === "PAYROLL_MONTH_LOCKED"
    );
    assert.equal(w.db.overrides.length, 0);
  });

  it("an approval in a locked month is refused before anything is written", async () => {
    const w = world({ startAt: ist("2026-09-21", 12) });
    const created = await w.regularization.raiseShiftChangeRequest({
      actor: EMPLOYEE_ACTOR,
      attendance_date: "2026-09-23",
      work_shift_id: LONG,
      reason: "Covering the evening delivery",
      today: "2026-09-21",
    });
    w.locked.add("2026-09");
    await assert.rejects(approve(w, created.attendance_approval_request_id), (err) => err.code === "PAYROLL_MONTH_LOCKED");
    assert.equal(w.db.requests[0].status, "PENDING");
    assert.equal(w.db.overrides.length, 0);
  });

  it("a lock that lands after the pre-check is still refused INSIDE the transaction for a deferred (open-date) approval", async () => {
    const w = world({ startAt: ist("2026-09-21", 12) });
    const created = await w.regularization.raiseShiftChangeRequest({
      actor: EMPLOYEE_ACTOR,
      attendance_date: "2026-09-23",
      work_shift_id: LONG,
      reason: "Covering the evening delivery",
      today: "2026-09-21",
    });
    w.locked.add("2026-09");
    w.faults.blindPrecheck = true; // the race: the pre-check saw no lock
    await assert.rejects(approve(w, created.attendance_approval_request_id), (err) => err.code === "PAYROLL_MONTH_LOCKED");
    assert.equal(w.db.requests[0].status, "PENDING", "rolled back");
    assert.equal(w.db.steps[0].decision, "PENDING");
    assert.equal(w.db.overrides.length, 0);
  });
});

/* ================================================================= I */

describe("I. failure atomicity, and deferral as a defined success", () => {
  it("a failure writing the override rolls back the whole SHIFT_CHANGE approval", async () => {
    const w = world({ startAt: ist("2026-09-21", 12) });
    const created = await w.regularization.raiseShiftChangeRequest({
      actor: EMPLOYEE_ACTOR,
      attendance_date: "2026-09-23",
      work_shift_id: LONG,
      reason: "Covering the evening delivery",
      today: "2026-09-21",
    });
    w.faults.failAt = "override";
    await assert.rejects(approve(w, created.attendance_approval_request_id), /injected failure at override/);
    assert.equal(w.db.requests[0].status, "PENDING", "no approval without its override");
    assert.equal(w.db.requests[0].finalization_state, "NOT_REQUIRED");
    assert.equal(w.db.steps[0].decision, "PENDING");
    assert.equal(w.db.overrides.length, 0, "no override without its approval");

    // Retried once the fault clears: the complete deferred state.
    w.faults.failAt = null;
    const decided = await approve(w, created.attendance_approval_request_id);
    assert.equal(decided.code, 200);
    assert.equal(decided.attendance_persisted, false, "deferral is a successful, defined outcome - not a partial one");
    assert.equal(w.db.requests[0].status, "APPROVED");
    assert.equal(w.db.overrides.length, 1);
  });

  it("a failure writing a setDateShift override leaves nothing behind", async () => {
    const w = world({ startAt: ist("2026-09-22", 12) });
    w.faults.failAt = "override";
    await assert.rejects(
      w.calculation.setDateShift({ employee_id: EMP, attendance_date: "2026-09-22", work_shift_id: LONG, actor_employee_id: ADMIN }),
      /injected failure at override/
    );
    assert.equal(w.db.overrides.length, 0);
    assert.equal(w.row("2026-09-22"), null);
  });
});
