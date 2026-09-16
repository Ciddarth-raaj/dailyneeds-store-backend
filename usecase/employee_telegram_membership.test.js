/**
 * Required groups, join links and Telegram Complete. Phase 3B.
 *
 *   node --test usecase/employee_telegram_membership.test.js
 *
 * The rules that matter here:
 *
 *   the matcher is PHASE 3A'S, not a second one written for this phase
 *   every join-link precondition is re-checked against CURRENT state
 *   the invite URL is returned once and stored only as a hash
 *   completion is DERIVED, never stored
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const buildMembership = require("./employee_telegram_membership");
const {
  MEMBERSHIP_STATUS,
  GROUP_READINESS,
  ATTEMPT_STATUS,
  JOIN_LINK_TTL_MS,
} = require("../constants/telegram_membership");

const sha256 = (v) => crypto.createHash("sha256").update(String(v)).digest("hex");
const NOW = new Date("2026-09-16T04:00:00Z"); // 09:30 IST
const INVITE = "https://t.me/+SecretInviteXyz";

const emp = (over = {}) => ({
  employee_id: 42,
  employee_name: "Raj",
  store_id: 5,
  designation_id: 7,
  department_id: 3,
  status: 1,
  date_of_joining: "2020-01-01",
  resignation_date: null,
  ...over,
});

const group = (id, name) => ({
  telegram_group_id: id,
  group_name: name,
  chat_id: `-100${id}`,
  category: "HR",
  used_for: "notices",
  is_active: true,
});

const mapping = (id, groupId, type, target, groupRow) => ({
  telegram_group_mapping_id: id,
  telegram_group_id: groupId,
  mapping_type: type,
  target_id: target,
  group: groupRow,
});

const build = (over = {}) => {
  const calls = { issued: [], invites: [], memberChecks: [], expired: [], verified: [] };
  const state = {
    mappings: [],
    identity: { employee_id: 42, employee_telegram_id: 900, telegram_user_id: 555001 },
    readiness: { status: GROUP_READINESS.READY, reason: null },
    liveAttempts: new Map(),
    joinedGroupIds: new Set(),
    isMember: false,
    memberThrows: null,
    inviteThrows: null,
    ...over,
  };

  const usecase = buildMembership({
    mappingRepo: {
      getAllMappingsWithGroups: async () => state.mappings,
      getEmployeeForMatching: async () => emp(),
    },
    identityRepo: { getActiveIdentityByEmployee: async () => state.identity },
    verificationRepo: {
      record: async (row) => {
        calls.verified.push(row);
        return { recorded: true };
      },
    },
    joinRepo: {
      expireOverdue: async (id) => {
        calls.expired.push(id);
        return { expired: 0 };
      },
      getLiveAttemptsForEmployee: async () => state.liveAttempts,
      getJoinedGroupIds: async () => state.joinedGroupIds,
      issueAttempt: async (a) => {
        calls.issued.push(a);
        return { employee_telegram_group_join_attempt_id: 1 };
      },
    },
    readiness: {
      check: async () => state.readiness,
      checkMany: async (groups) => new Map(groups.map((g) => [g.telegram_group_id, state.readiness])),
    },
    telegram: {
      getChatMember: async (chatId, userId) => {
        calls.memberChecks.push({ chatId, userId });
        if (state.memberThrows) throw state.memberThrows;
        return state.isMember ? { status: "member" } : { status: "left" };
      },
      createChatInviteLink: async (chatId, opts) => {
        calls.invites.push({ chatId, opts });
        if (state.inviteThrows) throw state.inviteThrows;
        return { invite_link: INVITE };
      },
    },
    now: () => NOW,
  });

  return { usecase, calls, state };
};

/* ======================================================= required groups */

