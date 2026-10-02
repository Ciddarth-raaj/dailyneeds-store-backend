/**
 *   node --test utils/attendance_break_regularization.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { validateBreakPair } = require("./attendance_break_regularization");

const D = "2026-09-12";
const at = (hm, date = D) => `${date} ${hm}:00`;
const punches = (...times) => times.map((t) => ({ io_time: t.includes(" ") ? t : at(t) }));

describe("validateBreakPair - a missed lunch on a two-punch day", () => {
  const day = punches("10:09", "22:04");

  it("accepts 14:00 OUT / 15:00 IN inside 10:09 -> 22:04", () => {
    const r = validateBreakPair({ effective_punches: day, out_time: at("14:00"), in_time: at("15:00") });
    assert.equal(r.ok, true);
    assert.deepEqual(r.segment, { in_time: at("10:09"), out_time: at("22:04") });
  });

  it("accepts times without seconds", () => {
    const r = validateBreakPair({ effective_punches: day, out_time: `${D} 14:00`, in_time: `${D} 15:00` });
    assert.equal(r.ok, true);
  });

  it("refuses IN before OUT, and IN equal to OUT", () => {
    assert.match(validateBreakPair({ effective_punches: day, out_time: at("15:00"), in_time: at("14:00") }).reason, /must be after/);
    assert.match(validateBreakPair({ effective_punches: day, out_time: at("14:00"), in_time: at("14:00") }).reason, /must be after/);
  });

  it("refuses a break outside the first/last punch span", () => {
    for (const [o, i] of [["09:30", "10:30"], ["21:30", "22:30"], ["08:00", "09:00"], ["10:09", "11:00"], ["21:00", "22:04"]]) {
      const r = validateBreakPair({ effective_punches: day, out_time: at(o), in_time: at(i) });
      assert.equal(r.ok, false, `${o}-${i}`);
      assert.match(r.reason, /inside the day's punches/);
    }
  });

  it("refuses a malformed time", () => {
    assert.equal(validateBreakPair({ effective_punches: day, out_time: "14:00", in_time: at("15:00") }).ok, false);
  });
});

describe("validateBreakPair - the sequence on a day that already has punches inside it", () => {
  const day = punches("10:00", "13:00", "14:00", "22:00");

  it("accepts a second break inside the afternoon segment", () => {
    const r = validateBreakPair({ effective_punches: day, out_time: at("18:00"), in_time: at("18:30") });
    assert.equal(r.ok, true);
    assert.deepEqual(r.segment, { in_time: at("14:00"), out_time: at("22:00") });
  });

  it("refuses a break overlapping the existing 13:00 -> 14:00 break", () => {
    for (const [o, i] of [["12:30", "13:30"], ["13:30", "14:30"], ["12:00", "15:00"], ["13:00", "14:00"], ["13:10", "13:50"]]) {
      const r = validateBreakPair({ effective_punches: day, out_time: at(o), in_time: at(i) });
      assert.equal(r.ok, false, `${o}-${i}`);
      assert.match(r.reason, /overlaps/);
    }
  });

  it("orders the effective punches itself", () => {
    const r = validateBreakPair({ effective_punches: [...day].reverse(), out_time: at("11:00"), in_time: at("12:00") });
    assert.equal(r.ok, true);
  });

  it("refuses an odd day (the missing punch comes first) and an empty one", () => {
    assert.match(
      validateBreakPair({ effective_punches: punches("10:00", "13:00", "14:00"), out_time: at("11:00"), in_time: at("12:00") }).reason,
      /regularize the missing punch first/
    );
    assert.match(validateBreakPair({ effective_punches: [], out_time: at("11:00"), in_time: at("12:00") }).reason, /no punches/);
  });

  it("handles a span crossing midnight", () => {
    const night = punches("18:00", "2026-09-13 01:30");
    assert.equal(
      validateBreakPair({ effective_punches: night, out_time: at("23:30"), in_time: "2026-09-13 00:15:00" }).ok,
      true
    );
  });
});
