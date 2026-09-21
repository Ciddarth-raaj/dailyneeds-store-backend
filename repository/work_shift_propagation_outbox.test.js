/**
 * THE PROPAGATION OBLIGATION IS WRITTEN IN THE SAVE'S OWN TRANSACTION.
 *
 *   node --test repository/work_shift_propagation_outbox.test.js
 *
 * Driven against the statements `repository/work_shift.js` actually issues,
 * on a fake connection that records them in order - because "in the same
 * transaction" is a claim about statement ORDER and about which BEGIN they
 * sit between, and a usecase-level fake cannot see either.
 *
 * WHAT IS BEING PREVENTED. A queue row written after the save committed can
 * fail on its own, and then: the rule is live, nothing propagates, and the
 * user's retry is a no-op because the content is now UNCHANGED, so no version
 * is appended and no propagation is ever attempted again. The open months
 * keep the old figures permanently, silently.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const buildRepo = require("./work_shift");

const CONFIG_ROW = {
  work_shift_id: 5,
  shift_code: "9 TO 6",
  overtime_allowed: 1,
  overtime_minimum_minutes: 10,
  overtime_rounding_method: "NONE",
  overtime_rounding_interval_minutes: 0,
  overtime_minimum_threshold_only: 0,
  overtime_minimum_excluded: 1,
  maximum_ot_minutes_per_day: null,
  pre_shift_overtime_allowed: 0,
  pre_shift_overtime_minimum_minutes: 0,
  pre_shift_overtime_rounding_method: "NONE",
  pre_shift_overtime_rounding_interval_minutes: 0,
  pre_shift_overtime_minimum_excluded: 0,
  late_offset_against_overtime: 0,
  early_exit_offset_against_overtime: 0,
  late_grace_minutes: 0,
  late_deduction_interval_minutes: 0,
  late_deduct_minutes: 0,
  late_exclude_grace_from_deduction: 0,
  early_exit_grace_minutes: 0,
  early_exit_deduction_interval_minutes: 0,
  early_exit_deduct_minutes: 0,
};

const SCHEDULE_ROWS = Array.from({ length: 7 }, (_, day) => ({
  day_of_week: day,
  is_working_day: 1,
  in_time: "09:00:00",
  out_time: "18:00:00",
  attendance_day_cutoff: "04:00:00",
  break_minutes: 60,
  ot_rate: 1,
}));

/**
 * One connection, one transaction, every statement recorded in order.
 *
 * `pendingRun` is what a SELECT for an already-QUEUED propagation finds;
 * `failOn` forces the failure whose handling is the whole point of the file.
 */
function fakeDb({ pendingRun = null, failOn = null, latestVersion = null } = {}) {
  const log = [];
  const connection = {
    query(sql, params, cb) {
      const text = String(sql).replace(/\s+/g, " ").trim();
      log.push({ sql: text, params });
      if (failOn && text.includes(failOn)) {
        cb(new Error(`forced failure on ${failOn}`));
        return;
      }
      if (/^SELECT work_shift_id FROM work_shift/i.test(text)) return cb(null, [{ work_shift_id: 5 }]);
      if (/FROM work_shift WHERE work_shift_id/i.test(text)) return cb(null, [CONFIG_ROW]);
      if (/FROM work_shift_weekly_schedule/i.test(text)) return cb(null, SCHEDULE_ROWS);
      if (/FROM work_shift_config_version/i.test(text)) return cb(null, latestVersion ? [latestVersion] : []);
      if (/FROM attendance_recalculation_run/i.test(text)) {
        return cb(null, pendingRun ? [{ attendance_recalculation_run_id: pendingRun }] : []);
      }
      cb(null, { insertId: /attendance_recalculation_run/.test(text) ? 77 : 42, affectedRows: 1 });
    },
    beginTransaction: (cb) => { log.push({ sql: "BEGIN" }); cb(null); },
    commit: (cb) => { log.push({ sql: "COMMIT" }); cb(null); },
    rollback: (cb) => { log.push({ sql: "ROLLBACK" }); cb(); },
    release: () => { log.push({ sql: "RELEASE" }); },
  };
  return {
    log,
    db: { getConnection: (cb) => cb(null, connection) },
  };
}

