/**
 * The 3-Day Absent rule, as pure arithmetic over stored engine days.
 *
 *   node --test utils/payrun_absence_review.test.js
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  absenceReview,
  reviewWindow,
  workingFlag,
  LOOKBACK_DAYS,
  EVALUATION,
  NOT_EVALUABLE_REASON: R,
} = require("./payrun_absence_review");

/* A review whose latest completed date is 30 Sep (made on 1 Oct). */
const SEP = { latest_completed: "2026-09-30" };
/* A review made on 4 Oct: the walk starts at 3 Oct. */
const OCT4 = { latest_completed: "2026-10-03" };
const day = (date, over = {}) => ({
  attendance_date: date,
  status: "ABSENT",
  is_final: 1,
  punch_count: 0,
  attendance_day_count: 0,
  attendance_calculation_mode: "SHIFT_BASED",
  is_working_day: "true",
  ...over,
});
const worked = (date) => day(date, { status: "FINAL", punch_count: 2, attendance_day_count: 1 });

test("Sep 28-30 all calculated Absent -> classified", () => {
  const r = absenceReview([worked("2026-09-27"), day("2026-09-28"), day("2026-09-29"), day("2026-09-30")], SEP);
  assert.equal(r.evaluation, EVALUATION.THREE_DAY_ABSENT);
  assert.deepEqual(r.absent_dates, ["2026-09-28", "2026-09-29", "2026-09-30"]);
  assert.equal(r.last_present_date, "2026-09-27");
});

test("Sep 30 uncalculated, Sep 27-29 Absent -> NOT classified (no stepping past a missing calculation)", () => {
  const r = absenceReview([day("2026-09-27"), day("2026-09-28"), day("2026-09-29")], SEP);
  assert.equal(r.three_day_absent, false);
  assert.equal(r.evaluation, EVALUATION.NOT_EVALUABLE);
  assert.equal(r.not_evaluable_reason, R.NOT_CALCULATED);
  assert.equal(r.not_evaluable_date, "2026-09-30");
  assert.deepEqual(r.absent_dates, []);
});

test("Sep 29 weekly off; Sep 27/28/30 Absent -> classified", () => {
  const r = absenceReview(
    [worked("2026-09-26"), day("2026-09-27"), day("2026-09-28"), day("2026-09-29", { is_working_day: "false" }), day("2026-09-30")],
    SEP
  );
  assert.equal(r.three_day_absent, true);
  assert.deepEqual(r.absent_dates, ["2026-09-27", "2026-09-28", "2026-09-30"]);
});

test("a Present day breaks the sequence", () => {
  const r = absenceReview([day("2026-09-27"), day("2026-09-28"), worked("2026-09-29"), day("2026-09-30")], SEP);
  assert.equal(r.evaluation, EVALUATION.NOT_ABSENT);
});

test("pending / unresolved / not final is never Absent", () => {
  for (const over of [
    { status: "REGULARIZATION_PENDING", is_final: 0 },
    { status: "REVIEW_REQUIRED", is_final: 0 },
    { status: "OT_PENDING", is_final: 0 },
    { status: "ABSENT", is_final: 0 },
  ]) {
    const r = absenceReview([day("2026-09-27"), day("2026-09-28"), day("2026-09-29", over), day("2026-09-30")], SEP);
    assert.equal(r.three_day_absent, false, JSON.stringify(over));
    assert.equal(r.not_evaluable_reason, R.UNRESOLVED);
  }
});

test("Present/Absent Only: no working-day source, so not evaluable - never every-date-is-a-workday", () => {
  const pa = { attendance_calculation_mode: "PRESENT_ABSENT_ONLY", is_working_day: null };
  const r = absenceReview([day("2026-09-28", pa), day("2026-09-29", pa), day("2026-09-30", pa)], SEP);
  assert.equal(r.three_day_absent, false);
  assert.equal(r.not_evaluable_reason, R.NO_WORKING_DAY_SOURCE);
});

test("only genuinely non-applicable dates are skipped", () => {
  // Not required: skipped.
  const exempt = absenceReview(
    [day("2026-09-27"), day("2026-09-28"), day("2026-09-29", { status: "ATTENDANCE_NOT_REQUIRED" }), day("2026-09-30")],
    SEP
  );
  assert.equal(exempt.three_day_absent, true);
  // No shift: a setup fault, stops the walk.
  for (const status of ["NO_SHIFT_FOR_DATE", "NO_SCHEDULE_ROW"]) {
    const r = absenceReview([day("2026-09-27"), day("2026-09-28"), day("2026-09-29", { status, is_working_day: null }), day("2026-09-30")], SEP);
    assert.equal(r.not_evaluable_reason, R.NO_SHIFT, status);
  }
  // An unreadable working-day flag: stops the walk.
  const unknown = absenceReview([day("2026-09-28"), day("2026-09-29", { is_working_day: null }), day("2026-09-30")], SEP);
  assert.equal(unknown.not_evaluable_reason, R.WORKING_DAY_UNKNOWN);
});

