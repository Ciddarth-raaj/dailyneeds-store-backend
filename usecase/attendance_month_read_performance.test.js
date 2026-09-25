/**
 * MY ATTENDANCE / TELEGRAM MONTH READ - how many database reads a month costs,
 * and that making it cheaper changed no answer.
 *
 * `readRange` serves `GET /attendance/me` and `GET /telegram/attendance/month`.
 * The contract pinned here:
 *
 *   - a month is a FIXED number of reads, whatever its length, however many
 *     punches, requests and shifts it has. Nothing is read per date.
 *   - the shift definitions are read in BULK (three reads for every shift the
 *     range touches), not three reads per shift in sequence.
 *   - the bulk read and the per-shift read produce the SAME days, field for
 *     field - the change is to how rows are fetched, not to what is decided.
 *   - the payroll lock is never consulted by a read, and nothing is written.
 *
 * No MySQL: a counting fake repository, shaped like the real one.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const buildUsecase = require("./attendance_calculation");
const readTiming = require("../utils/attendance_read_timing");

const EMP = 42;

const schedule = (id, inTime = "09:00:00", outTime = "18:00:00") =>
  Array.from({ length: 7 }, (_, day) => ({
    work_shift_weekly_schedule_id: id * 10 + day,
    work_shift_id: id,
    day_of_week: day,
    is_working_day: day === 0 ? 0 : 1,
    in_time: inTime,
    out_time: outTime,
    attendance_day_cutoff: "04:00:00",
    break_minutes: 60,
    normal_work_minutes: 480,
    ot_rate: 1.5,
  }));

const config = (id) => ({
  work_shift_id: id,
  shift_code: `S${id}`,
  shift_name: `Shift ${id}`,
  active: 1,
  overtime_allowed: 1,
  overtime_minimum_minutes: 30,
  overtime_rounding_method: "DOWN",
  overtime_rounding_interval_minutes: 15,
  overtime_minimum_threshold_only: 0,
  overtime_minimum_excluded: 0,
  maximum_ot_minutes_per_day: null,
  late_grace_minutes: 10,
  early_exit_grace_minutes: 10,
});

const SHIFTS = {
  7: { config: config(7), schedule: schedule(7) },
  8: { config: config(8), schedule: schedule(8, "13:00:00", "22:00:00") },
  9: { config: config(9), schedule: schedule(9, "07:00:00", "16:00:00") },
};

const VERSIONS = {
  7: [
    {
      work_shift_config_version_id: 71,
      work_shift_id: 7,
      effective_from: "2026-01-01",
      config_hash: "a",
      config_document: JSON.stringify({ format: 1, config: { ...config(7), late_grace_minutes: 5 }, schedule: schedule(7) }),
      source: "MIGRATION_SEED",
    },
    {
      work_shift_config_version_id: 72,
      work_shift_id: 7,
      effective_from: "2026-08-10",
      config_hash: "b",
      config_document: JSON.stringify({ format: 1, config: { ...config(7), late_grace_minutes: 15 }, schedule: schedule(7) }),
      source: "WORK_SHIFT_SAVE",
    },
  ],
};

const addDays = (d, n) => {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};

/** A month with everything in it: two shifts, an override, odd days, requests, stored rows. */
function monthState({ from = "2026-08-01", days = 31 } = {}) {
  const rawPunches = [];
  let id = 1;
  for (let i = -1; i <= days; i++) {
    const d = addDays(from, i);
    const times = i % 9 === 4 ? ["09:02:00", "13:00:00", "14:01:00"] : ["09:02:00", "13:00:00", "14:01:00", "19:10:00"];
    times.forEach((t) =>
      rawPunches.push({
        punch_id: id++,
        employee_id: EMP,
        punch_date: d,
        ingest_attendance_date: d,
        io_time: `${d} ${t}`,
        original_io_time: `${d} ${t}`,
        dev_id: "DEV1",
        ingest_source: "LIVE",
        attendance_punch_void_id: i === 3 && t === "13:00:00" ? 900 : null,
      })
    );
  }
  const stored = [];
  for (let i = 0; i < Math.min(days, 20); i++) {
    const d = addDays(from, i);
    stored.push({
      employee_id: EMP,
      attendance_date: d,
      work_shift_id: 7,
      shift_snapshot: JSON.stringify({ in_time: "09:00:00", out_time: "18:00:00", attendance_day_cutoff: "04:00:00", is_working_day: 1 }),
      shift_snapshot_hash: "h",
      raw_punch_ids: "[]",
      effective_punches: "[]",
      worked_minutes: 480,
      candidate_ot_minutes: 45,
      status: "FINAL",
      is_final: 1,
      review_reasons: "[]",
      calculated_at: "2026-09-01 00:00:00",
    });
  }
  return {
    assignments: [
      { employee_work_shift_assignment_id: 1, employee_id: EMP, work_shift_id: 7, effective_from: "2026-01-01", source: "MIGRATION_BACKFILL" },
      { employee_work_shift_assignment_id: 2, employee_id: EMP, work_shift_id: 8, effective_from: addDays(from, 15), source: "ASSIGNMENT" },
    ],
    overrides: [
      {
        attendance_date_shift_override_id: 5,
        employee_id: EMP,
        // Past the stored rows, so the live answer (and the override) shows.
        attendance_date: addDays(from, 24),
        work_shift_id: 9,
        previous_work_shift_id: 7,
        source: "APPROVED_REQUEST",
        attendance_approval_request_id: 301,
        shift_change_approved: 1,
      },
    ],
    rawPunches,
    regularized: [
      { punch_id: 11, employee_id: EMP, attendance_date: addDays(from, 4), io_time: `${addDays(from, 4)} 18:30:00`, attendance_approval_request_id: 302 },
    ],
    approvals: [
      { attendance_approval_request_id: 302, attendance_date: addDays(from, 4), request_type: "REGULARIZATION", status: "APPROVED", finalization_state: "SETTLED", approved_ot_minutes: 0 },
      { attendance_approval_request_id: 303, attendance_date: addDays(from, 5), request_type: "OT", status: "APPROVED", finalization_state: "SETTLED", approved_ot_minutes: 45, candidate_ot_minutes: 45 },
      { attendance_approval_request_id: 304, attendance_date: addDays(from, 13), request_type: "REGULARIZATION", status: "PENDING", finalization_state: "NOT_REQUIRED" },
      { attendance_approval_request_id: 305, attendance_date: addDays(from, 22), request_type: "OT", status: "REJECTED", finalization_state: "NOT_REQUIRED", rejection_remarks: "no" },
      { attendance_approval_request_id: 301, attendance_date: addDays(from, 24), request_type: "SHIFT_CHANGE", status: "APPROVED", finalization_state: "SETTLED", requested_work_shift_id: 9 },
    ],
    stored,
  };
}

