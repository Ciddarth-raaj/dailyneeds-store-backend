/**
 * The read-only OT rebuild preview: what it lists, how it classifies, and
 * what it blames a difference on.
 *
 *   node --test scripts/attendance/ot_rebuild_preview.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const preview = require("./ot-rebuild-preview");

const A = preview.ACTION;

// A FINAL day; `ot` is its claimable OT.
const day = (date, { ot = 0, pre = 0, post = ot, gap = 60, allowance = 60, punches = 4, shift = 7 } = {}) => ({
  attendance_date: date,
  shift_name: "General 9-6",
  work_shift_id: shift,
  raw_punch_ids: [1, 2, 3, 4].slice(0, punches),
  punch_count: punches,
  candidate_ot_minutes: ot,
  excess_ot_minutes: ot,
  pre_shift_ot_minutes: pre,
  post_shift_ot_minutes: post,
  actual_gap_minutes: gap,
  break_allowance_minutes: allowance,
  shift_authorised_ot_minutes: 0,
  status: "FINAL",
});
const verdict = (d) => (d.candidate_ot_minutes > 0 ? { eligible: true, minutes: d.candidate_ot_minutes, reason: null } : { eligible: false, minutes: 0, reason: "NO_OT" });
const req = (id, date, status, cand, appr = 0) => ({
  attendance_approval_request_id: id, request_type: "OT", status, employee_id: 1, attendance_date: date,
  candidate_ot_minutes: cand, approved_ot_minutes: appr,
});

function harness({ days, requests, stored = [], locked = [] }) {
  return preview.run({
    listEmployees: async () => [{ employee_id: 1, employee_name: "Test One" }],
    listRequests: async ({ month }) => requests.filter((r) => r.attendance_date.startsWith(month)),
    listStored: async ({ month }) => stored.filter((s) => s.attendance_date.startsWith(month)),
    findLocked: async () => locked,
    calculateRange: async ({ from_date, to_date }) => days.filter((d) => d.attendance_date >= from_date && d.attendance_date <= to_date),
    autoOtVerdict: verdict,
    months: ["2026-09", "2026-10"],
    today: "2026-10-07",
  });
}

describe("ot rebuild preview", () => {
  it("refuses --apply and defaults to Sep and Oct 2026", () => {
    assert.throws(() => preview.parseArgs(["--apply"]), /read-only/);
    assert.deepEqual(preview.parseArgs([]).months, ["2026-09", "2026-10"]);
  });

  it("clamps the current month to yesterday", () => {
    assert.deepEqual(preview.monthRange("2026-10", "2026-10-07"), { month: "2026-10", from: "2026-10-01", to: "2026-10-06" });
    assert.equal(preview.monthRange("2026-11", "2026-10-07"), null);
  });

  it("classifies every case and keeps rejected OT rejected", async () => {
    const report = await harness({
      days: [
        day("2026-09-02", { ot: 30, gap: 20, allowance: 60 }), // pending 70 -> 30: lunch
        day("2026-09-03", { ot: 45 }), // approved 45 -> 45
        day("2026-09-04", { ot: 0 }), // pending 40 -> 0
        day("2026-09-05", { ot: 50, pre: 50, post: 0 }), // rejected stays
        day("2026-09-06", { ot: 25 }), // no request -> create
        day("2026-09-07", { ot: 60 }), // approved 90 -> 60
        day("2026-10-01", { ot: 20 }),
        day("2026-10-02", { ot: 0 }), // nothing at all: not listed
      ],
      requests: [
        req(11, "2026-09-02", "PENDING", 70),
        req(12, "2026-09-03", "APPROVED", 45, 45),
        req(13, "2026-09-04", "PENDING", 40),
        req(14, "2026-09-05", "REJECTED", 50),
        req(15, "2026-09-07", "APPROVED", 90, 90),
        { ...req(16, "2026-10-01", "CANCELLED", 99) },
      ],
      stored: [
        { employee_id: 1, attendance_date: "2026-09-02", work_shift_id: 7, punch_count: 4, raw_punch_ids: "[1,2,3,4]", worked_minutes: 580, nrm_minutes: 480, base_nrm_minutes: 480, break_allowance_minutes: 60, actual_gap_minutes: 20, raw_ot_minutes: 70, pre_shift_ot_minutes: 0, post_shift_ot_minutes: 70, candidate_ot_minutes: 70 },
      ],
    });
    const by = Object.fromEntries(report.rows.map((r) => [r.attendance_date, r]));
    assert.equal(by["2026-09-02"].proposed_action, A.PENDING_REBUILD);
    assert.equal(by["2026-09-02"].difference_minutes, -40);
    assert.ok(by["2026-09-02"].reason_codes.includes("UNUSED_LUNCH"));
    assert.equal(by["2026-09-03"].proposed_action, A.UNCHANGED);
    assert.equal(by["2026-09-04"].proposed_action, A.WOULD_REMOVE);
    assert.equal(by["2026-09-05"].proposed_action, A.REJECTED_PRESERVE);
    assert.equal(by["2026-09-06"].proposed_action, A.WOULD_CREATE);
    assert.equal(by["2026-09-07"].proposed_action, A.APPROVED_REBUILD);
    assert.equal(by["2026-10-01"].proposed_action, A.WOULD_CREATE); // the cancelled request is ignored
    assert.equal(by["2026-10-02"], undefined);

    const sep = report.summary["2026-09"];
    assert.equal(sep.existing_pending.count, 2);
    assert.equal(sep.existing_pending.minutes, 110);
    assert.equal(sep.existing_approved.minutes, 135);
    assert.equal(sep.existing_rejected.count, 1);
    assert.equal(sep.rejected_rows_preserved, 1);
    assert.equal(sep.total_minutes_reduced, 40 + 40 + 30);
    assert.equal(sep.total_minutes_increased, 25);
    assert.equal(sep.rows_would_create, 1);
    assert.equal(sep.rows_would_remove, 1);
    assert.equal(sep.reductions_due_to_unused_lunch, 1);
    assert.equal(report.summary["2026-10"].rows_would_create, 1);
    assert.equal(report.cancelled_requests_ignored.length, 1);
    assert.match(preview.toCsv(report.rows).split("\n")[0], /^month,employee_id,employee_name/);
  });

  it("reports a date the engine could not calculate", async () => {
    const report = await harness({ days: [], requests: [req(21, "2026-09-10", "PENDING", 30)] });
    assert.equal(report.rows[0].could_not_recalculate, true);
    assert.equal(report.summary["2026-09"].rows_could_not_recalculate, 1);
  });
});
