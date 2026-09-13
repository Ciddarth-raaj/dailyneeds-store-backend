/**
 * The Attendance Dashboard's PURE classification.
 *
 *   node --test utils/attendance_dashboard.test.js
 *
 * What these defend is the honesty of the buckets, which is the whole risk in
 * a dashboard like this: that it reports a confirmed absence for somebody
 * whose shift has not started, a missing punch for somebody who is still at
 * work, or a 0% attendance rate for a branch that employs nobody. Every test
 * pins `now` explicitly, so none of them depends on the time of day it runs.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  COVERAGE,
  ISSUE_KEY,
  PRESENCE_SLICE,
  PRESENCE_SLICE_ORDER,
  dashboardIssueKey,
  dayCloseMinute,
  dayIssueKey,
  hasShiftStarted,
  isDayClosed,
  istNowParts,
  locationCoverage,
  nowOnDateAxis,
  presenceSlice,
  rate,
  timeMinutes,
  unresolvedReason,
} = require("./attendance_dashboard");

/** Shorthand: the common case in these tests is a fully delivered day. */
const covered = COVERAGE.COMPLETE;

/** An IST instant as epoch millis: IST is UTC+5:30, so subtract the offset. */
const ist = (date, hh, mm) =>
  Date.UTC(
    Number(date.slice(0, 4)),
    Number(date.slice(5, 7)) - 1,
    Number(date.slice(8, 10)),
    hh,
    mm
  ) - (5 * 60 + 30) * 60 * 1000;

/** A 10:00-22:00 shift whose attendance day runs to 04:00 the next morning. */
const nightish = {
  is_working_day: true,
  in_time: "10:00:00",
  out_time: "22:00:00",
  attendance_day_cutoff: "04:00:00",
};

/** A 09:00-18:00 shift with no cutoff configured. */
const dayShift = {
  is_working_day: true,
  in_time: "09:00:00",
  out_time: "18:00:00",
  attendance_day_cutoff: null,
};

describe("IST now", () => {
  it("reads the IST business date and minutes, not the process zone", () => {
    // 23:45 UTC on the 11th is 05:15 IST on the 12th.
    const parts = istNowParts(Date.UTC(2026, 8, 11, 23, 45));
    assert.equal(parts.date, "2026-09-12");
    assert.equal(parts.minutes, 5 * 60 + 15);
  });

  it("puts the following calendar morning on the attendance date's own axis", () => {
    // 02:00 IST on the 13th, as seen from attendance date the 12th.
    assert.equal(nowOnDateAxis("2026-09-12", ist("2026-09-13", 2, 0)), 1440 + 120);
    assert.equal(nowOnDateAxis("2026-09-12", ist("2026-09-12", 10, 30)), 630);
  });
});

describe("the attendance day boundary is the shift's cutoff, not midnight", () => {
  it("closes a 04:00-cutoff day at 04:00 the NEXT morning", () => {
    assert.equal(dayCloseMinute(nightish), 1440 + 240);
  });

  it("closes a day with no cutoff at the next midnight", () => {
    assert.equal(dayCloseMinute(dayShift), 1440);
  });

  it("a rest day never claims the following morning", () => {
    assert.equal(dayCloseMinute({ ...nightish, is_working_day: false }), 1440);
  });

  it("is NOT closed at 01:00 the next morning when the cutoff is 04:00", () => {
    assert.equal(
      isDayClosed({
        attendance_date: "2026-09-12",
        snapshot: nightish,
        now: ist("2026-09-13", 1, 0),
      }),
      false,
      "a night-shift employee finishing at 00:30 is still inside their attendance day"
    );
  });

  it("IS closed at 04:00 the next morning, exactly", () => {
    assert.equal(
      isDayClosed({
        attendance_date: "2026-09-12",
        snapshot: nightish,
        now: ist("2026-09-13", 4, 0),
      }),
      true
    );
  });

  it("treats an unresolvable shift as closed at midnight rather than open for ever", () => {
    assert.equal(
      isDayClosed({ attendance_date: "2026-09-12", snapshot: null, now: ist("2026-09-13", 0, 1) }),
      true
    );
  });
});

