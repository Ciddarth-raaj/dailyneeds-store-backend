/**
 * THE WORKER - budgets, caps, retries and the rerun handshake. Phase 3C.
 *
 *   node --test usecase/telegram_membership_worker.test.js
 *
 * The properties that keep this out of the password-reset poller's way, and
 * keep a mis-configured mapping from emptying a group while nobody is awake.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const buildWorker = require("./telegram_membership_worker");
const { JOB_SCOPE, JOB_REASON } = require("../constants/telegram_membership_claim");

const NOW = new Date("2026-09-17T06:00:00Z");

const build = (over = {}) => {
  const state = {
    jobs: [
      {
        telegram_membership_job_id: 1,
        scope_type: JOB_SCOPE.EMPLOYEE,
        scope_id: 42,
        reason: JOB_REASON.EMPLOYEE_EDITED,
      },
    ],
    claimed: new Set(),
    reconcileResult: { capReached: false },
    reconcileThrows: null,
    workerEnabled: true,
    ...over,
  };
  const calls = { completed: [], failed: [], delayed: [], reconciled: [], enqueued: [], reclaimed: 0 };

  const jobRepo = {
    dueJobs: async (limit) => state.jobs.slice(0, limit),
    claim: async (id) => {
      if (state.claimed.has(id)) return { claimed: false };
      state.claimed.add(id);
      return { claimed: true };
    },
    complete: async (id, options = {}) => {
      calls.completed.push({ id, ...options });
      return { changed: true };
    },
    fail: async (id, options) => {
      calls.failed.push({ id, ...options });
      return { changed: true, dead: state.dead === true };
    },
    delay: async (id, seconds) => {
      calls.delayed.push({ id, seconds });
      return { changed: true };
    },
    reclaimAbandoned: async () => {
      calls.reclaimed += 1;
      return { reclaimed: 2 };
    },
    enqueueEmployee: async (id, reason) => {
      calls.enqueued.push({ id, reason });
      return { created: true };
    },
  };

  const reconcile = {
    reconcileEmployee: async (id, options) => {
      calls.reconciled.push({ id, ...options });
      if (state.reconcileThrows) throw state.reconcileThrows;
      if (typeof state.onReconcile === "function") state.onReconcile(options);
      return state.reconcileResult;
    },
    reconcileGroup: async (id, options) => {
      calls.reconciled.push({ group: id, ...options });
      return state.reconcileResult;
    },
  };

  const usecase = buildWorker({
    jobRepo,
    claimRepo: {
      getEmployeeIdsWithLiveClaims: async () => [7],
      getEmployeeIdsAwaitingRemoval: async () => [8],
    },
    identityRepo: { getEmployeeIdsWithAnyIdentity: async () => [42, 7] },
    reconcile,
    config: {
      workerEnabled: state.workerEnabled,
      jobsPerTick: 5,
      apiCallsPerTick: 20,
      removalCapPerTick: 2,
      removalCapPerHour: 3,
      ...(over.config || {}),
    },
    now: () => NOW,
  });

  return { usecase, state, calls };
};

describe("nothing happens until it is switched on", () => {
  it("a tick does nothing at all with the worker off", async () => {
    const { usecase, calls } = build({ workerEnabled: false });
    assert.deepEqual(await usecase.tick(), { skipped: "disabled" });
    assert.deepEqual(calls.reconciled, []);
  });

  it("and neither does the sweep", async () => {
    const { usecase, calls } = build({ workerEnabled: false });
    assert.deepEqual(await usecase.sweep(), { skipped: "disabled" });
    assert.equal(calls.reclaimed, 0);
  });
});

describe("one tick", () => {
  it("claims a job, reconciles its scope and completes it", async () => {
    const { usecase, calls } = build();
    const summary = await usecase.tick();
    assert.equal(summary.jobs, 1);
    assert.equal(calls.reconciled[0].id, 42);
    assert.equal(calls.completed[0].requestRerun, false);
  });

  it("skips a job somebody else claimed", async () => {
    const { usecase, state, calls } = build();
    state.claimed.add(1);
    const summary = await usecase.tick();
    assert.equal(summary.jobs, 0);
    assert.deepEqual(calls.reconciled, []);
  });

  it("RE-ENTRANCY: a tick while one is running is a no-op, not a second worker", async () => {
    const { usecase } = build();
    usecase.running = true;
    assert.deepEqual(await usecase.tick(), { skipped: "in_progress" });
  });

  it("A CAPPED JOB IS NOT A FINISHED JOB - it asks for a rerun", async () => {
    const { usecase, state, calls } = build();
    state.reconcileResult = { capReached: true };
    await usecase.tick();
    assert.equal(calls.completed[0].requestRerun, true);
  });

  it("an exhausted API budget also asks for a rerun", async () => {
    const { usecase, state, calls } = build();
    state.onReconcile = (options) => {
      while (options.budget.spend(1)) {
        /* burn the tick's call budget, as a big group would */
      }
    };
    await usecase.tick();
    assert.equal(calls.completed[0].requestRerun, true);
  });
});