/**
 * The fake repository. `bulk: false` leaves out the bulk shift readers, which
 * is exactly what an older repository (or another test's double) looks like.
 */
function countingRepo(state, { bulk = true } = {}) {
  const calls = [];
  const note = (name, value) => {
    calls.push(name);
    return Promise.resolve(value);
  };
  const repo = {
    calls,
    listCalculations: () => note("listCalculations", state.stored),
    getShiftAssignmentHistory: () => note("getShiftAssignmentHistory", state.assignments),
    getRawPunchesByCalendarWindow: (_e, from, to) =>
      note("getRawPunchesByCalendarWindow", state.rawPunches.filter((p) => p.punch_date >= from && p.punch_date <= to)),
    getApprovedRegularizedPunches: () => note("getApprovedRegularizedPunches", state.regularized),
    getBreakOverride: () => note("getBreakOverride", { employee_id: EMP, special_break_override_minutes: null, extra_break_hours: null, attendance_required: 1 }),
    getApprovalStateByDate: () => note("getApprovalStateByDate", state.approvals),
    getDateShiftOverrides: () => note("getDateShiftOverrides", state.overrides),
    getWorkShiftWithSchedule: (id) => note("getWorkShiftWithSchedule", SHIFTS[id] || null),
    getWorkShiftConfigVersions: (id) => note("getWorkShiftConfigVersions", VERSIONS[id] || []),
    // Anything a read must never touch.
    saveCalculations: () => note("WRITE", null),
    saveCalculationsWithReconciliation: () => note("WRITE", null),
    findPayrollLocked: () => note("PAYROLL_LOCK", []),
  };
  if (bulk) {
    repo.getWorkShiftConfigsByIds = (ids) =>
      note("getWorkShiftConfigsByIds", ids.filter((id) => SHIFTS[id]).map((id) => SHIFTS[id].config));
    repo.getWorkShiftSchedulesByIds = (ids) =>
      note("getWorkShiftSchedulesByIds", ids.flatMap((id) => (SHIFTS[id] ? SHIFTS[id].schedule : [])));
    repo.getWorkShiftConfigVersionsByIds = (ids) =>
      note("getWorkShiftConfigVersionsByIds", ids.flatMap((id) => VERSIONS[id] || []));
  }
  return repo;
}