describe("required groups use the PHASE 3A matcher", () => {
  const ecr = group(1, "ECR Team");
  const cashiers = group(2, "Cashiers");
  const ops = group(3, "Operations");
  const everyone = group(4, "Everyone");

  it("matches ALL_EMPLOYEES, OUTLET, DESIGNATION and DEPARTMENT", async () => {
    const { usecase } = build({
      mappings: [
        mapping(1, 4, "ALL_EMPLOYEES", 0, everyone),
        mapping(2, 1, "OUTLET", 5, ecr),
        mapping(3, 2, "DESIGNATION", 7, cashiers),
        mapping(4, 3, "DEPARTMENT", 3, ops),
      ],
    });
    const required = await usecase.requiredGroups(emp());
    assert.deepEqual(required.map((g) => g.telegram_group_id).sort(), [1, 2, 3, 4]);
  });

  it("does NOT match a rule for another outlet, designation or department", async () => {
    const { usecase } = build({
      mappings: [
        mapping(1, 1, "OUTLET", 9, ecr),
        mapping(2, 2, "DESIGNATION", 99, cashiers),
        mapping(3, 3, "DEPARTMENT", 99, ops),
      ],
    });
    assert.deepEqual(await usecase.requiredGroups(emp()), []);
  });

  it("deduplicates a group required by several rules", async () => {
    // One group, matched by outlet AND designation. The employee is asked to
    // join it once.
    const { usecase } = build({
      mappings: [mapping(1, 1, "OUTLET", 5, ecr), mapping(2, 1, "DESIGNATION", 7, ecr)],
    });
    const required = await usecase.requiredGroups(emp());
    assert.equal(required.length, 1);
    assert.equal(required[0].telegram_group_id, 1);
  });

  it("requires NOTHING of somebody who is no longer employed", async () => {
    // Which is not the same as removing them from anything - this phase
    // removes nobody.
    const { usecase } = build({ mappings: [mapping(1, 4, "ALL_EMPLOYEES", 0, everyone)] });
    assert.deepEqual(await usecase.requiredGroups(emp({ resignation_date: "2026-09-15" })), []);
    assert.deepEqual(await usecase.requiredGroups(emp({ date_of_joining: "2026-09-17" })), []);
  });

  it("still requires groups of an employee exempt from attendance", async () => {
    const { usecase } = build({ mappings: [mapping(1, 4, "ALL_EMPLOYEES", 0, everyone)] });
    const required = await usecase.requiredGroups(emp({ attendance_required: 0 }));
    assert.equal(required.length, 1);
  });

  it("requires nothing when there are no mappings - a NAME decides nothing", async () => {
    const { usecase } = build({ mappings: [] });
    assert.deepEqual(await usecase.requiredGroups(emp()), []);
  });

  it("includes an INACTIVE group, so a requirement cannot vanish silently", async () => {
    const retired = { ...ecr, is_active: false };
    const { usecase } = build({ mappings: [mapping(1, 1, "OUTLET", 5, retired)] });
    const required = await usecase.requiredGroups(emp());
    assert.equal(required.length, 1, "readiness reports it inactive; it is not hidden");
  });
});

/* ============================================================== the view */

