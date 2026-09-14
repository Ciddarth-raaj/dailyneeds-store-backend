/**
 * RECALCULATION EXCLUDES WHAT IT SHOULD, AND REMOVES WHAT IT LEFT BEHIND.
 *
 *   node --test usecase/attendance_recalculation_reconciliation.test.js
 *
 * Items 1 and 2 of DN-ATTENDANCE-RECALC-DATA-INTEGRITY. Two claims, and the
 * second is the one the first does not cover:
 *
 *   1. the shared rule (`utils/attendance_eligibility.js`) decides which
 *      employee/date a recalculation may calculate, and it is applied in ONE
 *      place - `recalculateRange` - which is the path both the single-employee
 *      endpoint and every employee of a bulk run take;
 *
 *   2. filtering the future is not enough. What a PREVIOUS run stored for a
 *      date that is no longer eligible is deleted, bounded to the employee and
 *      the requested window, and nothing else is touched - in particular no
 *      raw punch.
 *
 * The fake repository below keeps a real STORE of calculated rows and
 * implements `saveCalculationsWithReconciliation` the way the SQL does
 * (upsert the batch, delete the rest of the window), so "the stale row is
 * gone" is observed rather than asserted about a call argument. It also keeps
 * the raw punches in a frozen array, so any write to them throws.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const buildUsecase = require("./attendance_calculation");

const scheduleRows = (workShiftId) =>
  Array.from({ length: 7 }, (_, day) => ({
    work_shift_weekly_schedule_id: workShiftId * 10 + day,
    work_shift_id: workShiftId,
    day_of_week: day,
    is_working_day: 1,
    in_time: "09:00:00",
    out_time: "21:00:00",
    attendance_day_cutoff: "04:00:00",
    break_minutes: 60,
    normal_work_minutes: 660,
    ot_rate: 1,
  }));

const punch = (id, ioTime) => ({
  punch_id: id,
  employee_id: 42,
  io_time: ioTime,
  punch_date: ioTime.slice(0, 10),
  ingest_attendance_date: ioTime.slice(0, 10),
  dev_id: "DEV1",
  ingest_source: "DEVICE",
});

/** A full worked day, so a calculated row is a real one. */
const workedDay = (date, firstId) => [
  punch(firstId, `${date} 09:00:00`),
  punch(firstId + 1, `${date} 21:00:00`),
];

function fakeRepo(state = {}) {
  // The stored calculated days, keyed as the unique index keys them.
  const store = new Map(
    (state.stored || []).map((row) => [`${row.employee_id}|${row.attendance_date}`, { ...row }])
  );
  // Raw punches, FROZEN. Anything that tried to write one would throw here.
  const raw = Object.freeze((state.rawPunches || []).map((p) => Object.freeze({ ...p })));
  const calls = { redrive: [], reconciliations: [] };

  return {
    store,
    raw,
    calls,
    rowsFor: (employeeId) =>
      [...store.values()]
        .filter((r) => r.employee_id === employeeId)
        .map((r) => r.attendance_date)
        .sort(),

    getShiftAssignmentHistory: async () => [
      {
        employee_work_shift_assignment_id: 1,
        employee_id: 42,
        work_shift_id: 7,
        effective_from: "2020-01-01",
        source: "MIGRATION_BACKFILL",
      },
    ],
    getWorkShiftWithSchedule: async (id) => ({
      config: {
        work_shift_id: id,
        shift_code: `S${id}`,
        overtime_allowed: 1,
        overtime_minimum_minutes: 0,
        overtime_rounding_method: "NONE",
        overtime_rounding_interval_minutes: 0,
        overtime_minimum_threshold_only: 0,
        maximum_ot_minutes_per_day: null,
      },
      schedule: scheduleRows(id),
    }),
    getWorkShiftConfigVersions: async () => [],
    getRawPunchesByCalendarWindow: async (_employeeId, from, to) =>
      raw.filter((p) => {
        const day = String(p.io_time).slice(0, 10);
        return day >= from && day <= to;
      }),
    getApprovedRegularizedPunches: async () => [],
    getBreakOverride: async () => ({ employee_id: 42, special_break_override_minutes: null }),
    getApprovalStateByDate: async () => [],
    getEmploymentWindow: async (employeeId) =>
      (state.employment || {})[employeeId] || {
        employee_id: employeeId,
        status: 1,
        attendance_required: 1,
        date_of_joining: "2020-01-01",
        resignation_date: null,
      },
    getMonthlyGrossAsOf: async () => null,

    /**
     * What the real repository's ONE transaction does, in memory: upsert the
     * batch, then delete every row of this employee inside the requested
     * window that the batch did not write.
     */
    saveCalculationsWithReconciliation: async ({ employee_id, from_date, to_date, rows }) => {
      calls.reconciliations.push({ employee_id, from_date, to_date, kept: rows.map((r) => r.attendance_date) });
      const keep = new Set(rows.map((r) => r.attendance_date));
      for (const row of rows) store.set(`${row.employee_id}|${row.attendance_date}`, { ...row });
      let removed = 0;
      for (const [key, row] of [...store.entries()]) {
        if (row.employee_id !== employee_id) continue;
        if (row.attendance_date < from_date || row.attendance_date > to_date) continue;
        if (keep.has(row.attendance_date)) continue;
        store.delete(key);
        removed += 1;
      }
      return { written: rows.length, stale_removed: removed };
    },
    saveMonthlyPayroll: async () => [],

    listEmployeesForRecalculation: async () => state.candidates || [],
    outletExists: async () => true,
    designationExists: async () => true,
    insertRecalculationRun: async () => 1,
    finishRecalculationRun: async () => {},
  };
}

