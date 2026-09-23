/**
 * A GENERAL RECALCULATION PERSISTS ONLY CLOSED ATTENDANCE DATES.
 *
 *   node --test usecase/attendance_closed_date_persistence.test.js
 *
 * The production case this pins (employee 1952, 22-Sep-2026): a manual
 * month-wide run (#45) stored 22-Sep at 18:11 IST from the three punches that
 * existed then; the fourth punch (18:32:17) arrived later through the direct
 * Biomax receiver, which stores raw punches and recalculates nothing; once the
 * date closed, every read returned the stale three-punch STORED row.
 *
 * The rule now (`utils/attendance_persist_guard.js`): a general or manual
 * recalculation may be ASKED for open or future dates but persists only the
 * dates whose attendance day has closed under that date's own shift snapshot
 * and cutoff (`isDayClosed`), and reports the rest. Open dates keep reading as
 * LIVE_PREVIEW from the raw punches as they stand.
 *
 * The fake repository keeps a real STORE of calculated rows, answers
 * `listCalculations` from it (so reads go through the real stored-read rule),
 * and mirrors the payroll lock gate on every write, as the MySQL one does.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const buildUsecase = require("./attendance_calculation");
const { CALCULATION_SOURCE } = require("../utils/attendance_stored_read");
const { partitionClosedDays, latestClosableDate, SKIP_REASON } = require("../utils/attendance_persist_guard");

const EMPLOYEE = 1952;
const DAY_SHIFT = 7; // 09:30-18:30, cutoff 04:00 the next morning
const NIGHT_SHIFT = 8; // 14:00-23:00, cutoff 06:00 the next morning

/** An IST instant as epoch millis. */
const ist = (date, hh, mm = 0, ss = 0) =>
  Date.parse(
    `${date}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}+05:30`
  );

const scheduleRows = (workShiftId, { inTime, outTime, cutoff, nrm }) =>
  Array.from({ length: 7 }, (_, day) => ({
    work_shift_weekly_schedule_id: workShiftId * 10 + day,
    work_shift_id: workShiftId,
    day_of_week: day,
    is_working_day: 1,
    in_time: inTime,
    out_time: outTime,
    attendance_day_cutoff: cutoff,
    break_minutes: 60,
    normal_work_minutes: nrm,
    ot_rate: 1,
  }));

const SCHEDULES = {
  [DAY_SHIFT]: scheduleRows(DAY_SHIFT, { inTime: "09:30:00", outTime: "18:30:00", cutoff: "04:00:00", nrm: 480 }),
  [NIGHT_SHIFT]: scheduleRows(NIGHT_SHIFT, { inTime: "14:00:00", outTime: "23:00:00", cutoff: "06:00:00", nrm: 480 }),
};

const punch = (id, ioTime) => ({
  punch_id: id,
  employee_id: EMPLOYEE,
  io_time: ioTime,
  punch_date: ioTime.slice(0, 10),
  ingest_attendance_date: ioTime.slice(0, 10),
  dev_id: "BIOMAX1",
  ingest_source: "LIVE",
});

const monthKey = (date) => String(date).slice(0, 7);

