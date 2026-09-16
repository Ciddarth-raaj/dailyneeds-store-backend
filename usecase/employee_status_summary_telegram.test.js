/**
 * TELEGRAM ON THE ONBOARDING DASHBOARD - the status-summary extension.
 *
 *   node --test usecase/employee_status_summary_telegram.test.js
 *
 * THE TWO PROPERTIES THIS FILE EXISTS FOR:
 *
 *   PARITY. The dashboard badge and the employee's own Telegram screen are
 *   produced by two different reads - two bulk queries versus two indexed
 *   lookups - and must never disagree. `deriveTelegramStatus` is the single
 *   decision both apply, and the parity suite below drives BOTH paths over
 *   the same scenarios and asserts the same answer.
 *
 *   BOUNDEDNESS. The whole reason this is not one Telegram request per
 *   employee. The query count is asserted against the headcount: 600
 *   employees must cost exactly what 2 cost.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const buildSummary = require("./employee_status_summary");
const buildLinkUsecase = require("./employee_telegram_link");
const { TELEGRAM_STATUS, PENDING_OUTCOME } = require("../constants/employee_telegram");

const IN_AN_HOUR = () => new Date(Date.now() + 60 * 60 * 1000);
const AN_HOUR_AGO = () => new Date(Date.now() - 60 * 60 * 1000);

/**
 * The employee list and the four other reads, stubbed to their emptiest
 * honest answers - this file is about the Telegram key and nothing else.
 */
function build({ employees = [], telegram = undefined }) {
  const queries = { telegram: 0 };
  const employeeUsecase = { get: async () => employees.map((id) => ({ employee_id: id })) };
  // Exactly the method names the usecase calls - a stub that guesses them
  // would pass while the real read was broken.
  const aadhaarRepo = { findEmployeeIdsWithIdentity: async () => [] };
  const bankRepo = {
    getBankDetailsMany: async () => [],
    getVerificationsMany: async () => [],
    findActiveVerifiedByFingerprints: async () => [],
  };

  const telegramRepo =
    telegram === undefined
      ? undefined
      : {
          // The REAL bulk shape: a Map of facts, never a status.
          async getSummaryForEmployees(ids) {
            queries.telegram += 1;
            const out = new Map();
            for (const id of ids) {
              const row = telegram[id] || {};
              out.set(Number(id), {
                hasActiveIdentity: Boolean(row.identity),
                latest: row.latest === undefined ? null : row.latest,
                latestIsLive: Boolean(row.latestIsLive),
              });
            }
            return out;
          },
        };

  return {
    usecase: buildSummary(employeeUsecase, aadhaarRepo, bankRepo, undefined, undefined, telegramRepo),
    queries,
  };
}

const byId = (rows) => Object.fromEntries(rows.map((r) => [r.employee_id, r]));

/* ------------------------------------------------------------- the states */