/** A stored day as a previous run left it. Only the keys this test reads. */
const storedDay = (employee_id, attendance_date) => ({
  employee_id,
  attendance_date,
  status: "FINAL",
  worked_minutes: 660,
});

const build = (state) => {
  const repo = fakeRepo(state);
  const usecase = buildUsecase(repo);
  // Punch re-derivation is a collaborator; recording it proves the exempt
  // employee's punches are not re-derived for a calculation nobody runs.
  usecase.setPunchRedriveService({
    redriveUndatedPunches: async (args) => {
      repo.calls.redrive.push(args);
      return { scanned: 0, rematched: 0, still_unmatched: 0, employees: [] };
    },
  });
  return { repo, usecase };
};

/* ============================================= 1. the eligible baseline == */

describe("an attendance-required employee inside their employment period", () => {
  it("recalculates normally, over the whole requested range", async () => {
    const { repo, usecase } = build({
      rawPunches: [...workedDay("2026-09-14", 1), ...workedDay("2026-09-15", 3)],
    });
    const r = await usecase.recalculateRange({
      employee_id: 42,
      from_date: "2026-09-14",
      to_date: "2026-09-15",
    });
    assert.equal(r.written, 2);
    assert.equal(r.stale_removed, 0);
    assert.deepEqual(r.days.map((d) => d.attendance_date), ["2026-09-14", "2026-09-15"]);
    assert.deepEqual(repo.rowsFor(42), ["2026-09-14", "2026-09-15"]);
    assert.equal(r.eligible_from, "2026-09-14");
    assert.equal(r.eligible_to, "2026-09-15");
    assert.equal(r.excluded_reason, null);
  });

  it("is idempotent: a second run leaves exactly the same rows", async () => {
    const { repo, usecase } = build({
      rawPunches: [...workedDay("2026-09-14", 1), ...workedDay("2026-09-15", 3)],
    });
    const range = { employee_id: 42, from_date: "2026-09-14", to_date: "2026-09-15" };
    await usecase.recalculateRange(range);
    const second = await usecase.recalculateRange(range);
    assert.equal(second.stale_removed, 0, "a re-run must not delete what it just wrote");
    assert.deepEqual(repo.rowsFor(42), ["2026-09-14", "2026-09-15"]);
  });
});

/* ================================= 2. the three exclusions, per employee = */

describe("exclusion: attendance_required = 0", () => {
  const world = () =>
    build({
      rawPunches: [...workedDay("2026-09-14", 1), ...workedDay("2026-09-15", 3)],
      employment: {
        42: { employee_id: 42, status: 1, attendance_required: 0, date_of_joining: "2020-01-01", resignation_date: null },
      },
      stored: [storedDay(42, "2026-09-14"), storedDay(42, "2026-09-15")],
    });

  it("calculates nothing for them", async () => {
    const { usecase } = world();
    const r = await usecase.recalculateRange({ employee_id: 42, from_date: "2026-09-14", to_date: "2026-09-15" });
    assert.equal(r.written, 0);
    assert.deepEqual(r.days, []);
    assert.equal(r.excluded_reason, "ATTENDANCE_NOT_REQUIRED");
  });

  it("AND REMOVES THE ROWS AN EARLIER RUN STORED - item 2's first case", async () => {
    const { repo, usecase } = world();
    const r = await usecase.recalculateRange({ employee_id: 42, from_date: "2026-09-14", to_date: "2026-09-15" });
    assert.equal(r.stale_removed, 2);
    assert.deepEqual(repo.rowsFor(42), [], "the exempted employee keeps no calculated day in the window");
  });

  it("does not re-derive their punches for a calculation nobody runs", async () => {
    const { repo, usecase } = world();
    await usecase.recalculateRange({ employee_id: 42, from_date: "2026-09-14", to_date: "2026-09-15" });
    assert.deepEqual(repo.calls.redrive, []);
  });
});

