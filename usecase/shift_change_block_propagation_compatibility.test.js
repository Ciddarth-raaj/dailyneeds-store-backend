/**
 * THE HR SHIFT CHANGE BLOCK vs WORK SHIFT RULE PROPAGATION.
 *
 *   node --test usecase/shift_change_block_propagation_compatibility.test.js
 *
 * WHY THIS FILE EXISTS. Work Shift rule propagation reached production after
 * the HR block was written. The two features meet on one row: an OPEN
 * attendance date that HR has marked not eligible and that a propagated rule
 * change is about to recalculate.
 *
 * Propagation is NOT "an assignment row appears". The production sequence is
 *
 *   Work Shift save
 *     -> `work_shift_config_version` appended
 *     -> a durable `attendance_recalculation_run` QUEUED
 *     -> `processQueuedRecalculations` claims and drains it
 *     -> the affected open employee/months are recalculated
 *
 * and no `employee_work_shift_assignment` row is written anywhere in it. So
 * these tests drive that real sequence, through the REAL `usecase/work_shift`
 * save path and the REAL `usecase/attendance_calculation` worker, over the
 * SAME harness the propagation regression suite itself runs on - not a copy,
 * and not a shortcut that pushes fixtures around.
 *
 * WHAT EACH TEST MUST ESTABLISH, IN BOTH HALVES:
 *
 *   A. propagation genuinely recalculated the blocked date - proven by the
 *      established regression figure, stored OT moving 100 -> 110 only after
 *      the worker runs, and by the run reaching its terminal state
 *   B. the HR decision survived it - the same ledger row, still active, and
 *      both the options endpoint and the authoritative submit still refusing
 *
 * Half A without half B would pass against a feature that silently dropped
 * the block; half B without half A would pass against a worker that did
 * nothing at all. Both are asserted, and the mutation notes on each test say
 * which mutation kills which half.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const buildRegularization = require("./attendance_regularization");
const buildBlock = require("./attendance_shift_change_block");
const { fakeBlockRepo } = require("./shift_change_block_ledger.fake");
const { EMPLOYEE_BRANCH_SCOPE } = require("../utils/employee_branch_scope");
const {
  TODAY,
  SHIFT,
  ALICE,
  scheduleFor,
  configFor,
  drainQueue,
  storedOt,
  saveMinimumOt,
  seedSeptember,
} = require("./work_shift_rule_propagation.harness");

/** The blocked date. Open September, punched, and already calculated. */
const DATE = "2026-09-13";

/** A THIRD shift, genuinely longer than 9 TO 6, so a shift change is a real
 *  option before HR blocks the date. 09:00-22:00 less an hour is 720 NRM
 *  against the base shift's 480. */
const LONG_SHIFT = 9;

const OUTLET = 1;
const HR = { employee_id: 900, user_id: 7 };
const ALL_BRANCHES = { kind: EMPLOYEE_BRANCH_SCOPE.ALL_BRANCHES, store_ids: null };

const alice = {
  employee_id: ALICE,
  employee_name: "Alice",
  store_id: OUTLET,
  designation_id: 5,
  outlet_name: "Main Store",
  designation_name: "Cashier",
};

/** Put the long shift into the same live world, with its own dated version. */
const addLongShift = (w, { outTime = "22:00:00" } = {}) => {
  w.state.live.set(LONG_SHIFT, {
    config: configFor(LONG_SHIFT, { shift_code: "LONG", shift_name: "Long Day" }),
    schedule: scheduleFor(LONG_SHIFT, {
      in_time: "09:00:00",
      out_time: outTime,
      break_minutes: 60,
      normal_work_minutes: 720,
    }),
  });
  if (!w.state.versions.has(LONG_SHIFT)) w.state.versions.set(LONG_SHIFT, []);
  w.appendVersion(LONG_SHIFT, "2026-09-01");
};

/**
 * The HR block and the shift-change request, wired to the SAME calculation
 * usecase the propagation worker runs on. That shared instance is the whole
 * point: an eligibility answer here is computed from the very configuration
 * the worker just recalculated under, never from a second copy of it.
 */