describe("the Telegram status of each row", () => {
  it("NO TELEGRAM ROWS AT ALL IS PENDING - which is every employee today", async () => {
    const { usecase } = build({ employees: [1], telegram: {} });
    const rows = byId(await usecase.list({}));
    assert.equal(rows[1].telegram_status, TELEGRAM_STATUS.PENDING);
    assert.equal(rows[1].telegram_connected, false);
  });

  it("an active identity is CONNECTED", async () => {
    const { usecase } = build({ employees: [1], telegram: { 1: { identity: true } } });
    const rows = byId(await usecase.list({}));
    assert.equal(rows[1].telegram_status, TELEGRAM_STATUS.CONNECTED);
    assert.equal(rows[1].telegram_connected, true);
  });

  it("a live pending session is AWAITING_CONTACT", async () => {
    const { usecase } = build({
      employees: [1],
      telegram: { 1: { latest: { pending_outcome: null }, latestIsLive: true } },
    });
    const rows = byId(await usecase.list({}));
    assert.equal(rows[1].telegram_status, TELEGRAM_STATUS.AWAITING_CONTACT);
    assert.equal(rows[1].telegram_connected, false);
  });

  it("AN EXPIRED PENDING SESSION IS NOT 'Awaiting' - it is PENDING again", async () => {
    const { usecase } = build({
      employees: [1],
      telegram: { 1: { latest: { pending_outcome: null }, latestIsLive: false } },
    });
    const rows = byId(await usecase.list({}));
    assert.equal(rows[1].telegram_status, TELEGRAM_STATUS.PENDING);
  });

  it("a mismatch on the latest attempt is MOBILE_MISMATCH", async () => {
    const { usecase } = build({
      employees: [1],
      telegram: { 1: { latest: { pending_outcome: PENDING_OUTCOME.MOBILE_MISMATCH } } },
    });
    const rows = byId(await usecase.list({}));
    assert.equal(rows[1].telegram_status, TELEGRAM_STATUS.MOBILE_MISMATCH);
  });

  it("AN ACTIVE IDENTITY BEATS AN OLD MISMATCH - somebody verified since", async () => {
    const { usecase } = build({
      employees: [1],
      telegram: {
        1: { identity: true, latest: { pending_outcome: PENDING_OUTCOME.MOBILE_MISMATCH } },
      },
    });
    const rows = byId(await usecase.list({}));
    assert.equal(rows[1].telegram_status, TELEGRAM_STATUS.CONNECTED);
  });

  it("a superseded attempt is PENDING, not a mismatch", async () => {
    const { usecase } = build({
      employees: [1],
      telegram: { 1: { latest: { pending_outcome: PENDING_OUTCOME.SUPERSEDED } } },
    });
    const rows = byId(await usecase.list({}));
    assert.equal(rows[1].telegram_status, TELEGRAM_STATUS.PENDING);
  });

  it("answers every employee in the list, each on its own facts", async () => {
    const { usecase } = build({
      employees: [1, 2, 3, 4],
      telegram: {
        1: { identity: true },
        2: { latest: { pending_outcome: null }, latestIsLive: true },
        3: { latest: { pending_outcome: PENDING_OUTCOME.MOBILE_MISMATCH } },
      },
    });
    const rows = byId(await usecase.list({}));
    assert.equal(rows[1].telegram_status, TELEGRAM_STATUS.CONNECTED);
    assert.equal(rows[2].telegram_status, TELEGRAM_STATUS.AWAITING_CONTACT);
    assert.equal(rows[3].telegram_status, TELEGRAM_STATUS.MOBILE_MISMATCH);
    assert.equal(rows[4].telegram_status, TELEGRAM_STATUS.PENDING);
  });
});

/* -------------------------------------------------------------- bounded */

describe("it is bounded", () => {
  it("ONE TELEGRAM READ FOR THE WHOLE LIST, whatever the headcount", async () => {
    const many = Array.from({ length: 600 }, (_, i) => i + 1);
    const { usecase, queries } = build({ employees: many, telegram: {} });

    const rows = await usecase.list({});

    assert.equal(rows.length, 600);
    assert.equal(queries.telegram, 1, "600 employees must cost exactly what 2 cost");
  });

  it("asks for nothing at all when the list is empty", async () => {
    const { usecase, queries } = build({ employees: [], telegram: {} });
    assert.deepEqual(await usecase.list({}), []);
    assert.equal(queries.telegram, 0);
  });
});

/* ------------------------------------------------------------- omission */

describe("when it cannot answer, it says nothing", () => {
  it("OMITS the keys where the repository is not wired - it does not guess Pending", async () => {
    // A `PENDING` this endpoint did not establish would put every employee on
    // a work queue for a reason that was really "not configured".
    const { usecase } = build({ employees: [1], telegram: undefined });
    const rows = byId(await usecase.list({}));
    assert.ok(!("telegram_status" in rows[1]));
    assert.ok(!("telegram_connected" in rows[1]));
  });

  it("omits them when the bulk read FAILS, rather than reporting everyone Pending", async () => {
    const { usecase } = build({ employees: [1], telegram: {} });
    usecase.telegramRepo.getSummaryForEmployees = async () => {
      throw new Error("mysql is down");
    };
    const rows = byId(await usecase.list({}));
    assert.ok(!("telegram_status" in rows[1]));
    // And the rest of the summary still answers.
    assert.equal(rows[1].aadhaar_status, "PENDING");
  });
});

/* ------------------------------------------------------------- nothing leaks */