function fakeRepo(state = {}) {
  const store = new Map(
    (state.stored || []).map((row) => [`${row.employee_id}|${row.attendance_date}`, { ...row }])
  );
  const raw = [...(state.rawPunches || [])];
  const lockedMonths = new Set(state.lockedMonths || []); // `YYYY-MM`
  const workShiftId = state.workShiftId || DAY_SHIFT;
  const calls = { saves: [], monthSaves: [], overrides: [], runs: [] };

  const lockGate = (rows) => {
    const hits = (rows || []).filter((r) => lockedMonths.has(monthKey(r.attendance_date)));
    if (hits.length > 0) {
      const err = new Error("Attendance cannot be changed because payroll for this month is approved and locked.");
      err.name = "ValidationError";
      err.code = "PAYROLL_MONTH_LOCKED";
      throw err;
    }
  };
  const upsert = (rows) =>
    (rows || []).forEach((row) => store.set(`${row.employee_id}|${row.attendance_date}`, { ...row }));

  return {
    store,
    raw,
    calls,
    storedDates: () => [...store.values()].map((r) => r.attendance_date).sort(),
    row: (date) => store.get(`${EMPLOYEE}|${date}`) || null,
    addPunch: (p) => raw.push(p),

    getShiftAssignmentHistory: async () => [
      {
        employee_work_shift_assignment_id: 1,
        employee_id: EMPLOYEE,
        work_shift_id: workShiftId,
        effective_from: "2026-01-01",
        source: "MIGRATION_BACKFILL",
      },
    ],
    getWorkShiftWithSchedule: async (id) => ({
      config: {
        work_shift_id: id,
        shift_code: `S${id}`,
        shift_name: `Shift ${id}`,
        active: 1,
        overtime_allowed: 1,
        overtime_minimum_minutes: 0,
        overtime_rounding_method: "NONE",
        overtime_rounding_interval_minutes: 0,
        overtime_minimum_threshold_only: 0,
        maximum_ot_minutes_per_day: null,
      },
      schedule: SCHEDULES[id],
    }),
    getWorkShiftConfigVersions: async () => [],
    getRawPunchesByCalendarWindow: async (_employeeId, from, to) =>
      raw.filter((p) => {
        const day = String(p.io_time).slice(0, 10);
        return day >= from && day <= to;
      }),
    getApprovedRegularizedPunches: async () => [],
    getBreakOverride: async () => ({ employee_id: EMPLOYEE, special_break_override_minutes: null }),
    getApprovalStateByDate: async () => [],
    getDateShiftOverrides: async () => [],
    getEmploymentWindow: async (employeeId) => ({
      employee_id: employeeId,
      employee_name: "Priyanga",
      status: 1,
      attendance_required: 1,
      date_of_joining: "2020-01-01",
      resignation_date: null,
    }),
    getMonthlyGrossAsOf: async () => null,

    listCalculations: async ({ employee_id, from_date, to_date }) =>
      [...store.values()].filter(
        (r) =>
          Number(r.employee_id) === Number(employee_id) &&
          r.attendance_date >= from_date &&
          r.attendance_date <= to_date
      ),

    saveCalculationsWithReconciliation: async ({ employee_id, from_date, to_date, rows, ineligible_dates }) => {
      if (!Array.isArray(ineligible_dates)) throw new Error("needs ineligible_dates");
      calls.saves.push({ employee_id, from_date, to_date, dates: rows.map((r) => r.attendance_date) });
      lockGate(rows);
      upsert(rows);
      return { written: rows.length, stale_removed: 0 };
    },
    saveCalculations: async (rows) => {
      lockGate(rows);
      upsert(rows);
      return { written: rows.length };
    },
    saveDateShiftOverrideWithCalculation: async ({ override, rows }) => {
      lockGate(rows);
      calls.overrides.push(override);
      upsert(rows);
      return { attendance_date_shift_override_id: calls.overrides.length, written: rows.length };
    },
    saveMonthWithPayroll: async ({ employee_id, period_year, period_month, rows, monthly }) => {
      lockGate([
        { employee_id, attendance_date: `${period_year}-${String(period_month).padStart(2, "0")}-01` },
        ...rows,
      ]);
      calls.monthSaves.push({ dates: rows.map((r) => r.attendance_date), monthly: !!monthly });
      upsert(rows);
      return { written: rows.length, monthly_written: monthly ? 1 : 0 };
    },
    findPayrollLockedPeriods: async (rows) => {
      const seen = new Map();
      (rows || []).forEach((r) => {
        const key = monthKey(r.attendance_date);
        if (!lockedMonths.has(key) || seen.has(key)) return;
        seen.set(key, {
          employee_id: Number(r.employee_id),
          year: Number(key.slice(0, 4)),
          month: Number(key.slice(5, 7)),
        });
      });
      return [...seen.values()];
    },

    // The bulk screen.
    outletExists: async () => true,
    designationExists: async () => true,
    listEmployeesForRecalculation: async () => [
      {
        employee_id: EMPLOYEE,
        employee_name: "Priyanga",
        status: 1,
        attendance_required: 1,
        date_of_joining: "2020-01-01",
        resignation_date: null,
      },
    ],
    insertRecalculationRun: async (run) => {
      calls.runs.push({ ...run });
      return calls.runs.length;
    },
    finishRecalculationRun: async (runId, outcome) => Object.assign(calls.runs[runId - 1], outcome),
  };
}

