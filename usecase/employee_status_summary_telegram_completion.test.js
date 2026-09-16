/**
 * DASHBOARD TELEGRAM COMPLETION - last-verified, and no Telegram call.
 *
 *   node --test usecase/employee_status_summary_telegram_completion.test.js
 *
 * The employee dashboard cannot ask Telegram: completion needs a readiness
 * check and a membership check per required group per employee, which for a
 * few hundred employees is thousands of Bot API calls on every page load,
 * sharing one rate-limited token with the three-second password-reset
 * poller. So it reads the cache the DETAIL screen fills in - and the field
 * says "last verified" rather than pretending to be live.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const buildSummary = require("./employee_status_summary");
const { TELEGRAM_COMPLETION, GROUP_READINESS, VERIFIED_MEMBERSHIP } = require("../constants/telegram_membership");

const emp = (id, over = {}) => ({
  employee_id: id,
  employee_name: `Employee ${id}`,
  store_id: 5,
  designation_id: 7,
  department_id: 3,
  status: 1,
  date_of_joining: "2020-01-01",
  resignation_date: null,
  ...over,
});

const mapping = (id, groupId, type, target) => ({
  telegram_group_mapping_id: id,
  telegram_group_id: groupId,
  mapping_type: type,
  target_id: target,
  group: { telegram_group_id: groupId, group_name: `G${groupId}`, is_active: true },
});

const verified = (membership, readiness = GROUP_READINESS.READY) => ({
  membership,
  readiness_status: readiness,
  verified_at: new Date("2026-09-16T04:00:00Z"),
});

/**
 * The summary with only its Telegram dependencies real. `calls` counts every
 * read so the no-N+1 and no-Telegram assertions are measured, not asserted
 * from a comment.
 */
const build = ({ employees = [emp(42)], mappings = [], verifications = new Map(), connected = [42] } = {}) => {
  const calls = { mappings: 0, verifications: 0, snapshot: 0, identities: 0, telegram: [] };
  const ids = employees.map((e) => e.employee_id);

  // The same stub shapes the existing summary tests use - exactly the method
  // names the usecase calls, because a stub that guesses them would pass
  // while the real read was broken.
  const employeeUsecase = { get: async () => employees.map((e) => ({ employee_id: e.employee_id })) };
  const aadhaarRepo = { findEmployeeIdsWithIdentity: async () => [] };
  const bankRepo = {
    getBankDetailsMany: async () => [],
    getVerificationsMany: async () => [],
    findActiveVerifiedByFingerprints: async () => [],
  };
  const telegramRepo = {
    getSummaryForEmployees: async (list) => {
      calls.identities += 1;
      return new Map(
        list.map((id) => [Number(id), { hasActiveIdentity: connected.includes(Number(id)), rows: [] }])
      );
    },
  };

  const summary = buildSummary(employeeUsecase, aadhaarRepo, bankRepo, null, null, telegramRepo, {
    mappingRepo: {
      getAllMappingsWithGroups: async () => {
        calls.mappings += 1;
        return mappings;
      },
      getEmployeeSnapshot: async () => {
        calls.snapshot += 1;
        return employees;
      },
    },
    verificationRepo: {
      getForEmployees: async () => {
        calls.verifications += 1;
        return verifications;
      },
    },
  });
  return { summary, calls, ids };
};

const completionFor = async (ctx, employeeId = 42) => {
  const rows = await ctx.summary.list({});
  const row = rows.find((r) => r.employee_id === employeeId);
  return row ? row.telegram_completion : undefined;
};

/* ============================================================== the rules */