describe("has the shift started", () => {
  it("no, before in-time", () => {
    assert.equal(
      hasShiftStarted({
        attendance_date: "2026-09-12",
        snapshot: nightish,
        now: ist("2026-09-12", 9, 59),
      }),
      false
    );
  });

  it("yes, at in-time", () => {
    assert.equal(
      hasShiftStarted({
        attendance_date: "2026-09-12",
        snapshot: nightish,
        now: ist("2026-09-12", 10, 0),
      }),
      true
    );
  });

  it("unknown is NOT started: no snapshot, no in-time, or a rest day", () => {
    const now = ist("2026-09-12", 23, 0);
    assert.equal(hasShiftStarted({ attendance_date: "2026-09-12", snapshot: null, now }), false);
    assert.equal(
      hasShiftStarted({ attendance_date: "2026-09-12", snapshot: { ...nightish, in_time: null }, now }),
      false
    );
    assert.equal(
      hasShiftStarted({
        attendance_date: "2026-09-12",
        snapshot: { ...nightish, is_working_day: false },
        now,
      }),
      false,
      "a rest day has no start, so nobody on one is ever 'late'"
    );
  });
});

/**
 * THE SHARED STATUS -> ISSUE TABLE.
 *
 * Spelled out literally, and spelled out again in the frontend's
 * `util/attendanceDashboard.test.js`. The two repositories cannot import each
 * other, so this table IS the contract between them: if the mapping changes on
 * either side, that side's suite fails until the table is edited, and the
 * table is what a reviewer compares across the two files.
 *
 * Column meanings: the engine `status`, the review reasons it carried, the
 * effective punch count, and the issue key staff see for it.
 */
const SHARED_ISSUE_TABLE = [
  { status: "FINAL", reasons: [], punch_count: 2, issue: null },
  { status: "ABSENT", reasons: [], punch_count: 0, issue: "ABSENT" },
  { status: "REGULARIZATION_PENDING", reasons: [], punch_count: 1, issue: "REGULARIZATION_PENDING" },
  { status: "NO_SHIFT_FOR_DATE", reasons: ["NO_SHIFT_FOR_DATE"], punch_count: 0, issue: "NO_SHIFT" },
  { status: "NO_SCHEDULE_ROW", reasons: ["NO_SCHEDULE_ROW"], punch_count: 0, issue: "SHIFT_SETUP" },
  { status: "REVIEW_REQUIRED", reasons: ["MISSING_PUNCH"], punch_count: 1, issue: "MISSING_PUNCH" },
  { status: "REVIEW_REQUIRED", reasons: [], punch_count: 3, issue: "MISSING_PUNCH" },
  { status: "REVIEW_REQUIRED", reasons: ["NO_SCHEDULE_ROW"], punch_count: 0, issue: "SHIFT_SETUP" },
  { status: "REVIEW_REQUIRED", reasons: ["NO_SHIFT_FOR_DATE"], punch_count: 0, issue: "NO_SHIFT" },
  { status: "REVIEW_REQUIRED", reasons: [], punch_count: 2, issue: null },
  // OT is a claim on a day, never a defect in it.
  { status: "OT_PENDING", reasons: [], punch_count: 2, issue: null },
];

describe("the shared status -> issue table", () => {
  it("maps every row exactly as the frontend's copy does", () => {
    SHARED_ISSUE_TABLE.forEach((row) => {
      assert.equal(
        dayIssueKey({
          status: row.status,
          review_reasons: row.reasons,
          punch_count: row.punch_count,
        }),
        row.issue,
        `${row.status} / [${row.reasons}] / ${row.punch_count} punches should map to ${row.issue}`
      );
    });
  });

  it("covers every status the engine can produce", () => {
    const { CALC_STATUS } = require("./attendance_engine");
    const covered = new Set(SHARED_ISSUE_TABLE.map((r) => r.status));
    Object.values(CALC_STATUS).forEach((status) => {
      assert.ok(covered.has(status), `the table has no row for engine status ${status}`);
    });
  });
});

