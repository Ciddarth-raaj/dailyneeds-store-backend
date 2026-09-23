/**
 * THE DAILY 06:50 AUTOMATIC ATTENDANCE RECALCULATION, and the 07:00 Missing
 * Attendance Telegram that must run after it.
 *
 *   node --test usecase/attendance_daily_recalculation.test.js
 *
 * The job is orchestration over `recalculateBulk`, so the calculation tests
 * below run the REAL attendance calculation usecase over a fake repository
 * that keeps a real store of rows and mirrors the payroll lock gate - the
 * closed-date guard, the lock and the late-punch repair are observed, not
 * asserted about call arguments.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const createDailyRecalculation = require("./attendance_daily_recalculation");
const { dailyRecalculationWindow, monthSegments, LOG_TYPE } = createDailyRecalculation;
const buildCalculation = require("./attendance_calculation");
const { CALCULATION_SOURCE } = require("../utils/attendance_stored_read");

const ROOT = path.join(__dirname, "..");

/** An IST instant as epoch millis. */
const ist = (date, hh, mm = 0) =>
  Date.parse(`${date}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00+05:30`);

const DAY = 7; // 09:30-18:30, cutoff 04:00 next morning
const OVERNIGHT = 8; // 22:00-07:00, cutoff 09:00 next morning - still OPEN at 06:50
const weekly = (id, inTime, outTime, cutoff) =>
  Array.from({ length: 7 }, (_, d) => ({
    work_shift_weekly_schedule_id: id * 10 + d,
    work_shift_id: id,
    day_of_week: d,
    is_working_day: 1,
    in_time: inTime,
    out_time: outTime,
    attendance_day_cutoff: cutoff,
    break_minutes: 60,
    normal_work_minutes: 480,
    ot_rate: 1,
  }));
const SHIFTS = {
  [DAY]: weekly(DAY, "09:30:00", "18:30:00", "04:00:00"),
  [OVERNIGHT]: weekly(OVERNIGHT, "22:00:00", "07:00:00", "09:00:00"),
};

const punch = (id, employee_id, ioTime) => ({
  punch_id: id,
  employee_id,
  io_time: ioTime,
  punch_date: ioTime.slice(0, 10),
  ingest_attendance_date: ioTime.slice(0, 10),
  dev_id: "BIOMAX1",
  ingest_source: "LIVE",
});

/**
 * A company: `employees` is `{ id: workShiftId }`. Stores rows, mirrors the
 * payroll lock gate (per employee-month) and records whether any
 * `attendance_recalculation_run` row was written.
 */
