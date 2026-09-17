/**
 * RECONCILING MANAGED MEMBERSHIP - the behaviour, end to end. Phase 3C.
 *
 *   node --test usecase/telegram_membership_reconcile.test.js
 *
 * The rules under test, in the order they matter:
 *
 *   CLAIMS SURVIVE A TELEGRAM OUTAGE. Local truth does not depend on an API.
 *   NOBODY IS REMOVED WHILE ANY SOURCE STILL WANTS THEM THERE.
 *   EMPLOYMENT ENDING REACHES FURTHER than ordinary reconciliation, on
 *     purpose, and reaches historical Telegram accounts too.
 *   AN UNCLAIMED MEMBERSHIP IS UNTOUCHED while somebody is employed.
 *   A HISTORICAL ACCOUNT THAT NOW BELONGS TO SOMEBODY ELSE IS LEFT ALONE.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const buildReconcile = require("./telegram_membership_reconcile");
const {
  CLAIM_SOURCE,
  CLAIM_STATE,
  INTENT_REASON,
  MEMBERSHIP_EVENT,
  CLOSE_OUTCOME,
} = require("../constants/telegram_membership_claim");

const NOW = new Date("2026-09-17T06:00:00Z");
const GROUP = (id = 10) => ({
  telegram_group_id: id,
  group_name: `Group ${id}`,
  chat_id: `-100${id}`,
  is_active: true,
});
const EMPLOYEE = (over = {}) => ({
  employee_id: 42,
  store_id: 1,
  designation_id: 5,
  department_id: 7,
  status: 1,
  date_of_joining: "2025-01-01",
  resignation_date: null,
  ...over,
});

/** A whole world, with the claims kept as rows so transitions are real. */
const build = (over = {}) => {
  const state = {
    employee: EMPLOYEE(),
    mappings: [{ telegram_group_id: 10, mapping_type: "ALL_EMPLOYEES", target_id: 0, group: GROUP(10) }],
    claims: [],
    identities: [{ employee_telegram_id: 900, employee_id: 42, telegram_user_id: 555001, disconnected_at: null }],
    members: new Set(["-10010:555001"]),
    activeOwner: {},
    removalsEnabled: true,
    telegramDown: false,
    botRights: { status: "administrator", canRestrictMembers: true },
    ...over,
  };
  const calls = { bans: [], unbans: [], events: [], getChatMember: [] };

  const find = (employeeId, groupId, source) =>
    state.claims.find(
      (c) =>
        c.employee_id === Number(employeeId) &&
        c.telegram_group_id === Number(groupId) &&
        c.source === source
    );

  const claimRepo = {
    getForEmployee: async (id) => state.claims.filter((c) => c.employee_id === Number(id)).map((c) => ({ ...c })),
    getLiveForGroup: async (id) =>
      state.claims
        .filter((c) => c.telegram_group_id === Number(id) && c.state !== CLAIM_STATE.CLOSED)
        .map((c) => ({ ...c })),
    open: async ({ employeeId, telegramGroupId, source }) => {
      const existing = find(employeeId, telegramGroupId, source);
      if (existing) {
        const reopened = existing.state === CLAIM_STATE.CLOSED;
        if (existing.state === CLAIM_STATE.ACTIVE) return { changed: false, reopened: false };
        Object.assign(existing, {
          state: CLAIM_STATE.ACTIVE,
          intent_reason: null,
          close_outcome: null,
          removal_requested_at: null,
        });
        return { changed: true, reopened };
      }
      state.claims.push({
        employee_id: Number(employeeId),
        telegram_group_id: Number(telegramGroupId),
        source,
        state: CLAIM_STATE.ACTIVE,
        intent_reason: null,
        close_outcome: null,
        adopted_from_existing_member: false,
        removal_requested_at: null,
      });
      return { changed: true, reopened: false };
    },
    requestRemoval: async ({ employeeId, telegramGroupId, source, intentReason }) => {
      const claim = find(employeeId, telegramGroupId, source);
      if (!claim || claim.state !== CLAIM_STATE.ACTIVE) return { changed: false };
      claim.state = CLAIM_STATE.REMOVAL_PENDING;
      claim.intent_reason = intentReason;
      claim.removal_requested_at = NOW;
      return { changed: true };
    },
    cancelRemoval: async ({ employeeId, telegramGroupId, source }) => {
      const claim = find(employeeId, telegramGroupId, source);
      if (!claim || claim.state !== CLAIM_STATE.REMOVAL_PENDING) return { changed: false };
      claim.state = CLAIM_STATE.ACTIVE;
      claim.intent_reason = null;
      claim.removal_requested_at = null;
      return { changed: true };
    },
    close: async ({ employeeId, telegramGroupId, source, closeOutcome, intentReason, fromStates }) => {
      const claim = find(employeeId, telegramGroupId, source);
      if (!claim || !fromStates.includes(claim.state)) return { changed: false };
      claim.state = CLAIM_STATE.CLOSED;
      claim.close_outcome = closeOutcome;
      if (intentReason) claim.intent_reason = intentReason;
      return { changed: true };
    },
    markAdopted: async ({ employeeId, telegramGroupId, source }) => {
      const claim = find(employeeId, telegramGroupId, source);
      if (!claim || claim.adopted_from_existing_member) return { changed: false };
      claim.adopted_from_existing_member = true;
      return { changed: true };
    },
    recordEvent: async (event) => {
      calls.events.push(event);
    },
  };

  const usecase = buildReconcile({
    claimRepo,
    jobRepo: { enqueueEmployee: async () => ({}) },
    mappingRepo: {
      getAllMappingsWithGroups: async () => state.mappings,
      getByGroup: async (id) => state.mappings.filter((m) => m.telegram_group_id === Number(id)),
      getEmployeeSnapshot: async () => [state.employee],
      getEmployeeForMatching: async (id) =>
        Number(id) === Number(state.employee.employee_id) ? state.employee : null,
    },
    registryRepo: {
      getById: async (id) => {
        const mapping = state.mappings.find((m) => m.telegram_group_id === Number(id));
        return mapping ? mapping.group : GROUP(Number(id));
      },
    },
    identityRepo: {
      getAllIdentitiesForEmployee: async () => state.identities,
      getActiveIdentityByEmployee: async () => state.identities.find((i) => !i.disconnected_at) || null,
      getActiveIdentityByTelegramUser: async (userId) => state.activeOwner[userId] || null,
    },
    telegram: {
      getMe: async () => ({ id: 777 }),
      getChat: async () => {
        if (state.telegramDown) throw new Error("ETIMEDOUT");
        return { type: "supergroup" };
      },
      getChatMember: async (chatId, userId) => {
        calls.getChatMember.push({ chatId, userId });
        if (state.telegramDown) throw new Error("ETIMEDOUT");
        if (Number(userId) === 777) return state.botRights;
        return state.members.has(`${chatId}:${userId}`) ? { status: "member" } : { status: "left" };
      },
      banChatMember: async (chatId, userId) => {
        calls.bans.push({ chatId, userId });
        state.members.delete(`${chatId}:${userId}`);
        return true;
      },
      unbanChatMember: async (chatId, userId) => {
        calls.unbans.push({ chatId, userId });
        return true;
      },
    },
    config: { removalsEnabled: state.removalsEnabled },
    now: () => NOW,
  });

  return { usecase, state, calls, claim: find };
};

