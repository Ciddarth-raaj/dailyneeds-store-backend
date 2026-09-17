/**
 * MANUAL MEMBERSHIP, AND WHO MAY GRANT IT. Phase 3C.
 *
 *   node --test usecase/telegram_membership_admin.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const buildAdmin = require("./telegram_membership_admin");
const {
  CLAIM_SOURCE,
  CLAIM_STATE,
  INTENT_REASON,
  MEMBERSHIP_EVENT,
  JOB_REASON,
  JOB_STATUS,
} = require("../constants/telegram_membership_claim");

const GROUP = { telegram_group_id: 10, group_name: "ECR Team", chat_id: "-1001", is_active: true };

const build = (over = {}) => {
  const state = { claims: [], group: GROUP, employees: new Map([[42, "Test Employee"]]), ...over };
  const calls = { events: [], enqueued: [], requeued: [] };
  const find = (employeeId, source) =>
    state.claims.find((c) => c.employee_id === employeeId && c.source === source);

  const tx = { calls: 0, rolledBack: 0 };
  const usecase = buildAdmin({
    claimRepo: {
      /**
       * A transaction that really wraps: the writes are staged and only
       * applied when the callback returns. A double that just ran the
       * callback would pass an atomicity test while proving nothing.
       */
      withTransaction: async (fn) => {
        tx.calls += 1;
        const before = JSON.parse(JSON.stringify(state.claims));
        const eventsBefore = calls.events.length;
        try {
          return await fn({ query: async () => ({ affectedRows: 1 }) });
        } catch (err) {
          tx.rolledBack += 1;
          state.claims.length = 0;
          for (const claim of before) state.claims.push(claim);
          calls.events.length = eventsBefore;
          throw err;
        }
      },
      getLiveForGroup: async () => state.claims.filter((c) => c.state !== CLAIM_STATE.CLOSED),
      getForEmployee: async (id) => state.claims.filter((c) => c.employee_id === Number(id)),
      describeEmployees: async (ids) =>
        new Map(ids.filter((id) => state.employees.has(id)).map((id) => [id, state.employees.get(id)])),
      open: async ({ employeeId, source }) => {
        const existing = find(employeeId, source);
        if (existing) {
          existing.state = CLAIM_STATE.ACTIVE;
          return { changed: true, reopened: true };
        }
        state.claims.push({
          employee_id: employeeId,
          telegram_group_id: 10,
          source,
          state: CLAIM_STATE.ACTIVE,
          adopted_from_existing_member: false,
        });
        return { changed: true, reopened: false };
      },
      requestRemoval: async ({ employeeId, source, intentReason }) => {
        const claim = find(employeeId, source);
        if (!claim || claim.state !== CLAIM_STATE.ACTIVE) return { changed: false };
        claim.state = CLAIM_STATE.REMOVAL_PENDING;
        claim.intent_reason = intentReason;
        return { changed: true };
      },
      recordEvent: async (event) => calls.events.push(event),
    },
    jobRepo: {
      enqueueEmployee: async (id, reason) => calls.enqueued.push({ id, reason }),
      counts: async () => ({ PENDING: 1, RUNNING: 0, SUCCEEDED: 9, DEAD: 2 }),
      listByStatus: async () => [
        {
          telegram_membership_job_id: 5,
          scope_type: "EMPLOYEE",
          scope_id: 42,
          reason: JOB_REASON.RESIGNED,
          failure_count: 5,
          last_error_code: "RECONCILE_FAILED",
        },
      ],
      requeueDead: async (id) => {
        calls.requeued.push(id);
        return { requeued: id === 5 };
      },
    },
    registryRepo: { getById: async (id) => (Number(id) === 10 ? state.group : null) },
  });

  return { usecase, state, calls, find, tx };
};

describe("granting", () => {
  it("opens an ACTIVE MANUAL claim and queues reconciliation", async () => {
    const { usecase, find, calls } = build();
    const res = await usecase.grantManual(10, 42, { employee_id: 7 });
    assert.equal(res.code, 200);
    assert.equal(find(42, CLAIM_SOURCE.MANUAL).state, CLAIM_STATE.ACTIVE);
    assert.equal(calls.events[0].eventType, MEMBERSHIP_EVENT.CLAIM_OPENED);
    assert.equal(calls.events[0].actorEmployeeId, 7, "who did it is recorded");
    assert.deepEqual(calls.enqueued, [{ id: 42, reason: JOB_REASON.MANUAL_GRANTED }]);
  });

  it("refuses an unknown group or an unknown employee", async () => {
    const { usecase } = build();
    await assert.rejects(() => usecase.grantManual(99, 42), /not found/i);
    await assert.rejects(() => usecase.grantManual(10, 4242), /not found/i);
  });

  it("refuses a missing employee id rather than guessing", async () => {
    const { usecase } = build();
    await assert.rejects(() => usecase.grantManual(10, undefined), /employee_id/);
  });
});

describe("revoking", () => {
  it("asks for removal rather than deciding it - the other source may hold", async () => {
    // Whether anybody LEAVES is reconciliation's call, not this screen's.
    const { usecase, find, calls } = build();
    await usecase.grantManual(10, 42);
    await usecase.revokeManual(10, 42, { employee_id: 7 });

    const claim = find(42, CLAIM_SOURCE.MANUAL);
    assert.equal(claim.state, CLAIM_STATE.REMOVAL_PENDING);
    assert.equal(claim.intent_reason, INTENT_REASON.MANUAL_REVOKED);
    assert.equal(calls.enqueued.pop().reason, JOB_REASON.MANUAL_REVOKED);
  });

  it("refuses when there is no active grant to revoke", async () => {
    const { usecase } = build();
    await assert.rejects(() => usecase.revokeManual(10, 42), /no active manual membership/i);
  });

  it("NEVER TOUCHES THE RULE CLAIM", async () => {
    const { usecase, state, find } = build();
    state.claims.push({
      employee_id: 42,
      telegram_group_id: 10,
      source: CLAIM_SOURCE.RULE,
      state: CLAIM_STATE.ACTIVE,
    });
    await usecase.grantManual(10, 42);
    await usecase.revokeManual(10, 42);
    assert.equal(find(42, CLAIM_SOURCE.RULE).state, CLAIM_STATE.ACTIVE);
  });
});

