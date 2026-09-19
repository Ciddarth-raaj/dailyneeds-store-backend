/**
 * THE SHARED MISSING ATTENDANCE RULE, on its own.
 *
 *   node --test utils/attendance_missing.test.js
 *
 * Pure, so there is no fake here and nothing is mocked: the rule takes an
 * employee row, a date, a computed day and today's business date, and
 * answers. Every case the approved definition names is asserted, and the
 * odd-number logic is asserted WELL PAST 5 - the one thing a hard-coded
 * `[1, 3, 5]` would pass and this must not.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const missing = require("../utils/attendance_missing");

const TODAY = "2026-09-19";
const YESTERDAY = "2026-09-18";

/** An ordinary employee: attendance required, no dated bound either side. */
const employee = (over = {}) => ({
  employee_id: 42,
  attendance_required: 1,
  joined_on: null,
  resignation_date: null,
  ...over,
});

const day = (punch_count) => ({ punch_count });

describe("the punch-count half of the rule", () => {
  it("0 punches is ABSENCE, not missing attendance", () => {
    assert.equal(missing.isMissingPunchCount(0), false);
  });

  it("every odd count is missing attendance, every even count is not - well past 5", () => {
    const expected = {
      0: false, 1: true, 2: false, 3: true, 4: false, 5: true, 6: false,
      7: true, 8: false, 9: true, 10: false, 11: true, 99: true, 100: false,
    };
    Object.entries(expected).forEach(([count, isMissing]) => {
      assert.equal(
        missing.isMissingPunchCount(Number(count)),
        isMissing,
        `${count} punches should ${isMissing ? "" : "not "}be missing attendance`
      );
    });
  });

  it("an unreadable count is neither odd nor positive, so it is excluded either way", () => {
    [null, undefined, "", "three", NaN, -1].forEach((value) => {
      assert.equal(missing.isMissingPunchCount(value), false, `${String(value)} is not a punch count`);
      assert.equal(missing.punchCountOf(value), null);
    });
  });
});

describe("the date half of the rule", () => {
  it("the latest reportable date is YESTERDAY, never today", () => {
    assert.equal(missing.latestReportableDate(TODAY), YESTERDAY);
    assert.equal(missing.isCompletedAttendanceDate(TODAY, TODAY), false);
    assert.equal(missing.isCompletedAttendanceDate(YESTERDAY, TODAY), true);
  });

  it("future dates are excluded", () => {
    assert.equal(missing.isCompletedAttendanceDate("2026-09-20", TODAY), false);
    assert.equal(missing.isCompletedAttendanceDate("2027-01-01", TODAY), false);
  });

  it("it crosses a month and a year boundary by UTC arithmetic, not local midnight", () => {
    assert.equal(missing.latestReportableDate("2026-10-01"), "2026-09-30");
    assert.equal(missing.latestReportableDate("2027-01-01"), "2026-12-31");
    assert.equal(missing.latestReportableDate("2028-03-01"), "2028-02-29");
  });

  it("clamps a range that runs into today, and says that it did", () => {
    const window = missing.clampToReportable({ from: "2026-09-01", to: TODAY, today: TODAY });
    assert.deepEqual(
      { from: window.from, to: window.to, clamped: window.clamped },
      { from: "2026-09-01", to: YESTERDAY, clamped: true }
    );
  });

  it("leaves a range that has wholly completed alone", () => {
    const window = missing.clampToReportable({ from: "2026-09-01", to: "2026-09-10", today: TODAY });
    assert.deepEqual(
      { from: window.from, to: window.to, clamped: window.clamped },
      { from: "2026-09-01", to: "2026-09-10", clamped: false }
    );
  });

  it("a range wholly in the future or wholly on today yields nothing at all", () => {
    assert.equal(missing.clampToReportable({ from: TODAY, to: TODAY, today: TODAY }), null);
    assert.equal(missing.clampToReportable({ from: "2026-10-01", to: "2026-10-05", today: TODAY }), null);
  });
});

describe("the whole rule", () => {
  it("includes an eligible employee with an odd count on a completed date", () => {
    assert.equal(
      missing.isMissingAttendance({ employee: employee(), date: YESTERDAY, day: day(3), today: TODAY }),
      true
    );
  });

  it("excludes today even when the count is odd - the day is still being punched", () => {
    assert.equal(
      missing.isMissingAttendance({ employee: employee(), date: TODAY, day: day(1), today: TODAY }),
      false
    );
    assert.equal(
      missing.exclusionReason({ employee: employee(), date: TODAY, day: day(1), today: TODAY }),
      missing.EXCLUSION.DATE_NOT_COMPLETED
    );
  });

  it("excludes an attendance-exempt employee whatever the count", () => {
    const exempt = employee({ attendance_required: 0 });
    assert.equal(
      missing.isMissingAttendance({ employee: exempt, date: YESTERDAY, day: day(3), today: TODAY }),
      false
    );
    assert.equal(
      missing.exclusionReason({ employee: exempt, date: YESTERDAY, day: day(3), today: TODAY }),
      missing.EXCLUSION.NOT_ELIGIBLE
    );
  });

  it("excludes dates before the joining date and after the resignation date", () => {
    const joiner = employee({ joined_on: "2026-09-18" });
    assert.equal(
      missing.isMissingAttendance({ employee: joiner, date: "2026-09-17", day: day(1), today: TODAY }),
      false
    );
    assert.equal(
      missing.isMissingAttendance({ employee: joiner, date: "2026-09-18", day: day(1), today: TODAY }),
      true
    );

    const leaver = employee({ resignation_date: "2026-09-16" });
    assert.equal(
      missing.isMissingAttendance({ employee: leaver, date: "2026-09-17", day: day(1), today: TODAY }),
      false
    );
    assert.equal(
      missing.isMissingAttendance({ employee: leaver, date: "2026-09-16", day: day(1), today: TODAY }),
      true
    );
  });

  it("does not consult `status` - a leaver left at status 1 is still out by their dated facts", () => {
    const stale = employee({ status: 1, resignation_date: "2020-01-01" });
    assert.equal(
      missing.isMissingAttendance({ employee: stale, date: YESTERDAY, day: day(1), today: TODAY }),
      false
    );
  });

  it("names exactly one reason per exclusion, and null when the day IS missing attendance", () => {
    const cases = [
      [employee({ attendance_required: 0 }), YESTERDAY, day(3), missing.EXCLUSION.NOT_ELIGIBLE],
      [employee(), TODAY, day(3), missing.EXCLUSION.DATE_NOT_COMPLETED],
      [employee(), YESTERDAY, day(0), missing.EXCLUSION.NO_PUNCHES],
      [employee(), YESTERDAY, day(4), missing.EXCLUSION.EVEN_PUNCH_COUNT],
      [employee(), YESTERDAY, day(5), null],
    ];
    cases.forEach(([emp, date, d, expected]) => {
      assert.equal(missing.exclusionReason({ employee: emp, date, day: d, today: TODAY }), expected);
    });
  });
});