describe("the canonical issue mapping", () => {
  it("maps each engine status to the agreed key", () => {
    assert.equal(dayIssueKey({ status: "ABSENT" }), ISSUE_KEY.ABSENT);
    assert.equal(
      dayIssueKey({ status: "REGULARIZATION_PENDING" }),
      ISSUE_KEY.REGULARIZATION_PENDING
    );
    assert.equal(dayIssueKey({ status: "NO_SHIFT_FOR_DATE" }), ISSUE_KEY.NO_SHIFT);
    assert.equal(dayIssueKey({ status: "NO_SCHEDULE_ROW" }), ISSUE_KEY.SHIFT_SETUP);
    assert.equal(dayIssueKey({ status: "FINAL" }), null);
  });

  it("an odd punch count on a REVIEW_REQUIRED day is a Missing Punch", () => {
    assert.equal(
      dayIssueKey({ status: "REVIEW_REQUIRED", review_reasons: ["MISSING_PUNCH"], punch_count: 1 }),
      ISSUE_KEY.MISSING_PUNCH
    );
  });

  it("OT_PENDING is NOT an attendance issue - it is a normal day", () => {
    assert.equal(dayIssueKey({ status: "OT_PENDING", punch_count: 2 }), null);
  });
});

describe("the open-day gate in front of the settled verdicts", () => {
  const odd = { status: "REVIEW_REQUIRED", review_reasons: ["MISSING_PUNCH"], punch_count: 1 };

  it("withholds Missing Punch while the day is open", () => {
    assert.equal(
      dashboardIssueKey(odd, { day_closed: false }),
      null,
      "one punch during an ongoing shift is somebody still at work, not a missing OUT"
    );
  });

  it("reports Missing Punch once the day has closed", () => {
    assert.equal(dashboardIssueKey(odd, { day_closed: true }), ISSUE_KEY.MISSING_PUNCH);
  });

  it("withholds Absent while the day is open", () => {
    assert.equal(
      dashboardIssueKey({ status: "ABSENT" }, { day_closed: false, coverage: COVERAGE.COMPLETE }),
      null
    );
  });

  it("withholds Absent on a closed day without delivery evidence", () => {
    assert.equal(
      dashboardIssueKey({ status: "ABSENT" }, { day_closed: true, coverage: COVERAGE.UNKNOWN }),
      null,
      "issue_key must never claim an absence the presence slice does not"
    );
    assert.equal(
      dashboardIssueKey({ status: "ABSENT" }, { day_closed: true, coverage: COVERAGE.COMPLETE }),
      ISSUE_KEY.ABSENT
    );
  });

  it("still reports a Missing Punch when delivery is unconfirmed", () => {
    // Deliberately asymmetric with Absent: a missing punch is a prompt to
    // look, and the day genuinely is not settled either way. Suppressing it
    // would hide real work from the people whose job is to clear it.
    assert.equal(
      dashboardIssueKey(
        { status: "REVIEW_REQUIRED", review_reasons: ["MISSING_PUNCH"], punch_count: 1 },
        { day_closed: true, coverage: COVERAGE.UNKNOWN }
      ),
      ISSUE_KEY.MISSING_PUNCH
    );
  });

  it("reports a configuration fault immediately, open day or not", () => {
    assert.equal(
      dashboardIssueKey({ status: "NO_SHIFT_FOR_DATE" }, { day_closed: false }),
      ISSUE_KEY.NO_SHIFT
    );
    assert.equal(
      dashboardIssueKey({ status: "NO_SCHEDULE_ROW" }, { day_closed: false }),
      ISSUE_KEY.SHIFT_SETUP
    );
  });

  it("reports a pending regularization immediately: somebody is genuinely waiting", () => {
    assert.equal(
      dashboardIssueKey({ status: "REGULARIZATION_PENDING", punch_count: 1 }, { day_closed: false }),
      ISSUE_KEY.REGULARIZATION_PENDING
    );
  });
});