describe("the employee's Telegram picture", () => {
  const ecr = group(1, "ECR Team");
  const mappings = [mapping(1, 1, "OUTLET", 5, ecr)];

  it("reports JOINED when Telegram says they are in the group", async () => {
    const { usecase } = build({ mappings, isMember: true });
    const result = await usecase.getGroups(42, emp());
    assert.equal(result.groups[0].membership_status, MEMBERSHIP_STATUS.JOINED);
    assert.equal(result.telegram_complete, true);
  });

  it("reports ACTION_REQUIRED when they are not in it and nothing is pending", async () => {
    const { usecase } = build({ mappings, isMember: false });
    const result = await usecase.getGroups(42, emp());
    assert.equal(result.groups[0].membership_status, MEMBERSHIP_STATUS.ACTION_REQUIRED);
    assert.equal(result.groups[0].can_generate_join_link, true);
    assert.equal(result.telegram_complete, false);
  });

  it("reports JOIN_PENDING while an attempt is live, and offers no second link", async () => {
    const expires = new Date(NOW.getTime() + 5 * 60 * 1000);
    const { usecase } = build({
      mappings,
      isMember: false,
      liveAttempts: new Map([[1, { status: ATTEMPT_STATUS.PENDING, expires_at: expires }]]),
    });
    const result = await usecase.getGroups(42, emp());
    assert.equal(result.groups[0].membership_status, MEMBERSHIP_STATUS.JOIN_PENDING);
    assert.equal(result.groups[0].can_generate_join_link, false);
    assert.equal(result.groups[0].join_attempt_expires_at, expires);
  });

  it("reports GROUP_NOT_READY with a human reason", async () => {
    const { usecase } = build({
      mappings,
      readiness: { status: GROUP_READINESS.BOT_NOT_ADMIN, reason: "Diya is not an admin" },
    });
    const result = await usecase.getGroups(42, emp());
    assert.equal(result.groups[0].membership_status, MEMBERSHIP_STATUS.GROUP_NOT_READY);
    assert.equal(result.groups[0].readiness_reason, "Diya is not an admin");
    assert.equal(result.telegram_complete, false);
  });

  it("TELEGRAM IS THE AUTHORITY - a stored JOINED yields to a live 'left'", async () => {
    // Somebody left the group after we recorded the join.
    const { usecase } = build({ mappings, isMember: false, joinedGroupIds: new Set([1]) });
    const result = await usecase.getGroups(42, emp());
    assert.equal(result.groups[0].membership_status, MEMBERSHIP_STATUS.ACTION_REQUIRED);
  });

  it("FAILS CLOSED when membership cannot be verified - never a stale JOINED", async () => {
    // The case this replaced an earlier behaviour for: employee joined last
    // week, left the group by hand since, and today's getChatMember times
    // out. Reporting Joined from the old record would report Telegram
    // Complete for somebody who is not in the group.
    const { usecase } = build({
      mappings,
      joinedGroupIds: new Set([1]),
      memberThrows: new Error("network"),
    });
    const result = await usecase.getGroups(42, emp());

    assert.notEqual(result.groups[0].membership_status, MEMBERSHIP_STATUS.JOINED);
    assert.equal(result.groups[0].membership_status, MEMBERSHIP_STATUS.GROUP_NOT_READY);
    assert.equal(result.groups[0].readiness_status, GROUP_READINESS.TELEGRAM_UNAVAILABLE);
    assert.match(result.groups[0].readiness_reason, /temporarily unavailable/);
    assert.equal(result.telegram_complete, false, "unverified is never complete");
  });

  it("does not offer a Join link while membership is unverifiable", async () => {
    // We do not know whether they are already in; offering a link would be
    // guessing, and the honest row says Telegram could not be reached.
    const { usecase } = build({ mappings, memberThrows: new Error("network") });
    const result = await usecase.getGroups(42, emp());
    assert.equal(result.groups[0].can_generate_join_link, false);
  });

  it("NEVER reads the stored JOINED as truth, even with no Telegram failure", async () => {
    // A record saying joined, and a live answer saying left. The live answer
    // wins; the record is history, not evidence.
    const { usecase } = build({ mappings, isMember: false, joinedGroupIds: new Set([1]) });
    const result = await usecase.getGroups(42, emp());
    assert.equal(result.groups[0].membership_status, MEMBERSHIP_STATUS.ACTION_REQUIRED);
    assert.equal(result.telegram_complete, false);
  });

  it("an employee with a verified membership is still Complete", async () => {
    // Failing closed must not make completion unreachable.
    const { usecase } = build({ mappings, isMember: true });
    const result = await usecase.getGroups(42, emp());
    assert.equal(result.groups[0].membership_status, MEMBERSHIP_STATUS.JOINED);
    assert.equal(result.telegram_complete, true);
  });

  it("a disconnected employee costs NO Telegram calls", async () => {
    const { usecase, calls } = build({ mappings, identity: null });
    const result = await usecase.getGroups(42, emp());
    assert.equal(result.connected, false);
    assert.equal(result.telegram_complete, false);
    assert.deepEqual(calls.memberChecks, [], "nobody to ask about");
  });

  it("sweeps overdue attempts before reading what is live", async () => {
    const { usecase, calls } = build({ mappings });
    await usecase.getGroups(42, emp());
    assert.deepEqual(calls.expired, [42], "a stale PENDING must not show as Join Pending");
  });

  it("connected with zero required groups is COMPLETE", async () => {
    const { usecase } = build({ mappings: [] });
    const result = await usecase.getGroups(42, emp());
    assert.deepEqual(result.groups, []);
    assert.equal(result.telegram_complete, true);
  });

  it("exposes no Telegram identifier of any kind", async () => {
    const { usecase } = build({ mappings, isMember: true });
    const body = JSON.stringify(await usecase.getGroups(42, emp()));
    for (const secret of ["555001", "-1001", "telegram_user_id", "private_chat_id", "invite"]) {
      assert.ok(!body.includes(secret), `must not expose ${secret}`);
    }
  });
});

/* ============================================ the dashboard's cache */