/** The usecase with its clock pinned to an IST instant that tests can move. */
function build(repo, startAt) {
  const clock = { now: startAt };
  const usecase = buildUsecase(repo, { now: () => clock.now });
  return { usecase, clock };
}

/** Priyanga's four direct Biomax LIVE punches on 22-Sep. */
const PRIYANGA = {
  date: "2026-09-22",
  firstThree: [
    punch(12112, "2026-09-22 09:38:25"),
    punch(12198, "2026-09-22 14:02:27"),
    punch(12535, "2026-09-22 15:09:02"),
  ],
  fourth: punch(12592, "2026-09-22 18:32:17"),
};

/** A normal closed working day, for the historical cases. */
const workedDay = (date, firstId) => [punch(firstId, `${date} 09:30:00`), punch(firstId + 1, `${date} 18:30:00`)];

describe("the guard itself, as arithmetic", () => {
  const day = (date, snapshot) => ({ attendance_date: date, shift_snapshot: snapshot });
  const dayShift = { is_working_day: 1, attendance_day_cutoff: "04:00" };

  it("today is never closed; yesterday closes at its own cutoff; the future is FUTURE_DATE", () => {
    const now = ist("2026-09-22", 3, 59);
    const { closed, skipped } = partitionClosedDays({
      days: [day("2026-09-20", dayShift), day("2026-09-21", dayShift), day("2026-09-22", dayShift), day("2026-09-23", dayShift)],
      now,
    });
    assert.deepEqual(closed.map((d) => d.attendance_date), ["2026-09-20"]);
    assert.deepEqual(skipped, [
      { attendance_date: "2026-09-21", reason: SKIP_REASON.DAY_OPEN, closes_at: "2026-09-22 04:00" },
      { attendance_date: "2026-09-22", reason: SKIP_REASON.DAY_OPEN, closes_at: "2026-09-23 04:00" },
      { attendance_date: "2026-09-23", reason: SKIP_REASON.FUTURE_DATE, closes_at: "2026-09-24 04:00" },
    ]);
  });

  it("a date with no resolvable shift closes at its next midnight, as the read path says", () => {
    const { closed } = partitionClosedDays({ days: [day("2026-09-21", null)], now: ist("2026-09-22", 0, 0) });
    assert.deepEqual(closed.map((d) => d.attendance_date), ["2026-09-21"]);
  });

  it("the latest date that can ever have closed on a given day is the day before", () => {
    assert.equal(latestClosableDate("2026-09-21"), "2026-09-20");
    assert.equal(latestClosableDate("2026-10-01"), "2026-09-30");
  });
});