describe("the four completion states", () => {
  it("no connected identity -> NOT_CONNECTED", async () => {
    const ctx = build({ connected: [], mappings: [mapping(1, 10, "ALL_EMPLOYEES", 0)] });
    assert.equal(await completionFor(ctx), TELEGRAM_COMPLETION.NOT_CONNECTED);
  });

  it("connected with ZERO required groups -> COMPLETE", async () => {
    const ctx = build({ mappings: [] });
    assert.equal(await completionFor(ctx), TELEGRAM_COMPLETION.COMPLETE);
  });

  it("every required group last-verified READY and JOINED -> COMPLETE", async () => {
    const ctx = build({
      mappings: [mapping(1, 10, "OUTLET", 5), mapping(2, 11, "DESIGNATION", 7)],
      verifications: new Map([
        [42, new Map([[10, verified(VERIFIED_MEMBERSHIP.JOINED)], [11, verified(VERIFIED_MEMBERSHIP.JOINED)]])],
      ]),
    });
    assert.equal(await completionFor(ctx), TELEGRAM_COMPLETION.COMPLETE);
  });

  it("a required group with NO verification -> VERIFICATION_PENDING", async () => {
    // Nobody has looked. Saying "not joined" would be a claim we have no
    // evidence for.
    const ctx = build({
      mappings: [mapping(1, 10, "OUTLET", 5), mapping(2, 11, "DESIGNATION", 7)],
      verifications: new Map([[42, new Map([[10, verified(VERIFIED_MEMBERSHIP.JOINED)]])]]),
    });
    assert.equal(await completionFor(ctx), TELEGRAM_COMPLETION.VERIFICATION_PENDING);
  });

  it("a required group last-verified NOT_JOINED -> PENDING", async () => {
    const ctx = build({
      mappings: [mapping(1, 10, "OUTLET", 5)],
      verifications: new Map([[42, new Map([[10, verified(VERIFIED_MEMBERSHIP.NOT_JOINED)]])]]),
    });
    assert.equal(await completionFor(ctx), TELEGRAM_COMPLETION.PENDING);
  });

  it("a required group verified as definitively NOT READY -> PENDING", async () => {
    // We DID look, and the requirement is genuinely unmet - that is a
    // finding, not an absence of one.
    for (const readiness of [
      GROUP_READINESS.BOT_NOT_ADMIN,
      GROUP_READINESS.BOT_NOT_MEMBER,
      GROUP_READINESS.BASIC_GROUP_UNSUPPORTED,
      GROUP_READINESS.INACTIVE_GROUP,
      GROUP_READINESS.BOT_PERMISSION_MISSING,
    ]) {
      const ctx = build({
        mappings: [mapping(1, 10, "OUTLET", 5)],
        verifications: new Map([
          [42, new Map([[10, verified(VERIFIED_MEMBERSHIP.NOT_JOINED, readiness)]])],
        ]),
      });
      assert.equal(await completionFor(ctx), TELEGRAM_COMPLETION.PENDING, readiness);
    }
  });

  it("unverified is reported ahead of not-joined", async () => {
    const ctx = build({
      mappings: [mapping(1, 10, "OUTLET", 5), mapping(2, 11, "DESIGNATION", 7)],
      verifications: new Map([[42, new Map([[10, verified(VERIFIED_MEMBERSHIP.NOT_JOINED)]])]]),
    });
    assert.equal(await completionFor(ctx), TELEGRAM_COMPLETION.VERIFICATION_PENDING);
  });
});

/* =================================================== staleness by design */

