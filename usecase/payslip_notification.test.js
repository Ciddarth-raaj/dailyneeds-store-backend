/**
 * THE "PAYSLIP AVAILABLE" TELEGRAM NOTIFICATION.
 *
 *   node --test usecase/payslip_notification.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const buildNotifier = require("./payslip_notification");

const SLIP = { payslip_id: 11, employee_id: 101, period_year: 2026, period_month: 9 };
const LINK = { employee_telegram_id: 5, employee_id: 101, telegram_user_id: 4242, private_chat_id: 777001 };

function harness({ link = LINK, sendImpl = null, lookupThrows = false } = {}) {
  const records = [];
  const sent = [];
  const notifier = buildNotifier({
    payslipRepo: {
      insertNotification: async (r) => {
        const attempt = records.filter((x) => x.payslip_id === r.payslip_id).length + 1;
        records.push({ ...r, attempt_no: attempt });
        return records.length;
      },
    },
    identityRepo: {
      getActiveIdentityByEmployee: async (id) => {
        if (lookupThrows) throw new Error("db down");
        return link && link.employee_id === id ? link : null;
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
  });
  return { notifier, records, sent };
}

describe("a successful notification", () => {
  it("goes to the employee's OWN active private chat, resolved on the server, and is tracked SENT with the message id", async () => {
    const { notifier, records, sent } = harness();
    const out = await notifier.notifyOne(SLIP, { trigger: "PUBLISH", actor: { employeeId: 77, userId: 7 } });
    assert.equal(out.result, "SENT");
    assert.equal(sent.length, 1);
    assert.equal(sent[0].chatId, 777001);
    assert.equal(records.length, 1);
    assert.deepEqual(
      [records[0].result, records[0].trigger_type, records[0].attempt_no, records[0].telegram_message_id,
        records[0].employee_telegram_id, records[0].private_chat_id, records[0].requested_by, records[0].requested_by_user],
      ["SENT", "PUBLISH", 1, 555, 5, 777001, 77, 7]
    );
    assert.ok(records[0].attempted_at instanceof Date);
  });

  it("the text is exactly the availability sentence: the month, and NO salary figure", async () => {
    const { notifier, sent } = harness();
    await notifier.notifyOne(SLIP);
    assert.equal(sent[0].text, "Your payslip for September 2026 is now available in My Payslips.");
    assert.ok(!/₹|rs\.?|net|pay\b|\d+\.\d{2}/i.test(sent[0].text.replace("payslip", "")));
    assert.equal(sent[0].options.parseMode, null, "plain text");
  });

  it("carries one button that opens My Payslips - no document, no amount, no employee id", async () => {
    const { notifier, sent } = harness();
    await notifier.notifyOne(SLIP);
    const rows = sent[0].options.replyMarkup.inlineKeyboard;
    assert.equal(rows.length, 1);
    assert.equal(rows[0][0].text, "Open My Payslips");
    assert.equal(rows[0][0].web_app.url, "https://dnds.example/telegram/attendance?section=payslips");
    assert.ok(!JSON.stringify(sent[0].options).includes("101"));
  });
});

describe("when the employee cannot be reached, the payslip is untouched and the outcome is recorded", () => {
  it("no Telegram link -> NO_TELEGRAM_LINK, nothing sent", async () => {
    const { notifier, records, sent } = harness({ link: null });
    const out = await notifier.notifyOne(SLIP);
    assert.equal(out.result, "NO_TELEGRAM_LINK");
    assert.equal(sent.length, 0);
    assert.equal(records[0].result, "NO_TELEGRAM_LINK");
    assert.equal(records[0].private_chat_id, null);
  });

  it("Telegram refuses -> FAILED with a short code and Telegram's description; never throws", async () => {
    const { notifier, records } = harness({
      sendImpl: async () => {
        const err = new Error("Request failed");
        err.response = { status: 403, data: { error_code: 403, description: "Forbidden: bot was blocked by the user" } };
        throw err;
      },
    });
    const out = await notifier.notifyOne(SLIP);
    assert.equal(out.result, "FAILED");
    assert.equal(records[0].failure_code, "TELEGRAM_403");
    assert.equal(records[0].failure_reason, "Forbidden: bot was blocked by the user");
  });

  it("a send that hangs is cut off at the timeout and recorded FAILED / TIMEOUT", async () => {
    const { notifier, records } = harness({ sendImpl: () => new Promise(() => {}) });
    const out = await notifier.notifyOne(SLIP);
    assert.equal(out.result, "FAILED");
    assert.equal(records[0].failure_code, "TIMEOUT");
  });

  it("the identity lookup failing is FAILED, not a crash", async () => {
    const { notifier, records } = harness({ lookupThrows: true });
    const out = await notifier.notifyOne(SLIP);
    assert.equal(out.result, "FAILED");
    assert.equal(records[0].failure_code, "IDENTITY_LOOKUP_FAILED");
  });
});

describe("retry and batches", () => {
  it("a retry is a NEW attempt row (attempt 2, trigger RETRY); the first stays as it was", async () => {
    let fail = true;
    const { notifier, records } = harness({
      sendImpl: async () => {
        if (fail) {
          fail = false;
          throw new Error("ETIMEDOUT");
        }
        return { code: 200, message_id: 9 };
      },
    });
    await notifier.notifyOne(SLIP, { trigger: "PUBLISH" });
    await notifier.notifyOne(SLIP, { trigger: "RETRY" });
    assert.deepEqual(records.map((r) => [r.attempt_no, r.trigger_type, r.result]), [
      [1, "PUBLISH", "FAILED"],
      [2, "RETRY", "SENT"],
    ]);
  });

  it("one failure in a batch does not stop the others; results stay in input order", async () => {
    const links = new Map([[1, { employee_telegram_id: 1, employee_id: 1, private_chat_id: 10 }], [2, { employee_telegram_id: 2, employee_id: 2, private_chat_id: 20 }]]);
    const records = [];
    const notifier = buildNotifier({
      payslipRepo: { insertNotification: async (r) => records.push(r) },
      identityRepo: { getActiveIdentityByEmployee: async (id) => links.get(id) || null },
      telegram: {
        sendMessage: async (chatId) => {
          if (chatId === 10) throw new Error("boom");
          return { message_id: 1 };
        },
      },
    });
    const out = await notifier.notifyMany([1, 2, 3].map((id) => ({ ...SLIP, payslip_id: id, employee_id: id })));
    assert.deepEqual(out.map((o) => o.result), ["FAILED", "SENT", "NO_TELEGRAM_LINK"]);
    assert.equal(records.length, 3);
  });

  it("a notifier has no way to be handed a chat id", () => {
    const src = require("fs").readFileSync(require.resolve("./payslip_notification"), "utf8");
    const notifyOneSig = src.match(/const notifyOne = async \(([^)]*)\)/)[1];
    assert.ok(!/chat/i.test(notifyOneSig));
  });
});