describe("what gets written to the verification cache", () => {
  const ecr = group(1, "ECR Team");
  const mappings = [mapping(1, 1, "OUTLET", 5, ecr)];

  it("records JOINED against the IDENTITY ROW, not just the employee", async () => {
    // The identity binding is what makes a reconnect invalidate the cache.
    const { usecase, calls } = build({ mappings, isMember: true });
    await usecase.getGroups(42, emp());

    assert.equal(calls.verified.length, 1);
    assert.equal(calls.verified[0].employeeTelegramId, 900);
    assert.equal(calls.verified[0].employeeId, 42);
    assert.equal(calls.verified[0].telegramGroupId, 1);
    assert.equal(calls.verified[0].membership, "JOINED");
    assert.equal(calls.verified[0].readinessStatus, GROUP_READINESS.READY);
    assert.ok(calls.verified[0].verifiedAt instanceof Date);
  });

  it("records NOT_JOINED when Telegram says they are not in the group", async () => {
    const { usecase, calls } = build({ mappings, isMember: false });
    await usecase.getGroups(42, emp());
    assert.equal(calls.verified[0].membership, "NOT_JOINED");
  });

  it("records a DEFINITIVE not-ready group, so the dashboard can say PENDING", async () => {
    // We DID look and the requirement is genuinely unmet - a finding, not
    // an absence of one.
    const { usecase, calls } = build({
      mappings,
      readiness: { status: GROUP_READINESS.BOT_NOT_ADMIN, reason: "Diya is not an admin" },
    });
    await usecase.getGroups(42, emp());
    assert.equal(calls.verified.length, 1);
    assert.equal(calls.verified[0].membership, "NOT_JOINED");
    assert.equal(calls.verified[0].readinessStatus, GROUP_READINESS.BOT_NOT_ADMIN);
  });

  it("WRITES NOTHING when Telegram could not be reached", async () => {
    // The rule the cache's trustworthiness rests on. A momentary network
    // failure must not knock an employee off the Complete list for a reason
    // that has nothing to do with them.
    const { usecase, calls } = build({
      mappings,
      readiness: { status: GROUP_READINESS.TELEGRAM_UNAVAILABLE, reason: "unavailable" },
    });
    await usecase.getGroups(42, emp());
    assert.deepEqual(calls.verified, []);
  });

  it("WRITES NOTHING when the membership check itself failed", async () => {
    // Readiness was fine; the member lookup threw. Still not an answer.
    const { usecase, calls } = build({ mappings, memberThrows: new Error("ETIMEDOUT") });
    await usecase.getGroups(42, emp());
    assert.deepEqual(calls.verified, []);
  });

  it("writes nothing for a disconnected employee", async () => {
    const { usecase, calls } = build({ mappings, identity: null });
    await usecase.getGroups(42, emp());
    assert.deepEqual(calls.verified, []);
  });

  it("NEVER READS the cache - this screen asks Telegram", async () => {
    const reads = [];
    const { usecase } = build({ mappings, isMember: true });
    usecase.verificationRepo.getForEmployees = async () => {
      reads.push(1);
      return new Map();
    };
    await usecase.getGroups(42, emp());
    assert.deepEqual(reads, [], "the detail screen is the authority, not the cache");
  });

  it("a cache failure never breaks the screen", async () => {
    const { usecase } = build({ mappings, isMember: true });
    usecase.verificationRepo.record = async () => {
      throw new Error("cache table is gone");
    };
    const result = await usecase.getGroups(42, emp());
    assert.equal(result.groups[0].membership_status, MEMBERSHIP_STATUS.JOINED);
  });

  it("the recorder REFUSES an unavailable readiness even if called directly", async () => {
    // Defence in depth, and worth its own test: the caller already avoids
    // this branch, so without calling it directly nothing would notice the
    // guard being removed. Three layers protect the one rule the cache's
    // trustworthiness rests on - the caller, this guard, and the
    // repository's own refusal.
    const { usecase, calls } = build({});
    await usecase._recordVerification({
      identity: { employee_telegram_id: 900, employee_id: 42 },
      group: { telegram_group_id: 1 },
      readiness: { status: GROUP_READINESS.TELEGRAM_UNAVAILABLE },
      joined: false,
    });
    assert.deepEqual(calls.verified, [], "we could not ask is not an answer");
  });

  it("the recorder refuses a missing readiness", async () => {
    const { usecase, calls } = build({});
    await usecase._recordVerification({
      identity: { employee_telegram_id: 900, employee_id: 42 },
      group: { telegram_group_id: 1 },
      readiness: null,
      joined: true,
    });
    assert.deepEqual(calls.verified, []);
  });

  it("caches no Telegram identifier", async () => {
    const { usecase, calls } = build({ mappings, isMember: true });
    await usecase.getGroups(42, emp());
    const body = JSON.stringify(calls.verified[0]);
    assert.ok(!body.includes("555001"), "no Telegram user id");
    assert.ok(!body.includes("-1001"), "no chat id");
  });
});

/* =========================================================== join links */