describe("what the row carries", () => {
  it("carries a status and a boolean, and NO identifier of any kind", async () => {
    const { usecase } = build({ employees: [1], telegram: { 1: { identity: true } } });
    const rows = await usecase.list({});
    const dumped = JSON.stringify(rows);

    for (const forbidden of [
      "telegram_user_id",
      "chat_id",
      "private_chat",
      "token",
      "hash",
      "mobile",
      "phone",
      "username",
      "verified_mobile",
    ]) {
      assert.ok(!dumped.includes(forbidden), `${forbidden} must never reach the dashboard`);
    }
    assert.deepEqual(
      Object.keys(rows[0]).filter((k) => k.startsWith("telegram")),
      ["telegram_status", "telegram_connected"]
    );
  });

  it("DOES NOT CHANGE hr_onboarding_pending - Telegram is tracked, not gating", async () => {
    // Group membership does not exist yet, so folding Telegram into HR
    // completion would mark all 630 employees incomplete for a feature that
    // has not shipped.
    const connected = build({ employees: [1], telegram: { 1: { identity: true } } });
    const pending = build({ employees: [1], telegram: {} });
    const a = byId(await connected.usecase.list({}))[1];
    const b = byId(await pending.usecase.list({}))[1];
    assert.equal(a.hr_onboarding_pending, b.hr_onboarding_pending);
  });

  it("does not change the population - it annotates the rows it was given", async () => {
    // The employee list is `employeeUsecase.get`, exactly as before, so a
    // resigned employee cannot be pulled into the dashboard by having no
    // Telegram row.
    const { usecase } = build({ employees: [1, 2], telegram: {} });
    const rows = await usecase.list({});
    assert.deepEqual(rows.map((r) => r.employee_id), [1, 2]);
  });
});

/* --------------------------------------------------------------- parity */

describe("PARITY with the employee's own Telegram screen", () => {
  /**
   * The same scenarios through BOTH paths. The dashboard reads facts in bulk
   * and the screen reads two rows; if the precedence ever forks, one of these
   * pairs stops matching.
   */
  const SCENARIOS = [
    {
      name: "nothing at all",
      identity: null,
      latestRow: null,
      facts: { latest: undefined },
      expected: TELEGRAM_STATUS.PENDING,
    },
    {
      name: "connected",
      identity: { employee_telegram_id: 1, telegram_username: "a", connected_at: new Date() },
      latestRow: null,
      facts: { identity: true },
      expected: TELEGRAM_STATUS.CONNECTED,
    },
    {
      name: "live pending session",
      identity: null,
      latestRow: { pending_outcome: null, pending_expires_at: IN_AN_HOUR() },
      facts: { latest: { pending_outcome: null }, latestIsLive: true },
      expected: TELEGRAM_STATUS.AWAITING_CONTACT,
    },
    {
      name: "expired pending session",
      identity: null,
      latestRow: { pending_outcome: null, pending_expires_at: AN_HOUR_AGO() },
      facts: { latest: { pending_outcome: null }, latestIsLive: false },
      expected: TELEGRAM_STATUS.PENDING,
    },
    {
      name: "mismatch",
      identity: null,
      latestRow: { pending_outcome: PENDING_OUTCOME.MOBILE_MISMATCH, pending_expires_at: null },
      facts: { latest: { pending_outcome: PENDING_OUTCOME.MOBILE_MISMATCH } },
      expected: TELEGRAM_STATUS.MOBILE_MISMATCH,
    },
    {
      name: "superseded",
      identity: null,
      latestRow: { pending_outcome: PENDING_OUTCOME.SUPERSEDED, pending_expires_at: null },
      facts: { latest: { pending_outcome: PENDING_OUTCOME.SUPERSEDED } },
      expected: TELEGRAM_STATUS.PENDING,
    },
    {
      name: "connected after an earlier mismatch",
      identity: { employee_telegram_id: 2, telegram_username: null, connected_at: new Date() },
      latestRow: { pending_outcome: PENDING_OUTCOME.MOBILE_MISMATCH, pending_expires_at: null },
      facts: { identity: true, latest: { pending_outcome: PENDING_OUTCOME.MOBILE_MISMATCH } },
      expected: TELEGRAM_STATUS.CONNECTED,
    },
  ];

  for (const scenario of SCENARIOS) {
    it(`${scenario.name}: both paths answer ${scenario.expected}`, async () => {
      // The single-employee path, as the employee's own screen calls it.
      const linkUsecase = buildLinkUsecase(
        {
          getActiveIdentityByEmployee: async () => scenario.identity,
          getLatestPendingForEmployee: async () => scenario.latestRow,
        },
        { getBotUsername: async () => "dnds_bot" }
      );
      const screen = (await linkUsecase.getStatus(7)).data;

      // The dashboard path, over the same facts.
      const { usecase } = build({ employees: [7], telegram: { 7: scenario.facts } });
      const row = byId(await usecase.list({}))[7];

      assert.equal(screen.status, scenario.expected, "the employee's own screen");
      assert.equal(row.telegram_status, scenario.expected, "the dashboard row");
      assert.equal(row.telegram_status, screen.status, "and they agree");
      assert.equal(row.telegram_connected, screen.connected);
    });
  }
});
