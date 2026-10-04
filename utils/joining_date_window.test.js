/**
 * The joining-date entry window - 30 calendar days either side of today's
 * IST business date - as a pure rule.
 *
 *   node --test utils/joining_date_window.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  JOINING_DATE_ERROR,
  joiningDateWindow,
  checkJoiningDateWindow,
  joiningDateChanged,
  strictIsoDate,
  correctionReason,
} = require("./joining_date_window");
const { istDateOf } = require("./istDate");

const TODAY = "2026-10-04";
const ok = (date, today = TODAY) => assert.equal(checkJoiningDateWindow(date, today), null, date);
const early = (date, today = TODAY) =>
  assert.deepEqual(checkJoiningDateWindow(date, today), { code: "TOO_EARLY", message: JOINING_DATE_ERROR.TOO_EARLY });
const late = (date, today = TODAY) =>
  assert.deepEqual(checkJoiningDateWindow(date, today), { code: "TOO_LATE", message: JOINING_DATE_ERROR.TOO_LATE });

describe("the window for 04-Oct-2026", () => {
  it("is 04-Sep-2026 through 03-Nov-2026, both inclusive", () => {
    assert.deepEqual(joiningDateWindow(TODAY), { earliest: "2026-09-04", latest: "2026-11-03" });
  });
  it("1. today is allowed", () => ok("2026-10-04"));
  it("2. today - 1 is allowed", () => ok("2026-10-03"));
  it("3. today - 30 is allowed", () => ok("2026-09-04"));
  it("4. today - 31 is blocked", () => early("2026-09-03"));
  it("5. today + 1 is allowed", () => ok("2026-10-05"));
  it("6. today + 30 is allowed", () => ok("2026-11-03"));
  it("7. today + 31 is blocked", () => late("2026-11-04"));
  it("8. the 03/10/2006 typo is blocked", () => early("2006-10-03"));
  it("the business examples", () => {
    ok("2026-09-20");
    early("2026-08-03");
  });
  it("the messages are the business wording, exactly", () => {
    assert.equal(JOINING_DATE_ERROR.TOO_EARLY, "Joining date cannot be more than 30 days before today.");
    assert.equal(JOINING_DATE_ERROR.TOO_LATE, "Joining date cannot be more than 30 days after today.");
  });
});

describe("14. calendar and timezone boundaries", () => {
  it("crosses month, year and leap-day boundaries by whole days", () => {
    assert.deepEqual(joiningDateWindow("2026-01-15"), { earliest: "2025-12-16", latest: "2026-02-14" });
    assert.deepEqual(joiningDateWindow("2028-03-01"), { earliest: "2028-01-31", latest: "2028-03-31" });
    assert.deepEqual(joiningDateWindow("2028-02-29"), { earliest: "2028-01-30", latest: "2028-03-30" });
    assert.deepEqual(joiningDateWindow("2026-12-20"), { earliest: "2026-11-20", latest: "2027-01-19" });
  });

  it("today is the IST date: 19:00 UTC on 3 Oct is already 4 Oct in India", () => {
    // 2026-10-03T19:00Z = 2026-10-04 00:30 IST. A UTC-dated "today" would put
    // 2026-11-03 one day outside the window; the IST date keeps it inside.
    const today = istDateOf(Date.UTC(2026, 9, 3, 19, 0));
    assert.equal(today, "2026-10-04");
    ok("2026-11-03", today);
    early("2026-09-03", today);
  });

  it("the last IST minute of 4 Oct is still 4 Oct", () => {
    const today = istDateOf(Date.UTC(2026, 9, 4, 18, 29)); // 23:59 IST
    assert.equal(today, "2026-10-04");
    ok("2026-09-04", today);
    late("2026-11-04", today);
  });

  it("does not depend on the process timezone", () => {
    const saved = process.env.TZ;
    try {
      for (const tz of ["UTC", "Asia/Kolkata", "America/Los_Angeles", "Pacific/Kiritimati"]) {
        process.env.TZ = tz;
        assert.deepEqual(joiningDateWindow(TODAY), { earliest: "2026-09-04", latest: "2026-11-03" }, tz);
      }
    } finally {
      if (saved === undefined) delete process.env.TZ;
      else process.env.TZ = saved;
    }
  });
});

describe("what counts as a date, and as a change", () => {
  it("only an exact real calendar date is accepted", () => {
    assert.equal(strictIsoDate("2026-02-30"), null);
    assert.equal(strictIsoDate("03/10/2026"), null);
    assert.equal(strictIsoDate("2026-10-03T00:00:00Z"), null);
    assert.deepEqual(checkJoiningDateWindow("", TODAY), { code: "INVALID", message: JOINING_DATE_ERROR.INVALID });
    assert.deepEqual(checkJoiningDateWindow(null, TODAY), { code: "INVALID", message: JOINING_DATE_ERROR.INVALID });
  });

  it("an unchanged stored date is not a change, whatever shape it is stored in", () => {
    assert.equal(joiningDateChanged("2015-06-15", "2015-06-15"), false);
    assert.equal(joiningDateChanged("2015-06-15", new Date(2015, 5, 15)), false);
    assert.equal(joiningDateChanged("", null), false);
    assert.equal(joiningDateChanged(null, ""), false);
  });

  it("a different date, a cleared date and a newly supplied date are changes", () => {
    assert.equal(joiningDateChanged("2010-01-01", "2015-06-15"), true);
    assert.equal(joiningDateChanged("", "2015-06-15"), true);
    assert.equal(joiningDateChanged("2026-10-03", null), true);
  });
});

describe("the historical-correction reason", () => {
  it("must be at least 10 characters once trimmed, and at most 500", () => {
    assert.equal(correctionReason(null), null);
    assert.equal(correctionReason("   "), null);
    assert.equal(correctionReason("typo fix"), null);
    assert.equal(correctionReason("  Appointment letter  "), "Appointment letter");
    assert.equal(correctionReason("x".repeat(501)), null);
  });
});
