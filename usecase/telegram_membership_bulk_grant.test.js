/**
 * BULK MANUAL GRANT - "Add Selected Employees", in one request.
 *
 *   node --test usecase/telegram_membership_bulk_grant.test.js
 *
 * The rules under test:
 *
 *   ONE TRANSACTION, ALL OR NOTHING. Eighteen separate requests can leave
 *   nine granted and nine not, with nothing on screen saying which nine.
 *   IT IS BOUNDED. An unbounded selection is an unbounded transaction
 *   holding unbounded locks.
 *   EVERY EMPLOYEE MUST BE THE CALLER'S TO GRANT. `manage_telegram_groups`
 *   permits the action; it does not widen which employees it reaches.
 *   NO TELEGRAM CALL, INSIDE THE TRANSACTION OR OUTSIDE IT.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const buildAdmin = require("./telegram_membership_admin");
const {
  CLAIM_SOURCE,
  MEMBERSHIP_EVENT,
  JOB_REASON,
} = require("../constants/telegram_membership_claim");
const { BULK_GRANT_MAX, PREVIEW_MESSAGES } = require("../constants/telegram_group_mapping");
const { EMPLOYEE_BRANCH_SCOPE } = require("../utils/employee_branch_scope");

const GROUP = { telegram_group_id: 10, group_name: "Cashiers", is_active: true };
const ACTOR = { employee_id: 7 };

const ALL_BRANCHES = { kind: EMPLOYEE_BRANCH_SCOPE.ALL_BRANCHES, store_ids: null };
const ownBranches = (ids) => ({ kind: EMPLOYEE_BRANCH_SCOPE.OWN_BRANCHES, store_ids: ids });
const NONE = { kind: EMPLOYEE_BRANCH_SCOPE.NONE, store_ids: null };

/** Employees 1..n, all at branch 5 unless `branches` says otherwise. */
const staff = (ids, branches = {}) =>
  new Map(
    ids.map((id) => [
      id,
      {
        employee_id: id,
        employee_name: `Employee ${id}`,
        store_id: branches[id] === undefined ? 5 : branches[id],
        status: 1,
        date_of_joining: "2020-01-01",
        resignation_date: null,
      },
    ])
  );

const makeAdmin = ({ known = [1, 2, 3], branches = {}, openThrows = null, enqueueThrows = null } = {}) => {
  const calls = { opened: [], events: [], enqueued: [], transactions: 0, committed: 0 };
  const claimRepo = {
    withTransaction: async (fn) => {
      calls.transactions += 1;
      const result = await fn({ query: async () => ({}) });
      calls.committed += 1;
      return result;
    },
    describeEmployeesWithBranch: async (ids) => {
      const all = staff(known, branches);
      return new Map(ids.filter((id) => all.has(id)).map((id) => [id, all.get(id)]));
    },
    describeEmployees: async (ids) => new Map(ids.map((id) => [id, `Employee ${id}`])),
    open: async (row, opts) => {
      if (openThrows && calls.opened.length === openThrows.after) throw openThrows.err;
      calls.opened.push({ ...row, tx: Boolean(opts && opts.tx) });
    },
    recordEvent: async (row, opts) => calls.events.push({ ...row, tx: Boolean(opts && opts.tx) }),
  };
  const jobRepo = {
    enqueueEmployee: async (employeeId, reason, meta, opts) => {
      if (enqueueThrows) throw enqueueThrows;
      calls.enqueued.push({ employeeId, reason, tx: Boolean(opts && opts.tx) });
    },
  };
  const registryRepo = { getById: async (id) => (id === 10 ? GROUP : null) };
  return { usecase: buildAdmin({ claimRepo, jobRepo, registryRepo }), calls, claimRepo };
};