describe("the presence slices", () => {
  it("a punch beats everything, including a day that needs a correction", () => {
    assert.equal(
      presenceSlice({
        day: { punch_count: 1, status: "REVIEW_REQUIRED" },
        resolution_status: "OK",
        day_closed: true,
        shift_started: true,
        coverage: covered,
      }),
      PRESENCE_SLICE.CHECKED_IN
    );
  });

  it("a punch stays a check-in even when delivery for the location is unconfirmed", () => {
    assert.equal(
      presenceSlice({
        day: { punch_count: 2, status: "FINAL" },
        resolution_status: "OK",
        day_closed: true,
        shift_started: true,
        coverage: COVERAGE.UNKNOWN,
      }),
      PRESENCE_SLICE.CHECKED_IN,
      "doubt about what is MISSING says nothing about what ARRIVED"
    );
  });

  it("shift not started yet is never absent and never 'not yet checked in'", () => {
    assert.equal(
      presenceSlice({
        day: { punch_count: 0, status: "ABSENT" },
        resolution_status: "OK",
        day_closed: false,
        shift_started: false,
        coverage: covered,
      }),
      PRESENCE_SLICE.SHIFT_NOT_STARTED
    );
  });

  it("shift started, day open, nothing punched -> Not Yet Checked In, not Absent", () => {
    assert.equal(
      presenceSlice({
        day: { punch_count: 0, status: "ABSENT" },
        resolution_status: "OK",
        day_closed: false,
        shift_started: true,
        coverage: covered,
      }),
      PRESENCE_SLICE.NOT_YET_CHECKED_IN
    );
  });

  it("a CLOSED day with CONFIRMED delivery can be Absent", () => {
    assert.equal(
      presenceSlice({
        day: { punch_count: 0, status: "ABSENT" },
        resolution_status: "OK",
        day_closed: true,
        shift_started: true,
        coverage: COVERAGE.COMPLETE,
      }),
      PRESENCE_SLICE.ABSENT
    );
  });

  it("a CLOSED day WITHOUT delivery evidence is NOT Absent", () => {
    [COVERAGE.UNKNOWN, COVERAGE.INCOMPLETE, null].forEach((coverage) => {
      assert.equal(
        presenceSlice({
          day: { punch_count: 0, status: "ABSENT" },
          resolution_status: "OK",
          day_closed: true,
          shift_started: true,
          coverage,
        }),
        PRESENCE_SLICE.UNRESOLVED,
        `coverage ${coverage}: the cutoff passing does not prove the punches arrived`
      );
    });
  });

  it("an unresolvable shift is Unresolved, never Absent", () => {
    ["NO_SHIFT_FOR_DATE", "NO_SCHEDULE_ROW"].forEach((status) => {
      assert.equal(
        presenceSlice({
          day: { punch_count: 0, status },
          resolution_status: status,
          day_closed: true,
          shift_started: false,
          coverage: covered,
        }),
        PRESENCE_SLICE.UNRESOLVED,
        `${status} is a setup fault, not evidence that somebody failed to turn up`
      );
    });
  });

  it("a REST DAY is NOT special-cased: the engine's answer stands", () => {
    // The removed dashboard-only rule diverted this to UNRESOLVED, which made
    // the screen disagree with the employee's own attendance for the date.
    assert.equal(
      presenceSlice({
        day: { punch_count: 0, status: "ABSENT" },
        resolution_status: "REST_DAY",
        day_closed: true,
        shift_started: false,
        coverage: COVERAGE.COMPLETE,
      }),
      PRESENCE_SLICE.ABSENT
    );
  });

  it("a rest day worked is a check-in, as it always was", () => {
    assert.equal(
      presenceSlice({
        day: { punch_count: 2, status: "FINAL" },
        resolution_status: "REST_DAY",
        day_closed: true,
        shift_started: false,
        coverage: COVERAGE.COMPLETE,
      }),
      PRESENCE_SLICE.CHECKED_IN
    );
  });

  it("a rest day gets the SAME completeness safeguard as any other day", () => {
    assert.equal(
      presenceSlice({
        day: { punch_count: 0, status: "ABSENT" },
        resolution_status: "REST_DAY",
        day_closed: true,
        shift_started: false,
        coverage: COVERAGE.UNKNOWN,
      }),
      PRESENCE_SLICE.UNRESOLVED,
      "no special rule for rest days - just the rule everything else gets"
    );
  });

  it("a closed day with a missing punch is Unresolved, not Absent", () => {
    assert.equal(
      presenceSlice({
        day: { punch_count: 0, status: "REVIEW_REQUIRED" },
        resolution_status: "OK",
        day_closed: true,
        shift_started: true,
        coverage: covered,
      }),
      PRESENCE_SLICE.UNRESOLVED
    );
  });

  it("every combination lands in exactly one declared slice", () => {
    const combos = [];
    [0, 1, 2].forEach((punch_count) =>
      ["OK", "REST_DAY", "NO_SHIFT_FOR_DATE", "NO_SCHEDULE_ROW"].forEach((resolution_status) =>
        [true, false].forEach((day_closed) =>
          [true, false].forEach((shift_started) =>
            [COVERAGE.COMPLETE, COVERAGE.INCOMPLETE, COVERAGE.UNKNOWN, null].forEach((coverage) =>
              ["FINAL", "ABSENT", "REVIEW_REQUIRED", "REGULARIZATION_PENDING"].forEach((status) =>
                combos.push({
                  day: { punch_count, status },
                  resolution_status,
                  day_closed,
                  shift_started,
                  coverage,
                })
              )
            )
          )
        )
      )
    );
    combos.forEach((input) => {
      const slice = presenceSlice(input);
      assert.ok(
        PRESENCE_SLICE_ORDER.includes(slice),
        `${JSON.stringify(input)} produced an undeclared slice ${slice}`
      );
    });
    assert.equal(combos.length, 3 * 4 * 2 * 2 * 4 * 4);
  });

  it("never reports Absent without both a closed day and confirmed delivery", () => {
    const combos = [];
    [true, false].forEach((day_closed) =>
      [COVERAGE.COMPLETE, COVERAGE.INCOMPLETE, COVERAGE.UNKNOWN, null].forEach((coverage) =>
        combos.push({ day_closed, coverage })
      )
    );
    combos.forEach(({ day_closed, coverage }) => {
      const slice = presenceSlice({
        day: { punch_count: 0, status: "ABSENT" },
        resolution_status: "OK",
        day_closed,
        shift_started: true,
        coverage,
      });
      if (slice === PRESENCE_SLICE.ABSENT) {
        assert.ok(day_closed, "absent on an open day");
        assert.equal(coverage, COVERAGE.COMPLETE, "absent without delivery evidence");
      }
    });
  });
});

