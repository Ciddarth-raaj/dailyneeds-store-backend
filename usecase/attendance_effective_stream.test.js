/**
 * The effective raw punch stream INSIDE the real calculation orchestration:
 * voids and ten-minute duplicates applied where production applies them, and
 * the engine fed the result.
 *
 *   node --test usecase/attendance_effective_stream.test.js
 *
 * The real `usecase/attendance_calculation.js` over a fake repository whose
 * rows have the exact shape `getRawPunchesByCalendarWindow` returns - the
 * void columns LEFT JOINed onto the raw row. A 09:00-21:00 shift, 60 minute
 * break, NRM 660, cutoff 04:00, every day working.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const buildUsecase = require("./attendance_calculation");
const { CALC_STATUS, CALCULATION_VERSION } = require("../utils/attendance_engine");

const EMPLOYEE = 42;

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

function fakeRepo(state = {}) {
  const saved = { calculations: [] };
  const rawPunches = state.rawPunches || [];
  return {
    saved,
    rawPunches,
    getShiftAssignmentHistory: async () => [
      { employee_work_shift_assignment_id: 1, employee_id: EMPLOYEE, work_shift_id: 7, effective_from: "2026-09-01", source: "MIGRATION_BACKFILL" },
    ],
    getWorkShiftWithSchedule: async (id) => ({
      config: {
        work_shift_id: id, shift_code: `S${id}`, overtime_allowed: 1, overtime_minimum_minutes: 0,
        overtime_rounding_method: "NONE", overtime_rounding_interval_minutes: 0,
        overtime_minimum_threshold_only: 0, maximum_ot_minutes_per_day: null,
      },
      schedule: scheduleRows(id),
    }),
    getWorkShiftConfigVersions: async () => [],
    getRawPunchesByCalendarWindow: async (_employeeId, from, to) =>
      rawPunches.filter((p) => p.punch_date >= from && p.punch_date <= to),
    getApprovedRegularizedPunches: async () => state.regularized || [],
    getBreakOverride: async () => ({ employee_id: EMPLOYEE, special_break_override_minutes: null }),
    getApprovalStateByDate: async () => state.approvals || [],
    getEmploymentWindow: async () => ({ employee_id: EMPLOYEE, status: 1, date_of_joining: "2020-01-01", resignation_date: null }),
    saveCalculations: async (rows) => {
      saved.calculations.push(rows);
      return { written: rows.length };
    },
  };
}

/** A raw row exactly as the repository hands it back, void columns included. */
const raw = (id, ioTime, extra = {}) => ({
  punch_id: id,
  employee_id: EMPLOYEE,
  punch_date: ioTime.slice(0, 10),
  ingest_attendance_date: ioTime.slice(0, 10),
  io_time: ioTime,
  dev_id: "C26924B2E7351O35",
  ingest_source: "LIVE",
  attendance_punch_void_id: null,
  void_reason: null,
  voided_by_employee_id: null,
  voided_at: null,
  ...extra,
});
const imported = (id, ioTime) => raw(id, ioTime, { dev_id: null, ingest_source: "DIGISME_IMPORT" });
const voided = (id, ioTime, reason = "Duplicate device punch") =>
  raw(id, ioTime, { attendance_punch_void_id: 900 + id, void_reason: reason, voided_by_employee_id: 7, voided_at: "2026-09-15 10:00:00" });

const day = async (state, date = "2026-09-14") => {
  const [d] = await buildUsecase(fakeRepo(state)).calculateRange({ employee_id: EMPLOYEE, from_date: date, to_date: date });
  return d;
};