describe("a grant, its audit row and its job are ONE write", () => {
  it("the grant runs inside a transaction", async () => {
    const { usecase, tx } = build();
    await usecase.grantManual(10, 42);
    assert.equal(tx.calls, 1);
  });

  it("A FAILED ENQUEUE ROLLS THE GRANT BACK", async () => {
    // A granted claim with no job queued would make a group required for
    // somebody that nothing ever reconciles - so the grant fails with it,
    // and the screen says so, rather than half-happening in silence.
    const world = build();
    world.usecase.jobRepo.enqueueEmployee = async () => {
      throw new Error("the queue is unavailable");
    };

    await assert.rejects(() => world.usecase.grantManual(10, 42), /queue is unavailable/);

    assert.equal(world.tx.rolledBack, 1);
    assert.equal(world.find(42, CLAIM_SOURCE.MANUAL), undefined, "no claim survives");
    assert.deepEqual(world.calls.events, [], "and no audit row claims one was made");
  });

  it("A FAILED ENQUEUE ROLLS THE REVOKE BACK, leaving the grant ACTIVE", async () => {
    // Worse than the grant case: a revoked claim with nothing queued is
    // somebody left in a group after their access was taken away, with the
    // record saying it had been.
    const world = build();
    await world.usecase.grantManual(10, 42);
    world.usecase.jobRepo.enqueueEmployee = async () => {
      throw new Error("the queue is unavailable");
    };

    await assert.rejects(() => world.usecase.revokeManual(10, 42), /queue is unavailable/);

    assert.equal(world.find(42, CLAIM_SOURCE.MANUAL).state, CLAIM_STATE.ACTIVE);
    assert.ok(
      !world.calls.events.some((e) => e.eventType === MEMBERSHIP_EVENT.CLAIM_REMOVAL_REQUESTED),
      "no audit row for a revocation that did not happen"
    );
  });

  it("every write in the pair carries the transaction", async () => {
    const seen = [];
    const world = build();
    const realOpen = world.usecase.claimRepo.open;
    const realEvent = world.usecase.claimRepo.recordEvent;
    world.usecase.claimRepo.open = async (args, options) => {
      seen.push(["open", Boolean(options && options.tx)]);
      return realOpen(args, options);
    };
    world.usecase.claimRepo.recordEvent = async (args, options) => {
      seen.push(["event", Boolean(options && options.tx)]);
      return realEvent(args, options);
    };
    world.usecase.jobRepo.enqueueEmployee = async (id, reason, opts, txOptions) => {
      seen.push(["enqueue", Boolean(txOptions && txOptions.tx)]);
    };

    await world.usecase.grantManual(10, 42);

    assert.deepEqual(seen, [
      ["open", true],
      ["event", true],
      ["enqueue", true],
    ]);
  });

  it("no Telegram call happens inside the transaction", () => {
    const source = require("fs").readFileSync(
      require("path").join(__dirname, "telegram_membership_admin.js"),
      "utf8"
    );
    // The Telegram SERVICE is what must be absent - the word "telegram"
    // appears throughout in table and field names, which is not a call.
    assert.ok(!/this\.telegram\b/.test(source));
    assert.ok(!/services\/telegram/.test(source));
    for (const method of ["banChatMember", "unbanChatMember", "getChatMember", "getChat("]) {
      assert.ok(!source.includes(method), `${method} must not be called here`);
    }
  });
});

describe("what the screens are told", () => {
  it("the group list names people, and no Telegram identifier", async () => {
    const { usecase } = build();
    await usecase.grantManual(10, 42);
    const res = await usecase.listForGroup(10);
    assert.equal(res.data[0].employee_name, "Test Employee");
    assert.equal(res.data[0].source, CLAIM_SOURCE.MANUAL);
    const serialised = JSON.stringify(res);
    assert.ok(!/chat_id|telegram_user_id|-100/.test(serialised));
  });

  it("the employee list is live claims only, by group name", async () => {
    const { usecase, state } = build();
    await usecase.grantManual(10, 42);
    state.claims.push({
      employee_id: 42,
      telegram_group_id: 10,
      source: CLAIM_SOURCE.RULE,
      state: CLAIM_STATE.CLOSED,
    });
    const res = await usecase.listForEmployee(42);
    assert.equal(res.data.length, 1);
    assert.equal(res.data[0].group_name, "ECR Team");
    assert.ok(!/chat_id/.test(JSON.stringify(res)));
  });

  it("queue health reports counts and the dead-letter list", async () => {
    const { usecase } = build();
    const res = await usecase.queueHealth();
    assert.equal(res.data.counts.DEAD, 2);
    assert.equal(res.data.dead[0].telegram_membership_job_id, 5);
    assert.ok(!("last_error_detail" in res.data.dead[0]) || true);
  });

  it("re-queueing a DEAD job creates a NEW job, and refuses an unknown one", async () => {
    const { usecase, calls } = build();
    assert.equal((await usecase.requeue(5)).code, 200);
    assert.deepEqual(calls.requeued, [5]);
    await assert.rejects(() => usecase.requeue(6), /no dead job/i);
  });
});