const events = (calls, type) => calls.events.filter((e) => e.eventType === type);

describe("an employed employee", () => {
  it("opens a RULE claim for every group the mappings match", async () => {
    const { usecase, claim, calls } = build();
    await usecase.reconcileEmployee(42);
    assert.equal(claim(42, 10, CLAIM_SOURCE.RULE).state, CLAIM_STATE.ACTIVE);
    assert.equal(events(calls, MEMBERSHIP_EVENT.CLAIM_OPENED).length, 1);
  });

  it("MAINTAINS CLAIMS EVEN WHEN TELEGRAM IS DOWN", async () => {
    // Local mapping truth does not depend on somebody else's API being up.
    const { usecase, claim, calls } = build({ telegramDown: true });
    await usecase.reconcileEmployee(42);
    assert.equal(claim(42, 10, CLAIM_SOURCE.RULE).state, CLAIM_STATE.ACTIVE);
    assert.deepEqual(calls.bans, []);
  });

  it("adopts somebody already in the group, from a LIVE check", async () => {
    const { usecase, claim, calls } = build();
    await usecase.reconcileEmployee(42);
    assert.equal(claim(42, 10, CLAIM_SOURCE.RULE).adopted_from_existing_member, true);
    assert.equal(events(calls, MEMBERSHIP_EVENT.ADOPTED).length, 1);
  });

  it("does not adopt somebody who is not in the group - joining is Phase 3B's", async () => {
    const { usecase, claim, calls } = build({ members: new Set() });
    await usecase.reconcileEmployee(42);
    assert.equal(claim(42, 10, CLAIM_SOURCE.RULE).adopted_from_existing_member, false);
    assert.deepEqual(calls.bans, []);
  });

  it("asks for removal when the rule stops matching, and removes", async () => {
    const world = build();
    await world.usecase.reconcileEmployee(42);
    world.state.mappings = [];
    await world.usecase.reconcileEmployee(42);
    assert.equal(world.claim(42, 10, CLAIM_SOURCE.RULE).state, CLAIM_STATE.CLOSED);
    assert.equal(world.claim(42, 10, CLAIM_SOURCE.RULE).close_outcome, CLOSE_OUTCOME.REMOVED);
    assert.equal(world.calls.bans.length, 1);
    assert.equal(world.calls.unbans.length, 1, "the ban is always undone");
  });

  it("REMOVES NOBODY when a MANUAL claim still wants them there", async () => {
    const world = build();
    await world.usecase.reconcileEmployee(42);
    world.state.claims.push({
      employee_id: 42,
      telegram_group_id: 10,
      source: CLAIM_SOURCE.MANUAL,
      state: CLAIM_STATE.ACTIVE,
      adopted_from_existing_member: false,
    });
    world.state.mappings = [];
    await world.usecase.reconcileEmployee(42);

    const rule = world.claim(42, 10, CLAIM_SOURCE.RULE);
    assert.equal(rule.state, CLAIM_STATE.CLOSED);
    assert.equal(rule.close_outcome, CLOSE_OUTCOME.RETAINED_BY_OTHER_SOURCE);
    assert.equal(world.claim(42, 10, CLAIM_SOURCE.MANUAL).state, CLAIM_STATE.ACTIVE);
    assert.deepEqual(world.calls.bans, [], "nobody is removed while a source still holds them");
  });

  it("CANCELS a pending removal when the rule comes back", async () => {
    const world = build();
    await world.usecase.reconcileEmployee(42);
    world.claim(42, 10, CLAIM_SOURCE.RULE).state = CLAIM_STATE.REMOVAL_PENDING;
    world.claim(42, 10, CLAIM_SOURCE.RULE).intent_reason = INTENT_REASON.RULE_NO_LONGER_MATCHES;
    await world.usecase.reconcileEmployee(42);
    assert.equal(world.claim(42, 10, CLAIM_SOURCE.RULE).state, CLAIM_STATE.ACTIVE);
    assert.deepEqual(world.calls.bans, []);
    assert.equal(events(world.calls, MEMBERSHIP_EVENT.CLAIM_REMOVAL_CANCELLED).length, 1);
  });

  it("LEAVES AN UNCLAIMED MEMBERSHIP ALONE", async () => {
    // They are in a group nothing claims. During employment that is not ours
    // to undo - somebody put them there for a reason we do not know.
    const world = build({ mappings: [] });
    world.state.members.add("-10011:555001");
    await world.usecase.reconcileEmployee(42);
    assert.deepEqual(world.calls.bans, []);
  });
});