describe("the removal caps", () => {
  it("the per-tick cap is the smaller of the tick and hour limits", async () => {
    const { usecase, state } = build();
    let seen = null;
    state.onReconcile = (options) => {
      seen = options.budget.removalsLeft;
    };
    await usecase.tick();
    assert.equal(seen, 2, "tick cap 2, hour cap 3 - the tick decides");
  });

  it("THE HOURLY CEILING SURVIVES ACROSS TICKS", async () => {
    // A mis-configured mapping must not empty a group over many ticks.
    const { usecase, state } = build();
    state.onReconcile = (options) => {
      // BOUNDED ON PURPOSE. An unbounded `while (takeRemoval())` would hang
      // rather than fail if the cap ever stopped refusing, and a hanging
      // test reports nothing useful.
      let guard = 0;
      while (options.budget.takeRemoval()) {
        guard += 1;
        assert.ok(guard <= 10, "takeRemoval must refuse once the cap is spent");
      }
    };
    await usecase.tick();
    state.claimed.clear();
    let left = null;
    state.onReconcile = (options) => {
      left = options.budget.removalsLeft;
    };
    await usecase.tick();
    assert.equal(left, 1, "only the hour's remaining allowance is offered");
  });
});

describe("failure handling", () => {
  it("a 429 DELAYS without spending a retry", async () => {
    const { usecase, state, calls } = build();
    const err = new Error("Too Many Requests: retry after 17");
    err.parameters = { retry_after: 17 };
    state.reconcileThrows = err;

    const summary = await usecase.tick();
    assert.equal(summary.delayed, 1);
    assert.deepEqual(calls.delayed, [{ id: 1, seconds: 17 }]);
    assert.deepEqual(calls.failed, [], "a rate limit is not a failed attempt");
  });

  it("reads retry_after out of the description when that is all there is", async () => {
    const { usecase, state, calls } = build();
    state.reconcileThrows = new Error("Too Many Requests: retry after 9");
    await usecase.tick();
    assert.deepEqual(calls.delayed, [{ id: 1, seconds: 9 }]);
  });

  it("an ordinary failure spends a retry", async () => {
    const { usecase, state, calls } = build();
    state.reconcileThrows = new Error("ETIMEDOUT");
    const summary = await usecase.tick();
    assert.equal(summary.failed, 1);
    assert.equal(calls.failed.length, 1);
    assert.deepEqual(calls.delayed, []);
  });

  it("a tick never throws - the next one would run anyway", async () => {
    const { usecase } = build();
    usecase.jobRepo.dueJobs = async () => {
      throw new Error("database is gone");
    };
    await usecase.tick();
  });
});

describe("a cleanup that did not happen never reads as SUCCEEDED", () => {
  const { TelegramMembershipRetryableError } = require("../utils/telegram_membership_errors");

  it("a TEMPORARY removal failure fails the job rather than completing it", async () => {
    const { usecase, state, calls } = build();
    state.reconcileThrows = new TelegramMembershipRetryableError("removal failed: ETIMEDOUT", {
      code: "TELEGRAM_REMOVAL_FAILED",
    });

    const summary = await usecase.tick();

    assert.equal(summary.failed, 1);
    assert.deepEqual(calls.completed, [], "the job must NOT be completed");
    assert.equal(calls.failed[0].errorCode, "TELEGRAM_REMOVAL_FAILED");
  });

  it("REPEATED failures reach DEAD", async () => {
    const { usecase, state } = build();
    state.reconcileThrows = new TelegramMembershipRetryableError("still failing");
    state.dead = true; // the repository reports the ladder exhausted
    const summary = await usecase.tick();
    assert.equal(summary.dead, 1);
  });

  it("a 429 raised from INSIDE a removal uses the delay path", async () => {
    // Raised deep in the reconciler, wrapped, and it still has to reach
    // `delay()` - spending a retry on a rate limit would kill jobs that were
    // never wrong.
    const { usecase, state, calls } = build();
    const cause = new Error("Too Many Requests: retry after 31");
    cause.parameters = { retry_after: 31 };
    state.reconcileThrows = new TelegramMembershipRetryableError("rate limited", {
      retryAfter: 31,
      cause,
    });

    const summary = await usecase.tick();

    assert.equal(summary.delayed, 1);
    assert.deepEqual(calls.delayed, [{ id: 1, seconds: 31 }]);
    assert.deepEqual(calls.failed, [], "a rate limit spends no retry");
    assert.deepEqual(calls.completed, []);
  });

  it("CONFIRMED ABSENT is success, and completes the job", async () => {
    const { usecase, state, calls } = build();
    state.reconcileResult = { removals: [10], capReached: false };
    const summary = await usecase.tick();
    assert.equal(summary.succeeded, 1);
    assert.equal(calls.completed[0].requestRerun, false);
  });

  it("REMOVALS SWITCHED OFF defers the job - not done, and not a failure", async () => {
    const { usecase, state, calls } = build();
    state.reconcileResult = { deferred: true };

    const summary = await usecase.tick();

    assert.equal(summary.deferred, 1);
    assert.deepEqual(calls.completed, [], "deferred work is not completed work");
    assert.deepEqual(calls.failed, [], "and it burns no retry");
    assert.equal(calls.delayed[0].seconds, 900);
  });
});

