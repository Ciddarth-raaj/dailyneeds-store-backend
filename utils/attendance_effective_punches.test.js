/**
 * The effective raw punch stream: manual voids and the ten-minute duplicate
 * rule, as pure arithmetic.
 *
 *   node --test utils/attendance_effective_punches.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  DUPLICATE_WINDOW_MINUTES,
  EFFECTIVE_PUNCH_STATUS,
  IGNORED_DUPLICATE_REASON,
  absoluteMinutes,
  resolveEffectiveRawPunches,
  resolveEffectiveRawPunchesByEmployee,
} = require("./attendance_effective_punches");

const p = (id, ioTime, extra = {}) => ({ punch_id: id, io_time: ioTime, source: "BIOMAX", ...extra });
const at = (hhmm, date = "2026-09-14") => `${date} ${hhmm}:00`;

const usedIds = (r) => r.used.map((x) => x.punch_id);
const ignoredIds = (r) => r.excluded.filter((x) => x.effective_status === "IGNORED_DUPLICATE").map((x) => x.punch_id);
const voidedIds = (r) => r.excluded.filter((x) => x.effective_status === "VOIDED").map((x) => x.punch_id);

describe("the ten-minute duplicate rule", () => {
  it("the window is ten minutes and the comparison is <= (exactly ten is a duplicate)", () => {
    assert.equal(DUPLICATE_WINDOW_MINUTES, 10);
  });

  it("1. 09:00 + 09:04 -> the second is ignored", () => {
    const r = resolveEffectiveRawPunches([p(1, at("09:00")), p(2, at("09:04"))]);
    assert.deepEqual(usedIds(r), [1]);
    assert.deepEqual(ignoredIds(r), [2]);
    assert.equal(r.excluded[0].exclusion_reason, IGNORED_DUPLICATE_REASON);
    assert.equal(r.excluded[0].exclusion_reason, "Duplicate punch within 10 minutes");
    assert.equal(r.excluded[0].duplicate_of_punch_id, 1);
    assert.equal(r.excluded[0].duplicate_of_io_time, at("09:00"));
    assert.equal(r.excluded[0].duplicate_gap_minutes, 4);
  });

  it("2. 09:00 + 09:10 -> exactly ten minutes is ignored", () => {
    const r = resolveEffectiveRawPunches([p(1, at("09:00")), p(2, at("09:10"))]);
    assert.deepEqual(usedIds(r), [1]);
    assert.deepEqual(ignoredIds(r), [2]);
  });

  it("3. 09:00 + 09:11 -> both kept", () => {
    const r = resolveEffectiveRawPunches([p(1, at("09:00")), p(2, at("09:11"))]);
    assert.deepEqual(usedIds(r), [1, 2]);
    assert.deepEqual(ignoredIds(r), []);
  });

  it("4. 09:00 + 09:04 + 09:09 + 09:11 -> 09:00 and 09:11 kept", () => {
    const r = resolveEffectiveRawPunches([p(1, at("09:00")), p(2, at("09:04")), p(3, at("09:09")), p(4, at("09:11"))]);
    assert.deepEqual(usedIds(r), [1, 4]);
    assert.deepEqual(ignoredIds(r), [2, 3]);
  });

  it("5. the comparison is against the LAST KEPT punch, not the previous raw record", () => {
    // 09:09 is 5 minutes after 09:04, which would be kept if the rule
    // compared neighbours; it is 9 minutes after the last KEPT (09:00).
    const r = resolveEffectiveRawPunches([p(1, at("09:00")), p(2, at("09:04")), p(3, at("09:09"))]);
    assert.deepEqual(usedIds(r), [1]);
    assert.equal(r.excluded[1].duplicate_of_punch_id, 1, "09:09 is a duplicate OF 09:00");
    // And a punch 10 minutes after an IGNORED one is still measured from the kept one:
    // 09:00 keep, 09:10 ignore, 09:11 keep (11 from 09:00, though only 1 from 09:10).
    const r2 = resolveEffectiveRawPunches([p(1, at("09:00")), p(2, at("09:10")), p(3, at("09:11"))]);
    assert.deepEqual(usedIds(r2), [1, 3]);
    assert.deepEqual(ignoredIds(r2), [2]);
  });

  it("the kept punch becomes the new comparison point", () => {
    // 09:00 keep, 09:11 keep, 09:20 ignore (9 from 09:11), 09:22 keep (11 from 09:11).
    const r = resolveEffectiveRawPunches([p(1, at("09:00")), p(2, at("09:11")), p(3, at("09:20")), p(4, at("09:22"))]);
    assert.deepEqual(usedIds(r), [1, 2, 4]);
    assert.deepEqual(ignoredIds(r), [3]);
  });

  it("6. a different employee is never suppressed", () => {
    const resolved = resolveEffectiveRawPunchesByEmployee([
      p(1, at("09:00"), { employee_id: 42 }),
      p(2, at("09:04"), { employee_id: 43 }),
      p(3, at("09:05"), { employee_id: 42 }),
    ]);
    assert.equal(resolved.get("1").effective_status, "USED");
    assert.equal(resolved.get("2").effective_status, "USED", "employee 43's first punch");
    assert.equal(resolved.get("3").effective_status, "IGNORED_DUPLICATE", "employee 42's second");
  });

  it("7. BIOMAX + BIOMAX", () => {
    const r = resolveEffectiveRawPunches([p(1, at("09:00")), p(2, at("09:05"))]);
    assert.deepEqual(ignoredIds(r), [2]);
  });

  it("8. IMPORT + IMPORT", () => {
    const r = resolveEffectiveRawPunches([p(1, at("09:00"), { source: "IMPORT" }), p(2, at("09:05"), { source: "IMPORT" })]);
    assert.deepEqual(ignoredIds(r), [2]);
  });

  it("9. BIOMAX + IMPORT: one chronological stream across the two raw sources", () => {
    const r = resolveEffectiveRawPunches([p(1, at("09:00")), p(2, at("09:05"), { source: "IMPORT" })]);
    assert.deepEqual(usedIds(r), [1]);
    assert.deepEqual(ignoredIds(r), [2]);
    assert.equal(r.excluded[0].source, "IMPORT");
  });

  it("10. IMPORT + BIOMAX", () => {
    const r = resolveEffectiveRawPunches([p(1, at("09:00"), { source: "IMPORT" }), p(2, at("09:05"))]);
    assert.deepEqual(usedIds(r), [1]);
    assert.deepEqual(ignoredIds(r), [2]);
    assert.equal(r.used[0].source, "IMPORT");
  });

  it("11. a REGULARIZED punch is not passed through the rule at all (the caller adds it afterwards)", () => {
    // The module contract: it resolves RAW punches. The orchestration test
    // proves the regularized punch joins the effective list untouched; here
    // the point is that nothing in this module looks for or special-cases
    // one, so nothing here can suppress one either.
    const src = require("fs").readFileSync(require.resolve("./attendance_effective_punches"), "utf8");
    assert.ok(!/REGULARIZED/.test(src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "")), "no REGULARIZED branch in the rule");
  });

  it("12. midnight boundary: 23:58 + 00:04 are six minutes apart, the second is ignored", () => {
    const r = resolveEffectiveRawPunches([p(1, at("23:58", "2026-09-14")), p(2, at("00:04", "2026-09-15"))]);
    assert.deepEqual(usedIds(r), [1]);
    assert.deepEqual(ignoredIds(r), [2]);
    assert.equal(r.excluded[0].duplicate_gap_minutes, 6);
    // and 23:58 + 00:09 is 11 minutes: kept
    const r2 = resolveEffectiveRawPunches([p(1, at("23:58", "2026-09-14")), p(2, at("00:09", "2026-09-15"))]);
    assert.deepEqual(usedIds(r2), [1, 2]);
  });

  it("the stream is ordered by the absolute instant whatever order the rows arrive in", () => {
    const r = resolveEffectiveRawPunches([p(2, at("09:04")), p(1, at("09:00"))]);
    assert.deepEqual(usedIds(r), [1]);
    assert.deepEqual(ignoredIds(r), [2]);
    assert.deepEqual(r.all.map((x) => x.punch_id), [1, 2]);
  });

  it("13. the exact same timestamp is handled deterministically: the lower id is kept, the other ignored", () => {
    const a = resolveEffectiveRawPunches([p(7, at("09:00")), p(3, at("09:00"))]);
    const b = resolveEffectiveRawPunches([p(3, at("09:00")), p(7, at("09:00"))]);
    assert.deepEqual(usedIds(a), [3]);
    assert.deepEqual(ignoredIds(a), [7]);
    assert.deepEqual(usedIds(b), usedIds(a));
    assert.deepEqual(ignoredIds(b), ignoredIds(a));
    assert.equal(a.excluded[0].duplicate_gap_minutes, 0);
  });

  it("seconds are truncated, so 09:00:59 -> 09:10:01 is still ten minutes", () => {
    const r = resolveEffectiveRawPunches([p(1, "2026-09-14 09:00:59"), p(2, "2026-09-14 09:10:01")]);
    assert.deepEqual(ignoredIds(r), [2]);
  });

  it("a punch with an unparseable time is dropped rather than crashing the stream", () => {
    const r = resolveEffectiveRawPunches([p(1, at("09:00")), p(2, "garbage"), p(3, at("13:00"))]);
    assert.deepEqual(usedIds(r), [1, 3]);
  });

  it("absoluteMinutes counts whole minutes since the epoch from the wall clock, no zone", () => {
    assert.equal(absoluteMinutes("2026-09-15 00:04:00") - absoluteMinutes("2026-09-14 23:58:00"), 6);
    assert.equal(absoluteMinutes("2026-09-14T09:10:00"), absoluteMinutes("2026-09-14 09:10:59"));
    assert.equal(absoluteMinutes("nope"), null);
  });
});

describe("manual voids in the stream", () => {
  it("a voided punch is excluded before the duplicate rule looks, so it neither counts nor hides a genuine punch", () => {
    // 09:00 voided; 09:04 would have been a duplicate of it - now 09:04 is
    // the first kept punch of the day.
    const r = resolveEffectiveRawPunches([
      p(1, at("09:00"), { attendance_punch_void_id: 5, void_reason: "Wrong employee punch" }),
      p(2, at("09:04")),
    ]);
    assert.deepEqual(voidedIds(r), [1]);
    assert.deepEqual(usedIds(r), [2]);
    assert.equal(r.excluded[0].effective_status, EFFECTIVE_PUNCH_STATUS.VOIDED);
    assert.equal(r.excluded[0].exclusion_reason, "Wrong employee punch");
    assert.equal(r.excluded[0].void.attendance_punch_void_id, 5);
  });

  it("voiding a duplicate that was already ignored changes nothing about the kept stream", () => {
    const before = resolveEffectiveRawPunches([p(1, at("09:00")), p(2, at("09:04")), p(3, at("13:00"))]);
    const after = resolveEffectiveRawPunches([p(1, at("09:00")), p(2, at("09:04"), { attendance_punch_void_id: 9 }), p(3, at("13:00"))]);
    assert.deepEqual(usedIds(before), [1, 3]);
    assert.deepEqual(usedIds(after), [1, 3]);
    assert.deepEqual(voidedIds(after), [2]);
  });

  it("the input rows are not mutated", () => {
    const rows = [p(1, at("09:00")), p(2, at("09:04"))];
    const snapshot = JSON.stringify(rows);
    resolveEffectiveRawPunches(rows);
    assert.equal(JSON.stringify(rows), snapshot);
  });

  it("every input punch comes back exactly once, in `all`, with a status", () => {
    const r = resolveEffectiveRawPunches([
      p(1, at("09:00")), p(2, at("09:03")), p(3, at("13:00"), { attendance_punch_void_id: 1 }), p(4, at("14:00")), p(5, at("18:00")),
    ]);
    assert.deepEqual(r.all.map((x) => [x.punch_id, x.effective_status]), [
      [1, "USED"], [2, "IGNORED_DUPLICATE"], [3, "VOIDED"], [4, "USED"], [5, "USED"],
    ]);
    assert.equal(r.used.length + r.excluded.length, r.all.length);
  });

  it("by-employee resolution leaves an unmatched punch with a null status", () => {
    const resolved = resolveEffectiveRawPunchesByEmployee([p(1, at("09:00"), { employee_id: null })]);
    assert.equal(resolved.get("1").effective_status, null);
  });
});
