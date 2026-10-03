/**
 * THE "PAYSLIP AVAILABLE" NOTIFICATION WORKER.
 *
 *   node --test usecase/payslip_notification.test.js
 *
 * The outbox is in memory here and implements the repository's contract
 * (claim = atomic QUEUED -> SENDING under a token; complete only by the
 * claiming token; recover stale SENDING -> FAILED / INTERRUPTED). The SQL of
 * that contract is proven in repository/payrun_payslip.mysql.test.js.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const buildNotifier = require("./payslip_notification");

function outbox() {
  const rows = [];
  let clock = 0;
  return {
    rows,
    tick: (s) => { clock += s; },
    queue: (r) => rows.push({ notification_id: rows.length + 1, result: "QUEUED", deliverable: 1, period_year: 2026, period_month: 9, attempt_no: 1, trigger_type: "PUBLISH", ...r }),
    claimQueued: async ({ limit, token }) => {
      const picked = rows.filter((r) => r.result === "QUEUED").slice(0, limit);
      picked.forEach((r) => Object.assign(r, { result: "SENDING", claim_token: token, attempted_at: clock }));
      return picked.map((r) => ({ ...r }));
    },
    completeNotification: async ({ notification_id, claim_token, ...outcome }) => {
      const r = rows.find((x) => x.notification_id === notification_id && x.claim_token === claim_token && x.result === "SENDING");
      if (!r) return false;
      Object.assign(r, outcome);
      return true;
    },
    recoverInterrupted: async ({ olderThanSeconds }) => {
      let n = 0;
      rows.filter((r) => r.result === "SENDING" && clock - r.attempted_at > olderThanSeconds).forEach((r) => {
        Object.assign(r, { result: "FAILED", failure_code: "INTERRUPTED" });
        n += 1;
      });
      return n;
    },
  };
}

const LINKS = new Map([
  [101, { employee_telegram_id: 5, employee_id: 101, private_chat_id: 777101 }],
  [102, { employee_telegram_id: 6, employee_id: 102, private_chat_id: 777102 }],
]);

function harness({ sendImpl = null, lookupThrows = false, concurrency } = {}) {
  const repo = outbox();
  const sent = [];
  const notifier = buildNotifier({
    payslipRepo: repo,
    identityRepo: {
      getActiveIdentityByEmployee: async (id) => {
        if (lookupThrows) throw new Error("db down");
        return LINKS.get(id) || null;
      },
    },
    telegram: {
      sendMessage: sendImpl || (async (chatId, text, options) => {
        sent.push({ chatId, text, options });
        return { code: 200, message_id: 555 };
      }),
    },
    getMiniAppUrl: () => "https://dnds.example/telegram/attendance",
    timeoutMs: 50,
    intervalMs: 0,
    ...(concurrency ? { concurrency } : {}),
  });
  return { notifier, repo, sent };
}

describe("a queued notification is sent by the worker", () => {
  it("to the employee's OWN active private chat, resolved on the server; recorded SENT with the message id", async () => {
    const { notifier, repo, sent } = harness();
    repo.queue({ payslip_id: 11, employee_id: 101 });
    await notifier.processQueue();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].chatId, 777101);
    assert.deepEqual(
      [repo.rows[0].result, repo.rows[0].telegram_message_id, repo.rows[0].employee_telegram_id, repo.rows[0].private_chat_id],
      ["SENT", 555, 5, 777101]
    );
  });

  it("the text is the availability sentence only - the month and no salary figure; one My Payslips button", async () => {
    const { notifier, repo, sent } = harness();
    repo.queue({ payslip_id: 11, employee_id: 101 });
    await notifier.processQueue();
    assert.equal(sent[0].text, "Your payslip for September 2026 is now available in My Payslips.");
    assert.ok(!/₹|\d+\.\d{2}/.test(sent[0].text));
    assert.equal(sent[0].options.parseMode, null);
    const rows = sent[0].options.replyMarkup.inlineKeyboard;
    assert.equal(rows.length, 1);
    assert.equal(rows[0][0].web_app.url, "https://dnds.example/telegram/attendance?section=payslips");
  });
});

describe("outcomes that are not SENT never touch publication", () => {
  it("no Telegram link -> NO_TELEGRAM_LINK, nothing sent", async () => {
    const { notifier, repo, sent } = harness();
    repo.queue({ payslip_id: 12, employee_id: 999 });
    await notifier.processQueue();
    assert.equal(sent.length, 0);
    assert.equal(repo.rows[0].result, "NO_TELEGRAM_LINK");
  });

  it("Telegram refuses -> FAILED with a short code and Telegram's description", async () => {
    const { notifier, repo } = harness({
      sendImpl: async () => {
        const err = new Error("Request failed");
        err.response = { status: 403, data: { error_code: 403, description: "Forbidden: bot was blocked by the user" } };
        throw err;
      },
    });
    repo.queue({ payslip_id: 11, employee_id: 101 });
    await notifier.processQueue();
    assert.deepEqual([repo.rows[0].result, repo.rows[0].failure_code, repo.rows[0].failure_reason],
      ["FAILED", "TELEGRAM_403", "Forbidden: bot was blocked by the user"]);
  });

  it("a hanging send is cut off at the timeout (FAILED / TIMEOUT)", async () => {
    const { notifier, repo } = harness({ sendImpl: () => new Promise(() => {}) });
    repo.queue({ payslip_id: 11, employee_id: 101 });
    await notifier.processQueue();
    assert.deepEqual([repo.rows[0].result, repo.rows[0].failure_code], ["FAILED", "TIMEOUT"]);
  });

  it("an identity lookup failure is FAILED, not a crash", async () => {
    const { notifier, repo } = harness({ lookupThrows: true });
    repo.queue({ payslip_id: 11, employee_id: 101 });
    await notifier.processQueue();
    assert.equal(repo.rows[0].failure_code, "IDENTITY_LOOKUP_FAILED");
  });

  it("a payslip unpublished before its turn is NOT announced", async () => {
    const { notifier, repo, sent } = harness();
    repo.queue({ payslip_id: 11, employee_id: 101, deliverable: 0 });
    await notifier.processQueue();
    assert.equal(sent.length, 0);
    assert.deepEqual([repo.rows[0].result, repo.rows[0].failure_code], ["FAILED", "PAYSLIP_NOT_PUBLISHED"]);
  });
});

describe("the worker", () => {
  it("kick() returns at once - the caller never waits on Telegram", async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const { notifier, repo, sent } = harness({ sendImpl: async (chatId) => { await gate; sent.push(chatId); return { message_id: 1 }; } });
    repo.queue({ payslip_id: 11, employee_id: 101 });
    const before = Date.now();
    assert.equal(notifier.kick(), undefined);
    assert.ok(Date.now() - before < 20);
    assert.equal(repo.rows[0].result, "QUEUED");
    await new Promise((r) => setImmediate(r));
    assert.equal(repo.rows[0].result, "SENDING");
    release();
    await notifier.processQueue();
    assert.equal(repo.rows[0].result, "SENT");
  });

  it("bounded concurrency: never more than the limit at once, and a slow send holds up only itself", async () => {
    let running = 0;
    let peak = 0;
    const { notifier, repo } = harness({
      concurrency: 3,
      sendImpl: async () => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 10));
        running -= 1;
        return { message_id: 1 };
      },
    });
    for (let i = 0; i < 12; i += 1) repo.queue({ payslip_id: 100 + i, employee_id: 101 });
    await notifier.processQueue();
    assert.equal(peak, 3);
    assert.ok(repo.rows.every((r) => r.result === "SENT"));
  });

  it("NO DUPLICATE SENDS: overlapping passes never send one attempt twice", async () => {
    const counts = new Map();
    const { notifier, repo } = harness({
      sendImpl: async (chatId) => {
        counts.set(chatId, (counts.get(chatId) || 0) + 1);
        await new Promise((r) => setTimeout(r, 5));
        return { message_id: 1 };
      },
    });
    repo.queue({ payslip_id: 11, employee_id: 101 });
    repo.queue({ payslip_id: 12, employee_id: 102 });
    await Promise.all([notifier.processQueue(), notifier.processQueue(), notifier.processQueue()]);
    assert.deepEqual([...counts.values()], [1, 1]);
  });

  it("AFTER A RESTART: QUEUED rows are sent; a stale SENDING row is closed INTERRUPTED and NOT re-sent", async () => {
    const { notifier, repo, sent } = harness();
    repo.queue({ payslip_id: 11, employee_id: 101 });
    repo.queue({ payslip_id: 12, employee_id: 102, result: "SENDING", claim_token: "dead-process", attempted_at: 0 });
    repo.tick(600);
    await notifier.processQueue();
    assert.deepEqual(repo.rows.map((r) => [r.payslip_id, r.result, r.failure_code || null]), [
      [11, "SENT", null],
      [12, "FAILED", "INTERRUPTED"],
    ]);
    assert.deepEqual(sent.map((s) => s.chatId), [777101]);
  });

  it("a recent SENDING row (another live pass) is left alone", async () => {
    const { notifier, repo, sent } = harness();
    repo.queue({ payslip_id: 12, employee_id: 102, result: "SENDING", claim_token: "live", attempted_at: 0 });
    repo.tick(5);
    await notifier.processQueue();
    assert.equal(repo.rows[0].result, "SENDING");
    assert.equal(sent.length, 0);
  });

  it("the worker has no way to be handed a chat id", () => {
    const src = require("fs").readFileSync(require.resolve("./payslip_notification"), "utf8");
    assert.ok(!/claimQueued\(\{[^}]*chat/.test(src));
    assert.match(src, /identityRepo\.getActiveIdentityByEmployee\(row\.employee_id\)/);
  });
});
