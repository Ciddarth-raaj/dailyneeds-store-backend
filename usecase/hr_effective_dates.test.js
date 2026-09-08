/**
 * Stage 0C / C3 — effective dates and employment-period boundaries.
 *
 *   node --test usecase/hr_effective_dates.test.js
 *
 * These are the rules Assignment, Default Shift and Salary all run on, so a
 * mistake here is a mistake in three places at once. The cases that matter
 * most are the ones that look like arithmetic and are actually policy:
 *
 *   a replacement boundary belongs to the NEW row
 *   a second business change on one date is a correction, not a change
 *   an unknown employment boundary is skipped, never invented
 *   a baseline row is never read backwards
 */
const test = require("node:test");
const assert = require("node:assert");

const {
  toDate,
  addDays,
  covers,
  overlaps,
  rowCovering,
  currentRow,
  assertWithinPeriod,
  assertNotLocked,
  assertNoSameDayBusinessChange,
  assertNoOverlap,
  closeCurrentAt,
  resolveAsOf,
} = require("./hr_effective_dates");

const throwsCode = (fn, code) =>
  assert.throws(fn, (err) => {
    assert.strictEqual(err.code, code, `expected ${code}, got ${err.code}: ${err.message}`);
    return true;
  });

const openPeriod = (over = {}) => ({
  period_id: 1,
  period_state: "open",
  joined_on: "2024-01-01",
  ended_on: null,
  history_locked_through: null,
  ...over,
});

/* ================================================================= dates */
test("a date must be a real calendar date, not something that looks like one", () => {
  assert.strictEqual(toDate("2026-09-01"), "2026-09-01");
  assert.strictEqual(toDate("2026-09-01T00:00:00.000Z"), "2026-09-01");
  assert.strictEqual(toDate(new Date(Date.UTC(2026, 8, 1))), "2026-09-01");

  // JavaScript would roll 30 February into March without complaint. A wrong
  // effective date is a wrong pay period.
  assert.strictEqual(toDate("2026-02-30"), null);
  assert.strictEqual(toDate("2026-13-01"), null);
  assert.strictEqual(toDate("01-09-2026"), null);
  assert.strictEqual(toDate("today"), null);
  assert.strictEqual(toDate(""), null);
  assert.strictEqual(toDate(null), null);
});

test("leap days are real dates, and non-leap 29 February is not", () => {
  assert.strictEqual(toDate("2024-02-29"), "2024-02-29");
  assert.strictEqual(toDate("2026-02-29"), null);
});

test("date arithmetic crosses month and year boundaries", () => {
  assert.strictEqual(addDays("2026-08-31", 1), "2026-09-01");
  assert.strictEqual(addDays("2026-12-31", 1), "2027-01-01");
  assert.strictEqual(addDays("2024-02-28", 1), "2024-02-29");
});

/* ============================================================= intervals */
test("THE END DATE IS EXCLUSIVE", () => {
  const row = { effective_from: "2026-01-01", effective_to: "2026-09-01" };
  assert.strictEqual(covers(row, "2026-01-01"), true, "the start is included");
  assert.strictEqual(covers(row, "2026-08-31"), true, "the day before the end is included");
  assert.strictEqual(covers(row, "2026-09-01"), false, "the end date itself is NOT");
  assert.strictEqual(covers(row, "2025-12-31"), false);
});

test("an open row covers every date from its start, including future ones", () => {
  const row = { effective_from: "2026-09-01", effective_to: null };
  assert.strictEqual(covers(row, "2026-09-01"), true);
  assert.strictEqual(covers(row, "2099-01-01"), true, "today's assignment applies next year too");
  assert.strictEqual(covers(row, "2026-08-31"), false);
});

test("touching intervals do not overlap - that is what makes replacement legal", () => {
  const a = { effective_from: "2026-01-01", effective_to: "2026-09-01" };
  const b = { effective_from: "2026-09-01", effective_to: null };
  assert.strictEqual(overlaps(a, b), false);
  assert.strictEqual(overlaps(b, a), false);
});

test("genuinely overlapping intervals are detected in both directions", () => {
  const a = { effective_from: "2026-01-01", effective_to: "2026-09-02" };
  const b = { effective_from: "2026-09-01", effective_to: null };
  assert.strictEqual(overlaps(a, b), true);
  assert.strictEqual(overlaps(b, a), true);
});

test("a one-day interval is distinguishable from a zero-day one", () => {
  const oneDay = { effective_from: "2026-09-01", effective_to: "2026-09-02" };
  assert.strictEqual(covers(oneDay, "2026-09-01"), true);
  assert.strictEqual(covers(oneDay, "2026-09-02"), false);
});