describe("the worked example from the approved task", () => {
  it("09:00 09:03 13:00 14:00 18:00 -> effective 09:00 13:00 14:00 18:00; 09:03 is visible only as ignored", async () => {
    const d = await day({
      rawPunches: [
        raw(1, "2026-09-14 09:00:00"), raw(2, "2026-09-14 09:03:00"), raw(3, "2026-09-14 13:00:00"),
        raw(4, "2026-09-14 14:00:00"), raw(5, "2026-09-14 18:00:00"),
      ],
    });
    assert.deepEqual(d.effective_punches.map((p) => p.io_time.slice(11, 16)), ["09:00", "13:00", "14:00", "18:00"]);
    assert.deepEqual(d.effective_punches.map((p) => p.effective_status), ["USED", "USED", "USED", "USED"]);
    assert.equal(d.punch_count, 4);
    assert.deepEqual(d.excluded_punches.map((p) => [p.punch_id, p.effective_status, p.exclusion_reason]), [
      [2, "IGNORED_DUPLICATE", "Duplicate punch within 10 minutes"],
    ]);
    assert.equal(d.excluded_punches[0].duplicate_of_punch_id, 1);
    // every raw punch the engine looked at, counted or not
    assert.deepEqual(d.raw_punch_ids, [1, 2, 3, 4, 5]);
    // 09:00-18:00 = 540 span, gap 13:00-14:00 = 60 charged: worked 480, short 180, no OT
    assert.equal(d.span_minutes, 540);
    assert.equal(d.worked_minutes, 480);
    assert.equal(d.shortage_minutes, 180);
    assert.equal(d.candidate_ot_minutes, 0);
    assert.equal(d.status, CALC_STATUS.FINAL);
  });
});