describe("exclusion: dates after the resignation date", () => {
  const world = () =>
    build({
      rawPunches: [
        ...workedDay("2026-09-14", 1),
        ...workedDay("2026-09-15", 3),
        // Punches AFTER they left - a shared device, a colleague's mistake.
        ...workedDay("2026-09-17", 5),
      ],
      employment: {
        42: { employee_id: 42, status: 0, attendance_required: 1, date_of_joining: "2020-01-01", resignation_date: "2026-09-15" },
      },
      stored: [
        storedDay(42, "2026-09-14"),
        storedDay(42, "2026-09-15"),
        storedDay(42, "2026-09-16"),
        storedDay(42, "2026-09-17"),
      ],
    });

  it("calculates up to and INCLUDING the resignation date, and no further", async () => {
    const { usecase } = world();
    const r = await usecase.recalculateRange({ employee_id: 42, from_date: "2026-09-14", to_date: "2026-09-18" });
    assert.deepEqual(r.days.map((d) => d.attendance_date), ["2026-09-14", "2026-09-15"]);
  });

  it("removes only the days after it, and KEEPS the valid history before it", async () => {
    const { repo, usecase } = world();
    const r = await usecase.recalculateRange({ employee_id: 42, from_date: "2026-09-14", to_date: "2026-09-18" });
    assert.equal(r.stale_removed, 2, "the 16th and the 17th");
    assert.deepEqual(
      repo.rowsFor(42),
      ["2026-09-14", "2026-09-15"],
      "a resigned employee retains their attendance up to the resignation boundary"
    );
  });
});

describe("exclusion: dates before the joining date", () => {
  it("calculates from the joining date and deletes what sits before it", async () => {
    const { repo, usecase } = build({
      rawPunches: [...workedDay("2026-09-15", 1), ...workedDay("2026-09-16", 3)],
      employment: {
        42: { employee_id: 42, status: 1, attendance_required: 1, date_of_joining: "2026-09-15", resignation_date: null },
      },
      stored: [storedDay(42, "2026-09-13"), storedDay(42, "2026-09-14"), storedDay(42, "2026-09-15")],
    });
    const r = await usecase.recalculateRange({ employee_id: 42, from_date: "2026-09-13", to_date: "2026-09-16" });
    assert.deepEqual(r.days.map((d) => d.attendance_date), ["2026-09-15", "2026-09-16"]);
    assert.equal(r.stale_removed, 2, "the 13th and the 14th - days they did not work here");
    assert.deepEqual(repo.rowsFor(42), ["2026-09-15", "2026-09-16"]);
  });

  it("a CORRECTED joining date moves the boundary, and the old rows go", async () => {
    // The joining date was 2026-09-10 and a run stored from there; HR then
    // corrects it to the 15th. Item 2's "joining date is corrected" case.
    const { repo, usecase } = build({
      rawPunches: [],
      employment: {
        42: { employee_id: 42, status: 1, attendance_required: 1, date_of_joining: "2026-09-15", resignation_date: null },
      },
      stored: [
        storedDay(42, "2026-09-10"),
        storedDay(42, "2026-09-11"),
        storedDay(42, "2026-09-12"),
        storedDay(42, "2026-09-15"),
      ],
    });
    await usecase.recalculateRange({ employee_id: 42, from_date: "2026-09-10", to_date: "2026-09-16" });
    assert.deepEqual(repo.rowsFor(42), ["2026-09-15", "2026-09-16"]);
  });
});

/* ================================================= 3. the guardrails ===== */