function company({ employees = { 1952: DAY }, rawPunches = [], lockedMonths = [], stored = [] } = {}) {
  const store = new Map(stored.map((r) => [`${r.employee_id}|${r.attendance_date}`, { ...r }]));
  const raw = [...rawPunches];
  const locked = new Set(lockedMonths);
  const runRows = [];
  const lockGate = (rows) => {
    if ((rows || []).some((r) => locked.has(String(r.attendance_date).slice(0, 7)))) {
      const err = new Error("Attendance cannot be changed because payroll for this month is approved and locked.");
      err.name = "ValidationError";
      err.code = "PAYROLL_MONTH_LOCKED";
      throw err;
    }
  };
  const repo = {
    getShiftAssignmentHistory: async (id) => [
      { employee_work_shift_assignment_id: Number(id), employee_id: Number(id), work_shift_id: employees[id], effective_from: "2026-01-01" },
    ],
    getWorkShiftWithSchedule: async (id) => ({
      config: {
        work_shift_id: id, shift_code: `S${id}`, shift_name: `S${id}`, active: 1, overtime_allowed: 1,
        overtime_minimum_minutes: 0, overtime_rounding_method: "NONE", overtime_rounding_interval_minutes: 0,
        overtime_minimum_threshold_only: 0, maximum_ot_minutes_per_day: null,
      },
      schedule: SHIFTS[id],
    }),
    getWorkShiftConfigVersions: async () => [],
    getRawPunchesByCalendarWindow: async (id, from, to) =>
      raw.filter((p) => p.employee_id === Number(id) && p.punch_date >= from && p.punch_date <= to),
    getApprovedRegularizedPunches: async () => [],
    getBreakOverride: async () => null,
    getApprovalStateByDate: async () => [],
    getDateShiftOverrides: async () => [],
    getEmploymentWindow: async (id) => ({
      employee_id: Number(id), status: 1, attendance_required: 1, date_of_joining: "2020-01-01", resignation_date: null,
    }),
    getMonthlyGrossAsOf: async () => null,
    listCalculations: async ({ employee_id, from_date, to_date }) =>
      [...store.values()].filter(
        (r) => r.employee_id === Number(employee_id) && r.attendance_date >= from_date && r.attendance_date <= to_date
      ),
    saveCalculationsWithReconciliation: async ({ rows }) => {
      lockGate(rows);
      rows.forEach((r) => store.set(`${r.employee_id}|${r.attendance_date}`, { ...r }));
      return { written: rows.length, stale_removed: 0 };
    },
    findPayrollLockedPeriods: async (rows) =>
      (rows || [])
        .filter((r) => locked.has(String(r.attendance_date).slice(0, 7)))
        .map((r) => ({ employee_id: r.employee_id, year: Number(r.attendance_date.slice(0, 4)), month: Number(r.attendance_date.slice(5, 7)) })),
    listEmployeesForRecalculation: async () =>
      Object.keys(employees).map((id) => ({
        employee_id: Number(id), employee_name: `E${id}`, status: 1, attendance_required: 1,
        date_of_joining: "2020-01-01", resignation_date: null,
      })),
    insertRecalculationRun: async (run) => {
      runRows.push(run);
      return runRows.length;
    },
    finishRecalculationRun: async () => {},
  };
  return { repo, store, raw, runRows, row: (id, date) => store.get(`${id}|${date}`) || null };
}

/** The job, with its clock pinned, its audit and its error log captured. */
function job(calculation, startAt) {
  const audit = [];
  const errors = [];
  const lines = [];
  const clock = { now: startAt };
  const daily = createDailyRecalculation({
    calculation,
    apiSyncLogger: { write: async (entry) => audit.push(entry) },
    logger: { LEVEL: { ERROR: "error" }, Log: (entry) => errors.push(entry) },
    now: () => clock.now,
    console: { log: (line) => lines.push(line) },
  });
  return { daily, audit, errors, lines, clock };
}

/* ======================================================== A / B schedules */