const save = (db) =>
  buildRepo(db).updateWorkShiftWithSchedule(5, { overtime_minimum_minutes: 10 }, null, {
    created_by: 77,
  });

const indexOfStatement = (log, needle) => log.findIndex((entry) => entry.sql.includes(needle));

describe("a rule change and its propagation obligation commit together", () => {
  it("the queue INSERT is between the version INSERT and the COMMIT", async () => {
    const { log, db } = fakeDb();
    const result = await save(db);

    const begin = indexOfStatement(log, "BEGIN");
    const version = indexOfStatement(log, "INSERT INTO work_shift_config_version");
    const queued = indexOfStatement(log, "INSERT INTO attendance_recalculation_run");
    const commit = indexOfStatement(log, "COMMIT");

    assert.ok(begin >= 0 && version > begin, "the version is written inside the transaction");
    assert.ok(queued > version, "and the obligation right after it");
    assert.ok(commit > queued, "and both before the commit");
    assert.equal(result.code, 200);
    assert.equal(result.config_version.propagation_run_id, 77);
  });

  it("it is QUEUED, carries the shift and the actor, and claims no scope", async () => {
    const { log, db } = fakeDb();
    await save(db);

    const insert = log[indexOfStatement(log, "INSERT INTO attendance_recalculation_run")];
    assert.match(insert.sql, /'WORK_SHIFT_SAVE'/);
    assert.match(insert.sql, /'QUEUED'/);
    assert.match(insert.sql, /employees_targeted, status/);
    // requested_by, the widest possible range, the shift. The real scope is
    // the worker's to derive when it runs.
    assert.deepEqual(insert.params, [77, "2026-09-01", insert.params[2], 5]);
    assert.match(insert.params[2], /^\d{4}-\d{2}-\d{2}$/);
  });

  it("A FAILED QUEUE INSERT ROLLS THE RULE CHANGE BACK - no orphan is possible", async () => {
    const { log, db } = fakeDb({ failOn: "INSERT INTO attendance_recalculation_run" });

    await assert.rejects(() => save(db), /forced failure/);

    assert.ok(indexOfStatement(log, "ROLLBACK") > 0, "the save rolled back");
    assert.equal(indexOfStatement(log, "COMMIT"), -1, "and never committed");
    // The next attempt therefore sees a CHANGED configuration again and
    // appends a version - the retry is a real save, not an UNCHANGED no-op.
  });

  it("an UNCHANGED save writes neither a version nor an obligation", async () => {
    // The stored document is byte-identical to what this save would write.
    const { buildConfigVersion, configVersionHash } = require("../utils/shift_config_version");
    const document = buildConfigVersion(CONFIG_ROW, SCHEDULE_ROWS);
    const { log, db } = fakeDb({
      latestVersion: {
        work_shift_config_version_id: 1,
        config_hash: configVersionHash(document),
        config_document: JSON.stringify(document),
      },
    });

    const result = await save(db);

    assert.equal(result.config_version.appended, false);
    assert.equal(indexOfStatement(log, "INSERT INTO work_shift_config_version"), -1);
    assert.equal(
      indexOfStatement(log, "INSERT INTO attendance_recalculation_run"),
      -1,
      "renaming a shift owes no propagation"
    );
    assert.ok(indexOfStatement(log, "COMMIT") > 0);
  });

  it("one pending job per shift: an already-QUEUED run is reused, not duplicated", async () => {
    const { log, db } = fakeDb({ pendingRun: 12 });
    const result = await save(db);

    assert.equal(result.config_version.propagation_run_id, 12);
    assert.equal(result.config_version.propagation_reused, true);
    assert.equal(
      indexOfStatement(log, "INSERT INTO attendance_recalculation_run"),
      -1,
      "three edits in a minute owe one propagation, not three"
    );
  });

  it("creating a shift owes nothing: it governs no attendance date yet", async () => {
    const { log, db } = fakeDb();
    await buildRepo(db).createWorkShiftWithSchedule(CONFIG_ROW, SCHEDULE_ROWS, { created_by: 7 });

    assert.ok(indexOfStatement(log, "INSERT INTO work_shift_config_version") > 0, "it is still versioned");
    assert.equal(indexOfStatement(log, "INSERT INTO attendance_recalculation_run"), -1);
  });
});