const NOW = Date.UTC(2026, 8, 25, 6, 0, 0);
const read = (repo, from, to) =>
  buildUsecase(repo, { today: "2026-09-25" }).readRange({ employee_id: EMP, from_date: from, to_date: to, now: NOW });

describe("a month of My Attendance is a fixed number of reads", () => {
  it("reads ten times for a 31-day month with two shifts and a one-day override - never per date", async () => {
    const repo = countingRepo(monthState());
    const days = await read(repo, "2026-08-01", "2026-08-31");

    assert.equal(days.length, 31);
    assert.equal(repo.calls.length, 10, repo.calls.join(", "));
    // Every reader exactly once.
    const counts = repo.calls.reduce((m, c) => ((m[c] = (m[c] || 0) + 1), m), {});
    Object.entries(counts).forEach(([name, n]) => assert.equal(n, 1, `${name} called ${n} times`));
    // The per-shift readers are not used when the bulk ones exist.
    assert.equal(counts.getWorkShiftWithSchedule, undefined);
    assert.equal(counts.getWorkShiftConfigVersions, undefined);
  });

  it("costs the same number of reads for one day, a short month and a 31-day month", async () => {
    const counts = [];
    for (const [from, to] of [
      ["2026-08-15", "2026-08-15"],
      ["2026-02-01", "2026-02-28"],
      ["2026-08-01", "2026-08-31"],
    ]) {
      const repo = countingRepo(monthState({ from }));
      await read(repo, from, to);
      counts.push(repo.calls.length);
    }
    assert.deepEqual(counts, [10, 10, 10]);
  });

  it("never writes, and never consults the payroll lock", async () => {
    const repo = countingRepo(monthState());
    await read(repo, "2026-08-01", "2026-08-31");
    assert.ok(!repo.calls.includes("WRITE"));
    assert.ok(!repo.calls.includes("PAYROLL_LOCK"));
  });

  it("does not wait for the stored rows before starting the other reads", async () => {
    const state = monthState();
    const repo = countingRepo(state);
    let releaseStored;
    const storedGate = new Promise((resolve) => (releaseStored = resolve));
    repo.listCalculations = () => {
      repo.calls.push("listCalculations");
      return storedGate.then(() => state.stored);
    };
    const pending = read(repo, "2026-08-01", "2026-08-31");
    // Let every microtask run: the context reads must already be in flight
    // while the stored read is still unanswered.
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(repo.calls.includes("getRawPunchesByCalendarWindow"), repo.calls.join(", "));
    assert.ok(repo.calls.includes("getApprovalStateByDate"));
    releaseStored();
    const days = await pending;
    assert.equal(days.length, 31);
  });
});

describe("the bulk shift read changes no answer", () => {
  it("returns exactly the days the per-shift read returns - stored, live, override, OT, corrections", async () => {
    const bulk = await read(countingRepo(monthState()), "2026-08-01", "2026-08-31");
    const legacy = await read(countingRepo(monthState(), { bulk: false }), "2026-08-01", "2026-08-31");
    assert.deepEqual(bulk, legacy);

    // And the month really does exercise what it claims to.
    const sources = new Set(bulk.map((d) => d.calculation_source));
    assert.ok(sources.has("STORED") && sources.has("LIVE_PREVIEW"));
    const overrideDay = bulk.find((d) => d.attendance_date === "2026-08-25");
    assert.equal(overrideDay.work_shift_id, 9, "override date");
    assert.equal(overrideDay.calculation_source, "LIVE_PREVIEW");
    assert.ok(bulk.some((d) => d.work_shift_id === 8), "second shift");
  });

  it("falls back to the per-shift reads for a repository without the bulk readers", async () => {
    const repo = countingRepo(monthState(), { bulk: false });
    await read(repo, "2026-08-01", "2026-08-31");
    assert.ok(repo.calls.includes("getWorkShiftWithSchedule"));
    assert.ok(!repo.calls.includes("getWorkShiftConfigsByIds"));
  });

  it("treats a shift with versions but no live row as the per-shift read does", async () => {
    const state = monthState();
    // Shift 7's live row is gone; its versions remain.
    const repoBulk = countingRepo(state);
    const repoLegacy = countingRepo(state, { bulk: false });
    const configs = repoBulk.getWorkShiftConfigsByIds;
    repoBulk.getWorkShiftConfigsByIds = (ids) => configs(ids).then((rows) => rows.filter((r) => r.work_shift_id !== 7));
    const withSchedule = repoLegacy.getWorkShiftWithSchedule;
    repoLegacy.getWorkShiftWithSchedule = (id) => (id === 7 ? Promise.resolve(null) : withSchedule(id));
    assert.deepEqual(
      await read(repoBulk, "2026-08-01", "2026-08-31"),
      await read(repoLegacy, "2026-08-01", "2026-08-31")
    );
  });
});

