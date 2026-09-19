/**
 * THE 06:00 MISSING ATTENDANCE ALERT.
 *
 *   node --test usecase/attendance_missing_telegram.test.js
 *
 * No MySQL and no Telegram. The candidate list is a stub, because WHO is
 * messaged is `usecase/attendance_missing.js`'s question and is tested there;
 * what is tested here is everything after that: addressing, the duplicate
 * guard, failure isolation, and that every outcome reaches the ledger.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const buildNotifier = require("../usecase/attendance_missing_telegram");

const TODAY = "2026-09-19";
const YESTERDAY = "2026-09-18";

const candidate = (employee_id, punch_count = 3) => ({
  employee_id,
  employee_name: `Employee ${employee_id}`,
  attendance_date: YESTERDAY,
  punch_count,
  status: "Missing Attendance",
});

/** The usecase, stubbed at the one method the notifier calls. */
const fakePopulation = (data) => ({
  getTelegramCandidates: async () => ({
    meta: { today: TODAY, effective_from_date: YESTERDAY, effective_to_date: YESTERDAY },
    data,
  }),
});

/**
 * The ledger, faked WITH ITS UNIQUE KEY - because the unique key IS the
 * duplicate guard, and a fake that let every claim succeed would test
 * nothing.
 */
function fakeRepo({ chats = [], alreadyClaimed = [] } = {}) {
  const claimed = new Set(alreadyClaimed.map((k) => String(k)));
  const settled = [];
  return {
    claimed,
    settled,
    getActiveTelegramChats: async (ids) =>
      chats.filter((c) => ids.includes(Number(c.employee_id))),
    claim: async ({ employee_id, attendance_date }) => {
      const key = `${employee_id}:${attendance_date}`;
      if (claimed.has(key)) return { claimed: false };
      claimed.add(key);
      return { claimed: true, insert_id: claimed.size };
    },
    settle: async (row) => {
      settled.push(row);
      return {};
    },
    releaseClaim: async () => ({}),
  };
}

function fakeTelegram({ failFor = [], configured = true } = {}) {
  const sent = [];
  return {
    sent,
    isConfigured: () => configured,
    sendMessage: async (chat_id, msg, options) => {
      sent.push({ chat_id, msg, options });
      if (failFor.includes(chat_id)) throw new Error("Forbidden: bot was blocked by the user");
      return { code: 200 };
    },
  };
}

const build = ({ data, chats, alreadyClaimed, failFor, configured, miniAppUrl = null }) => {
  const attendanceMissingRepo = fakeRepo({ chats, alreadyClaimed });
  const telegramService = fakeTelegram({ failFor, configured });
  const notifier = buildNotifier({
    attendanceMissingUsecase: fakePopulation(data),
    attendanceMissingRepo,
    telegramService,
    miniAppUrl,
    log: { info: () => {}, error: () => {} },
  });
  return { notifier, attendanceMissingRepo, telegramService };
};

describe("the message", () => {
  it("is the approved text, with the date and the real punch count", () => {
    assert.equal(
      buildNotifier.buildMessage({ attendance_date: YESTERDAY, punch_count: 3 }),
      [
        "Good morning.",
        "Your attendance for 18 Sep 2026 has a missing punch.",
        "Punches recorded: 3",
        "Please submit the required attendance correction.",
      ].join("\n")
    );
  });

  it("is sent as PLAIN TEXT, so no database value can break the whole batch", async () => {
    const { notifier, telegramService } = build({
      data: [candidate(42)],
      chats: [{ employee_id: 42, private_chat_id: 9001 }],
    });
    await notifier.run({ today: TODAY });
    assert.equal(telegramService.sent[0].options.parseMode, null);
  });

  it("goes to the employee's PRIVATE chat, never anywhere else", async () => {
    const { notifier, telegramService } = build({
      data: [candidate(42), candidate(43)],
      chats: [
        { employee_id: 42, private_chat_id: 9001 },
        { employee_id: 43, private_chat_id: 9002 },
      ],
    });
    await notifier.run({ today: TODAY });
    assert.deepEqual(telegramService.sent.map((s) => s.chat_id), [9001, 9002]);
  });
});

describe("the duplicate guard", () => {
  it("sends once, and a second run of the same date sends nothing", async () => {
    const { notifier, telegramService } = build({
      data: [candidate(42)],
      chats: [{ employee_id: 42, private_chat_id: 9001 }],
    });

    const first = await notifier.run({ today: TODAY });
    assert.deepEqual([first.sent, first.skipped, first.failed], [1, 0, 0]);

    const second = await notifier.run({ today: TODAY });
    assert.deepEqual([second.sent, second.skipped, second.failed], [0, 1, 0]);
    assert.equal(second.results[0].reason, "ALREADY_NOTIFIED");

    // ONE message, from two runs.
    assert.equal(telegramService.sent.length, 1);
  });

  it("a row already claimed by another process is skipped, not re-sent", async () => {
    const { notifier, telegramService } = build({
      data: [candidate(42)],
      chats: [{ employee_id: 42, private_chat_id: 9001 }],
      alreadyClaimed: [`42:${YESTERDAY}`],
    });
    const summary = await notifier.run({ today: TODAY });
    assert.equal(telegramService.sent.length, 0);
    assert.equal(summary.results[0].reason, "ALREADY_NOTIFIED");
  });

  it("claims BEFORE it sends, so a crash cannot turn into a second message", async () => {
    const { notifier, attendanceMissingRepo } = build({
      data: [candidate(42)],
      chats: [{ employee_id: 42, private_chat_id: 9001 }],
      failFor: [9001],
    });
    await notifier.run({ today: TODAY });
    // The claim survives a failed send: the row is FAILED, not released.
    assert.ok(attendanceMissingRepo.claimed.has(`42:${YESTERDAY}`));
    assert.equal(attendanceMissingRepo.settled[0].status, "FAILED");
  });
});