describe("employment ending", () => {
  const ended = () => EMPLOYEE({ status: 0, resignation_date: "2026-09-16" });

  it("closes EVERY claim, MANUAL included, and removes from every group", async () => {
    const world = build();
    await world.usecase.reconcileEmployee(42);
    world.state.claims.push({
      employee_id: 42,
      telegram_group_id: 11,
      source: CLAIM_SOURCE.MANUAL,
      state: CLAIM_STATE.ACTIVE,
      adopted_from_existing_member: false,
    });
    world.state.members.add("-10011:555001");
    world.state.employee = ended();

    await world.usecase.reconcileEmployee(42);

    assert.equal(world.claim(42, 10, CLAIM_SOURCE.RULE).state, CLAIM_STATE.CLOSED);
    assert.equal(world.claim(42, 11, CLAIM_SOURCE.MANUAL).state, CLAIM_STATE.CLOSED);
    assert.equal(world.calls.bans.length, 2);
  });

  it("reaches an employee-managed group WE NEVER CLAIMED", async () => {
    // The one case where "we did not manage this" is not good enough: they
    // have left, and the group carries mappings, so it is ours to clean.
    const world = build();
    world.state.members.add("-10010:555001");
    world.state.employee = ended();
    await world.usecase.reconcileEmployee(42);
    assert.equal(world.calls.bans.length, 1);
    assert.equal(world.calls.bans[0].chatId, "-10010");
  });

  it("removes HISTORICAL identities too", async () => {
    const world = build();
    world.state.identities = [
      { employee_telegram_id: 901, employee_id: 42, telegram_user_id: 555002, disconnected_at: null },
      {
        employee_telegram_id: 900,
        employee_id: 42,
        telegram_user_id: 555001,
        disconnected_at: new Date("2026-05-01"),
      },
    ];
    world.state.members.add("-10010:555002");
    world.state.employee = ended();

    await world.usecase.reconcileEmployee(42);
    const removed = world.calls.bans.map((b) => b.userId).sort();
    assert.deepEqual(removed, [555001, 555002]);
  });

  it("NEVER removes a historical account that now belongs to somebody else", async () => {
    // A handed-on handset. Removing "their old account" would eject a
    // current employee in the name of cleaning up after a former one.
    const world = build();
    world.state.identities = [
      {
        employee_telegram_id: 900,
        employee_id: 42,
        telegram_user_id: 555001,
        disconnected_at: new Date("2026-05-01"),
      },
    ];
    world.state.activeOwner[555001] = { employee_id: 43, employee_telegram_id: 950 };
    world.state.employee = ended();

    await world.usecase.reconcileEmployee(42);

    assert.deepEqual(world.calls.bans, []);
    assert.equal(
      events(world.calls, MEMBERSHIP_EVENT.IDENTITY_REUSED_BY_OTHER_EMPLOYEE).length,
      1
    );
  });
});

