/**
 *   node --test utils/stock_audit_queries.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const Q = require("./stock_audit_queries");

describe("stock audit timestamps", () => {
  it("converts RetailPilot's +05:30 microsecond strings to UTC without losing microseconds", () => {
    const u = Q.toUtc("2026-11-26T21:57:30.073153+05:30");
    assert.equal(u.iso, "2026-11-26T16:27:30.073153Z");
    assert.equal(u.sql, "2026-11-26 16:27:30.073153");
  });
  it("accepts Z, no fraction, and a space separator", () => {
    assert.equal(Q.toUtc("2026-11-26T16:27:30Z").iso, "2026-11-26T16:27:30.000000Z");
    assert.equal(Q.toUtc("2026-11-26 16:27:30.5").iso, "2026-11-26T16:27:30.500000Z");
  });
  it("crosses midnight correctly", () => {
    assert.equal(Q.toUtc("2026-11-27T02:00:00.000001+05:30").iso, "2026-11-26T20:30:00.000001Z");
  });
  it("orders timestamps exactly, inside the same millisecond", () => {
    assert.equal(Q.compareTs("2026-11-26T21:57:30.073153+05:30", "2026-11-26T21:57:30.073154+05:30"), -1);
    assert.equal(Q.compareTs("2026-11-26T16:27:30.073153Z", "2026-11-26T21:57:30.073153+05:30"), 0);
  });
  it("refuses anything that is not a timestamp", () => {
    assert.throws(() => Q.toUtc("2026-11-26' OR '1'='1"));
    assert.throws(() => Q.toUtc(null));
  });
  it("moves a watermark back by the overlap, keeping microseconds", () => {
    assert.equal(Q.minusMinutes("2026-11-26T00:10:00.123456Z", 30), "2026-11-25T23:40:00.123456Z");
  });
});

describe("stock audit cursors and queries", () => {
  it("starts 30 minutes before the watermark with an empty slug", () => {
    assert.deepEqual(Q.startCursor({ ts: "2026-11-26T16:27:30.073153Z", slug: "abc" }), { ts: "2026-11-26T15:57:30.073153Z", slug: "" });
  });
  it("starts at `since` without a watermark, and at the beginning without either", () => {
    assert.deepEqual(Q.startCursor(null, { since: "2026-09-01T00:00:00+05:30" }), { ts: "2026-08-31T18:30:00.000000Z", slug: "" });
    assert.equal(Q.startCursor(null), null);
  });
  it("builds keyset SQL ordered by timestamp then slug, with no OFFSET, subquery or positional reference", () => {
    for (const name of ["session", "line", "adjustment"]) {
      const sql = Q.STREAMS[name].build({ ts: "2026-11-26T16:27:30.073153Z", slug: "b336" }, 2000);
      const col = Q.STREAMS[name].tsColumn;
      assert.match(sql, new RegExp(`\\(${col} > '2026-11-26T16:27:30.073153Z' OR \\(${col} = '2026-11-26T16:27:30.073153Z' AND slug > 'b336'\\)\\)`));
      assert.match(sql, new RegExp(`ORDER BY ${col} ASC, slug ASC\\nLIMIT 2000$`));
      assert.doesNotMatch(sql, /OFFSET|\(\s*SELECT|ORDER BY \d|GROUP BY \d/i);
    }
  });
  it("reads only STK_ADJ from the ledger, and never without a start", () => {
    assert.match(Q.STREAMS.adjustment.build({ ts: "2026-11-01T00:00:00Z", slug: "" }, 10), /WHERE action = 'STK_ADJ' AND/);
    assert.throws(() => Q.STREAMS.adjustment.build(null, 10));
  });
  it("reads the session table from the beginning when there is no cursor", () => {
    assert.match(Q.STREAMS.session.build(null, 5), /WHERE TRUE\n/);
  });
  it("refuses unsafe slugs and page sizes", () => {
    assert.throws(() => Q.STREAMS.session.build({ ts: "2026-11-26T00:00:00Z", slug: "x' OR '1" }, 10));
    assert.throws(() => Q.STREAMS.session.build(null, 2001));
  });
  it("takes the cursor from the last row as returned (string timestamps)", () => {
    assert.deepEqual(Q.STREAMS.session.cursorOf({ slug: "s1", updated_at: "2026-11-26T21:57:30.073153+05:30" }), { ts: "2026-11-26T21:57:30.073153+05:30", slug: "s1" });
    assert.deepEqual(Q.STREAMS.adjustment.cursorOf({ slug: "g1", ts: "2026-11-26T21:57:30+05:30" }), { ts: "2026-11-26T21:57:30+05:30", slug: "g1" });
  });
});