describe("A. a future date is never persisted", () => {
  it("today = 21-Sep, a request through 22-Sep writes NO row for 22-Sep", async () => {
    const repo = fakeRepo({ rawPunches: [...workedDay("2026-09-20", 1)] });
    const { usecase } = build(repo, ist("2026-09-21", 12, 0));

    const result = await usecase.recalculateRange({
      employee_id: EMPLOYEE,
      from_date: "2026-09-20",
      to_date: "2026-09-22",
    });

    assert.equal(repo.row("2026-09-22"), null, "no attendance_day_calculation row for 22-Sep");
    assert.equal(repo.row("2026-09-21"), null, "nor for today, which is still open");
    assert.ok(repo.row("2026-09-20"), "the closed date IS persisted");
    assert.deepEqual(result.days.map((d) => d.attendance_date), ["2026-09-20"], "days = what was stored");
    assert.equal(result.written, 1);
    assert.deepEqual(
      result.skipped_open_dates.map((s) => [s.attendance_date, s.reason]),
      [
        ["2026-09-21", "DAY_OPEN"],
        ["2026-09-22", "FUTURE_DATE"],
      ],
      "and the dates it did not store are reported, not passed off as processed"
    );
  });

  it("the BULK screen accepts the range, stores no future row, and reports the skipped dates", async () => {
    const repo = fakeRepo({ rawPunches: [...workedDay("2026-09-20", 1)] });
    const { usecase } = build(repo, ist("2026-09-21", 12, 0));

    const result = await usecase.recalculateBulk({ from_date: "2026-09-01", to_date: "2026-09-30" });

    assert.equal(result.status, "COMPLETED");
    assert.equal(repo.storedDates().some((d) => d >= "2026-09-21"), false, "nothing on or after today");
    assert.equal(repo.storedDates().length, 20, "1-20 Sep are closed and stored");
    assert.equal(result.attendance_days_processed, 20);
    assert.equal(result.attendance_days_skipped_open, 10, "21-30 Sep");
    assert.equal(result.open_dates_skipped[0], "2026-09-21");
    assert.equal(result.open_dates_skipped[9], "2026-09-30");
  });
});

describe("B. a same-day unfinished shift is not persisted", () => {
  it("3 punches, before the cutoff: recalculation stores nothing, the day reads LIVE_PREVIEW", async () => {
    const repo = fakeRepo({ rawPunches: [...PRIYANGA.firstThree] });
    const { usecase } = build(repo, ist(PRIYANGA.date, 16, 0));

    const result = await usecase.recalculateRange({
      employee_id: EMPLOYEE,
      from_date: PRIYANGA.date,
      to_date: PRIYANGA.date,
    });
    assert.equal(repo.row(PRIYANGA.date), null, "the open day is NOT persisted");
    assert.deepEqual(result.days, []);
    assert.equal(result.skipped_open_dates[0].reason, "DAY_OPEN");
    assert.equal(result.skipped_open_dates[0].closes_at, "2026-09-23 04:00");

    const [read] = await usecase.readRange({
      employee_id: EMPLOYEE,
      from_date: PRIYANGA.date,
      to_date: PRIYANGA.date,
      now: ist(PRIYANGA.date, 16, 0),
    });
    assert.equal(read.calculation_source, CALCULATION_SOURCE.LIVE_PREVIEW, "still readable - not hidden");
    assert.equal(read.punch_count, 3);
  });
});