test("the covering row is found, and voided rows are not history", () => {
  const rows = [
    { assignment_id: 1, effective_from: "2026-01-01", effective_to: "2026-09-01" },
    { assignment_id: 2, effective_from: "2026-09-01", effective_to: null },
    { assignment_id: 3, effective_from: "2026-09-01", effective_to: null, voided_at: "2026-09-02" },
  ];
  assert.strictEqual(rowCovering(rows, "2026-05-01").assignment_id, 1);
  assert.strictEqual(rowCovering(rows, "2026-09-01").assignment_id, 2);
  assert.strictEqual(currentRow(rows).assignment_id, 2, "the voided row is not current");
});

/* ================================================== period boundaries == */
test("history cannot begin before the employment period did", () => {
  throwsCode(
    () => assertWithinPeriod(openPeriod(), { effective_from: "2023-06-01", effective_to: null }),
    "BEFORE_PERIOD_START"
  );
});

test("history may begin exactly on the joining date", () => {
  assert.ok(assertWithinPeriod(openPeriod(), { effective_from: "2024-01-01", effective_to: null }));
});

test("AN UNKNOWN JOINING DATE IS SKIPPED, NEVER INVENTED", () => {
  // 424 of the 629 employees C1 backfilled have no joining date. Fabricating
  // one to satisfy validation would put a number in the system that looks
  // like evidence and is not.
  const noJoinDate = openPeriod({ joined_on: null });
  assert.ok(assertWithinPeriod(noJoinDate, { effective_from: "2019-01-01", effective_to: null }));
  assert.ok(assertWithinPeriod(noJoinDate, { effective_from: "2026-09-15", effective_to: null }));
});

test("an open row cannot sit on a period that has ended", () => {
  const closed = openPeriod({ period_state: "closed", ended_on: "2026-06-30" });
  throwsCode(
    () => assertWithinPeriod(closed, { effective_from: "2026-01-01", effective_to: null }),
    "OPEN_ROW_ON_CLOSED_PERIOD"
  );
});

test("a closed row may end the day after the last day employed, and no later", () => {
  const closed = openPeriod({ period_state: "closed", ended_on: "2026-06-30" });
  // ended_on is the last day employed; the exclusive bound is the next day.
  assert.ok(assertWithinPeriod(closed, { effective_from: "2026-01-01", effective_to: "2026-07-01" }));
  throwsCode(
    () => assertWithinPeriod(closed, { effective_from: "2026-01-01", effective_to: "2026-07-02" }),
    "EXTENDS_PAST_PERIOD_END"
  );
});

test("history cannot start after the employee had already left", () => {
  const closed = openPeriod({ period_state: "closed", ended_on: "2026-06-30" });
  throwsCode(
    () => assertWithinPeriod(closed, { effective_from: "2026-07-01", effective_to: "2026-08-01" }),
    "AFTER_PERIOD_END"
  );
});

test("a zero-length or inverted interval is refused with a useful message", () => {
  throwsCode(
    () => assertWithinPeriod(openPeriod(), { effective_from: "2026-09-01", effective_to: "2026-09-01" }),
    "EMPTY_INTERVAL"
  );
  throwsCode(
    () => assertWithinPeriod(openPeriod(), { effective_from: "2026-09-05", effective_to: "2026-09-01" }),
    "EMPTY_INTERVAL"
  );
});

test("a malformed effective date is refused rather than guessed", () => {
  throwsCode(() => assertWithinPeriod(openPeriod(), { effective_from: "not-a-date" }), "BAD_EFFECTIVE_FROM");
  throwsCode(
    () => assertWithinPeriod(openPeriod(), { effective_from: "2026-09-01", effective_to: "2026-02-30" }),
    "BAD_EFFECTIVE_TO"
  );
});

/* ========================================================= the lock ==== */
test("the lock is checked even though it is NULL today", () => {
  assert.ok(assertNotLocked(openPeriod(), "2026-09-01"));
});

test("a change inside finalized history is refused", () => {
  const locked = openPeriod({ history_locked_through: "2026-08-31" });
  throwsCode(() => assertNotLocked(locked, "2026-08-15"), "HISTORY_LOCKED");
  throwsCode(() => assertNotLocked(locked, "2026-08-31"), "HISTORY_LOCKED");
  assert.ok(assertNotLocked(locked, "2026-09-01"), "the day after the lock is open");
});