describe("why a day is still unresolved is always answerable", () => {
  it("names the setup fault", () => {
    assert.match(
      unresolvedReason({ day: { punch_count: 0 }, resolution_status: "NO_SHIFT_FOR_DATE", day_closed: true }),
      /No shift assigned/
    );
    assert.match(
      unresolvedReason({ day: { punch_count: 0 }, resolution_status: "NO_SCHEDULE_ROW", day_closed: true }),
      /no schedule row/
    );
  });

  it("names a pull that is still retrieving", () => {
    assert.match(
      unresolvedReason({
        day: { punch_count: 0, status: "ABSENT" },
        resolution_status: "OK",
        day_closed: true,
        coverage: COVERAGE.INCOMPLETE,
      }),
      /still being retrieved/
    );
  });

  it("names an unconfirmed terminal, without calling it offline", () => {
    const reason = unresolvedReason({
      day: { punch_count: 0, status: "ABSENT" },
      resolution_status: "OK",
      day_closed: true,
      coverage: COVERAGE.UNKNOWN,
    });
    assert.match(reason, /has not been in contact/);
    assert.doesNotMatch(reason, /offline|down/i);
  });

  it("says nothing for an employee who punched", () => {
    assert.equal(
      unresolvedReason({ day: { punch_count: 2 }, resolution_status: "OK", day_closed: true, coverage: COVERAGE.UNKNOWN }),
      null
    );
  });
});