describe("C. the Priyanga regression: a late 4th punch is never masked by a stale 3-punch row", () => {
  it("run while open -> 4th punch arrives -> clock passes the cutoff -> the read resolves all 4 punches", async () => {
    const repo = fakeRepo({ rawPunches: [...PRIYANGA.firstThree] });
    // Run #45 was stored at 12:41:25 UTC = 18:11:25 IST, between the 3rd and
    // the 4th punch. The same month-wide request is made here.
    const { usecase, clock } = build(repo, ist(PRIYANGA.date, 18, 11, 25));

    const run = await usecase.recalculateBulk({ from_date: "2026-09-01", to_date: "2026-09-30" });
    assert.equal(repo.row(PRIYANGA.date), null, "22-Sep was open at 18:11: nothing stored for it");
    assert.ok(run.open_dates_skipped.includes(PRIYANGA.date));

    // 18:32:17 - the final punch, through the direct receiver: a raw row, no
    // recalculation.
    repo.addPunch(PRIYANGA.fourth);

    // Past 22-Sep's close: 04:00 on the 23rd under its cutoff.
    clock.now = ist("2026-09-23", 4, 0);
    const [read] = await usecase.readRange({
      employee_id: EMPLOYEE,
      from_date: PRIYANGA.date,
      to_date: PRIYANGA.date,
      now: clock.now,
    });
    assert.notEqual(read.calculation_source, CALCULATION_SOURCE.STORED, "no stale STORED row");
    assert.equal(read.punch_count, 4, "all four punches");
    assert.deepEqual(read.raw_punch_ids.map(String), ["12112", "12198", "12535", "12592"]);

    // And the next ordinary recalculation, now that the date HAS closed,
    // stores the four-punch day, which is then what a read returns.
    await usecase.recalculateRange({ employee_id: EMPLOYEE, from_date: "2026-09-01", to_date: "2026-09-30" });
    assert.equal(repo.row(PRIYANGA.date).punch_count, 4);
    const [settled] = await usecase.readRange({
      employee_id: EMPLOYEE,
      from_date: PRIYANGA.date,
      to_date: PRIYANGA.date,
      now: clock.now,
    });
    assert.equal(settled.calculation_source, CALCULATION_SOURCE.STORED);
    assert.equal(settled.punch_count, 4);
  });

  it("a row stored prematurely BEFORE this fix still wins once the date closes - until it is recalculated", async () => {
    // What production holds today for 22-Sep. The guard stops NEW premature
    // rows; it does not rewrite old ones, and a read of a closed date with a
    // stored row returns that row. One recalculation after close repairs it.
    const stale = {
      employee_id: EMPLOYEE,
      attendance_date: PRIYANGA.date,
      work_shift_id: DAY_SHIFT,
      shift_snapshot: JSON.stringify({ is_working_day: 1, attendance_day_cutoff: "04:00" }),
      raw_punch_ids: JSON.stringify(["12112", "12198", "12535"]),
      effective_punches: JSON.stringify([]),
      punch_count: 3,
      status: "REVIEW_REQUIRED",
    };
    const repo = fakeRepo({
      rawPunches: [...PRIYANGA.firstThree, PRIYANGA.fourth],
      stored: [stale],
    });
    const { usecase } = build(repo, ist("2026-09-23", 10, 0));

    const [before] = await usecase.readRange({
      employee_id: EMPLOYEE,
      from_date: PRIYANGA.date,
      to_date: PRIYANGA.date,
      now: ist("2026-09-23", 10, 0),
    });
    assert.equal(before.calculation_source, CALCULATION_SOURCE.STORED);
    assert.equal(before.punch_count, 3, "the pre-fix stale row");

    await usecase.recalculateRange({ employee_id: EMPLOYEE, from_date: PRIYANGA.date, to_date: PRIYANGA.date });
    const [after] = await usecase.readRange({
      employee_id: EMPLOYEE,
      from_date: PRIYANGA.date,
      to_date: PRIYANGA.date,
      now: ist("2026-09-23", 10, 0),
    });
    assert.equal(after.punch_count, 4, "one recalculation after close repairs it");
  });
});