describe("failure isolation and the ledger", () => {
  it("one failed message does not stop the batch", async () => {
    const { notifier, telegramService } = build({
      data: [candidate(42), candidate(43), candidate(44)],
      chats: [
        { employee_id: 42, private_chat_id: 9001 },
        { employee_id: 43, private_chat_id: 9002 },
        { employee_id: 44, private_chat_id: 9003 },
      ],
      failFor: [9002],
    });

    const summary = await notifier.run({ today: TODAY });
    assert.deepEqual([summary.sent, summary.failed, summary.skipped], [2, 1, 0]);
    // The third employee was still attempted AFTER the second one threw.
    assert.deepEqual(telegramService.sent.map((s) => s.chat_id), [9001, 9002, 9003]);
  });

  it("records SENT, FAILED and SKIPPED with a short reason code", async () => {
    const { notifier, attendanceMissingRepo } = build({
      data: [candidate(42), candidate(43), candidate(44)],
      chats: [
        { employee_id: 42, private_chat_id: 9001 },
        { employee_id: 43, private_chat_id: 9002 },
      ],
      failFor: [9002],
    });

    const summary = await notifier.run({ today: TODAY });
    assert.deepEqual(
      summary.results.map((r) => [r.employee_id, r.outcome, r.reason]),
      [
        [42, "SENT", null],
        [43, "FAILED", "SEND_FAILED"],
        [44, "SKIPPED", "NO_TELEGRAM_IDENTITY"],
      ]
    );
    assert.deepEqual(
      attendanceMissingRepo.settled.map((s) => [s.employee_id, s.status, s.failure_reason || null]),
      [
        [42, "SENT", null],
        [43, "FAILED", "SEND_FAILED"],
        [44, "SKIPPED", "NO_TELEGRAM_IDENTITY"],
      ]
    );
  });

  it("never records the provider's error text - only a code this code produced", async () => {
    const { notifier, attendanceMissingRepo } = build({
      data: [candidate(42)],
      chats: [{ employee_id: 42, private_chat_id: 9001 }],
      failFor: [9001],
    });
    await notifier.run({ today: TODAY });
    assert.equal(attendanceMissingRepo.settled[0].failure_reason, "SEND_FAILED");
  });
});

describe("what it refuses to do", () => {
  it("does not invent a mapping for an employee who has not linked Telegram", async () => {
    const { notifier, telegramService } = build({ data: [candidate(42)], chats: [] });
    const summary = await notifier.run({ today: TODAY });
    assert.equal(telegramService.sent.length, 0);
    assert.equal(summary.results[0].reason, "NO_TELEGRAM_IDENTITY");
  });

  it("never sends for a zero or even punch count, even if one reached it", async () => {
    const { notifier, telegramService } = build({
      data: [candidate(42, 0), candidate(43, 4)],
      chats: [
        { employee_id: 42, private_chat_id: 9001 },
        { employee_id: 43, private_chat_id: 9002 },
      ],
    });
    const summary = await notifier.run({ today: TODAY });
    assert.equal(telegramService.sent.length, 0);
    assert.deepEqual(summary.results.map((r) => r.reason), ["NOT_ODD_PUNCH_COUNT", "NOT_ODD_PUNCH_COUNT"]);
  });

  it("claims NOTHING when the bot is not configured, so a later run can still send", async () => {
    const { notifier, attendanceMissingRepo } = build({
      data: [candidate(42)],
      chats: [{ employee_id: 42, private_chat_id: 9001 }],
      configured: false,
    });
    const summary = await notifier.run({ today: TODAY });
    assert.equal(summary.skipped, 1);
    assert.equal(summary.results[0].reason, "TELEGRAM_NOT_CONFIGURED");
    assert.equal(attendanceMissingRepo.claimed.size, 0);
  });
});

describe("Telegram Mini App readiness", () => {
  it("carries the employee/date handoff on every result", async () => {
    const { notifier } = build({
      data: [candidate(42, 5)],
      chats: [{ employee_id: 42, private_chat_id: 9001 }],
    });
    const summary = await notifier.run({ today: TODAY });
    assert.deepEqual(summary.results[0].correction_target, {
      employee_id: 42,
      attendance_date: YESTERDAY,
      punch_count: 5,
    });
  });

  it("attaches NO keyboard when no Mini App is configured - today's state", async () => {
    const { notifier, telegramService } = build({
      data: [candidate(42)],
      chats: [{ employee_id: 42, private_chat_id: 9001 }],
    });
    await notifier.run({ today: TODAY });
    assert.equal(telegramService.sent[0].options.replyMarkup, undefined);
  });

  it("attaches a Correct Attendance web_app button once a Mini App URL is configured", async () => {
    const { notifier, telegramService } = build({
      data: [candidate(42)],
      chats: [{ employee_id: 42, private_chat_id: 9001 }],
      miniAppUrl: "https://app.example.com/correct-attendance/",
    });
    await notifier.run({ today: TODAY });
    const button = telegramService.sent[0].options.replyMarkup.inlineKeyboard[0][0];
    assert.equal(button.text, "Correct Attendance");
    assert.equal(
      button.web_app.url,
      "https://app.example.com/correct-attendance?employee_id=42&attendance_date=2026-09-18"
    );
  });
});