describe("the temporary read timing", () => {
  it("is a pass-through without a timing context", async () => {
    let asked = null;
    const db = { query: (sql, params, cb) => ((asked = { sql, params }), cb(null, [{ a: 1 }])) };
    const rows = await new Promise((resolve, reject) =>
      readTiming.timedQuery(db, "X", "SELECT 1", [1], (err, r) => (err ? reject(err) : resolve(r)))
    );
    assert.deepEqual(rows, [{ a: 1 }]);
    assert.deepEqual(asked, { sql: "SELECT 1", params: [1] });
  });

  it("with a pool, takes and RELEASES a connection per query, on success and on error, and records wait and execution", async () => {
    const released = [];
    const pool = {
      getConnection: (cb) =>
        cb(null, {
          query: (sql, params, qcb) => (sql === "BAD" ? qcb(new Error("boom")) : qcb(null, [1, 2])),
          release: () => released.push(true),
        }),
      query: () => assert.fail("pool.query must not be used inside a timed request"),
    };
    const ctx = readTiming.create("test");
    await readTiming.run(ctx, async () => {
      const ok = await new Promise((resolve) => readTiming.timedQuery(pool, "OK", "SELECT", [], (e, r) => resolve(r)));
      assert.deepEqual(ok, [1, 2]);
      const err = await new Promise((resolve) => readTiming.timedQuery(pool, "BAD", "BAD", [], (e) => resolve(e)));
      assert.equal(err.message, "boom");
    });
    assert.equal(released.length, 2);
    const s = readTiming.summary(ctx);
    assert.equal(s.query_count, 2);
    assert.equal(typeof s.queries[0].wait_ms, "number");
    assert.equal(typeof s.queries[0].exec_ms, "number");
  });

  it("sets Server-Timing and sends the handler's body unchanged", async () => {
    const headers = {};
    let sent = null;
    const res = {
      headersSent: false,
      statusCode: 200,
      set: (k, v) => (headers[k] = v),
      json: (body) => ((sent = body), res),
    };
    const body = { code: 200, days: [{ attendance_date: "2026-08-01" }] };
    await readTiming.instrument("t", async (_req, r) => {
      await readTiming.phase("raw_punch_lookup", async () => null);
      r.json(body);
    })({ path: "/x", receivedAtMs: readTiming.nowMs() - 5 }, res);
    assert.equal(sent, body);
    assert.match(headers["Server-Timing"], /middleware;dur=/);
    assert.match(headers["Server-Timing"], /raw_punch_lookup;dur=/);
    assert.match(headers["Server-Timing"], /payroll_lock_lookup;dur=0/);
    assert.match(headers["Server-Timing"], /total;dur=/);
  });

  it("a read inside a timed request returns the same days as one outside it", async () => {
    const plain = await read(countingRepo(monthState()), "2026-08-01", "2026-08-31");
    const ctx = readTiming.create("t");
    const timed = await readTiming.run(ctx, () => read(countingRepo(monthState()), "2026-08-01", "2026-08-31"));
    assert.deepEqual(timed, plain);
    const phases = readTiming.summary(ctx).phases;
    [
      "date_generation",
      "stored_calculation_lookup",
      "raw_punch_lookup",
      "shift_assignment_lookup",
      "shift_definition_lookup",
      "correction_ot_request_lookup",
      "live_calculation",
    ].forEach((name) => assert.ok(name in phases, `${name} missing`));
  });
});