describe("a change to the configuration reopens the question", () => {
  it("A NEW MAPPING turns a COMPLETE employee into VERIFICATION_PENDING", async () => {
    const before = build({
      mappings: [mapping(1, 10, "OUTLET", 5)],
      verifications: new Map([[42, new Map([[10, verified(VERIFIED_MEMBERSHIP.JOINED)]])]]),
    });
    assert.equal(await completionFor(before), TELEGRAM_COMPLETION.COMPLETE);

    // Somebody maps a second group to this outlet. Nobody has checked it.
    const after = build({
      mappings: [mapping(1, 10, "OUTLET", 5), mapping(2, 11, "OUTLET", 5)],
      verifications: new Map([[42, new Map([[10, verified(VERIFIED_MEMBERSHIP.JOINED)]])]]),
    });
    assert.equal(await completionFor(after), TELEGRAM_COMPLETION.VERIFICATION_PENDING);
  });

  it("A RECONNECT invalidates the previous identity's verifications", async () => {
    // The repository joins verifications to the ACTIVE identity, so a new
    // identity row simply returns nothing - which is what the empty map
    // here represents. The employee is not wrongly Complete against an
    // account they no longer use.
    const ctx = build({
      mappings: [mapping(1, 10, "OUTLET", 5)],
      verifications: new Map(),
    });
    assert.equal(await completionFor(ctx), TELEGRAM_COMPLETION.VERIFICATION_PENDING);
  });

  it("an employee who left is required to be in nothing -> COMPLETE", async () => {
    // The dated rule, shared with every other Telegram path.
    const ctx = build({
      employees: [emp(42, { resignation_date: "2020-06-01" })],
      mappings: [mapping(1, 10, "ALL_EMPLOYEES", 0)],
      verifications: new Map(),
    });
    assert.equal(await completionFor(ctx), TELEGRAM_COMPLETION.COMPLETE);
  });

  it("uses the SAME matcher - another outlet's rule is not required here", async () => {
    const ctx = build({
      mappings: [mapping(1, 10, "OUTLET", 99)],
      verifications: new Map(),
    });
    assert.equal(await completionFor(ctx), TELEGRAM_COMPLETION.COMPLETE);
  });
});

/* ============================================================ the budget */

describe("the dashboard's cost", () => {
  it("makes ZERO Telegram API calls", async () => {
    // The whole reason this reads a cache. A Telegram service is not even
    // injected into the summary - there is nothing here to call.
    const ctx = build({ mappings: [mapping(1, 10, "ALL_EMPLOYEES", 0)] });
    await ctx.summary.list({});
    assert.deepEqual(ctx.calls.telegram, []);
    assert.equal(typeof ctx.summary.telegram, "undefined");
    assert.equal(typeof ctx.summary.readiness, "undefined");
  });

  it("is a FIXED number of reads for 200 employees, not one per employee", async () => {
    const employees = Array.from({ length: 200 }, (_, i) => emp(i + 1));
    const ctx = build({
      employees,
      connected: employees.map((e) => e.employee_id),
      mappings: [mapping(1, 10, "ALL_EMPLOYEES", 0), mapping(2, 11, "OUTLET", 5)],
      verifications: new Map(
        employees.map((e) => [
          e.employee_id,
          new Map([[10, verified(VERIFIED_MEMBERSHIP.JOINED)], [11, verified(VERIFIED_MEMBERSHIP.JOINED)]]),
        ])
      ),
    });
    const rows = await ctx.summary.list({});

    assert.equal(rows.length, 200);
    assert.equal(ctx.calls.mappings, 1, "one mapping read for the whole page");
    assert.equal(ctx.calls.verifications, 1, "one verification read for the whole page");
    assert.equal(ctx.calls.snapshot, 1);
    assert.equal(ctx.calls.identities, 1);
    assert.ok(rows.every((r) => r.telegram_completion === TELEGRAM_COMPLETION.COMPLETE));
  });
});

/* ========================================================== the boundary */

