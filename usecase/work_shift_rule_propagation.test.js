/**
 * WORK SHIFT RULE PROPAGATION - the regression suite.
 *
 * The world these tests run in - the fakes, the queue, the worker tick and
 * the September seed - lives in `work_shift_rule_propagation.harness.js`,
 * shared with the cross-feature compatibility suite so there is one harness
 * and not two. The assertions are unchanged.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { buildConfigVersion, configVersionHash } = require("../utils/shift_config_version");
const { governsEmployeeMonth } = require("../utils/shift_propagation");
const {
  TODAY,
  SHIFT,
  OTHER_SHIFT,
  ALICE,
  BOB,
  CARL,
  DEE,
  scheduleFor,
  configFor,
  monthOf,
  workedDay,
  world,
  drainQueue,
  storedOt,
  saveMinimumOt,
  seedSeptember,
} = require("./work_shift_rule_propagation.harness");

describe("work shift rule propagation", () => {
  it("the regression case: 120 raw OT, minimum 20 -> 100, and the same day becomes 110 when the minimum drops to 10", async () => {
    const w = await seedSeptember();
    assert.equal(storedOt(w, ALICE, "2026-09-13"), 100, "120 earned, 20 excluded");

    const result = await saveMinimumOt(w, 10);
    assert.equal(result.code, 200);
    assert.equal(
      storedOt(w, ALICE, "2026-09-13"),
      100,
      "the SAVE itself recalculates nothing - it queues"
    );

    await drainQueue(w);

    assert.equal(
      storedOt(w, ALICE, "2026-09-13"),
      110,
      "13-Sep is recalculated under the new rule although it is in the past"
    );
  });

  it("THE FULL SEQUENCE: open recalc under the new rule, then lock, then another rule change", async () => {
    // This is the case that decides what a locked month means. 13-Sep is
    // calculated under the 20 minute minimum; the minimum becomes 10 while
    // September is open, so 13-Sep correctly becomes 110; September is then
    // locked; a later change to 5 must leave 13-Sep at 110 - NOT at the 100
    // the version dated to 13-Sep would reconstruct.
    const w = await seedSeptember();
    assert.equal(storedOt(w, ALICE, "2026-09-13"), 100);

    await saveMinimumOt(w, 10);
    await drainQueue(w);
    assert.equal(storedOt(w, ALICE, "2026-09-13"), 110, "open September takes the new rule");

    // Payroll approves and locks September.
    w.state.lockedMonths.add(`${ALICE}|2026-09`);

    await saveMinimumOt(w, 5);
    await drainQueue(w);

    assert.equal(
      storedOt(w, ALICE, "2026-09-13"),
      110,
      "the frozen result stands: not 115 from the new rule, and not 100 from the rule dated to 13-Sep"
    );
    await assert.rejects(
      () =>
        w.calculation.recalculateRange({
          employee_id: ALICE,
          from_date: "2026-09-13",
          to_date: "2026-09-14",
        }),
      (err) => err.code === "PAYROLL_MONTH_LOCKED",
      "and a manual recalculation cannot move it either"
    );
    assert.equal(storedOt(w, ALICE, "2026-09-13"), 110);
  });

  it("saving the shift returns promptly and says what was STARTED", async () => {
    const w = await seedSeptember();
    const result = await saveMinimumOt(w, 10);

    assert.equal(w.state.runs.length, 1, "the obligation is committed with the rule change");
    assert.equal(w.state.runs[0].status, "QUEUED");
    assert.equal(result.config_version.propagation_run_id, 1);
    assert.equal(
      result.msg,
      "Shift updated. Attendance recalculation queued (run #1): every open attendance day " +
        "on this shift will be recalculated under the new rule, and payroll-locked months are skipped."
    );
    assert.equal(w.state.recalculatedRanges.length, 0, "no recalculation happened in the request");
    // The counts belong to the RUN, and the run has not started yet.
    assert.equal(w.state.runs[0].employees_targeted, 0);
  });

  it("AN OPEN DATE THAT WAS NEVER CALCULATED is recalculated too", async () => {
    // Discovery is from the assignment history, not from stored rows: this
    // employee punched but nobody has ever run attendance for them.
    const w = await seedSeptember();
    w.state.punches.push(...workedDay(41, DEE, "2026-09-10"));
    assert.equal(w.state.stored.get(`${DEE}|2026-09-10`), undefined);

    await saveMinimumOt(w, 10);
    await drainQueue(w);

    assert.equal(
      storedOt(w, DEE, "2026-09-10"),
      110,
      "a date with no stored calculation is exactly the date that needed the new rule"
    );
  });

  it("the whole open window is covered - from the shift assignment to today, never beyond", async () => {
    const w = await seedSeptember();
    await saveMinimumOt(w, 10);
    await drainQueue(w);

    const alice = w.state.recalculatedRanges.filter((r) => r.employee_id === ALICE);
    assert.equal(alice.length, 1, "one range for September");
    assert.equal(alice[0].from_date, "2026-09-01", "from the assignment, not from the first stored day");
    assert.equal(alice[0].to_date, TODAY, "to today");
    assert.equal(
      w.state.recalculatedRanges.every((r) => r.to_date <= TODAY),
      true,
      "and never into the future"
    );
  });

  it("a LOCKED month is skipped entirely and its days do not move", async () => {
    const w = await seedSeptember();
    w.state.lockedMonths.add(`${BOB}|2026-09`);
    assert.equal(storedOt(w, BOB, "2026-09-13"), 100);

    await saveMinimumOt(w, 10);
    const ticks = await drainQueue(w);

    assert.equal(storedOt(w, BOB, "2026-09-13"), 100, "the settled day is untouched");
    assert.equal(storedOt(w, ALICE, "2026-09-13"), 110, "and the open one is not");
    assert.equal(
      ticks[0].result.employees_targeted,
      2,
      "Alice and Dee; Bob's only open month is the one that was locked"
    );
    assert.equal(ticks[0].result.months_skipped_locked, 1);
    assert.equal(
      w.state.recalculatedRanges.some((r) => r.employee_id === BOB),
      false,
      "the locked employee-month was never even attempted"
    );
  });

  it("a month that locks BETWEEN the scope read and the write is refused and counted, not lost", async () => {
    const w = await seedSeptember();
    await saveMinimumOt(w, 10);
    // The lock lands after the run was queued, before the worker gets there.
    w.state.lockedMonths.add(`${BOB}|2026-09`);
    await drainQueue(w);

    assert.equal(storedOt(w, BOB, "2026-09-13"), 100, "the write gate refused it");
    assert.equal(storedOt(w, ALICE, "2026-09-13"), 110);
    const run = w.state.runs[0];
    assert.equal(run.status, "COMPLETED", "a refusal by the lock is not an error");
    assert.equal(run.employees_failed, 0);
    assert.ok(run.days_skipped_locked > 0, "and it is reported as skipped");
  });

  it("the MANUAL Recalculate uses the latest shift configuration for an open date", async () => {
    const w = await seedSeptember();
    // The save queues a propagation; this test never drains it, so only the
    // MANUAL recalculation below can be what brings the date up to date.
    await saveMinimumOt(w, 10);
    assert.equal(storedOt(w, ALICE, "2026-09-13"), 100, "nothing has recalculated it yet");

    await w.calculation.recalculateRange({
      employee_id: ALICE,
      from_date: "2026-09-13",
      to_date: "2026-09-14",
    });

    assert.equal(storedOt(w, ALICE, "2026-09-13"), 110);
  });

  it("no unrelated employee or date is recalculated", async () => {
    const w = await seedSeptember();
    const carlBefore = storedOt(w, CARL, "2026-09-13");

    await saveMinimumOt(w, 10);
    await drainQueue(w);

    assert.equal(storedOt(w, CARL, "2026-09-13"), carlBefore, "another shift's employee is untouched");
    assert.equal(
      w.state.recalculatedRanges.some((r) => r.employee_id === CARL),
      false,
      "and was never recalculated at all"
    );
    w.state.recalculatedRanges.forEach((range) => {
      assert.equal(monthOf(range.from_date), "2026-09");
      assert.equal(monthOf(range.to_date), "2026-09");
      assert.equal([ALICE, BOB, DEE].includes(range.employee_id), true);
    });
  });

  it("a save that changes nothing calculable queues nothing", async () => {
    const w = await seedSeptember();
    const result = await w.workShift.update(SHIFT, {
      work_shift_details: { overtime_minimum_minutes: 20 },
      actor_employee_id: 7,
    });
    assert.equal(result.config_version.appended, false, "no version, so no obligation");
    assert.equal(result.config_version.propagation_run_id, null);
    assert.equal(result.msg, "Shift updated.");
    assert.equal(w.state.runs.length, 0);
  });

  it("A COMMITTED RULE CAN NEVER BECOME AN UNQUEUED ORPHAN", async () => {
    // The failure this guards against: the configuration commits, the queue
    // INSERT fails, nothing propagates - and the retry is a no-op because the
    // content is now UNCHANGED, so no version is appended and no propagation
    // is ever attempted. The rule would be live with the old figures stored
    // and nothing anywhere would say so.
    const w = await seedSeptember();
    w.state.enqueueThrows = "the queue table is unreachable";

    await assert.rejects(() => saveMinimumOt(w, 10), /queue table is unreachable/);

    // NEITHER committed.
    assert.equal(w.state.runs.length, 0);
    assert.equal(
      w.state.live.get(SHIFT).config.overtime_minimum_minutes,
      20,
      "the rule change rolled back with the obligation it could not record"
    );
    assert.equal(w.state.versions.get(SHIFT).length, 1, "and no version was appended");

    // So the retry is a REAL save again, not an UNCHANGED no-op.
    w.state.enqueueThrows = null;
    const retry = await saveMinimumOt(w, 10);
    assert.equal(retry.config_version.appended, true);
    assert.equal(retry.config_version.propagation_run_id, 1);

    await drainQueue(w);
    assert.equal(storedOt(w, ALICE, "2026-09-13"), 110);
  });

  it("several edits in a row owe ONE propagation, and it sees all of them", async () => {
    const w = await seedSeptember();
    await saveMinimumOt(w, 15);
    await saveMinimumOt(w, 10);

    assert.equal(w.state.runs.length, 1, "the queued run is reused, not duplicated");

    await drainQueue(w);
    assert.equal(storedOt(w, ALICE, "2026-09-13"), 110, "and it applied the LAST rule");
  });

  it("the run is auditable: who, which shift, that a shift save started it, and how it ended", async () => {
    const w = await seedSeptember();
    await saveMinimumOt(w, 10, 77);

    assert.equal(w.state.runs.length, 1);
    assert.equal(w.state.runs[0].status, "QUEUED", "durable before anything runs");
    assert.equal(w.state.runs[0].trigger_source, "WORK_SHIFT_SAVE");
    assert.equal(w.state.runs[0].work_shift_id, SHIFT);
    assert.equal(w.state.runs[0].requested_by_employee_id, 77);

    await drainQueue(w);

    const run = w.state.runs[0];
    assert.equal(run.status, "COMPLETED");
    assert.equal(run.attempts, 1);
    assert.ok(run.days_processed > 0);
    assert.equal(run.days_skipped_locked, 0);
    assert.ok(w.state.heartbeats.length > 0, "a long run beats while it works");
  });

  it("the employee's shift on the DATE still decides which shift's rules apply", async () => {
    const w = await seedSeptember();
    // Alice moves to the other shift from 14-Sep. 13-Sep is still 9 TO 6.
    w.state.assignments.set(ALICE, [
      ...w.state.assignments.get(ALICE),
      {
        employee_work_shift_assignment_id: 9,
        employee_id: ALICE,
        work_shift_id: OTHER_SHIFT,
        effective_from: "2026-09-14",
      },
    ]);
    await w.calculation.recalculateRange({
      employee_id: ALICE,
      from_date: "2026-09-13",
      to_date: "2026-09-14",
    });

    assert.equal(
      Number(w.state.stored.get(`${ALICE}|2026-09-13`).work_shift_id),
      SHIFT,
      "13-Sep keeps the shift she was on that day"
    );
    assert.equal(Number(w.state.stored.get(`${ALICE}|2026-09-14`).work_shift_id), OTHER_SHIFT);

    // Editing 9 TO 6 now reaches 13-Sep and not 14-Sep.
    await saveMinimumOt(w, 10);
    await drainQueue(w);
    assert.equal(storedOt(w, ALICE, "2026-09-13"), 110);
    assert.equal(storedOt(w, ALICE, "2026-09-14"), 100, "14-Sep is the other shift's day");
    // And the range stops where the assignment does.
    const alice = w.state.recalculatedRanges.filter((r) => r.employee_id === ALICE);
    assert.equal(alice[alice.length - 1].to_date, "2026-09-13");
  });

  it("a single-date override ONTO this shift brings that date into scope", async () => {
    const w = await seedSeptember();
    // Carl is on the other shift, but 15-Sep was moved onto 9 TO 6.
    w.state.overrides.set(CARL, [{ attendance_date: "2026-09-15", work_shift_id: SHIFT }]);
    w.state.punches.push(...workedDay(51, CARL, "2026-09-15"));

    await saveMinimumOt(w, 10);
    await drainQueue(w);

    assert.equal(storedOt(w, CARL, "2026-09-15"), 110, "the overridden date uses 9 TO 6's new rule");
    assert.equal(storedOt(w, CARL, "2026-09-13"), 100, "his ordinary days are not this shift's");
  });
});

describe("payroll cannot overtake a pending propagation", () => {
  it("THE REQUIRED SEQUENCE: blocked before the worker, approved after it, frozen afterwards", async () => {
    const w = await seedSeptember();
    assert.equal(storedOt(w, ALICE, "2026-09-13"), 100, "1. 13-Sep pays 100 under the 20 minute minimum");

    // 2 + 3. The rule changes and commits with its queued propagation.
    const save = await saveMinimumOt(w, 10);
    assert.equal(w.state.runs[0].status, "QUEUED");

    // 4. The worker has NOT run.
    // 5. Approve & Lock must refuse, and say why.
    const blocked = await w.approveAndLock(ALICE, "2026-09");
    assert.equal(blocked.outcome, "RECALCULATION_PENDING");
    assert.deepEqual(blocked.pending_recalculations, [
      { run_id: save.config_version.propagation_run_id, work_shift_id: SHIFT, status: "QUEUED" },
    ]);
    assert.equal(w.isLocked(ALICE, "2026-09-13"), false, "nothing was settled");

    // 6. The worker runs.
    await drainQueue(w);
    assert.equal(storedOt(w, ALICE, "2026-09-13"), 110);
    assert.equal(w.state.runs[0].status, "COMPLETED");

    // 7. Now it approves.
    const approved = await w.approveAndLock(ALICE, "2026-09");
    assert.equal(approved.outcome, "APPROVED");

    // 8. A later rule change leaves the settled month alone.
    await saveMinimumOt(w, 5);
    await drainQueue(w);
    assert.equal(storedOt(w, ALICE, "2026-09-13"), 110, "September is frozen at what was approved");
  });

  it("a RUNNING propagation blocks too", async () => {
    const w = await seedSeptember();
    await saveMinimumOt(w, 10);
    w.state.runs[0].status = "RUNNING";
    assert.equal((await w.approveAndLock(ALICE, "2026-09")).outcome, "RECALCULATION_PENDING");
  });

  it("a FAILED propagation blocks: nobody knows whether it reached this month", async () => {
    const w = await seedSeptember();
    await saveMinimumOt(w, 10);
    w.state.runs[0].status = "FAILED";
    assert.equal((await w.approveAndLock(ALICE, "2026-09")).outcome, "RECALCULATION_PENDING");

    // And the retry clears the way once it completes.
    await w.calculation.retryRecalculationRun(1);
    await drainQueue(w);
    assert.equal((await w.approveAndLock(ALICE, "2026-09")).outcome, "APPROVED");
  });

  it("COMPLETED_WITH_ERRORS blocks the employee whose month is in the unresolved run", async () => {
    const w = await seedSeptember();
    await saveMinimumOt(w, 10);
    w.state.runs[0].status = "COMPLETED_WITH_ERRORS";
    assert.equal((await w.approveAndLock(ALICE, "2026-09")).outcome, "RECALCULATION_PENDING");
  });

  it("an unrelated shift's propagation does not block", async () => {
    const w = await seedSeptember();
    await saveMinimumOt(w, 10);
    // Carl is on the other shift and was never on 9 TO 6.
    assert.equal((await w.approveAndLock(CARL, "2026-09")).outcome, "APPROVED");
  });

  it("a month locked while the propagation was pending is reported, never skipped silently", async () => {
    // The guard above should prevent this. If a lock lands anyway - through a
    // path that predates the guard, or in the instant between its read and
    // this run reaching the month - the month has been settled on attendance
    // the rule change never reached, and that must be visible.
    const w = await seedSeptember();
    await saveMinimumOt(w, 10);
    w.state.lockedMonths.add(`${ALICE}|2026-09`);
    w.state.lockedAt.set(`${ALICE}|2026-09`, new Date(w.state.now + 60000).toISOString());

    await drainQueue(w);

    const run = w.state.runs[0];
    assert.equal(run.status, "COMPLETED_WITH_ERRORS");
    const reported = run.errors.find((e) => e.employee_id === ALICE);
    assert.ok(reported, "the employee-month is named");
    assert.match(reported.message, /was approved and locked at .*after this shift-rule recalculation was queued/s);
    assert.equal(storedOt(w, ALICE, "2026-09-13"), 100, "and the locked month is untouched");
  });
});

describe("the run row tells the truth about its own scope", () => {
  it("the queued placeholder is replaced with the REAL employees and dates", async () => {
    const w = await seedSeptember();
    const save = await saveMinimumOt(w, 10);

    const queued = w.state.runs[0];
    assert.equal(queued.employees_targeted, 0, "the save could not know, and did not guess");
    assert.equal(queued.from_date, "2026-09-01");

    await drainQueue(w);

    const run = w.state.runs[save.config_version.propagation_run_id - 1];
    assert.equal(run.employees_targeted, 3, "Alice, Bob and Dee are on this shift");
    assert.equal(run.employees_completed, 3);
    assert.equal(run.employees_failed, 0);
    assert.ok(
      run.employees_completed <= run.employees_targeted,
      "never 3 / 0 - the screen shows completed out of targeted"
    );
    assert.equal(run.from_date, "2026-09-01", "the first open affected date");
    assert.equal(run.to_date, TODAY, "and the last");
    assert.equal(run.status, "COMPLETED");
  });

  it("the range is the range actually affected, not the cutover-to-today placeholder", async () => {
    const w = await seedSeptember();
    // Everyone leaves the shift after 14-Sep, so the affected window ends there.
    [ALICE, BOB, DEE].forEach((id) => {
      w.state.assignments.set(id, [
        ...w.state.assignments.get(id),
        {
          employee_work_shift_assignment_id: 50 + id,
          employee_id: id,
          work_shift_id: OTHER_SHIFT,
          effective_from: "2026-09-15",
        },
      ]);
    });

    await saveMinimumOt(w, 10);
    await drainQueue(w);

    const run = w.state.runs[0];
    assert.equal(run.to_date, "2026-09-14", "not today, because the shift stopped governing then");
  });

  it("no open work left: the run finishes honestly at zero rather than keeping the placeholder", async () => {
    const w = await seedSeptember();
    await saveMinimumOt(w, 10);
    // Every affected month is locked before the worker gets there.
    [ALICE, BOB, DEE].forEach((id) => w.state.lockedMonths.add(`${id}|2026-09`));

    await drainQueue(w);

    const run = w.state.runs[0];
    assert.equal(run.employees_targeted, 0);
    assert.equal(run.employees_completed, 0);
    assert.equal(run.days_processed, 0);
    assert.ok(run.days_skipped_locked > 0, "the days it did not touch are counted");
    assert.equal(run.status, "COMPLETED");
    // The range now describes the SKIPPED work rather than a window of work
    // that never existed: here that is the same September span, and what
    // matters is that no employee is claimed as targeted.
    assert.equal(run.from_date, "2026-09-01");
    assert.equal(
      run.employees_completed,
      0,
      "a run that recalculated nothing says so, instead of inheriting the placeholder"
    );
  });

  it("RETRY clears the previous attempt's figures, and the next claim re-derives them", async () => {
    const w = await seedSeptember();
    await saveMinimumOt(w, 10);
    await drainQueue(w);

    // Dirty it the way a partly failed attempt would.
    Object.assign(w.state.runs[0], {
      status: "COMPLETED_WITH_ERRORS",
      employees_completed: 2,
      employees_failed: 1,
      days_processed: 40,
      days_skipped_locked: 9,
      errors: [{ employee_id: ALICE, message: "stale" }],
      last_error: "stale",
      completed_at: "2026-09-21 10:00:00",
    });

    await w.calculation.retryRecalculationRun(1);

    const requeued = w.state.runs[0];
    assert.equal(requeued.status, "QUEUED");
    assert.equal(requeued.attempts, 0);
    assert.equal(requeued.employees_targeted, 0, "the scope is pending again until re-derived");
    assert.equal(requeued.employees_completed, 0);
    assert.equal(requeued.employees_failed, 0);
    assert.equal(requeued.days_processed, 0);
    assert.equal(requeued.days_skipped_locked, 0);
    assert.equal(requeued.errors, null);
    assert.equal(requeued.last_error, null);
    assert.equal(requeued.completed_at, null);
    assert.equal(requeued.heartbeat_at, null);

    await drainQueue(w);

    const done = w.state.runs[0];
    assert.equal(done.status, "COMPLETED");
    assert.equal(done.employees_targeted, 3, "re-derived, not inherited");
    assert.equal(done.employees_completed, 3);
    assert.equal(done.employees_failed, 0);
    assert.deepEqual(done.errors, []);
  });
});

describe("the recalculation queue", () => {
  it("survives a worker that died mid-run: stale RUNNING is requeued and finishes", async () => {
    const w = await seedSeptember();
    await saveMinimumOt(w, 10);

    // The worker claims the run and the process dies before finishing.
    const run = await w.state.runs[0];
    run.status = "RUNNING";
    run.attempts = 1;
    run.heartbeat_at = w.state.now - 20 * 60 * 1000;

    const ticks = await drainQueue(w);
    assert.equal(ticks[0].recovered.requeued, 1, "the stale run came back to the queue");
    assert.equal(w.state.runs[0].status, "COMPLETED");
    assert.equal(storedOt(w, ALICE, "2026-09-13"), 110, "and the work actually happened");
  });

  it("gives up after too many attempts rather than looping forever", async () => {
    const w = await seedSeptember();
    await saveMinimumOt(w, 10);
    const run = w.state.runs[0];
    run.status = "RUNNING";
    run.attempts = 3;
    run.heartbeat_at = w.state.now - 20 * 60 * 1000;

    await w.calculation.processQueuedRecalculations({ today: TODAY });

    assert.equal(run.status, "FAILED");
    assert.match(run.last_error, /abandoned after 3 attempts/);
  });

  it("STALE RUNNING + a newer QUEUED run for the same shift: the old one is superseded, the new one drains", async () => {
    // The collision the unique pending-job key creates: run A is RUNNING, the
    // shift is edited again so run B is queued, then A's worker dies. A
    // cannot go back to QUEUED - B owns that shift's pending slot - and a
    // tick that tried would throw on every future tick and never claim B.
    const w = await seedSeptember();
    await saveMinimumOt(w, 15);
    const runA = w.state.runs[0];
    runA.status = "RUNNING";
    runA.attempts = 1;
    runA.heartbeat_at = w.state.now;

    // The shift is edited again while A is running: B is correctly created.
    await saveMinimumOt(w, 10);
    assert.equal(w.state.runs.length, 2, "a RUNNING run does not absorb a new obligation");
    const runB = w.state.runs[1];
    assert.equal(runB.status, "QUEUED");

    // A's worker dies.
    runA.heartbeat_at = w.state.now - 20 * 60 * 1000;

    const ticks = await drainQueue(w);

    assert.equal(ticks[0].recovered.superseded, 1);
    assert.equal(ticks[0].recovered.requeued, 0, "it was never put back in the queue");
    assert.equal(runA.status, "SUPERSEDED");
    assert.equal(runA.superseded_by_run_id, runB.attendance_recalculation_run_id);
    assert.equal(ticks[0].claimed, runB.attendance_recalculation_run_id, "and B was claimed");
    assert.equal(runB.status, "COMPLETED");
    assert.equal(storedOt(w, ALICE, "2026-09-13"), 110, "the latest rule reached the open dates");
  });

  it("FAILED A + QUEUED B for the same shift: Retry on A closes it, B stays the one obligation", async () => {
    const w = await seedSeptember();
    await saveMinimumOt(w, 15);
    const runA = w.state.runs[0];
    runA.status = "RUNNING";
    runA.heartbeat_at = w.state.now;
    await saveMinimumOt(w, 10);
    const runB = w.state.runs[1];
    runA.status = "FAILED";

    const retried = await w.calculation.retryRecalculationRun(
      runA.attendance_recalculation_run_id
    );

    assert.equal(retried.code, 200);
    assert.equal(retried.status, "SUPERSEDED");
    assert.equal(retried.superseded_by_run_id, runB.attendance_recalculation_run_id);
    assert.match(retried.msg, /newer recalculation \(run #2\) is already queued/);
    assert.equal(runA.status, "SUPERSEDED", "no second queued obligation was created");
    assert.equal(
      w.state.runs.filter((r) => r.status === "QUEUED").length,
      1,
      "exactly one pending job for the shift"
    );

    await drainQueue(w);
    assert.equal(runB.status, "COMPLETED");
    assert.equal(storedOt(w, ALICE, "2026-09-13"), 110);
  });

  it("different shifts do NOT coalesce", async () => {
    const w = await seedSeptember();
    await saveMinimumOt(w, 10);
    const runA = w.state.runs[0];
    runA.status = "RUNNING";
    runA.attempts = 1;
    runA.heartbeat_at = w.state.now - 20 * 60 * 1000;

    // A queued run for ANOTHER shift must not adopt this one's work.
    await w.workShift.update(OTHER_SHIFT, {
      work_shift_details: { overtime_minimum_minutes: 10 },
      actor_employee_id: 7,
    });

    const ticks = await drainQueue(w);

    assert.equal(ticks[0].recovered.superseded, 0);
    assert.equal(ticks[0].recovered.requeued, 1, "the stale run for shift 5 is requeued normally");
    assert.equal(runA.status, "COMPLETED", "and it runs");
  });

  it("payroll ignores a SUPERSEDED run but still waits for the run that replaced it", async () => {
    const w = await seedSeptember();
    await saveMinimumOt(w, 15);
    const runA = w.state.runs[0];
    runA.status = "RUNNING";
    runA.heartbeat_at = w.state.now;
    await saveMinimumOt(w, 10);
    const runB = w.state.runs[1];
    runA.heartbeat_at = w.state.now - 20 * 60 * 1000;

    // Recovery has closed A as superseded (proved in the case above); B is
    // still queued and still owes the work.
    runA.status = "SUPERSEDED";
    runA.superseded_by_run_id = runB.attendance_recalculation_run_id;

    const blocked = await w.approveAndLock(ALICE, "2026-09");
    assert.equal(blocked.outcome, "RECALCULATION_PENDING");
    assert.deepEqual(
      blocked.pending_recalculations.map((p) => p.run_id),
      [runB.attendance_recalculation_run_id],
      "the superseded run is not among the things payroll is waiting for"
    );

    await drainQueue(w);

    // Once B completes, payroll is clear.
    assert.equal(runB.status, "COMPLETED");
    assert.equal((await w.approveAndLock(ALICE, "2026-09")).outcome, "APPROVED");
    assert.equal(storedOt(w, ALICE, "2026-09-13"), 110);
  });

  it("a recovery that throws does not stop the tick from claiming the queued run", async () => {
    const w = await seedSeptember();
    await saveMinimumOt(w, 10);
    const original = w.state.requeueThrows;
    w.state.requeueThrows = "deadlock found when trying to get lock";

    const tick = await w.calculation.processQueuedRecalculations({ today: TODAY });

    assert.match(tick.recovered.error, /deadlock/);
    assert.equal(tick.claimed, 1, "the queue still drained");
    assert.equal(w.state.runs[0].status, "COMPLETED");
    w.state.requeueThrows = original;
  });

  it("a MANUAL bulk run is never claimed, requeued or abandoned by the worker", async () => {
    // A manual run is executed by the request that asked for it: it is
    // RUNNING for as long as that takes and it never heartbeats, so a
    // recovery that went by heartbeat alone would declare it dead, requeue
    // it, and hand the worker a run with no shift to propagate.
    const w = await seedSeptember();
    w.state.runs.push({
      attendance_recalculation_run_id: 1,
      trigger_source: "MANUAL",
      status: "RUNNING",
      attempts: 0,
      heartbeat_at: null,
      work_shift_id: null,
    });

    const tick = await w.calculation.processQueuedRecalculations({ today: TODAY });

    assert.equal(tick.recovered.requeued, 0);
    assert.equal(tick.recovered.abandoned, 0);
    assert.equal(tick.claimed, null);
    assert.equal(w.state.runs[0].status, "RUNNING", "the manual run is left entirely alone");

    const retried = await w.calculation.retryRecalculationRun(1);
    assert.equal(retried.code, 422, "and it is not retryable from the queue either");
  });

  it("a failed run is retryable, and a clean one is not", async () => {
    const w = await seedSeptember();
    await saveMinimumOt(w, 10);
    w.state.runs[0].status = "FAILED";

    const retried = await w.calculation.retryRecalculationRun(1);
    assert.equal(retried.code, 200);
    assert.equal(w.state.runs[0].status, "QUEUED");

    await drainQueue(w);
    assert.equal(w.state.runs[0].status, "COMPLETED");

    const again = await w.calculation.retryRecalculationRun(1);
    assert.equal(again.code, 422, "a run that completed cleanly is not re-runnable");
  });

  it("one employee with a failed month and a succeeded month counts as ONE failed employee", async () => {
    const w = await seedSeptember();
    // Two open months for Alice, and the second one blows up.
    w.state.punches.push(...workedDay(61, ALICE, "2026-10-05"));
    w.state.assignments.set(ALICE, w.state.assignments.get(ALICE));
    w.state.failRange = { employee_id: ALICE, from_date: "2026-10-01" };

    // Saved and run in late October, so both September and October are in
    // scope for everybody the shift governs.
    await w.workShift.update(SHIFT, {
      work_shift_details: { overtime_minimum_minutes: 10 },
      actor_employee_id: 7,
    });
    const ticks = await drainQueue(w, { today: "2026-10-20" });
    assert.ok(ticks[0].claimed);

    const run = w.state.runs[0];
    assert.equal(run.employees_failed, 1);
    assert.equal(
      run.employees_completed,
      2,
      "Bob and Dee completed; Alice is counted once, as failed, not also as completed"
    );
    assert.equal(run.status, "COMPLETED_WITH_ERRORS");
    assert.equal(run.errors.length, 1);
    assert.equal(run.errors[0].employee_id, ALICE);
    assert.equal(run.errors[0].period, "10/2026");
  });
});