describe("A/B. the schedules, in Asia/Kolkata, in the required order", () => {
  const server = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
  const code = server.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("A. the daily recalculation is registered at 06:50", () => {
    assert.match(code, /register\(\s*"attendance_daily_recalculation",\s*"50 6 \* \* \*"/);
    assert.match(code, /this\.attendanceDailyRecalculation\.run\(\)/);
  });

  it("B. the Missing Attendance Telegram is registered at 07:00, not 06:00", () => {
    assert.match(code, /register\(\s*"attendance_missing_telegram",\s*"0 7 \* \* \*"/);
    assert.doesNotMatch(code, /register\(\s*"attendance_missing_telegram",\s*"0 6 \* \* \*"/);
  });

  it("both run in Asia/Kolkata - the zone every in-process cron is scheduled in", async () => {
    const CronService = require("../services/cron_service");
    assert.equal(CronService.CRON_TIMEZONE, "Asia/Kolkata");

    const nodeCron = require("node-cron");
    const original = nodeCron.schedule;
    const scheduled = [];
    nodeCron.schedule = (expr, fn, opts) => {
      scheduled.push({ expr, fn, opts });
      return { stop() {} };
    };
    const log = console.log;
    console.log = () => {};
    try {
      const service = new CronService();
      service.register("attendance_daily_recalculation", "50 6 * * *", async () => {});
      service.register("attendance_missing_telegram", "0 7 * * *", async () => {});
      service.start();
    } finally {
      nodeCron.schedule = original;
      console.log = log;
    }
    assert.deepEqual(
      scheduled.map((s) => [s.expr, s.opts.timezone]),
      [
        ["50 6 * * *", "Asia/Kolkata"],
        ["0 7 * * *", "Asia/Kolkata"],
      ]
    );
  });

  it("the morning order is 06:45 DigiSME recovery < 06:50 recalculation < 07:00 Telegram", () => {
    // Read from the REAL registrations, so moving any one of the three out of
    // order fails here.
    const scheduleOf = (name) => {
      const m = new RegExp(`register\\(\\s*"${name}",\\s*"([^"]+)"`).exec(code);
      assert.ok(m, `${name} is registered`);
      return m[1];
    };
    // The earliest firing at or after 06:00, in minutes past midnight.
    const morningMinute = (expr) => {
      const [minute, hours] = expr.split(" ");
      const hour = hours.split(",").map(Number).filter((h) => h >= 6).sort((a, b) => a - b)[0];
      return hour * 60 + Number(minute);
    };
    const recovery = morningMinute(scheduleOf("digisme_attendance_recovery"));
    const recalculation = morningMinute(scheduleOf("attendance_daily_recalculation"));
    const telegram = morningMinute(scheduleOf("attendance_missing_telegram"));
    assert.deepEqual([recovery, recalculation, telegram], [6 * 60 + 45, 6 * 60 + 50, 7 * 60]);
    assert.ok(recovery < recalculation && recalculation < telegram);
  });
});

/* ================================================================ C */

describe("C. the rolling window is today-3 through yesterday", () => {
  it("on 2026-09-24 it is 2026-09-21 .. 2026-09-23", () => {
    assert.deepEqual(dailyRecalculationWindow("2026-09-24"), { from_date: "2026-09-21", to_date: "2026-09-23" });
  });

  it("the 06:50 run on 2026-09-24 asks recalculateBulk for exactly that range, as a SYSTEM run", async () => {
    const calls = [];
    const fake = {
      recalculateBulk: async (args) => {
        calls.push(args);
        return { status: "COMPLETED", errors: [], employees_targeted: 219, attendance_days_processed: 657 };
      },
    };
    const { daily, audit } = job(fake, ist("2026-09-24", 6, 50));
    const summary = await daily.run();
    assert.deepEqual(
      calls.map(({ from_date, to_date, actor_employee_id, record_run, now }) => ({ from_date, to_date, actor_employee_id, record_run, now })),
      [{ from_date: "2026-09-21", to_date: "2026-09-23", actor_employee_id: null, record_run: false, now: ist("2026-09-24", 6, 50) }]
    );
    assert.equal(summary.trigger, "DAILY_AUTO");
    assert.equal(summary.status, "COMPLETED");
    assert.equal(audit.length, 1);
    assert.equal(audit[0].log_type, LOG_TYPE);
    assert.equal(audit[0].source, "cron");
    assert.equal(audit[0].employee_id, null, "nobody is named as having requested it");
    assert.equal(audit[0].status, "success");
    assert.equal(audit[0].metadata_json.from_date, "2026-09-21");
  });

  it("its api_sync_log rows have a label on the API Sync Log screen", () => {
    const { TYPE_BY_LOG_TYPE } = require("../constants/api_sync_types");
    assert.equal(TYPE_BY_LOG_TYPE[LOG_TYPE].label, "Daily Attendance Recalculation");
  });

  it("a window across a month end is split per calendar month", () => {
    assert.deepEqual(monthSegments("2026-09-29", "2026-10-01"), [
      { from_date: "2026-09-29", to_date: "2026-09-30" },
      { from_date: "2026-10-01", to_date: "2026-10-01" },
    ]);
  });

  it("writes NO attendance_recalculation_run row - it is not a manual run", async () => {
    const c = company({ rawPunches: [punch(1, 1952, "2026-09-22 09:30:00"), punch(2, 1952, "2026-09-22 18:30:00")] });
    const { daily } = job(buildCalculation(c.repo), ist("2026-09-24", 6, 50));
    await daily.run();
    assert.equal(c.runRows.length, 0);
  });
});

/* ================================================================ D / E */

describe("D/E. the closed-date guard stays authoritative", () => {
  it("D. yesterday still open under an overnight cutoff (09:00) is skipped at 06:50; E. closed dates are stored", async () => {
    const c = company({
      employees: { 1952: DAY, 2001: OVERNIGHT },
      rawPunches: [
        punch(1, 1952, "2026-09-23 09:30:00"), punch(2, 1952, "2026-09-23 18:30:00"),
        punch(3, 2001, "2026-09-23 22:00:00"), punch(4, 2001, "2026-09-24 06:30:00"),
      ],
    });
    const { daily } = job(buildCalculation(c.repo), ist("2026-09-24", 6, 50));
    const summary = await daily.run();

    assert.ok(c.row(1952, "2026-09-23"), "E. the day shift's 23rd closed at 04:00 and is stored");
    assert.ok(c.row(1952, "2026-09-21") && c.row(1952, "2026-09-22"), "E. and the older closed dates");
    assert.equal(c.row(2001, "2026-09-23"), null, "D. the overnight 23rd closes at 09:00 on the 24th - not stored");
    assert.ok(c.row(2001, "2026-09-22"), "D. its earlier, closed dates are");
    assert.equal(summary.attendance_days_skipped_open, 1);
    assert.deepEqual(summary.open_dates_skipped, ["2026-09-23"]);
    assert.equal(summary.status, "COMPLETED", "an open date is a skip, not an error");

    // The next morning's window still contains the 23rd, and it has closed.
    const next = job(buildCalculation(c.repo), ist("2026-09-25", 6, 50));
    await next.daily.run();
    assert.equal(c.row(2001, "2026-09-23").punch_count, 2, "picked up by the following run");
  });
});

/* ================================================================ F */

describe("F. payroll-locked dates remain unchanged", () => {
  it("a locked September is untouched; the open October date beside it is still stored", async () => {
    const settled = { employee_id: 1952, attendance_date: "2026-09-30", punch_count: 2, marker: "as paid" };
    const c = company({
      lockedMonths: ["2026-09"],
      stored: [settled],
      rawPunches: [
        punch(1, 1952, "2026-09-30 09:30:00"), punch(2, 1952, "2026-09-30 18:30:00"), punch(3, 1952, "2026-09-30 20:00:00"),
        punch(4, 1952, "2026-10-01 09:30:00"), punch(5, 1952, "2026-10-01 18:30:00"),
      ],
    });
    const { daily, audit } = job(buildCalculation(c.repo), ist("2026-10-02", 6, 50));
    const summary = await daily.run();

    assert.deepEqual(c.row(1952, "2026-09-30"), settled, "the locked row is exactly as it was");
    assert.equal(c.row(1952, "2026-09-29"), null, "and nothing new is written into the locked month");
    assert.ok(c.row(1952, "2026-10-01"), "the open month's date is not blocked by the lock");
    assert.equal(summary.employee_months_skipped_locked, 1);
    assert.equal(summary.status, "COMPLETED", "a lock refusal is the lock working, not a failure");
    assert.equal(audit[0].status, "success");
  });
});

/* ================================================================ G */

describe("G. a late punch for 22-Sep is repaired by the next morning's run", () => {
  it("22-Sep stored with 3 punches on the 23rd; a 4th arrives; the 24th's run (21..23) stores 4", async () => {
    const D = "2026-09-22";
    const c = company({
      rawPunches: [punch(12112, 1952, `${D} 09:38:25`), punch(12198, 1952, `${D} 14:02:27`), punch(12535, 1952, `${D} 15:09:02`)],
    });
    const calculation = buildCalculation(c.repo);

    await job(calculation, ist("2026-09-23", 6, 50)).daily.run(); // window 20..22
    assert.equal(c.row(1952, D).punch_count, 3, "first stored calculation");

    c.raw.push(punch(12592, 1952, `${D} 18:32:17`)); // the delayed LIVE punch
    const [stale] = await calculation.readRange({ employee_id: 1952, from_date: D, to_date: D, now: ist("2026-09-23", 12) });
    assert.equal(stale.punch_count, 3, "until the next run the stored row still wins (known, accepted window)");

    await job(calculation, ist("2026-09-24", 6, 50)).daily.run(); // window 21..23
    assert.equal(c.row(1952, D).punch_count, 4);
    const [read] = await calculation.readRange({ employee_id: 1952, from_date: D, to_date: D, now: ist("2026-09-24", 7) });
    assert.equal(read.calculation_source, CALCULATION_SOURCE.STORED);
    assert.equal(read.punch_count, 4);
    assert.deepEqual(read.raw_punch_ids.map(String), ["12112", "12198", "12535", "12592"]);
  });
});

/* ================================================================ H */

describe("H. the job never overlaps itself", () => {
  it("a second invocation while the first is running is a logged no-op; the next one after it runs", async () => {
    let release;
    let calls = 0;
    const fake = {
      recalculateBulk: () => {
        calls += 1;
        return new Promise((resolve) => {
          release = () => resolve({ status: "COMPLETED", errors: [] });
        });
      },
    };
    const { daily, lines, audit } = job(fake, ist("2026-09-24", 6, 50));
    const first = daily.run();
    await new Promise((r) => setImmediate(r));
    assert.equal(daily.isRunning(), true);

    const second = await daily.run();
    assert.deepEqual(second, { skipped: true, reason: "in_progress" });
    assert.equal(calls, 1, "no second recalculation started");
    assert.ok(lines.some((l) => /still in flight/.test(l)));

    release();
    await first;
    assert.equal(daily.isRunning(), false);
    assert.equal(audit.length, 1, "only the real run is audited");

    const third = daily.run();
    await new Promise((r) => setImmediate(r));
    release();
    await third;
    assert.equal(calls, 2);
  });
});

/* ================================================================ I */

describe("I. a failure is logged and never stops the 07:00 Telegram", () => {
  it("a throwing recalculation resolves to a FAILED summary, is logged and audited, and does not throw", async () => {
    const fake = { recalculateBulk: async () => { throw new Error("ER_LOCK_WAIT_TIMEOUT"); } };
    const { daily, audit, errors } = job(fake, ist("2026-09-24", 6, 50));
    const summary = await daily.run();
    assert.equal(summary.status, "FAILED");
    assert.equal(summary.message, "ER_LOCK_WAIT_TIMEOUT");
    assert.equal(errors.length, 1);
    assert.equal(errors[0].code, "CRON.ATTENDANCE_DAILY_RECALCULATION.RUN");
    assert.equal(audit[0].status, "failed");
    assert.equal(audit[0].error_message, "ER_LOCK_WAIT_TIMEOUT");
    assert.equal(daily.isRunning(), false, "and the guard is released for tomorrow");
  });

  it("per-employee errors (not locks) are reported as COMPLETED_WITH_ERRORS and logged", async () => {
    const fake = {
      recalculateBulk: async () => ({
        status: "COMPLETED_WITH_ERRORS",
        errors: [{ employee_id: 7, message: "punch store unreachable" }],
        employees_targeted: 2,
        attendance_days_processed: 3,
      }),
    };
    const { daily, audit, errors } = job(fake, ist("2026-09-24", 6, 50));
    const summary = await daily.run();
    assert.equal(summary.status, "COMPLETED_WITH_ERRORS");
    assert.equal(summary.employees_failed, 1);
    assert.equal(audit[0].status, "failed");
    assert.equal(errors[0].code, "CRON.ATTENDANCE_DAILY_RECALCULATION.EMPLOYEE_ERRORS");
  });

  it("the two are separate cron registrations: a failing 06:50 job does not prevent the 07:00 one from firing", async () => {
    const CronService = require("../services/cron_service");
    const nodeCron = require("node-cron");
    const original = nodeCron.schedule;
    const scheduled = new Map();
    nodeCron.schedule = (expr, fn) => {
      scheduled.set(expr, fn);
      return { stop() {} };
    };
    const log = console.log;
    const errLog = console.error;
    console.log = () => {};
    const cronErrors = [];
    console.error = (...args) => cronErrors.push(args);
    let telegramRan = false;
    try {
      const service = new CronService();
      // Even a daily job that DID throw (it does not - see above) is caught by
      // the cron wrapper and cannot affect another registration.
      service.register("attendance_daily_recalculation", "50 6 * * *", async () => { throw new Error("boom"); });
      service.register("attendance_missing_telegram", "0 7 * * *", async () => { telegramRan = true; });
      service.start();
      scheduled.get("50 6 * * *")();
      await new Promise((r) => setImmediate(r));
      scheduled.get("0 7 * * *")();
      await new Promise((r) => setImmediate(r));
    } finally {
      nodeCron.schedule = original;
      console.log = log;
      console.error = errLog;
    }
    assert.equal(telegramRan, true);
    assert.equal(cronErrors.length, 1, "the 06:50 failure was logged by the wrapper, not thrown");
  });
});
