/**
 * R13 - unregistered-device flood caps, with an injected clock.
 *
 *   node --test biomax/flood.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { createFloodGuard, DEFAULTS } = require("./flood");

function clock(start = Date.UTC(2026, 8, 15, 10, 0, 0)) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => {
    t += ms;
  };
  return now;
}

describe("per-minute cap", () => {
  it("admits the default 30 in a minute and refuses the 31st, then resets next minute", () => {
    const now = clock();
    const g = createFloodGuard({ now });
    for (let i = 0; i < DEFAULTS.perMinute; i += 1) assert.equal(g.admit("X1").allowed, true);
    const refused = g.admit("X1");
    assert.equal(refused.allowed, false);
    assert.match(refused.reason, /this minute/);
    now.advance(60 * 1000);
    assert.equal(g.admit("X1").allowed, true);
  });

  it("is per device", () => {
    const g = createFloodGuard({ now: clock(), limits: { perMinute: 1 } });
    assert.equal(g.admit("A").allowed, true);
    assert.equal(g.admit("A").allowed, false);
    assert.equal(g.admit("B").allowed, true);
  });
});

describe("per-day cap", () => {
  it("refuses after the daily limit even when spread across minutes", () => {
    const now = clock();
    const g = createFloodGuard({ now, limits: { perMinute: 100, perDay: 5 } });
    for (let i = 0; i < 5; i += 1) {
      assert.equal(g.admit("X").allowed, true);
      now.advance(61 * 1000);
    }
    assert.match(g.admit("X").reason, /today/);
    now.advance(24 * 3600 * 1000);
    assert.equal(g.admit("X").allowed, true);
  });
});

describe("distinct devices per day", () => {
  it("admits the default 20 distinct unknown devices and refuses the 21st", () => {
    const g = createFloodGuard({ now: clock() });
    for (let i = 0; i < DEFAULTS.devicesPerDay; i += 1) assert.equal(g.admit(`D${i}`).allowed, true);
    const r = g.admit("D99");
    assert.equal(r.allowed, false);
    assert.match(r.reason, /unregistered devices today/);
    // An already-admitted device is still fine.
    assert.equal(g.admit("D0").allowed, true);
  });
});

describe("oncePerHour", () => {
  it("is true once per key per hour", () => {
    const now = clock();
    const g = createFloodGuard({ now });
    assert.equal(g.oncePerHour("k"), true);
    assert.equal(g.oncePerHour("k"), false);
    assert.equal(g.oncePerHour("other"), true);
    now.advance(3600 * 1000);
    assert.equal(g.oncePerHour("k"), true);
  });
});