function wire(w) {
  const created = [];
  const requests = [];
  const blockRepo = fakeBlockRepo({ employees: [alice], now: TODAY });

  const regularization = buildRegularization(
    {
      getApprovalIdentity: async (id) =>
        Number(id) === ALICE
          ? {
              employee_id: ALICE,
              employee_name: alice.employee_name,
              outlet_id: alice.store_id,
              outlet_name: alice.outlet_name,
              designation_id: alice.designation_id,
              designation_name: alice.designation_name,
              approver_role: null,
            }
          : null,
      findRequestsForDates: async (employeeId, dates) =>
        requests.filter(
          (r) => Number(r.employee_id) === Number(employeeId) && dates.includes(r.attendance_date)
        ),
      createRequest: async (payload) => {
        created.push(payload);
        return { attendance_approval_request_id: 7000 + created.length, chain: [] };
      },
    },
    w.calculation,
    {
      getActiveSetup: async (employeeId) => ({
        employee_id: employeeId,
        first_level_approver_employee_id: 7,
        second_level_approver_employee_id: null,
        final_approver_employee_id: 8,
      }),
    },
    blockRepo
  );

  return { blockRepo, regularization, blocks: buildBlock(blockRepo, regularization), created };
}

const optionsFor = (world, date = DATE) =>
  world.regularization.shiftChangeOptions({
    actor: { employee_id: ALICE },
    attendance_date: date,
  });

/** Raise a shift change as the employee would. Returns the refusal, or null. */
const raise = async (world, { work_shift_id = LONG_SHIFT, date = DATE } = {}) => {
  try {
    await world.regularization.raiseShiftChangeRequest({
      actor: { employee_id: ALICE },
      attendance_date: date,
      work_shift_id,
      reason: "covering the late delivery",
      today: TODAY,
    });
    return null;
  } catch (err) {
    return err.message;
  }
};

const blockIt = (world) =>
  world.blocks.blockDate({
    actor: HR,
    scope: ALL_BRANCHES,
    employee_id: ALICE,
    attendance_date: DATE,
    reason: "Punch timing is incorrect",
    today: TODAY,
  });

