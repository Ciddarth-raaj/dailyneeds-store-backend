/**
 * THE IST BUSINESS DATE.
 *
 *   node --test utils/istDate.test.js
 *
 * The whole point of this module is that the answer does NOT depend on where
 * the process runs, so the cases that matter are the ones either side of
 * 18:30 UTC - the instant at which India has already started the next day and
 * a UTC host has not.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { istDateOf, istToday, IST_OFFSET_MINUTES } = require("./istDate");

describe("istDateOf", () => {
  it("is IST+5:30", () => {
    assert.equal(IST_OFFSET_MINUTES, 330);
  });

  it("2026-09-15T20:00:00Z is the 16th in India", () => {
    // The case from review: a UTC host would still call this the 15th.
    assert.equal(istDateOf(new Date("2026-09-15T20:00:00Z")), "2026-09-16");
  });

  it("rolls over at exactly 18:30 UTC and not a second before", () => {
    assert.equal(istDateOf(new Date("2026-09-15T18:29:59Z")), "2026-09-15");
    assert.equal(istDateOf(new Date("2026-09-15T18:30:00Z")), "2026-09-16");
  });

  it("handles month, year and leap-day boundaries", () => {
    assert.equal(istDateOf(new Date("2026-09-30T18:30:00Z")), "2026-10-01");
    assert.equal(istDateOf(new Date("2026-12-31T18:30:00Z")), "2027-01-01");
    assert.equal(istDateOf(new Date("2028-02-28T18:30:00Z")), "2028-02-29");
  });

  it("accepts an epoch as well as a Date", () => {
    const at = new Date("2026-09-15T20:00:00Z");
    assert.equal(istDateOf(at.getTime()), "2026-09-16");
  });

  it("answers null rather than dating something to 1970", () => {
    for (const bad of [null, undefined, "", "not a date", NaN, {}]) {
      assert.equal(istDateOf(bad), null);
    }
  });

  it("DOES NOT READ THE PROCESS ZONE - the same instant answers the same anywhere", () => {
    // `process.env.TZ` is honoured by `Date`'s LOCAL accessors only. If this
    // module ever went back to getFullYear()/getMonth()/getDate(), this test
    // would start failing under one of these zones.
    const instant = new Date("2026-09-15T20:00:00Z");
    const original = process.env.TZ;
    const answers = new Set();
    try {
      for (const zone of ["UTC", "America/Los_Angeles", "Asia/Kolkata", "Pacific/Kiritimati"]) {
        process.env.TZ = zone;
        answers.add(istDateOf(instant));
      }
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
    assert.deepEqual([...answers], ["2026-09-16"], "one answer, whatever TZ says");
  });
});

describe("istToday", () => {
  it("returns a business date in the documented shape", () => {
    assert.match(istToday(), /^\d{4}-\d{2}-\d{2}$/);
  });

  it("honours an override, so a caller holding a business date pins the day", () => {
    assert.equal(istToday("2026-01-02"), "2026-01-02");
  });

  it("ignores an override that is not a business date", () => {
    assert.match(istToday("yesterday"), /^\d{4}-\d{2}-\d{2}$/);
  });
});