describe("one request, one transaction", () => {
  it("grants everybody in the selection", async () => {
    const { usecase, calls } = makeAdmin();
    const result = await usecase.grantManualBulk(10, [1, 2, 3], ACTOR, { scope: ALL_BRANCHES });
    assert.equal(result.code, 200);
    assert.equal(result.granted, 3);
    assert.deepEqual(calls.opened.map((o) => o.employeeId), [1, 2, 3]);
  });

  it("opens ONE transaction for the whole selection, not one each", async () => {
    const { usecase, calls } = makeAdmin();
    await usecase.grantManualBulk(10, [1, 2, 3], ACTOR, { scope: ALL_BRANCHES });
    assert.equal(calls.transactions, 1);
    assert.equal(calls.committed, 1);
  });

  it("every claim, event and job is written INSIDE that transaction", async () => {
    const { usecase, calls } = makeAdmin();
    await usecase.grantManualBulk(10, [1, 2, 3], ACTOR, { scope: ALL_BRANCHES });
    for (const write of [...calls.opened, ...calls.events, ...calls.enqueued]) {
      assert.equal(write.tx, true, JSON.stringify(write));
    }
    assert.equal(calls.enqueued.length, 3);
  });

  it("writes a MANUAL claim, an audit row and a job for each employee", async () => {
    const { usecase, calls } = makeAdmin();
    await usecase.grantManualBulk(10, [1, 2], ACTOR, { scope: ALL_BRANCHES });
    for (const claim of calls.opened) {
      assert.equal(claim.source, CLAIM_SOURCE.MANUAL);
      assert.equal(claim.telegramGroupId, 10);
      assert.equal(claim.actorEmployeeId, 7);
    }
    for (const event of calls.events) {
      assert.equal(event.eventType, MEMBERSHIP_EVENT.CLAIM_OPENED);
      assert.equal(event.source, CLAIM_SOURCE.MANUAL);
    }
    for (const job of calls.enqueued) assert.equal(job.reason, JOB_REASON.MANUAL_GRANTED);
  });

  it("a failure partway writes NOTHING - the transaction is what makes it atomic", async () => {
    const boom = new Error("ER_LOCK_WAIT_TIMEOUT");
    const { usecase, calls } = makeAdmin({ openThrows: { after: 1, err: boom } });
    await assert.rejects(() => usecase.grantManualBulk(10, [1, 2, 3], ACTOR, { scope: ALL_BRANCHES }), /LOCK_WAIT/);
    assert.equal(calls.committed, 0, "the transaction must not commit");
  });

  it("an enqueue failure fails the whole grant - never a claim with no job", async () => {
    const { usecase, calls } = makeAdmin({ enqueueThrows: new Error("queue down") });
    await assert.rejects(() => usecase.grantManualBulk(10, [1, 2], ACTOR, { scope: ALL_BRANCHES }), /queue down/);
    assert.equal(calls.committed, 0);
  });

  it("de-duplicates a selection that names somebody twice", async () => {
    const { usecase, calls } = makeAdmin();
    const result = await usecase.grantManualBulk(10, [1, 1, 2, 2, 2], ACTOR, { scope: ALL_BRANCHES });
    assert.equal(result.granted, 2);
    assert.deepEqual(calls.opened.map((o) => o.employeeId), [1, 2]);
  });
});

describe("the selection is bounded and must name real people", () => {
  it(`refuses more than ${BULK_GRANT_MAX} employees`, async () => {
    const tooMany = Array.from({ length: BULK_GRANT_MAX + 1 }, (_, i) => i + 1);
    const { usecase, calls } = makeAdmin({ known: tooMany });
    await assert.rejects(
      () => usecase.grantManualBulk(10, tooMany, ACTOR, { scope: ALL_BRANCHES }),
      (err) => err.message === PREVIEW_MESSAGES.TOO_MANY_EMPLOYEES
    );
    assert.equal(calls.transactions, 0, "refused before any transaction is opened");
  });

  it(`accepts exactly ${BULK_GRANT_MAX}`, async () => {
    const atLimit = Array.from({ length: BULK_GRANT_MAX }, (_, i) => i + 1);
    const { usecase } = makeAdmin({ known: atLimit });
    assert.equal((await usecase.grantManualBulk(10, atLimit, ACTOR, { scope: ALL_BRANCHES })).granted, BULK_GRANT_MAX);
  });

  it("refuses an empty selection rather than committing nothing quietly", async () => {
    const { usecase } = makeAdmin();
    for (const empty of [[], null, undefined, "not a list"]) {
      await assert.rejects(
        () => usecase.grantManualBulk(10, empty, ACTOR, { scope: ALL_BRANCHES }),
        (err) => err.message === PREVIEW_MESSAGES.NO_EMPLOYEES
      );
    }
  });

  it("drops junk ids rather than sending them to the database", async () => {
    const { usecase, calls } = makeAdmin();
    await usecase.grantManualBulk(10, [1, 0, -3, "abc", 2.5, null, 2], ACTOR, { scope: ALL_BRANCHES });
    assert.deepEqual(calls.opened.map((o) => o.employeeId), [1, 2]);
  });

  it("refuses the WHOLE request when any id is not an employee", async () => {
    const { usecase, calls } = makeAdmin({ known: [1, 2] });
    await assert.rejects(() => usecase.grantManualBulk(10, [1, 2, 404], ACTOR, { scope: ALL_BRANCHES }), /Employee not found/);
    assert.equal(calls.transactions, 0);
  });

  it("refuses a group that does not exist", async () => {
    const { usecase } = makeAdmin();
    await assert.rejects(() => usecase.grantManualBulk(77, [1], ACTOR, { scope: ALL_BRANCHES }), /not found/);
  });
});