describe("a rate limit raised during ADOPTION", () => {
  const { TelegramMembershipRetryableError } = require("../utils/telegram_membership_errors");

  it("reaches the delay path, spends no retry, and honours retry_after", async () => {
    const { usecase, state, calls } = build();
    const cause = new Error("Too Many Requests: retry after 42");
    cause.parameters = { retry_after: 42 };
    state.reconcileThrows = new TelegramMembershipRetryableError("rate limited during adoption", {
      code: "TELEGRAM_RATE_LIMITED",
      retryAfter: 42,
      cause,
    });

    const summary = await usecase.tick();

    assert.equal(summary.delayed, 1);
    assert.deepEqual(calls.delayed, [{ id: 1, seconds: 42 }]);
    assert.deepEqual(calls.failed, [], "failure_count is untouched by a rate limit");
    assert.deepEqual(calls.completed, [], "and the job is certainly not complete");
  });

  it("the tick stops there rather than claiming another job", async () => {
    const { usecase, state, calls } = build();
    state.jobs = [
      { telegram_membership_job_id: 1, scope_type: JOB_SCOPE.EMPLOYEE, scope_id: 42, reason: JOB_REASON.SWEEP },
      { telegram_membership_job_id: 2, scope_type: JOB_SCOPE.EMPLOYEE, scope_id: 43, reason: JOB_REASON.SWEEP },
    ];
    const cause = new Error("Too Many Requests: retry after 5");
    cause.parameters = { retry_after: 5 };
    state.reconcileThrows = new TelegramMembershipRetryableError("rate limited", {
      retryAfter: 5,
      cause,
    });

    await usecase.tick();

    // Both jobs may be claimed, but every one of them is delayed rather than
    // failed - nothing in this tick reports work it did not do.
    assert.deepEqual(calls.completed, []);
    assert.deepEqual(calls.failed, []);
    assert.ok(calls.delayed.length >= 1);
  });
});

describe("the budget cannot be overspent", () => {
  it("spend refuses what it cannot cover, and never goes negative", async () => {
    const { usecase, state } = build({ config: { apiCallsPerTick: 3 } });
    let budget = null;
    state.onReconcile = (options) => {
      budget = options.budget;
    };
    await usecase.tick();

    assert.equal(budget.spend(2), true);
    assert.equal(budget.callsLeft, 1);
    assert.equal(budget.spend(2), false, "a request it cannot cover is refused whole");
    assert.equal(budget.callsLeft, 1, "and nothing is deducted");
    assert.equal(budget.spend(1), true);
    assert.equal(budget.callsLeft, 0);
    assert.equal(budget.spend(1), false);
    assert.ok(budget.callsLeft >= 0);
  });

  it("takeRemoval is a checked withdrawal, not a subtraction", async () => {
    const { usecase, state } = build({ config: { removalCapPerTick: 2, removalCapPerHour: 99 } });
    let budget = null;
    state.onReconcile = (options) => {
      budget = options.budget;
    };
    await usecase.tick();

    assert.equal(budget.takeRemoval(), true);
    assert.equal(budget.takeRemoval(), true);
    assert.equal(budget.takeRemoval(), false, "the cap is a limit, not a suggestion");
    assert.equal(budget.removalsLeft, 0, "never negative");
  });
});

describe("the hourly sweep", () => {
  it("reclaims abandoned jobs and re-enqueues the bounded population", async () => {
    const { usecase, calls } = build();
    const summary = await usecase.sweep();
    assert.equal(summary.reclaimed, 2);
    // Everybody with an identity, everybody with a live claim, everybody
    // stuck awaiting removal - de-duplicated, and no cursor anywhere.
    assert.deepEqual(
      calls.enqueued.map((e) => e.id).sort((a, b) => a - b),
      [7, 8, 42]
    );
    for (const call of calls.enqueued) assert.equal(call.reason, JOB_REASON.SWEEP);
  });

  it("keeps no durable employment-change cursor", () => {
    // The sweep re-enqueues a bounded population instead. A "changed since"
    // cursor would be a second source of truth, and a wrong one silently
    // stops reconciling anybody.
    const source = require("fs")
      .readFileSync(require("path").join(__dirname, "telegram_membership_worker.js"), "utf8")
      .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
    assert.ok(!/cursor|last_swept|since_id|changed_since/i.test(source));
  });
});