describe("delivery coverage for a location", () => {
  const close = 1440 + 240; // a 04:00 cutoff

  it("is COMPLETE when every terminal was in contact at or after the close", () => {
    assert.equal(
      locationCoverage({
        devices: [{ last_seen_minute: close }, { last_seen_minute: close + 600 }],
        close_minute: close,
      }),
      COVERAGE.COMPLETE
    );
  });

  it("is UNKNOWN when any terminal's last contact predates the close", () => {
    assert.equal(
      locationCoverage({
        devices: [{ last_seen_minute: close + 600 }, { last_seen_minute: close - 1 }],
        close_minute: close,
      }),
      COVERAGE.UNKNOWN,
      "a terminal last heard from before the window ended may still hold buffered punches"
    );
  });

  it("is UNKNOWN when a terminal has no recorded contact at all", () => {
    assert.equal(
      locationCoverage({ devices: [{ last_seen_minute: null }], close_minute: close }),
      COVERAGE.UNKNOWN
    );
  });

  it("is UNKNOWN when no terminal is mapped to the location", () => {
    assert.equal(locationCoverage({ devices: [], close_minute: close }), COVERAGE.UNKNOWN);
  });

  it("is INCOMPLETE when a historical pull covering the date is still running", () => {
    assert.equal(
      locationCoverage({
        devices: [{ last_seen_minute: close + 600 }],
        close_minute: close,
        open_pull: true,
      }),
      COVERAGE.INCOMPLETE,
      "an open pull is a positive statement that punches are still arriving"
    );
  });

  it("uses no time threshold: only the day's own close decides", () => {
    // One minute before the close is not complete; the close itself is.
    assert.equal(
      locationCoverage({ devices: [{ last_seen_minute: close - 1 }], close_minute: close }),
      COVERAGE.UNKNOWN
    );
    assert.equal(
      locationCoverage({ devices: [{ last_seen_minute: close }], close_minute: close }),
      COVERAGE.COMPLETE
    );
  });
});

describe("rates carry their own denominator, and zero is not a rate", () => {
  it("reports the pair it was built from", () => {
    assert.deepEqual(rate(3, 4), { numerator: 3, denominator: 4, percent: 75, available: true });
  });

  it("a zero denominator is UNAVAILABLE, never 0%", () => {
    const r = rate(0, 0);
    assert.equal(r.available, false);
    assert.equal(r.percent, null, "an outlet that employs nobody has not failed at attendance");
  });

  it("rounds to one decimal for display and keeps the counts exact", () => {
    const r = rate(1, 3);
    assert.equal(r.percent, 33.3);
    assert.equal(r.numerator, 1);
    assert.equal(r.denominator, 3);
  });
});

describe("time parsing", () => {
  it("reads HH:MM:SS, HH:MM and a full datetime", () => {
    assert.equal(timeMinutes("04:00:00"), 240);
    assert.equal(timeMinutes("4:00"), 240);
    assert.equal(timeMinutes("2026-09-12 10:30:00"), 630);
  });

  it("returns null for nothing and for nonsense", () => {
    assert.equal(timeMinutes(null), null);
    assert.equal(timeMinutes(""), null);
    assert.equal(timeMinutes("25:00"), null);
  });
});