describe("every selected employee must be the caller's to grant", () => {
  it("a branch manager may grant their own branch", async () => {
    const { usecase } = makeAdmin({ known: [1, 2], branches: { 1: 5, 2: 5 } });
    assert.equal((await usecase.grantManualBulk(10, [1, 2], ACTOR, { scope: ownBranches([5]) })).granted, 2);
  });

  it("ONE employee outside the branch fails the WHOLE request", async () => {
    // A partial success the operator did not ask for and cannot see is worse
    // than a refusal they can read.
    const { usecase, calls } = makeAdmin({ known: [1, 2], branches: { 1: 5, 2: 9 } });
    await assert.rejects(
      () => usecase.grantManualBulk(10, [1, 2], ACTOR, { scope: ownBranches([5]) }),
      (err) => err.message === PREVIEW_MESSAGES.NOT_IN_SCOPE
    );
    assert.equal(calls.transactions, 0, "nothing is granted, not even the one in scope");
  });

  it("an employee with no branch is nobody's to grant", async () => {
    const { usecase } = makeAdmin({ known: [1], branches: { 1: null } });
    await assert.rejects(() => usecase.grantManualBulk(10, [1], ACTOR, { scope: ownBranches([5]) }), /not yours/);
  });

  it("a NONE scope grants NOTHING - it never degrades to company-wide", async () => {
    for (const scope of [NONE, undefined, ownBranches([])]) {
      const { usecase, calls } = makeAdmin({ known: [1] });
      await assert.rejects(() => usecase.grantManualBulk(10, [1], ACTOR, { scope }), /not yours/);
      assert.equal(calls.transactions, 0);
    }
  });

  it("a missing scope argument entirely still fails closed", async () => {
    const { usecase } = makeAdmin({ known: [1] });
    await assert.rejects(() => usecase.grantManualBulk(10, [1], ACTOR), /not yours/);
  });

  it("ALL_BRANCHES reaches every branch, as HR must", async () => {
    const { usecase } = makeAdmin({ known: [1, 2, 3], branches: { 1: 5, 2: 6, 3: null } });
    assert.equal((await usecase.grantManualBulk(10, [1, 2, 3], ACTOR, { scope: ALL_BRANCHES })).granted, 3);
  });
});

describe("no Telegram call happens here", () => {
  it("the bulk grant reaches no Telegram service", async () => {
    const source = require("node:fs").readFileSync(require.resolve("./telegram_membership_admin.js"), "utf8");
    const body = source.slice(source.indexOf("async grantManualBulk"), source.indexOf("REVOKE. The claim goes"));
    for (const forbidden of [/sendMessage/, /banChatMember/, /unbanChatMember/, /createChatInviteLink/, /approveChatJoinRequest/, /getChatMember/]) {
      assert.doesNotMatch(body, forbidden, String(forbidden));
    }
    assert.doesNotMatch(body, /this\.telegram/);
  });

  it("writes no mapping rule to describe the selection", async () => {
    // Inventing a rule for an arbitrary selection is how a group ends up
    // with configuration nobody chose and nobody can read back.
    const { usecase, claimRepo } = makeAdmin();
    assert.equal(typeof claimRepo.create, "undefined");
    await usecase.grantManualBulk(10, [1], ACTOR, { scope: ALL_BRANCHES });
  });
});