describe("what an ignored duplicate does NOT do", () => {
  it("14. positional pairing ignores it: the punch after it is still the OUT", async () => {
    const d = await day({ rawPunches: [raw(1, "2026-09-14 09:00:00"), raw(2, "2026-09-14 09:04:00"), raw(3, "2026-09-14 21:00:00")] });
    assert.equal(d.punch_count, 2);
    assert.deepEqual(d.effective_punches.map((p) => p.punch_id), [1, 3]);
    assert.equal(d.status, CALC_STATUS.FINAL);
  });

  it("15. it creates no false Missing Punch: two genuine punches plus one duplicate is a complete day", async () => {
    const d = await day({ rawPunches: [raw(1, "2026-09-14 09:00:00"), raw(2, "2026-09-14 09:04:00"), raw(3, "2026-09-14 21:00:00")] });
    assert.deepEqual(d.review_reasons, []);
    assert.equal(d.is_final, true);
    // and a genuine missing punch is still reported
    const odd = await day({ rawPunches: [raw(1, "2026-09-14 09:00:00"), raw(2, "2026-09-14 09:04:00")] });
    assert.equal(odd.punch_count, 1);
    assert.equal(odd.status, CALC_STATUS.REVIEW_REQUIRED);
    assert.deepEqual(odd.review_reasons, ["MISSING_PUNCH"]);
  });

  it("16. Worked / NRM / Shortage come from the effective stream only", async () => {
    const clean = await day({ rawPunches: [raw(1, "2026-09-14 09:00:00"), raw(2, "2026-09-14 21:00:00")] });
    const noisy = await day({
      rawPunches: [raw(1, "2026-09-14 09:00:00"), raw(2, "2026-09-14 09:02:00"), raw(3, "2026-09-14 09:09:00"), raw(4, "2026-09-14 21:00:00"), raw(5, "2026-09-14 21:05:00")],
    });
    for (const k of ["nrm_minutes", "worked_minutes", "shortage_minutes", "span_minutes", "break_charged_minutes", "punch_count", "status"]) {
      assert.equal(noisy[k], clean[k], k);
    }
    assert.equal(noisy.worked_minutes, 660);
    assert.equal(noisy.shortage_minutes, 0);
    assert.equal(noisy.punch_count, 2);
    assert.equal(noisy.excluded_punches.length, 3);
  });

  it("17. it creates no false OT: a duplicate near the OUT is not a fifth punch and not an unused break", async () => {
    const clean = await day({ rawPunches: [raw(1, "2026-09-14 09:00:00"), raw(2, "2026-09-14 13:00:00"), raw(3, "2026-09-14 14:00:00"), raw(4, "2026-09-14 21:00:00")] });
    const noisy = await day({ rawPunches: [raw(1, "2026-09-14 09:00:00"), raw(2, "2026-09-14 13:00:00"), raw(3, "2026-09-14 14:00:00"), raw(4, "2026-09-14 21:00:00"), raw(5, "2026-09-14 21:06:00")] });
    assert.equal(clean.candidate_ot_minutes, 0);
    assert.equal(noisy.candidate_ot_minutes, 0);
    assert.equal(noisy.punch_count, 4);
  });

  it("11. a REGULARIZED punch is never auto-suppressed, even three minutes after a raw punch", async () => {
    const d = await day({
      rawPunches: [raw(1, "2026-09-14 09:00:00"), raw(2, "2026-09-14 13:00:00"), raw(3, "2026-09-14 14:00:00")],
      regularized: [{ punch_id: 500, employee_id: EMPLOYEE, attendance_date: "2026-09-14", io_time: "2026-09-14 14:03:00", punch_source: "REGULARIZED" }],
    });
    assert.equal(d.punch_count, 4);
    assert.deepEqual(d.effective_punches.map((p) => p.source), ["BIOMAX", "BIOMAX", "BIOMAX", "REGULARIZED"]);
    assert.deepEqual(d.excluded_punches, []);
    assert.equal(d.status, CALC_STATUS.FINAL);
  });

  it("9/10. BIOMAX and IMPORT are one stream: an import three minutes after a device punch is ignored, and vice versa", async () => {
    const a = await day({ rawPunches: [raw(1, "2026-09-14 09:00:00"), imported(2, "2026-09-14 09:03:00"), raw(3, "2026-09-14 21:00:00")] });
    assert.deepEqual(a.excluded_punches.map((p) => [p.punch_id, p.source, p.effective_status]), [[2, "IMPORT", "IGNORED_DUPLICATE"]]);
    const b = await day({ rawPunches: [imported(1, "2026-09-14 09:00:00"), raw(2, "2026-09-14 09:03:00"), imported(3, "2026-09-14 21:00:00")] });
    assert.deepEqual(b.excluded_punches.map((p) => [p.punch_id, p.source]), [[2, "BIOMAX"]]);
    assert.deepEqual(b.effective_punches.map((p) => p.source), ["IMPORT", "IMPORT"]);
  });

  it("12. the midnight boundary: a 00:04 punch after a 23:58 punch is ignored, on an overnight day", async () => {
    // 23:58 is on the 14th; 00:04 on the 15th is before the 04:00 cutoff and
    // therefore also on the 14th. Six minutes apart: the second is ignored,
    // and the 14th is a complete two-punch day rather than a three-punch one.
    const d = await day({ rawPunches: [raw(1, "2026-09-14 09:00:00"), raw(2, "2026-09-14 23:58:00"), raw(3, "2026-09-15 00:04:00")] });
    assert.equal(d.punch_count, 2);
    assert.deepEqual(d.excluded_punches.map((p) => [p.punch_id, p.duplicate_gap_minutes]), [[3, 6]]);
    assert.equal(d.status, CALC_STATUS.FINAL);
  });

  it("12b. the first punch of the range is compared with the last KEPT punch of the day before (the widened window)", async () => {
    // 15th 00:04 is on the 14th by cutoff, so ask for the 14th while the
    // punch that makes it a duplicate is dated the 13th's evening... no: make
    // the comparison cross the FETCH boundary. Calculate the 15th only; its
    // first punch 09:00 has a 08:55 punch on the 15th too - trivially same
    // window. Instead: calculate the 15th; a 03:59 punch on the 15th belongs
    // to the 14th (cutoff), a 04:05 punch belongs to the 15th. They are six
    // minutes apart, so 04:05 is a duplicate of a punch that is NOT on the
    // 15th at all.
    const d = await day({ rawPunches: [raw(1, "2026-09-14 09:00:00"), raw(2, "2026-09-15 03:59:00"), raw(3, "2026-09-15 04:05:00"), raw(4, "2026-09-15 21:00:00")] }, "2026-09-15");
    assert.equal(d.attendance_date, "2026-09-15");
    assert.deepEqual(d.excluded_punches.map((p) => [p.punch_id, p.duplicate_of_punch_id]), [[3, 2]]);
    assert.deepEqual(d.effective_punches.map((p) => p.punch_id), [4]);
    assert.equal(d.status, CALC_STATUS.REVIEW_REQUIRED, "the 15th has one genuine punch");
  });
});