describe("D. an overnight/cutoff shift: YESTERDAY can still be open", () => {
  // 14:00-23:00 with a 06:00 cutoff. 21-Sep's day owns punches until 06:00
  // on the 22nd, so at 03:00 on the 22nd it is open although it is
  // "yesterday" - exactly what a `date < today` rule would get wrong.
  const nightPunches = [punch(1, "2026-09-21 14:00:00"), punch(2, "2026-09-22 00:30:00")];

  it("at 03:00 the next morning, yesterday is open and is NOT persisted", async () => {
    const repo = fakeRepo({ workShiftId: NIGHT_SHIFT, rawPunches: nightPunches });
    const { usecase } = build(repo, ist("2026-09-22", 3, 0));

    const result = await usecase.recalculateRange({
      employee_id: EMPLOYEE,
      from_date: "2026-09-21",
      to_date: "2026-09-21",
    });
    assert.equal(repo.row("2026-09-21"), null);
    assert.deepEqual(result.skipped_open_dates, [
      { attendance_date: "2026-09-21", reason: "DAY_OPEN", closes_at: "2026-09-22 06:00" },
    ]);
  });

  it("at 06:00 it has closed and IS persisted, with the after-midnight punch on it", async () => {
    const repo = fakeRepo({ workShiftId: NIGHT_SHIFT, rawPunches: nightPunches });
    const { usecase } = build(repo, ist("2026-09-22", 6, 0));

    const result = await usecase.recalculateRange({
      employee_id: EMPLOYEE,
      from_date: "2026-09-21",
      to_date: "2026-09-21",
    });
    assert.deepEqual(result.skipped_open_dates, []);
    assert.equal(repo.row("2026-09-21").punch_count, 2);
  });
});

describe("F. a closed historical date still persists exactly as before", () => {
  it("10-Sep, recalculated on 22-Sep, is stored and read back as STORED", async () => {
    const repo = fakeRepo({ rawPunches: workedDay("2026-09-10", 1) });
    const { usecase } = build(repo, ist("2026-09-22", 12, 0));

    const result = await usecase.recalculateRange({
      employee_id: EMPLOYEE,
      from_date: "2026-09-10",
      to_date: "2026-09-10",
    });
    assert.equal(result.written, 1);
    assert.deepEqual(result.skipped_open_dates, []);
    assert.equal(repo.row("2026-09-10").punch_count, 2);

    const [read] = await usecase.readRange({
      employee_id: EMPLOYEE,
      from_date: "2026-09-10",
      to_date: "2026-09-10",
      now: ist("2026-09-22", 12, 0),
    });
    assert.equal(read.calculation_source, CALCULATION_SOURCE.STORED);
  });

  it("stored closed history is never deleted because the request also named an open date", async () => {
    const existing = {
      employee_id: EMPLOYEE,
      attendance_date: "2026-09-05",
      punch_count: 2,
      status: "PRESENT",
      marker: "untouched",
    };
    const openRow = { employee_id: EMPLOYEE, attendance_date: "2026-09-22", punch_count: 3, marker: "untouched" };
    const repo = fakeRepo({ rawPunches: workedDay("2026-09-10", 1), stored: [existing, openRow] });
    const { usecase } = build(repo, ist("2026-09-22", 12, 0));

    await usecase.recalculateRange({ employee_id: EMPLOYEE, from_date: "2026-09-10", to_date: "2026-09-30" });

    assert.equal(repo.row("2026-09-05").marker, "untouched", "outside the window: untouched");
    assert.equal(repo.row("2026-09-22").marker, "untouched", "an open date's row is skipped, not deleted or rewritten");
    assert.ok(repo.row("2026-09-21"), "21-Sep closed at 04:00 today and is stored");
  });
});