describe("issuing a join link", () => {
  const ecr = group(1, "ECR Team");
  const mappings = [mapping(1, 1, "OUTLET", 5, ecr)];

  it("creates a 15-minute join-request link and stores only its HASH", async () => {
    const { usecase, calls } = build({ mappings, isMember: false });
    const result = await usecase.createJoinLink(42, 1, emp(), { actorUserId: 9 });

    assert.equal(result.invite_link, INVITE, "returned ONCE, here");
    assert.equal(result.expires_in_minutes, 15);
    assert.equal(
      result.expires_at.getTime() - NOW.getTime(),
      JOIN_LINK_TTL_MS
    );
    assert.equal(calls.issued[0].inviteLinkHash, sha256(INVITE));
    assert.notEqual(calls.issued[0].inviteLinkHash, INVITE, "the URL itself is never stored");
    assert.equal(calls.issued[0].createdBy, 9);
  });

  it("asks Telegram for a link that CREATES A JOIN REQUEST", async () => {
    // The whole security model: the link lets somebody ASK, not enter.
    const { usecase, calls } = build({ mappings, isMember: false });
    await usecase.createJoinLink(42, 1, emp());
    assert.equal(calls.invites[0].chatId, ecr.chat_id);
    assert.ok(calls.invites[0].opts.expireDate > NOW.getTime());
  });

  it("refuses when the employee has not connected Telegram", async () => {
    const { usecase, calls } = build({ mappings, identity: null });
    await assert.rejects(() => usecase.createJoinLink(42, 1, emp()), /not connected Telegram/i);
    assert.deepEqual(calls.invites, []);
  });

  it("refuses a group that is not required for this employee", async () => {
    const { usecase, calls } = build({ mappings: [] });
    await assert.rejects(() => usecase.createJoinLink(42, 1, emp()), /not required/i);
    assert.deepEqual(calls.invites, []);
  });

  it("gives the SAME answer for a group that does not exist", async () => {
    // A group somebody has no business in must not be distinguishable from
    // one that is not there.
    const { usecase } = build({ mappings });
    await assert.rejects(() => usecase.createJoinLink(42, 4242, emp()), /not required/i);
  });

  it("refuses when the group is not ready, and says why", async () => {
    const { usecase, calls } = build({
      mappings,
      readiness: { status: GROUP_READINESS.BOT_PERMISSION_MISSING, reason: "Diya needs permission to manage join requests" },
    });
    await assert.rejects(() => usecase.createJoinLink(42, 1, emp()), /needs permission/);
    assert.deepEqual(calls.invites, []);
  });

  it("issues NO link when the employee is already in the group", async () => {
    const { usecase, calls } = build({ mappings, isMember: true });
    const result = await usecase.createJoinLink(42, 1, emp());
    assert.equal(result.already_joined, true);
    assert.equal(result.membership_status, MEMBERSHIP_STATUS.JOINED);
    assert.equal(result.invite_link, undefined);
    assert.deepEqual(calls.invites, [], "asking somebody already in to join is nonsense");
  });

  it("re-checks EVERY precondition against current state, not the screen's", async () => {
    // The screen only offers the button when these hold, but it is seconds
    // old and is not an authorization boundary.
    const { usecase, calls } = build({ mappings, isMember: false });
    await usecase.createJoinLink(42, 1, emp());
    assert.equal(calls.memberChecks.length, 1, "membership re-checked at issue time");
    assert.equal(calls.invites.length, 1);
  });

  it("reports Telegram being unavailable rather than leaking its error", async () => {
    const { usecase, calls } = build({
      mappings,
      isMember: false,
      inviteThrows: new Error("Bad Request: CHAT_ADMIN_REQUIRED at 0x7f"),
    });
    await assert.rejects(
      () => usecase.createJoinLink(42, 1, emp()),
      (err) => /temporarily unavailable/i.test(err.message) && !/CHAT_ADMIN_REQUIRED/.test(err.message)
    );
    assert.deepEqual(calls.issued, [], "no attempt is recorded for a link that was never made");
  });

  it("records no attempt when Telegram returns no URL", async () => {
    const { usecase, calls } = build({ mappings, isMember: false });
    usecase.telegram.createChatInviteLink = async () => ({});
    await assert.rejects(() => usecase.createJoinLink(42, 1, emp()));
    assert.deepEqual(calls.issued, []);
  });
});

/* ============================================================= boundary */

describe("PHASE 3B REMOVES NOBODY", () => {
  it("no membership path calls a removal method", async () => {
    const forbidden = [];
    const { usecase } = build({
      mappings: [mapping(1, 1, "OUTLET", 5, group(1, "ECR"))],
      isMember: false,
    });
    for (const m of ["banChatMember", "unbanChatMember", "kickChatMember", "restrictChatMember"]) {
      usecase.telegram[m] = async () => forbidden.push(m);
    }
    await usecase.getGroups(42, emp());
    await usecase.createJoinLink(42, 1, emp());
    // An employee who no longer matches: the group simply stops being
    // required. Nothing acts on that.
    await usecase.getGroups(42, emp({ store_id: 99 }));
    assert.deepEqual(forbidden, []);
  });
});
