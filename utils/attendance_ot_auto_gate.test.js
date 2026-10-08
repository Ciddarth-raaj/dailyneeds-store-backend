/**
 *   node --test utils/attendance_ot_auto_gate.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { AUTO_OT_GATE, AUTO_OT_STATE, autoOtCreationGate, explainAutoOt } = require("./attendance_ot_auto_gate");

const SETTING = { enabled: 1, auto_pending_from_date: "2026-10-06" };
const OLDEST = "2026-08-24"; // 8 Oct - 45 days

describe("autoOtCreationGate - the rule the sync raises by", () => {
  it("4 Sep is before a 6 Oct cutover", () => {
    assert.equal(autoOtCreationGate({ date: "2026-09-04", cutover: "2026-10-06", oldest: OLDEST }), AUTO_OT_GATE.BEFORE_CUTOVER);
  });
  it("on and after the cutover, inside the window, it may raise", () => {
    assert.equal(autoOtCreationGate({ date: "2026-10-06", cutover: "2026-10-06", oldest: OLDEST }), null);
  });
  it("the deploy backfill's own start date opens earlier dates for that call only", () => {
    assert.equal(autoOtCreationGate({ date: "2026-10-01", cutover: "2026-10-06", creation_from: "2026-09-30", oldest: OLDEST }), null);
    assert.equal(autoOtCreationGate({ date: "2026-09-04", cutover: "2026-10-06", creation_from: "2026-09-30", oldest: OLDEST }), AUTO_OT_GATE.BEFORE_CUTOVER);
  });
  it("older than the window is OUTSIDE_WINDOW", () => {
    assert.equal(autoOtCreationGate({ date: "2026-08-01", cutover: "2026-07-01", oldest: OLDEST }), AUTO_OT_GATE.OUTSIDE_WINDOW);
  });
  it("a remembered (deferred) date passes both gates", () => {
    assert.equal(autoOtCreationGate({ date: "2026-09-04", cutover: "2026-10-06", oldest: OLDEST, marker_waiting: true }), null);
  });
});

describe("explainAutoOt - what the attendance read tells people", () => {
  it("Employee 945, 4 Sep 2026: not raised, before the cutover, with the date", () => {
    const e = explainAutoOt({ date: "2026-09-04", setting: SETTING, oldest: OLDEST, max_backdate_days: 45 });
    assert.equal(e.state, AUTO_OT_STATE.NOT_RAISED);
    assert.equal(e.reason, AUTO_OT_GATE.BEFORE_CUTOVER);
    assert.equal(e.detail, "Not sent for approval: dated before automatic OT approval started (6 Oct 2026)");
  });
  it("a locked month is PAYROLL_LOCKED whatever the date", () => {
    assert.equal(explainAutoOt({ date: "2026-10-07", setting: SETTING, oldest: OLDEST, locked: true }).reason, AUTO_OT_GATE.PAYROLL_LOCKED);
  });
  it("switched off or not installed is AUTOMATION_OFF", () => {
    assert.equal(explainAutoOt({ date: "2026-10-07", setting: { ...SETTING, enabled: 0 }, oldest: OLDEST }).reason, AUTO_OT_GATE.AUTOMATION_OFF);
    assert.equal(explainAutoOt({ date: "2026-10-07", setting: null, oldest: OLDEST }).reason, AUTO_OT_GATE.AUTOMATION_OFF);
  });
  it("within every rule: on its way", () => {
    const e = explainAutoOt({ date: "2026-10-07", setting: SETTING, oldest: OLDEST });
    assert.equal(e.state, AUTO_OT_STATE.AWAITING_AUTOMATIC_REQUEST);
    assert.equal(e.reason, null);
  });
  it("outside the window names the window", () => {
    const e = explainAutoOt({ date: "2026-08-01", setting: { enabled: 1, auto_pending_from_date: "2026-07-01" }, oldest: OLDEST, max_backdate_days: 45 });
    assert.equal(e.detail, "Not sent for approval: older than the 45-day approval window");
  });
});