describe("G. a payroll-locked month is refused exactly as before", () => {
  it("closed dates in a locked month: refused with PAYROLL_MONTH_LOCKED, nothing written", async () => {
    const repo = fakeRepo({ rawPunches: workedDay("2026-08-10", 1), lockedMonths: ["2026-08"] });
    const { usecase } = build(repo, ist("2026-09-22", 12, 0));

    await assert.rejects(
      usecase.recalculateRange({ employee_id: EMPLOYEE, from_date: "2026-08-01", to_date: "2026-08-31" }),
      (err) => err.code === "PAYROLL_MONTH_LOCKED"
    );
    assert.deepEqual(repo.storedDates(), []);
  });

  it("a request whose only dates in the locked month are open is STILL refused, not quietly skipped", async () => {
    const repo = fakeRepo({ rawPunches: [...PRIYANGA.firstThree], lockedMonths: ["2026-09"] });
    const { usecase } = build(repo, ist(PRIYANGA.date, 12, 0));

    await assert.rejects(
      usecase.recalculateRange({ employee_id: EMPLOYEE, from_date: PRIYANGA.date, to_date: "2026-09-30" }),
      (err) => err.code === "PAYROLL_MONTH_LOCKED"
    );
    assert.deepEqual(repo.storedDates(), []);
  });

  it("the bulk run reports a locked employee as failed, as before", async () => {
    const repo = fakeRepo({ rawPunches: workedDay("2026-08-10", 1), lockedMonths: ["2026-08"] });
    const { usecase } = build(repo, ist("2026-09-22", 12, 0));
    const result = await usecase.recalculateBulk({ from_date: "2026-08-01", to_date: "2026-08-31" });
    assert.equal(result.employees_failed, 1);
    assert.match(result.errors[0].message, /approved and locked/);
  });

  it("the monthly persist of a locked month is refused", async () => {
    const repo = fakeRepo({ lockedMonths: ["2026-08"] });
    const { usecase } = build(repo, ist("2026-09-22", 12, 0));
    await assert.rejects(
      usecase.calculateMonth({ employee_id: EMPLOYEE, year: 2026, month: 8, persist: true }),
      (err) => err.code === "PAYROLL_MONTH_LOCKED"
    );
  });
});

describe("the monthly persist obeys the same rule", () => {
  it("persist=true mid-month stores the closed days only, keeps the roll-up, and reports the rest", async () => {
    const repo = fakeRepo({ rawPunches: [...workedDay("2026-09-10", 1), ...PRIYANGA.firstThree] });
    const { usecase } = build(repo, ist(PRIYANGA.date, 18, 11));

    const result = await usecase.calculateMonth({ employee_id: EMPLOYEE, year: 2026, month: 9, persist: true });

    assert.equal(repo.calls.monthSaves.length, 1);
    assert.equal(repo.calls.monthSaves[0].monthly, true, "the monthly roll-up is still stored");
    assert.equal(repo.storedDates().at(-1), "2026-09-21", "no day row on or after the open 22nd");
    assert.equal(repo.row(PRIYANGA.date), null);
    assert.equal(result.skipped_open_dates.length, 9, "22-30 Sep reported");
    assert.equal(result.days.length, 30, "the returned month is still the whole month");
  });

  it("a plain read of a month writes nothing, as before", async () => {
    const repo = fakeRepo({ rawPunches: workedDay("2026-09-10", 1) });
    const { usecase } = build(repo, ist("2026-09-22", 12, 0));
    const result = await usecase.calculateMonth({ employee_id: EMPLOYEE, year: 2026, month: 9 });
    assert.deepEqual(repo.storedDates(), []);
    assert.equal(result.skipped_open_dates, undefined);
  });
});

describe("the single-date shift edit obeys the same rule (formerly exempt)", () => {
  it("on an OPEN date it saves the override alone - no day row - and says so", async () => {
    // The override is the decision and is committed; the day row waits for
    // the close. Full coverage of this path, and of the approval paths, is in
    // `usecase/attendance_open_day_decisions.test.js`.
    const repo = fakeRepo({ rawPunches: [...PRIYANGA.firstThree] });
    const { usecase } = build(repo, ist(PRIYANGA.date, 12, 0));

    const result = await usecase.setDateShift({
      employee_id: EMPLOYEE,
      attendance_date: PRIYANGA.date,
      work_shift_id: NIGHT_SHIFT,
      actor_employee_id: 1,
    });
    assert.equal(result.changed, true);
    assert.equal(repo.calls.overrides.length, 1, "the override is saved");
    assert.equal(repo.row(PRIYANGA.date), null, "no attendance_day_calculation row for the open date");
    assert.equal(result.attendance_persisted, false);
  });
});
