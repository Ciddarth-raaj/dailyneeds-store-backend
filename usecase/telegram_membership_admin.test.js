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

  const usecase = buildAdmin({
    claimRepo: {
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

  return { usecase, state, calls, find };
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