/* ================================================ same-day and overlap = */
test("A SECOND BUSINESS CHANGE ON THE SAME DATE IS REFUSED", () => {
  // Nobody transfers twice in one day. The second entry is a correction of
  // the first, and closing the first at the second's start would produce a
  // zero-length row anyway.
  const rows = [{ assignment_id: 7, effective_from: "2026-09-01", effective_to: null }];
  throwsCode(() => assertNoSameDayBusinessChange(rows, "2026-09-01"), "SAME_DAY_CHANGE");
  assert.ok(assertNoSameDayBusinessChange(rows, "2026-09-02"));
});

test("a voided row does not block a new change on its date", () => {
  const rows = [
    { assignment_id: 7, effective_from: "2026-09-01", effective_to: null, voided_at: "2026-09-01" },
  ];
  assert.ok(assertNoSameDayBusinessChange(rows, "2026-09-01"));
});

test("overlapping history is refused, and a row being replaced can be ignored", () => {
  const rows = [{ assignment_id: 1, effective_from: "2026-01-01", effective_to: "2026-09-01" }];
  assert.ok(assertNoOverlap(rows, { effective_from: "2026-09-01", effective_to: null }));
  throwsCode(
    () => assertNoOverlap(rows, { effective_from: "2026-08-01", effective_to: null }),
    "OVERLAPPING_HISTORY"
  );
  // The row under correction is excluded by id.
  assert.ok(assertNoOverlap(rows, { effective_from: "2026-08-01", effective_to: null }, [1]));
});

test("a replacement closes the current row AT its own start date", () => {
  const current = { assignment_id: 1, effective_from: "2026-01-01", effective_to: null };
  assert.strictEqual(closeCurrentAt(current, "2026-09-01"), "2026-09-01");
  // Which is what makes the boundary belong to the new row.
  const closed = { ...current, effective_to: "2026-09-01" };
  assert.strictEqual(covers(closed, "2026-09-01"), false);
});

test("a replacement cannot be effective on or before the row it replaces", () => {
  const current = { assignment_id: 1, effective_from: "2026-09-01", effective_to: null };
  throwsCode(() => closeCurrentAt(current, "2026-09-01"), "REPLACEMENT_NOT_AFTER_CURRENT");
  throwsCode(() => closeCurrentAt(current, "2026-08-01"), "REPLACEMENT_NOT_AFTER_CURRENT");
});

/* ====================================== the pre-go-live query boundary = */
test("A BASELINE ROW IS NEVER READ BACKWARDS", () => {
  // The baseline says "20,000 as of go-live". It does not say July was
  // 20,000 - July might have been 18,000, and the system does not know.
  const rows = [
    {
      salary_history_id: 1,
      effective_from: "2026-09-15",
      effective_to: null,
      effective_from_precision: "UNKNOWN_BASELINE",
    },
  ];
  const july = resolveAsOf(rows, "2026-07-01", { goLiveDate: "2026-09-15" });
  assert.strictEqual(july.known, false);
  assert.strictEqual(july.reason, "BEFORE_GO_LIVE");
  assert.strictEqual(july.row, null);

  // On and after go-live it answers normally.
  const later = resolveAsOf(rows, "2026-10-01", { goLiveDate: "2026-09-15" });
  assert.strictEqual(later.known, true);
  assert.strictEqual(later.row.salary_history_id, 1);
});

test("verified pre-go-live history DOES answer, because it is evidence", () => {
  const rows = [
    {
      salary_history_id: 9,
      effective_from: "2026-04-01",
      effective_to: "2026-09-15",
      effective_from_precision: "KNOWN",
    },
    {
      salary_history_id: 1,
      effective_from: "2026-09-15",
      effective_to: null,
      effective_from_precision: "UNKNOWN_BASELINE",
    },
  ];
  const july = resolveAsOf(rows, "2026-07-01", { goLiveDate: "2026-09-15" });
  assert.strictEqual(july.known, true);
  assert.strictEqual(july.row.salary_history_id, 9);
});

test("a gap before go-live is reported as unknown, not filled in", () => {
  const rows = [
    { salary_history_id: 1, effective_from: "2026-09-15", effective_to: null, effective_from_precision: "UNKNOWN_BASELINE" },
  ];
  const r = resolveAsOf(rows, "2026-09-14", { goLiveDate: "2026-09-15" });
  assert.strictEqual(r.known, false);
  assert.strictEqual(r.reason, "BEFORE_GO_LIVE");
});

test("with no history at all, the answer is unknown rather than empty", () => {
  const r = resolveAsOf([], "2026-10-01", { goLiveDate: "2026-09-15" });
  assert.strictEqual(r.known, false);
  assert.strictEqual(r.reason, "NO_AUTHORITATIVE_HISTORY");
});