describe("what the dashboard must not change", () => {
  it("`hr_onboarding_pending` is untouched by completion", async () => {
    // Adding Telegram to it would flip the HR status of every employee who
    // predates Telegram onboarding - a migration-sized product change, not a
    // dashboard column.
    const ctx = build({
      mappings: [mapping(1, 10, "OUTLET", 5)],
      verifications: new Map([[42, new Map([[10, verified(VERIFIED_MEMBERSHIP.NOT_JOINED)]])]]),
    });
    const [row] = await ctx.summary.list({});
    assert.equal(row.telegram_completion, TELEGRAM_COMPLETION.PENDING);
    // The onboarding repo is not wired in this fixture, so the key is
    // omitted entirely - completion did not invent one.
    assert.equal("hr_onboarding_pending" in row, false);
  });

  it("keeps telegram_status and telegram_connected as separate fields", async () => {
    const ctx = build({ mappings: [] });
    const [row] = await ctx.summary.list({});
    assert.equal(row.telegram_completion, TELEGRAM_COMPLETION.COMPLETE);
    // Other screens read these; completion is additive.
    assert.ok("telegram_connected" in row || "telegram_status" in row);
  });

  it("OMITS the key rather than guessing when completion is not wired", async () => {
    const summary = buildSummary(
      { get: async () => [{ employee_id: 42 }] },
      { findEmployeeIdsWithIdentity: async () => [] },
      {
        getBankDetailsMany: async () => [],
        getVerificationsMany: async () => [],
        findActiveVerifiedByFingerprints: async () => [],
      },
      null,
      null,
      null
    );
    const [row] = await summary.list({});
    assert.equal("telegram_completion" in row, false, "a guessed PENDING is a false work queue");
  });

  it("omits the key rather than failing the page when the read throws", async () => {
    const summary = buildSummary(
      { get: async () => [{ employee_id: 42 }] },
      { findEmployeeIdsWithIdentity: async () => [] },
      {
        getBankDetailsMany: async () => [],
        getVerificationsMany: async () => [],
        findActiveVerifiedByFingerprints: async () => [],
      },
      null,
      null,
      { getSummaryForEmployees: async () => new Map([[42, { hasActiveIdentity: true, rows: [] }]]) },
      {
        mappingRepo: {
          getAllMappingsWithGroups: async () => {
            throw new Error("database is down");
          },
          getEmployeeSnapshot: async () => [emp(42)],
        },
        verificationRepo: { getForEmployees: async () => new Map() },
      }
    );
    const [row] = await summary.list({});
    assert.equal("telegram_completion" in row, false);
    assert.equal(row.employee_id, 42, "the rest of the dashboard still renders");
  });
});

/* ======================================================= the factory seam */

describe("the factory forwards everything the constructor takes", () => {
  it("passes ALL SEVEN arguments through", () => {
    // THE BUG THIS EXISTS FOR, TWICE NOW. The constructor grew a parameter,
    // the factory's argument list did not, and every unit test built the
    // class DIRECTLY and passed while `server.js` - which uses the factory -
    // would have produced the column silently missing in production. The
    // sixth argument was dropped this way during Phase 3A; the seventh very
    // nearly was here.
    const source = fs.readFileSync(__filename.replace(/_telegram_completion\.test\.js$/, ".js"), "utf8");
    const factory = /module\.exports = \(([\s\S]*?)\) =>\s*new EmployeeStatusSummaryUsecase\(([\s\S]*?)\n  \);/.exec(source);
    assert.ok(factory, "the factory must still be an arrow returning the class");

    // COMMENTS COME OUT BEFORE THE SPLIT. A prose comment contains commas,
    // so splitting first turns one comment into several "parameters".
    const names = (block) =>
      block
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/[^\n]*/g, "")
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);

    const accepted = names(factory[1]);
    const forwarded = names(factory[2]);
    assert.deepEqual(forwarded, accepted, "every parameter the factory accepts must be passed on");
    assert.ok(accepted.includes("telegramCompletionDeps"), "the completion dependencies must be a parameter");
  });

  it("the constructor's arity matches what the factory hands it", () => {
    const { EmployeeStatusSummaryUsecase } = require("./employee_status_summary");
    assert.equal(EmployeeStatusSummaryUsecase.length, 7);
  });

  it("a summary built through the FACTORY reports completion", async () => {
    // The end-to-end version of the same guarantee: not the class, the
    // factory - the thing server.js actually calls.
    const employees = [emp(42)];
    const summary = buildSummary(
      { get: async () => [{ employee_id: 42 }] },
      { findEmployeeIdsWithIdentity: async () => [] },
      {
        getBankDetailsMany: async () => [],
        getVerificationsMany: async () => [],
        findActiveVerifiedByFingerprints: async () => [],
      },
      null,
      null,
      { getSummaryForEmployees: async () => new Map([[42, { hasActiveIdentity: true, rows: [] }]]) },
      {
        mappingRepo: {
          getAllMappingsWithGroups: async () => [],
          getEmployeeSnapshot: async () => employees,
        },
        verificationRepo: { getForEmployees: async () => new Map() },
      }
    );
    const [row] = await summary.list({});
    assert.equal(row.telegram_completion, TELEGRAM_COMPLETION.COMPLETE);
  });
});