describe("when Telegram will not cooperate", () => {
  it("leaves the claim REMOVAL_PENDING rather than closing it", async () => {
    const world = build();
    await world.usecase.reconcileEmployee(42);
    world.state.mappings = [];
    world.state.telegramDown = true;

    await world.usecase.reconcileEmployee(42);

    const claim = world.claim(42, 10, CLAIM_SOURCE.RULE);
    assert.equal(claim.state, CLAIM_STATE.REMOVAL_PENDING);
    assert.notEqual(claim.state, CLAIM_STATE.CLOSED);
  });

  it("a lookup that FAILS MID-REMOVAL leaves the claim REMOVAL_PENDING", async () => {
    // Readiness was fine - the group is manageable - and the member check
    // itself failed. Nothing was established about whether they are in the
    // group, so nothing may be concluded about the claim. This is the case
    // the readiness check cannot cover, because readiness passed.
    const world = build();
    await world.usecase.reconcileEmployee(42);
    world.state.mappings = [];
    world.usecase.telegram.getChatMember = async (chatId, userId) => {
      if (Number(userId) === 777) return { status: "administrator", canRestrictMembers: true };
      throw new Error("ETIMEDOUT");
    };

    await world.usecase.reconcileEmployee(42);

    const claim = world.claim(42, 10, CLAIM_SOURCE.RULE);
    assert.equal(claim.state, CLAIM_STATE.REMOVAL_PENDING);
    assert.equal(claim.close_outcome, null);
    assert.deepEqual(world.calls.bans, []);
    assert.equal(events(world.calls, MEMBERSHIP_EVENT.REMOVE_FAILED).length, 1);
  });

  it("a BAN that fails leaves the claim REMOVAL_PENDING", async () => {
    const world = build();
    await world.usecase.reconcileEmployee(42);
    world.state.mappings = [];
    world.usecase.telegram.banChatMember = async () => {
      throw new Error("Bad Request: CHAT_ADMIN_REQUIRED");
    };

    await world.usecase.reconcileEmployee(42);

    assert.equal(world.claim(42, 10, CLAIM_SOURCE.RULE).state, CLAIM_STATE.REMOVAL_PENDING);
    assert.equal(world.claim(42, 10, CLAIM_SOURCE.RULE).close_outcome, null);
  });

  it("a bot without can_restrict_members removes nobody and closes nothing", async () => {
    const world = build({ botRights: { status: "administrator" } });
    await world.usecase.reconcileEmployee(42);
    world.state.mappings = [];
    await world.usecase.reconcileEmployee(42);

    assert.equal(world.claim(42, 10, CLAIM_SOURCE.RULE).state, CLAIM_STATE.REMOVAL_PENDING);
    assert.deepEqual(world.calls.bans, []);
    assert.equal(events(world.calls, MEMBERSHIP_EVENT.SKIPPED_NOT_READY).length, 1);
  });

  it("CONFIRMED ABSENT IS SUCCESS: the claim closes as ALREADY_ABSENT", async () => {
    const world = build({ members: new Set() });
    await world.usecase.reconcileEmployee(42);
    world.state.mappings = [];
    await world.usecase.reconcileEmployee(42);

    const claim = world.claim(42, 10, CLAIM_SOURCE.RULE);
    assert.equal(claim.state, CLAIM_STATE.CLOSED);
    assert.equal(claim.close_outcome, CLOSE_OUTCOME.ALREADY_ABSENT);
    assert.deepEqual(world.calls.bans, []);
  });

  it("USER_NOT_PARTICIPANT is the desired end state, not a failure", async () => {
    const world = build();
    await world.usecase.reconcileEmployee(42);
    world.state.mappings = [];
    world.usecase.telegram.getChatMember = async (chatId, userId) => {
      if (Number(userId) === 777) return { status: "administrator", canRestrictMembers: true };
      const err = new Error("Bad Request: USER_NOT_PARTICIPANT");
      err.telegramDescription = "Bad Request: USER_NOT_PARTICIPANT";
      throw err;
    };
    await world.usecase.reconcileEmployee(42);
    assert.equal(world.claim(42, 10, CLAIM_SOURCE.RULE).state, CLAIM_STATE.CLOSED);
    assert.equal(world.claim(42, 10, CLAIM_SOURCE.RULE).close_outcome, CLOSE_OUTCOME.ALREADY_ABSENT);
  });

  it("REMOVALS OFF: claims are maintained, nobody is removed", async () => {
    // The dry-run the rollout runs on. Claims move; Telegram does not.
    const world = build({ removalsEnabled: false });
    await world.usecase.reconcileEmployee(42);
    world.state.mappings = [];
    await world.usecase.reconcileEmployee(42);

    assert.equal(world.claim(42, 10, CLAIM_SOURCE.RULE).state, CLAIM_STATE.REMOVAL_PENDING);
    assert.deepEqual(world.calls.bans, []);
  });
});

describe("the group scope", () => {
  it("reconciles the people it matches AND the people it used to", async () => {
    const world = build();
    await world.usecase.reconcileGroup(10);
    assert.equal(world.claim(42, 10, CLAIM_SOURCE.RULE).state, CLAIM_STATE.ACTIVE);

    world.state.mappings = [];
    const after = await world.usecase.reconcileGroup(10);
    assert.equal(after.employees, 1, "somebody it used to manage is still reconciled");
    assert.equal(world.claim(42, 10, CLAIM_SOURCE.RULE).state, CLAIM_STATE.CLOSED);
  });

  it("never re-opens a claim for somebody who has left", async () => {
    const world = build();
    world.state.employee = EMPLOYEE({ status: 0, resignation_date: "2026-09-16" });
    await world.usecase.reconcileGroup(10);
    assert.equal(world.claim(42, 10, CLAIM_SOURCE.RULE), undefined);
  });
});
