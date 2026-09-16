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
                rows: row.rows || [],
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
      telegram: { 1: { rows: [{ token_hash: "a", pending_outcome: null, is_live: 1 }] } },
    });
    const rows = byId(await usecase.list({}));
    assert.equal(rows[1].telegram_status, TELEGRAM_STATUS.AWAITING_CONTACT);
    assert.equal(rows[1].telegram_connected, false);
  });

  it("AN EXPIRED PENDING SESSION IS NOT 'Awaiting' - it is PENDING again", async () => {
    const { usecase } = build({
      employees: [1],
      telegram: { 1: { rows: [{ token_hash: "a", pending_outcome: null, is_live: 0 }] } },
    });
    const rows = byId(await usecase.list({}));
    assert.equal(rows[1].telegram_status, TELEGRAM_STATUS.PENDING);
  });

  it("a mismatch on the latest attempt is MOBILE_MISMATCH", async () => {
    const { usecase } = build({
      employees: [1],
      telegram: { 1: { rows: [{ token_hash: "a", pending_outcome: PENDING_OUTCOME.MOBILE_MISMATCH }] } },
    });
    const rows = byId(await usecase.list({}));
    assert.equal(rows[1].telegram_status, TELEGRAM_STATUS.MOBILE_MISMATCH);
  });

  it("AN ACTIVE IDENTITY BEATS AN OLD MISMATCH - somebody verified since", async () => {
    const { usecase } = build({
      employees: [1],
      telegram: {
        1: { identity: true, rows: [{ token_hash: "a", pending_outcome: PENDING_OUTCOME.MOBILE_MISMATCH }] },
      },
    });
    const rows = byId(await usecase.list({}));
    assert.equal(rows[1].telegram_status, TELEGRAM_STATUS.CONNECTED);
  });

  it("a superseded attempt is PENDING, not a mismatch", async () => {
    const { usecase } = build({
      employees: [1],
      telegram: { 1: { rows: [{ token_hash: "a", pending_outcome: PENDING_OUTCOME.SUPERSEDED }] } },
    });
    const rows = byId(await usecase.list({}));
    assert.equal(rows[1].telegram_status, TELEGRAM_STATUS.PENDING);
  });

  it("answers every employee in the list, each on its own facts", async () => {
    const { usecase } = build({
      employees: [1, 2, 3, 4],
      telegram: {
        1: { identity: true },
        2: { rows: [{ token_hash: "b", pending_outcome: null, is_live: 1 }] },
        3: { rows: [{ token_hash: "c", pending_outcome: PENDING_OUTCOME.MOBILE_MISMATCH }] },
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
      rows: [],
      facts: { rows: [] },
      expected: TELEGRAM_STATUS.PENDING,
    },
    {
      name: "connected",
      identity: { employee_telegram_id: 1, telegram_username: "a", connected_at: new Date() },
      rows: [],
      facts: { identity: true, rows: [] },
      expected: TELEGRAM_STATUS.CONNECTED,
    },
    {
      name: "live pending session",
      identity: null,
      rows: [{ token_hash: "a", pending_outcome: null, is_live: 1 }],
      facts: { rows: [{ token_hash: "a", pending_outcome: null, is_live: 1 }] },
      expected: TELEGRAM_STATUS.AWAITING_CONTACT,
    },
    {
      name: "expired pending session",
      identity: null,
      rows: [{ token_hash: "a", pending_outcome: null, is_live: 0 }],
      facts: { rows: [{ token_hash: "a", pending_outcome: null, is_live: 0 }] },
      expected: TELEGRAM_STATUS.PENDING,
    },
    {
      name: "mismatch",
      identity: null,
      rows: [{ token_hash: "a", pending_outcome: PENDING_OUTCOME.MOBILE_MISMATCH }],
      facts: { rows: [{ token_hash: "a", pending_outcome: PENDING_OUTCOME.MOBILE_MISMATCH }] },
      expected: TELEGRAM_STATUS.MOBILE_MISMATCH,
    },
    {
      name: "superseded",
      identity: null,
      rows: [{ token_hash: "a", pending_outcome: PENDING_OUTCOME.SUPERSEDED }],
      facts: { rows: [{ token_hash: "a", pending_outcome: PENDING_OUTCOME.SUPERSEDED }] },
      expected: TELEGRAM_STATUS.PENDING,
    },
    {
      name: "connected after an earlier mismatch",
      identity: { employee_telegram_id: 2, telegram_username: null, connected_at: new Date() },
      rows: [{ token_hash: "a", pending_outcome: PENDING_OUTCOME.MOBILE_MISMATCH }],
      facts: { identity: true, rows: [{ token_hash: "a", pending_outcome: PENDING_OUTCOME.MOBILE_MISMATCH }] },
      expected: TELEGRAM_STATUS.CONNECTED,
    },
  ];

  for (const scenario of SCENARIOS) {
    it(`${scenario.name}: both paths answer ${scenario.expected}`, async () => {
      // The single-employee path, as the employee's own screen calls it.
      const linkUsecase = buildLinkUsecase(
        {
          getActiveIdentityByEmployee: async () => scenario.identity,
          getCurrentAttemptRows: async () => scenario.rows,
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

/* ------------------------------------------------- same-second tie-breaks */

describe("TWO ATTEMPTS INSIDE ONE SECOND", () => {
  /**
   * `created_at` is a TIMESTAMP, so a fresh QR issued while an older attempt
   * is still on the row ties with it. `ORDER BY created_at DESC LIMIT 1` then
   * returns whichever the storage engine felt like - a manager would see a
   * mismatch that had already been superseded, or miss one that had not.
   *
   * The tie is broken by the LIFECYCLE, and these are the four cases that
   * decide it. Each is driven through BOTH paths, and in BOTH row orders, so
   * neither the answer nor the agreement can depend on SQL result order.
   */
  const CASES = [
    {
      name: "A: an old mismatch and a fresh, never-opened QR",
      rows: [
        { token_hash: "old", pending_outcome: PENDING_OUTCOME.MOBILE_MISMATCH },
        { token_hash: "new", pending_outcome: null, is_unconsumed: 1 },
      ],
      expected: TELEGRAM_STATUS.PENDING,
      why: "the fresh link replaced the mismatch - it is not still the answer",
    },
    {
      name: "B: a superseded attempt and a fresh live pending one",
      rows: [
        { token_hash: "old", pending_outcome: PENDING_OUTCOME.SUPERSEDED },
        { token_hash: "new", pending_outcome: null, is_live: 1 },
      ],
      expected: TELEGRAM_STATUS.AWAITING_CONTACT,
      why: "somebody is mid-flow right now",
    },
    {
      name: "C: a superseded attempt and a fresh one that ended in a mismatch",
      rows: [
        { token_hash: "old", pending_outcome: PENDING_OUTCOME.SUPERSEDED },
        { token_hash: "new", pending_outcome: PENDING_OUTCOME.MOBILE_MISMATCH },
      ],
      expected: TELEGRAM_STATUS.MOBILE_MISMATCH,
      why: "the conclusion is newer than the supersession, and needs a human",
    },
    {
      name: "D: an active identity and any tied token states at all",
      identity: true,
      rows: [
        { token_hash: "old", pending_outcome: PENDING_OUTCOME.MOBILE_MISMATCH },
        { token_hash: "new", pending_outcome: null, is_live: 1 },
      ],
      expected: TELEGRAM_STATUS.CONNECTED,
      why: "somebody verified - everything else is history",
    },
  ];

  for (const testCase of CASES) {
    it(`${testCase.name} -> ${testCase.expected} (${testCase.why})`, async () => {
      for (const rows of [testCase.rows, [...testCase.rows].reverse()]) {
        const facts = { identity: testCase.identity, rows };

        const { usecase } = build({ employees: [7], telegram: { 7: facts } });
        const row = byId(await usecase.list({}))[7];

        const linkUsecase = buildLinkUsecase(
          {
            getActiveIdentityByEmployee: async () =>
              testCase.identity ? { employee_telegram_id: 1, telegram_username: null, connected_at: new Date() } : null,
            getCurrentAttemptRows: async () => rows,
          },
          { getBotUsername: async () => "dnds_bot" }
        );
        const screen = (await linkUsecase.getStatus(7)).data;

        assert.equal(row.telegram_status, testCase.expected, "the dashboard");
        assert.equal(screen.status, testCase.expected, "the employee's own screen");
        assert.equal(row.telegram_status, screen.status, "and they agree, in either row order");
      }
    });
  }

  it("THE ANSWER DOES NOT DEPEND ON RESULT ORDER, for any tie at all", async () => {
    const outcomes = [
      null,
      PENDING_OUTCOME.SUPERSEDED,
      PENDING_OUTCOME.MOBILE_MISMATCH,
      PENDING_OUTCOME.VERIFIED,
    ];
    for (const a of outcomes) {
      for (const b of outcomes) {
        const rows = [
          { token_hash: "aaa", pending_outcome: a, is_live: a === null ? 1 : 0 },
          { token_hash: "bbb", pending_outcome: b, is_unconsumed: b === null ? 1 : 0 },
        ];
        const forward = build({ employees: [7], telegram: { 7: { rows } } });
        const reverse = build({ employees: [7], telegram: { 7: { rows: [...rows].reverse() } } });
        assert.equal(
          byId(await forward.usecase.list({}))[7].telegram_status,
          byId(await reverse.usecase.list({}))[7].telegram_status,
          `${a} vs ${b} must not depend on order`
        );
      }
    }
  });

  it("two rows that are semantically identical still answer deterministically", async () => {
    // Every lifecycle fact agrees, so only the stable token_hash tie-break is
    // left - which is exactly when an arbitrary one is acceptable.
    const rows = [
      { token_hash: "bbb", pending_outcome: PENDING_OUTCOME.MOBILE_MISMATCH },
      { token_hash: "aaa", pending_outcome: PENDING_OUTCOME.MOBILE_MISMATCH },
    ];
    const one = build({ employees: [7], telegram: { 7: { rows } } });
    const two = build({ employees: [7], telegram: { 7: { rows: [...rows].reverse() } } });
    assert.equal(
      byId(await one.usecase.list({}))[7].telegram_status,
      byId(await two.usecase.list({}))[7].telegram_status
    );
  });
});

/* --------------------------------------------------- the reconnect signal */

describe("link_attempt - the field the reconnect experience needs", () => {
  const statusFor = async (identity, rows) => {
    const linkUsecase = buildLinkUsecase(
      {
        getActiveIdentityByEmployee: async () =>
          identity ? { employee_telegram_id: 1, telegram_username: "a", connected_at: new Date() } : null,
        getCurrentAttemptRows: async () => rows,
      },
      { getBotUsername: async () => "dnds_bot" }
    );
    return (await linkUsecase.getStatus(7)).data;
  };

  it("A RECONNECT IN FLIGHT: still CONNECTED, but the attempt is AWAITING_CONTACT", async () => {
    // The old identity is deliberately kept until the new account verifies,
    // so `status` alone cannot tell a screen whether its QR has been dealt
    // with. Without this field the UI declares success the moment it generates
    // the QR.
    const data = await statusFor(true, [{ token_hash: "a", pending_outcome: null, is_live: 1 }]);
    assert.equal(data.status, TELEGRAM_STATUS.CONNECTED, "the employee is still reachable");
    assert.equal(data.link_attempt, "AWAITING_CONTACT", "and the new QR is still outstanding");
  });

  it("a finished reconnect reads VERIFIED", async () => {
    const data = await statusFor(true, [{ token_hash: "a", pending_outcome: PENDING_OUTCOME.VERIFIED }]);
    assert.equal(data.status, TELEGRAM_STATUS.CONNECTED);
    assert.equal(data.link_attempt, "VERIFIED");
  });

  it("a failed reconnect reads MOBILE_MISMATCH while the OLD identity stays connected", async () => {
    const data = await statusFor(true, [
      { token_hash: "a", pending_outcome: PENDING_OUTCOME.MOBILE_MISMATCH },
    ]);
    assert.equal(data.status, TELEGRAM_STATUS.CONNECTED, "the working connection survives");
    assert.equal(data.link_attempt, "MOBILE_MISMATCH", "and the attempt is reported as failed");
  });

  it("no attempt at all reads NONE", async () => {
    assert.equal((await statusFor(false, [])).link_attempt, "NONE");
    assert.equal((await statusFor(true, [])).link_attempt, "NONE");
  });

  it("an initial connection moves NONE -> AWAITING_CONTACT -> VERIFIED", async () => {
    assert.equal((await statusFor(false, [])).link_attempt, "NONE");
    assert.equal(
      (await statusFor(false, [{ token_hash: "a", pending_outcome: null, is_live: 1 }])).link_attempt,
      "AWAITING_CONTACT"
    );
    const done = await statusFor(true, [{ token_hash: "a", pending_outcome: PENDING_OUTCOME.VERIFIED }]);
    assert.equal(done.status, TELEGRAM_STATUS.CONNECTED);
    assert.equal(done.link_attempt, "VERIFIED");
  });

  it("IT CARRIES NO SECRET - it is one word about progress", async () => {
    const data = await statusFor(true, [{ token_hash: "supersecret", pending_outcome: null, is_live: 1 }]);
    const dumped = JSON.stringify(data);
    // VALUES, not key names: `mobile_verified` is a legitimate boolean saying
    // whether verification happened, and carries no number.
    assert.ok(!dumped.includes("supersecret"), "no token or hash value");
    assert.ok(!/\d{6,}/.test(dumped), "no run of digits that could be a mobile, user id or chat id");
    assert.equal(typeof data.link_attempt, "string");
    assert.ok(
      ["NONE", "PENDING", "AWAITING_CONTACT", "MOBILE_MISMATCH", "VERIFIED"].includes(data.link_attempt),
      "and it is one of five fixed words"
    );
  });
});