describe("what reconciliation must never touch", () => {
  it("RAW PUNCHES ARE UNTOUCHED - they are frozen, and the run still succeeds", async () => {
    const rawPunches = [...workedDay("2026-09-14", 1), ...workedDay("2026-09-17", 5)];
    const { repo, usecase } = build({
      rawPunches,
      employment: {
        42: { employee_id: 42, status: 0, attendance_required: 1, date_of_joining: "2020-01-01", resignation_date: "2026-09-15" },
      },
      stored: [storedDay(42, "2026-09-17")],
    });
    const before = JSON.stringify(repo.raw);
    await usecase.recalculateRange({ employee_id: 42, from_date: "2026-09-14", to_date: "2026-09-18" });
    assert.equal(JSON.stringify(repo.raw), before, "not one raw punch changed");
    assert.equal(repo.raw.length, rawPunches.length, "and none was removed");
  });

  it("another employee's rows inside the same window are untouched", async () => {
    const { repo, usecase } = build({
      rawPunches: [],
      employment: {
        42: { employee_id: 42, status: 1, attendance_required: 0, date_of_joining: "2020-01-01", resignation_date: null },
      },
      stored: [storedDay(42, "2026-09-14"), storedDay(43, "2026-09-14"), storedDay(43, "2026-09-15")],
    });
    await usecase.recalculateRange({ employee_id: 42, from_date: "2026-09-14", to_date: "2026-09-15" });
    assert.deepEqual(repo.rowsFor(42), []);
    assert.deepEqual(repo.rowsFor(43), ["2026-09-14", "2026-09-15"], "a different employee is a different reconciliation");
  });

  it("the SAME employee's rows OUTSIDE the requested window are untouched", async () => {
    const { repo, usecase } = build({
      rawPunches: [],
      employment: {
        42: { employee_id: 42, status: 1, attendance_required: 0, date_of_joining: "2020-01-01", resignation_date: null },
      },
      stored: [storedDay(42, "2026-08-31"), storedDay(42, "2026-09-14"), storedDay(42, "2026-10-01")],
    });
    await usecase.recalculateRange({ employee_id: 42, from_date: "2026-09-01", to_date: "2026-09-30" });
    assert.deepEqual(
      repo.rowsFor(42),
      ["2026-08-31", "2026-10-01"],
      "reconciliation is bounded by the window it was asked about"
    );
  });

  it("the reconciliation is always asked about the REQUESTED window, not the clamped one", async () => {
    const { repo, usecase } = build({
      rawPunches: [],
      employment: {
        42: { employee_id: 42, status: 1, attendance_required: 1, date_of_joining: "2026-09-15", resignation_date: null },
      },
    });
    await usecase.recalculateRange({ employee_id: 42, from_date: "2026-09-10", to_date: "2026-09-16" });
    assert.deepEqual(repo.calls.reconciliations, [
      { employee_id: 42, from_date: "2026-09-10", to_date: "2026-09-16", kept: ["2026-09-15", "2026-09-16"] },
    ]);
  });
});

/* ====================================== 4. one rule, both recalc paths === */

describe("the bulk run applies the same rule through the same path", () => {
  const CANDIDATES = [
    { employee_id: 42, employee_name: "Asha", attendance_required: 1, date_of_joining: "2020-01-01", resignation_date: null },
    { employee_id: 43, employee_name: "Exempt", attendance_required: 0, date_of_joining: "2020-01-01", resignation_date: null },
    { employee_id: 44, employee_name: "Left", attendance_required: 1, date_of_joining: "2020-01-01", resignation_date: "2026-08-01" },
    { employee_id: 45, employee_name: "Joiner", attendance_required: 1, date_of_joining: "2026-12-01", resignation_date: null },
  ];
  const world = () =>
    build({
      rawPunches: [...workedDay("2026-09-14", 1), ...workedDay("2026-09-15", 3)],
      candidates: CANDIDATES,
      employment: Object.fromEntries(
        CANDIDATES.map((c) => [c.employee_id, { ...c, status: 1 }])
      ),
      stored: [
        storedDay(43, "2026-09-14"),
        storedDay(44, "2026-09-14"),
        storedDay(45, "2026-09-15"),
      ],
    });

  it("targets only the eligible employees", async () => {
    const { usecase } = world();
    const r = await usecase.recalculateBulk({ from_date: "2026-09-14", to_date: "2026-09-15" });
    assert.equal(r.employees_targeted, 1, "only Asha earns attendance in this window");
    assert.equal(r.employees_completed, 1);
    assert.deepEqual(
      r.excluded.map((e) => [e.employee_id, e.reason]),
      [
        [43, "ATTENDANCE_NOT_REQUIRED"],
        [44, "AFTER_RESIGNATION_DATE"],
        [45, "BEFORE_JOINING_DATE"],
      ]
    );
  });

  it("but RECONCILES all four, so the ineligible ones lose their stale rows", async () => {
    const { repo, usecase } = world();
    const r = await usecase.recalculateBulk({ from_date: "2026-09-14", to_date: "2026-09-15" });
    assert.equal(r.employees_reconciled, 4);
    assert.equal(r.stale_rows_removed, 3);
    assert.deepEqual(repo.rowsFor(42), ["2026-09-14", "2026-09-15"]);
    assert.deepEqual(repo.rowsFor(43), []);
    assert.deepEqual(repo.rowsFor(44), []);
    assert.deepEqual(repo.rowsFor(45), []);
  });

  it("an active employee is never accidentally excluded", async () => {
    const { repo, usecase } = world();
    await usecase.recalculateBulk({ from_date: "2026-09-14", to_date: "2026-09-15" });
    assert.deepEqual(repo.rowsFor(42), ["2026-09-14", "2026-09-15"]);
  });
});