describe("the HR block and Work Shift rule propagation, on one date", () => {
  it("a real propagated recalculation of the blocked date leaves the block standing and both paths refusing", async () => {
    const w = await seedSeptember();
    addLongShift(w);
    const world = wire(w);

    /* --- 1. the date is genuinely raisable, so the refusals below mean something */
    const before = await optionsFor(world);
    assert.equal(before.can_raise, true, "raisable before HR touches it");
    assert.ok(
      (before.options || []).some((o) => Number(o.work_shift_id) === LONG_SHIFT),
      "the longer shift is on offer"
    );
    assert.equal(storedOt(w, ALICE, DATE), 100, "120 earned, 20 excluded by the current minimum");

    /* --- 2. HR marks the date not eligible */
    await blockIt(world);
    const placed = await world.blockRepo.findActive(ALICE, DATE);
    assert.ok(placed, "the block exists");

    const blocked = await optionsFor(world);
    assert.equal(blocked.can_raise, false);
    assert.equal(blocked.hr_blocked, true);
    assert.deepEqual(blocked.options || [], [], "nothing is offered on a blocked date");

    /* --- 3. THE REAL WORK SHIFT SAVE. Minimum OT 20 -> 10. */
    const saved = await saveMinimumOt(w, 10);
    assert.equal(saved.code, 200);
    assert.equal(saved.config_version.appended, true, "a config version was appended");
    const runId = saved.config_version.propagation_run_id;
    assert.ok(runId, "a propagation run was queued");
    assert.equal(
      (await w.state.runs[runId - 1]).status,
      "QUEUED",
      "the save QUEUES and recalculates nothing itself"
    );
    assert.equal(storedOt(w, ALICE, DATE), 100, "the save alone changed no stored attendance");

    /* --- 4. THE REAL WORKER. */
    await drainQueue(w);

    /* --- 5. PROPAGATION DEMONSTRABLY RAN. Mutation A - skip the drain - fails here. */
    assert.equal(
      storedOt(w, ALICE, DATE),
      110,
      "the blocked date was recalculated under the new minimum"
    );
    const run = w.state.runs[runId - 1];
    assert.equal(run.status, "COMPLETED", "the run reached its terminal state");
    assert.ok(
      w.state.recalculatedRanges.some(
        (r) => Number(r.employee_id) === ALICE && r.from_date <= DATE && r.to_date >= DATE
      ),
      "the blocked employee/date really was in a recalculated range"
    );

    /* --- 6. AND THE HR DECISION SURVIVED IT. Mutation D - clearing the block
     *       during recalculation - fails here. */
    const after = await world.blockRepo.findActive(ALICE, DATE);
    assert.ok(after, "the block is still active after the recalculation");
    assert.equal(
      after.attendance_shift_change_block_id,
      placed.attendance_shift_change_block_id,
      "it is the SAME ledger row, not a replacement"
    );
    assert.equal(after.removed_at, null, "removed_at is untouched");
    assert.equal(after.reason, placed.reason, "the reason is unchanged");
    assert.equal(
      after.blocked_by_employee_id,
      placed.blocked_by_employee_id,
      "the actor is unchanged"
    );

    /* --- 7. Both refusing paths still refuse. Mutation B kills the first,
     *       mutation C the second. */
    const stillBlocked = await optionsFor(world);
    assert.equal(stillBlocked.can_raise, false, "options still refuse");
    assert.equal(stillBlocked.hr_blocked, true);
    assert.deepEqual(stillBlocked.options || [], [], "still zero usable options");

    const refusal = await raise(world);
    assert.match(refusal, /not allowed for 13\/09\/2026/, "the authoritative submit refuses");
    assert.equal(world.created.length, 0, "no SHIFT_CHANGE request was inserted");
  });

  it("unblocking after a real propagation hands the verdict back to the NEW configuration", async () => {
    const w = await seedSeptember();
    addLongShift(w);
    const world = wire(w);

    assert.equal((await optionsFor(world)).can_raise, true);
    await blockIt(world);

    /* Two real saves before the worker runs. The first is the established
     * propagation regression, and is what proves the recalculation happened
     * at all. The SECOND shortens the long shift to 09:00-17:00 - 420 NRM
     * against the base shift's 480 - so it is no longer a longer shift and
     * the SYSTEM rule must refuse the date once the block is gone.
     *
     * That is the point of this test: the verdict after unblocking has to be
     * computed from the configuration propagation left behind, not from the
     * pre-propagation answer this world already produced once above. */
    await saveMinimumOt(w, 10);
    await w.workShift.update(LONG_SHIFT, {
      weekly_schedule: scheduleFor(LONG_SHIFT, {
        in_time: "09:00:00",
        out_time: "17:00:00",
        break_minutes: 60,
        normal_work_minutes: 420,
      }),
      actor_employee_id: HR.employee_id,
    });

    assert.equal(storedOt(w, ALICE, DATE), 100, "nothing has recalculated yet");
    await drainQueue(w);

    /* Propagation really ran. */
    assert.equal(storedOt(w, ALICE, DATE), 110, "the stored day moved under the latest rule");

    /* The block held right up to the moment HR removed it. */
    assert.ok(await world.blockRepo.findActive(ALICE, DATE), "still blocked before the unblock");

    await world.blocks.unblockDate({
      actor: HR,
      scope: ALL_BRANCHES,
      employee_id: ALICE,
      attendance_date: DATE,
      removal_reason: "Punch corrected after review",
    });
    assert.equal(await world.blockRepo.findActive(ALICE, DATE), null, "the block is gone");

    /* THE VERDICT IS THE SYSTEM'S AGAIN - and it is the NEW configuration's
     * answer. Under the shortened long shift there is no longer shift left,
     * so the system legitimately refuses. This test asserts AGREEMENT with
     * the authoritative rule, not a fixed "eligible". */
    const probe = await world.regularization.shiftChangeEligibilityFor({
      employee_id: ALICE,
      attendance_date: DATE,
      today: TODAY,
    });
    // `system` is the rule with no block composed in; `effective` is what the
    // employee actually meets. With the block removed the two must agree, and
    // that is asserted rather than assumed.
    assert.equal(probe.active_block, null, "the probe sees no active block either");
    assert.equal(
      probe.effective.can_raise,
      probe.system.can_raise,
      "with no block, the effective verdict IS the system verdict"
    );
    const options = await optionsFor(world);

    assert.notEqual(options.hr_blocked, true, "no HR refusal remains");
    assert.equal(
      options.can_raise,
      probe.system.can_raise,
      "the options endpoint agrees with the authoritative system rule"
    );
    assert.equal(
      probe.system.can_raise,
      false,
      "and that rule, read from the configuration propagation left behind, refuses: " +
        "the long shift is no longer longer than the base shift"
    );

    /* The submit path agrees with the same rule, and refuses for a SYSTEM
     * reason rather than an HR one. */
    const refusal = await raise(world);
    assert.ok(refusal, "the submit refuses too");
    assert.doesNotMatch(
      refusal,
      /not allowed for 13\/09\/2026/,
      "and not with the HR block's sentence - the block is gone"
    );
    assert.equal(world.created.length, 0);
  });
});