test("dates after the latest completed date are never read", () => {
  // Latest completed 29 Sep: the stored 30 Sep row is ignored, 29/28 absent, 27 worked.
  const r = absenceReview(
    [worked("2026-09-27"), day("2026-09-28"), day("2026-09-29"), day("2026-09-30")],
    { latest_completed: "2026-09-29" }
  );
  assert.equal(r.evaluation, EVALUATION.NOT_ABSENT);
  assert.equal(r.last_present_date, "2026-09-27");
});

/* --------------------------------------------- as of today, across months */

test("REGRESSION (Devi G): Sep 28-30 absent, Oct 1-2 absent, Oct 3 present, reviewed 4 Oct -> false", () => {
  const r = absenceReview(
    [day("2026-09-28"), day("2026-09-29"), day("2026-09-30"), day("2026-10-01"), day("2026-10-02"), worked("2026-10-03")],
    OCT4
  );
  assert.equal(r.three_day_absent, false);
  assert.equal(r.evaluation, EVALUATION.NOT_ABSENT);
  assert.equal(r.last_present_date, "2026-10-03");
});

test("Oct 1-3 absent, reviewed 4 Oct -> true, with the October dates", () => {
  const r = absenceReview([worked("2026-09-30"), day("2026-10-01"), day("2026-10-02"), day("2026-10-03")], OCT4);
  assert.equal(r.three_day_absent, true);
  assert.deepEqual(r.absent_dates, ["2026-10-01", "2026-10-02", "2026-10-03"]);
});

test("across the boundary: Sep 30 + Oct 1 + Oct 3 absent, Oct 2 weekly off -> true", () => {
  const r = absenceReview(
    [day("2026-09-30"), day("2026-10-01"), day("2026-10-02", { is_working_day: "false" }), day("2026-10-03")],
    OCT4
  );
  assert.deepEqual(r.absent_dates, ["2026-09-30", "2026-10-01", "2026-10-03"]);
});

test("latest day present / middle day present -> false", () => {
  assert.equal(absenceReview([day("2026-10-01"), day("2026-10-02"), worked("2026-10-03")], OCT4).three_day_absent, false);
  assert.equal(
    absenceReview([day("2026-09-30"), day("2026-10-01"), worked("2026-10-02"), day("2026-10-03")], OCT4).three_day_absent,
    false
  );
});

test("latest applicable day uncalculated -> not evaluable, never stepping back into September", () => {
  const r = absenceReview([day("2026-09-28"), day("2026-09-29"), day("2026-09-30"), day("2026-10-01"), day("2026-10-02")], OCT4);
  assert.equal(r.not_evaluable_reason, R.NOT_CALCULATED);
  assert.equal(r.not_evaluable_date, "2026-10-03");
});

test("the read window is the LOOKBACK_DAYS ending at the latest completed date", () => {
  assert.equal(LOOKBACK_DAYS, 31);
  assert.deepEqual(reviewWindow("2026-10-03"), { from: "2026-09-03", to: "2026-10-03" });
  assert.equal(reviewWindow(null), null);
  assert.equal(absenceReview([], {}).not_evaluable_reason, R.NO_REVIEW_DATE);
});

test("a whole window of rest days is not evaluable rather than reaching further back", () => {
  const rests = [];
  for (let i = 0; i < LOOKBACK_DAYS; i += 1) {
    const d = new Date(Date.UTC(2026, 9, 3 - i)).toISOString().slice(0, 10);
    rests.push(day(d, { is_working_day: "false" }));
  }
  assert.equal(absenceReview(rests, OCT4).not_evaluable_reason, R.LOOKBACK_EXHAUSTED);
});

test("fewer than three applicable days since joining is not absent", () => {
  const r = absenceReview([day("2026-09-29"), day("2026-09-30")], { ...SEP, joined_on: "2026-09-29" });
  assert.equal(r.evaluation, EVALUATION.NOT_ABSENT);
});

test("the JSON flag is read in every shape MySQL can hand it back", () => {
  [true, 1, "1", "true"].forEach((v) => assert.equal(workingFlag(v), true));
  [false, 0, "0", "false"].forEach((v) => assert.equal(workingFlag(v), false));
  [null, undefined, "", "null"].forEach((v) => assert.equal(workingFlag(v), null));
});