describe("manual voids in the calculation", () => {
  it("30/31. a voided punch is excluded from the calculation and the punch count, and shown as VOIDED with its reason", async () => {
    const d = await day({ rawPunches: [raw(1, "2026-09-14 09:00:00"), voided(2, "2026-09-14 12:30:00", "Accidental terminal scan"), raw(3, "2026-09-14 21:00:00")] });
    assert.equal(d.punch_count, 2);
    assert.deepEqual(d.effective_punches.map((p) => p.punch_id), [1, 3]);
    assert.deepEqual(d.excluded_punches.map((p) => [p.punch_id, p.effective_status, p.exclusion_reason]), [[2, "VOIDED", "Accidental terminal scan"]]);
    assert.equal(d.excluded_punches[0].void.voided_by_employee_id, 7);
    assert.equal(d.status, CALC_STATUS.FINAL);
    assert.equal(d.worked_minutes, 660);
  });

  it("32. a void changes the odd/even Missing Punch result correctly, in both directions", async () => {
    // three punches: missing punch. Void the stray middle one: complete day.
    const before = await day({ rawPunches: [raw(1, "2026-09-14 09:00:00"), raw(2, "2026-09-14 12:30:00"), raw(3, "2026-09-14 21:00:00")] });
    assert.equal(before.status, CALC_STATUS.REVIEW_REQUIRED);
    const after = await day({ rawPunches: [raw(1, "2026-09-14 09:00:00"), voided(2, "2026-09-14 12:30:00"), raw(3, "2026-09-14 21:00:00")] });
    assert.equal(after.status, CALC_STATUS.FINAL);
    // two punches: complete. Void the OUT: missing punch.
    const broken = await day({ rawPunches: [raw(1, "2026-09-14 09:00:00"), voided(2, "2026-09-14 21:00:00", "Wrong employee punch")] });
    assert.equal(broken.punch_count, 1);
    assert.equal(broken.status, CALC_STATUS.REVIEW_REQUIRED);
  });

  it("the order is void first, then the duplicate rule: voiding the kept punch promotes the one it hid", async () => {
    const d = await day({ rawPunches: [voided(1, "2026-09-14 09:00:00"), raw(2, "2026-09-14 09:04:00"), raw(3, "2026-09-14 21:00:00")] });
    assert.deepEqual(d.effective_punches.map((p) => p.punch_id), [2, 3]);
    assert.deepEqual(d.excluded_punches.map((p) => [p.punch_id, p.effective_status]), [[1, "VOIDED"]]);
  });
});

describe("recalculation and storage", () => {
  it("18. recalculation applies the rule to historical data and stores the effective result under the new version", async () => {
    const repo = fakeRepo({ rawPunches: [raw(1, "2026-09-01 09:00:00"), raw(2, "2026-09-01 09:04:00"), raw(3, "2026-09-01 21:00:00")] });
    const result = await buildUsecase(repo).recalculateRange({ employee_id: EMPLOYEE, from_date: "2026-09-01", to_date: "2026-09-01" });
    const [batch] = repo.saved.calculations;
    assert.equal(result.written, 1);
    assert.equal(batch[0].punch_count, 2);
    assert.deepEqual(JSON.parse(batch[0].raw_punch_ids), [1, 2, 3], "every raw punch is still named on the stored row");
    assert.deepEqual(JSON.parse(batch[0].effective_punches).map((p) => p.punch_id), [1, 3]);
    assert.equal(batch[0].calculation_version, CALCULATION_VERSION);
    assert.equal(CALCULATION_VERSION, 2, "historical results can differ, so the version is bumped");
    assert.equal(batch[0].status, CALC_STATUS.FINAL);
  });

  it("19. the raw records are never changed: the repository's rows are byte-identical after calculating and storing", async () => {
    const repo = fakeRepo({ rawPunches: [raw(1, "2026-09-14 09:00:00"), raw(2, "2026-09-14 09:04:00"), voided(3, "2026-09-14 13:00:00"), raw(4, "2026-09-14 21:00:00")] });
    const snapshot = JSON.stringify(repo.rawPunches);
    const usecase = buildUsecase(repo);
    await usecase.calculateRange({ employee_id: EMPLOYEE, from_date: "2026-09-14", to_date: "2026-09-14" });
    await usecase.recalculateRange({ employee_id: EMPLOYEE, from_date: "2026-09-14", to_date: "2026-09-14" });
    assert.equal(JSON.stringify(repo.rawPunches), snapshot);
    assert.equal(repo.saved.calculations.length, 1, "only the calculation table was written");
  });

  it("the stored effective punches carry their USED status and the excluded ones are not among them", async () => {
    const repo = fakeRepo({ rawPunches: [raw(1, "2026-09-14 09:00:00"), raw(2, "2026-09-14 09:04:00"), raw(3, "2026-09-14 21:00:00")] });
    await buildUsecase(repo).recalculateRange({ employee_id: EMPLOYEE, from_date: "2026-09-14", to_date: "2026-09-14" });
    const stored = JSON.parse(repo.saved.calculations[0][0].effective_punches);
    assert.deepEqual(stored.map((p) => p.effective_status), ["USED", "USED"]);
  });
});
