/**
 * THE QUEUE'S OWN INTEGRITY: one pending job per shift, and a recovery that
 * cannot deadlock against it.
 *
 *   node --test repository/recalculation_queue_coalescing.test.js
 *
 * `uq_arr_pending_shift` guarantees at most one QUEUED propagation per work
 * shift. That guarantee creates a collision the recovery paths have to
 * handle, because a stale RUNNING run whose shift ALREADY has a queued
 * successor cannot go back to QUEUED:
 *
 *   1  run A for shift X is RUNNING
 *   2  shift X is edited again, so run B is correctly queued
 *   3  A's worker dies
 *   4  recovery tries A: RUNNING -> QUEUED
 *   5  the unique key refuses it
 *
 * and since recovery runs before the claim, step 5 would fail every tick
 * forever and B would never drain. B carries the same latest configuration
 * over the same open attendance, so A is closed as SUPERSEDED instead.
 *
 * Driven against the statements the repository issues, in order.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const buildRepo = require("./attendance_calculation");

function fakeDb({ rows = {} } = {}) {
  const asked = [];
  return {
    asked,
    query(sql, params, cb) {
      const text = String(sql).replace(/\s+/g, " ").trim();
      asked.push({ sql: text, params });
      for (const [needle, answer] of Object.entries(rows)) {
        if (text.includes(needle)) return cb(null, answer);
      }
      cb(null, { affectedRows: 1 });
    },
  };
}

const index = (asked, needle) => asked.findIndex((q) => q.sql.includes(needle));

describe("stale recovery coalesces onto a newer queued run", () => {
  it("supersedes BEFORE it requeues, so the two can never collide", async () => {
    const db = fakeDb();
    await buildRepo(db).requeueStaleRecalculationRuns();

    const supersede = index(db.asked, "SET stale.status = 'SUPERSEDED'");
    const requeue = index(db.asked, "SET status = 'QUEUED', heartbeat_at = NULL");
    const abandon = index(db.asked, "SET status = 'FAILED'");

    assert.ok(supersede >= 0, "there is a superseding pass");
    assert.ok(
      supersede < requeue,
      "and it runs first: a stale run whose shift already has a queued successor is " +
        "taken out of the RUNNING set before anything tries to requeue it"
    );
    assert.ok(requeue < abandon);
  });

  it("supersedes only a stale RUNNING propagation that has a DIFFERENT queued run for its own shift", async () => {
    const db = fakeDb();
    await buildRepo(db).requeueStaleRecalculationRuns();
    const { sql } = db.asked[index(db.asked, "SET stale.status = 'SUPERSEDED'")];

    assert.match(sql, /JOIN \(SELECT work_shift_id, MIN\(attendance_recalculation_run_id\)/);
    assert.match(sql, /WHERE status = 'QUEUED' AND trigger_source = 'WORK_SHIFT_SAVE'/);
    assert.match(sql, /queued.work_shift_id = stale.work_shift_id/, "the same shift, never another");
    assert.match(sql, /stale.status = 'RUNNING'/);
    assert.match(sql, /stale.trigger_source = 'WORK_SHIFT_SAVE'/, "a manual run is never touched");
    assert.match(sql, /attendance_recalculation_run_id <> queued.successor_id/, "never itself");
    assert.match(sql, /heartbeat_at IS NULL OR stale.heartbeat_at </, "and only when it is stale");
    assert.match(sql, /superseded_by_run_id = queued.successor_id/, "recording which run took over");
  });

  it("reports what it did, so a tick can be read", async () => {
    const db = fakeDb();
    const result = await buildRepo(db).requeueStaleRecalculationRuns();
    assert.deepEqual(Object.keys(result).sort(), ["abandoned", "requeued", "superseded"]);
  });
});

describe("Retry coalesces the same way", () => {
  const failedRun = {
    "SELECT attendance_recalculation_run_id, work_shift_id, status, trigger_source": [
      {
        attendance_recalculation_run_id: 1,
        work_shift_id: 5,
        status: "FAILED",
        trigger_source: "WORK_SHIFT_SAVE",
      },
    ],
  };

  it("with a queued successor: closes the old run as SUPERSEDED and creates nothing", async () => {
    const db = fakeDb({
      rows: {
        ...failedRun,
        "WHERE pending_work_shift_id = ?": [{ attendance_recalculation_run_id: 2 }],
      },
    });

    const result = await buildRepo(db).retryRecalculationRun(1);

    assert.deepEqual(result, { requeued: false, superseded_by_run_id: 2 });
    assert.ok(index(db.asked, "SET status = 'SUPERSEDED', superseded_by_run_id = ?") >= 0);
    assert.equal(
      index(db.asked, "SET status = 'QUEUED', attempts = 0"),
      -1,
      "no second queued obligation for the shift"
    );
  });

  it("with no successor: requeues, clearing the previous attempt", async () => {
    const db = fakeDb({ rows: { ...failedRun, "WHERE pending_work_shift_id = ?": [] } });

    const result = await buildRepo(db).retryRecalculationRun(1);

    assert.deepEqual(result, { requeued: true });
    const { sql } = db.asked[index(db.asked, "SET status = 'QUEUED', attempts = 0")];
    assert.match(sql, /employees_targeted = 0, employees_completed = 0, employees_failed = 0/);
    assert.match(sql, /days_processed = 0, days_skipped_locked = 0, errors = NULL/);
    assert.match(sql, /superseded_by_run_id = NULL/);
  });

  it("a SUPERSEDED run is not retryable, and neither is a completed or a manual one", async () => {
    for (const row of [
      { status: "SUPERSEDED", trigger_source: "WORK_SHIFT_SAVE" },
      { status: "COMPLETED", trigger_source: "WORK_SHIFT_SAVE" },
      { status: "FAILED", trigger_source: "MANUAL" },
    ]) {
      const db = fakeDb({
        rows: {
          "SELECT attendance_recalculation_run_id, work_shift_id, status, trigger_source": [
            { attendance_recalculation_run_id: 1, work_shift_id: 5, ...row },
          ],
        },
      });
      const result = await buildRepo(db).retryRecalculationRun(1);
      assert.deepEqual(result, { requeued: false }, JSON.stringify(row));
      assert.equal(index(db.asked, "SET status = 'QUEUED', attempts = 0"), -1);
      assert.equal(index(db.asked, "SET status = 'SUPERSEDED'"), -1);
    }
  });
});

describe("the claim ignores everything that is not a queued propagation", () => {
  it("peeks only at QUEUED WORK_SHIFT_SAVE rows", async () => {
    const db = fakeDb({ rows: { "FROM attendance_recalculation_run WHERE status = 'QUEUED'": [] } });
    await buildRepo(db).claimNextQueuedRun();
    const { sql } = db.asked[0];
    assert.match(sql, /status = 'QUEUED' AND trigger_source = 'WORK_SHIFT_SAVE'/);
  });
});
