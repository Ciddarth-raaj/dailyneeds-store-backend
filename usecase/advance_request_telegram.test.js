const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const build = require("./advance_request_telegram");
const buildWorkflow = require("./advance_request");

const REQUEST = {
  advance_request_id: 42,
  status: "pending_approval",
  supplier_name: "SRI HOME CONSUMABLES PVT_LTD",
  invoice_number: "SO-37769",
  amount: "135869.00",
  outlet_name: "Warehouse",
  created_by_name: "Prashanth D",
  previous_advance_balance: "0.00",
};

const GROUPS = [
  { group_name: "Dn Urgent payments", chat_id: "-1004317755669", used_for: "Dn Urgent payments" },
  { group_name: "Pick Pack", chat_id: "-1001", used_for: "Pick Pack Daily Report" },
];

function harness({ canApprove = true, linked = true, approvalError = null, groups = GROUPS } = {}) {
  const sent = [];
  const answers = [];
  const edits = [];
  const decisions = [];
  const telegram = {
    isConfigured: () => true,
    sendMessage: async (chatId, text, options) => {
      sent.push({ chatId, text, options });
      return { code: 200, message_id: 900 };
    },
    answerCallbackQuery: async (id, text) => answers.push(text),
    editMessageReplyMarkup: async (chatId, messageId, markup) => edits.push({ chatId, messageId, markup }),
  };
  const usecase = build({
    telegram,
    webBaseUrl: "https://dnds.co.in/",
    registryRepo: { getAll: async (filter) => (assert.deepEqual(filter, { is_active: true }), groups) },
    employeeTelegramRepo: {
      getActiveIdentityByTelegramUser: async () => (linked ? { employee_id: 5 } : null),
    },
    advanceRequestRepo: {
      isEmployeeAdmin: async () => canApprove,
      getAll: async (filters) =>
        ({
          pending_approval: [{ ...REQUEST, advance_request_id: 2, created_at: "2026-11-20" }],
          on_hold: [{ ...REQUEST, advance_request_id: 1, status: "on_hold", created_at: "2026-11-10" }],
        })[filters.status] || [],
    },
    advanceRequestUsecase: {
      approval: async (id, data, employeeId) => {
        decisions.push({ id, data, employeeId });
        if (approvalError) {
          const err = new Error("stale");
          err.name = approvalError;
          throw err;
        }
        return {};
      },
    },
  });
  return { usecase, sent, answers, edits, decisions };
}

const tap = (data) => ({
  callback_query: {
    id: "q1",
    data,
    from: { id: 77, first_name: "Vijay" },
    message: { message_id: 900, chat: { id: -1004317755669 } },
  },
});

const reply = (promptText, text) => ({
  message: {
    text,
    from: { id: 77, first_name: "Vijay" },
    chat: { id: -1004317755669 },
    reply_to_message: { text: promptText },
  },
});

describe("advance request approval on Telegram", () => {
  it("posts ONE card to the Dn Urgent payments group, and only there", async () => {
    const h = harness();
    const result = await h.usecase.notifyApprovers(REQUEST);
    assert.equal(result.sent, 1);
    assert.equal(h.sent.length, 1);
    assert.equal(h.sent[0].chatId, "-1004317755669");
    assert.equal(h.sent[0].options.parseMode, null);
    assert.match(h.sent[0].text, /SRI HOME CONSUMABLES PVT_LTD/);
    assert.match(h.sent[0].text, /Rs\. 1,35,869\.00/);
    assert.match(h.sent[0].text, /Request #42/);
    const [row, view] = h.sent[0].options.replyMarkup.inline_keyboard;
    assert.deepEqual(row.map((b) => b.callback_data), ["ar:42:A", "ar:42:H", "ar:42:R"]);
    assert.equal(view[0].url, "https://dnds.co.in/advance-request/view/42");
  });

  it("also accepts a group whose Used For says Advance Request", async () => {
    const h = harness({ groups: [{ group_name: "x", chat_id: "-5", used_for: "advance  REQUEST approvals" }] });
    assert.equal((await h.usecase.notifyApprovers(REQUEST)).sent, 1);
  });

  it("sends nothing, and does not throw, when no group is registered", async () => {
    const h = harness({ groups: [] });
    assert.equal((await h.usecase.notifyApprovers(REQUEST)).reason, "NO_APPROVAL_GROUP");
    assert.equal(h.sent.length, 0);
  });

  it("Approve is one tap, through the web app's approval, and takes the buttons away", async () => {
    const h = harness();
    assert.equal(h.usecase.claims(tap("ar:42:A")), true);
    await h.usecase.handle(tap("ar:42:A"));
    assert.deepEqual(h.decisions, [{ id: 42, data: { decision: "approve", approval_note: null }, employeeId: 5 }]);
    assert.equal(h.edits.length, 1);
    assert.match(h.sent.at(-1).text, /approved by Vijay/);
  });

  it("refuses a group member who is not an admin, and records nothing", async () => {
    const h = harness({ canApprove: false });
    await h.usecase.handle(tap("ar:42:A"));
    assert.equal(h.decisions.length, 0);
    assert.match(h.answers[0], /Only an admin/);
  });

  it("refuses an unlinked Telegram account", async () => {
    const h = harness({ linked: false });
    await h.usecase.handle(tap("ar:42:R"));
    assert.equal(h.decisions.length, 0);
    assert.match(h.answers[0], /not linked/);
  });

  it("Reject asks for a reason first, and the reply decides", async () => {
    const h = harness();
    await h.usecase.handle(tap("ar:42:R"));
    assert.equal(h.decisions.length, 0);
    const prompt = h.sent.at(-1).text;
    assert.match(prompt, /^Reject advance request #42/);

    const update = reply(prompt, "Supplier already has 50k with us");
    assert.equal(h.usecase.claims(update), true);
    await h.usecase.handle(update);
    assert.deepEqual(h.decisions[0].data, { decision: "reject", approval_note: "Supplier already has 50k with us" });
    assert.match(h.sent.at(-1).text, /rejected by Vijay/);
  });

  it("a non-admin's reason reply decides nothing either", async () => {
    const h = harness({ canApprove: false });
    await h.usecase.handle(reply("Reject advance request #42\n\n...", "Supplier already paid"));
    assert.equal(h.decisions.length, 0);
    assert.match(h.sent.at(-1).text, /Only an admin/);
  });

  it("Hold asks for a reason too", async () => {
    const h = harness();
    await h.usecase.handle(tap("ar:42:H"));
    const prompt = h.sent.at(-1).text;
    await h.usecase.handle(reply(prompt, "Check with supplier"));
    assert.equal(h.decisions[0].data.decision, "hold");
  });

  it("a too-short reason decides nothing", async () => {
    const h = harness();
    await h.usecase.handle(reply("Reject advance request #42\n\n...", "no"));
    assert.equal(h.decisions.length, 0);
  });

  it("a stale button is answered as already actioned and retired", async () => {
    const h = harness({ approvalError: "ConflictError" });
    await h.usecase.handle(tap("ar:42:A"));
    assert.match(h.answers[0], /already been actioned/);
    assert.equal(h.edits.length, 1);
  });

  it("send pending posts a card for every request already waiting, oldest first", async () => {
    const h = harness();
    const result = await h.usecase.sendPending();
    assert.deepEqual(result, { requests: 2, sent: 2 });
    assert.equal(h.sent.length, 2);
    assert.match(h.sent[0].text, /ON HOLD/);
    assert.match(h.sent[0].text, /Request #1/);
    assert.match(h.sent[1].text, /approval needed/);
    assert.match(h.sent[1].text, /Request #2/);
  });

  it("send pending reports a missing group rather than sending nowhere", async () => {
    const h = harness({ groups: [] });
    assert.equal((await h.usecase.sendPending()).reason, "NO_APPROVAL_GROUP");
  });

  it("claims nothing that is not its own", () => {
    const h = harness();
    assert.equal(h.usecase.claims(tap("sc:42:A")), false);
    assert.equal(h.usecase.claims({ message: { text: "/start" } }), false);
    assert.equal(h.usecase.claims(reply("Reject shift request #4", "reason here")), false);
  });
});

describe("advance request workflow -> approval notifier", () => {
  const repoAt = (status) => {
    const state = { advance_request_id: 7, status };
    return {
      getById: async () => ({ ...state }),
      updateStage: async (id, expected, next, fields) => {
        if (state.status !== expected) return { affectedRows: 0 };
        Object.assign(state, fields, { status: next });
        return { affectedRows: 1 };
      },
      createActivity: async () => ({}),
      getDocumentsByRequestId: async () => [],
      getActivityByRequestId: async () => [],
    };
  };
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  it("notifies when accounts find no balance", async () => {
    const calls = [];
    const wf = buildWorkflow(repoAt("submitted"));
    wf.setApprovalNotifier({ notifyApprovers: async (r) => calls.push(r.status) });
    await wf.balanceCheck(7, { previous_advance_balance: 0 }, 1);
    await flush();
    assert.deepEqual(calls, ["pending_approval"]);
  });

  it("does NOT notify when a balance sends it back to purchase", async () => {
    const calls = [];
    const wf = buildWorkflow(repoAt("submitted"));
    wf.setApprovalNotifier({ notifyApprovers: async (r) => calls.push(r.status) });
    await wf.balanceCheck(7, { previous_advance_balance: 500 }, 1);
    await flush();
    assert.deepEqual(calls, []);
  });

  it("notifies when purchase decide the balance, and a notifier failure does not fail the stage", async () => {
    const wf = buildWorkflow(repoAt("pending_purchase_decision"));
    let called = false;
    wf.setApprovalNotifier({
      notifyApprovers: async () => {
        called = true;
        throw new Error("telegram down");
      },
    });
    const result = await wf.balanceAction(7, { balance_action: "defer" }, 1);
    await flush();
    assert.equal(result.status, "pending_approval");
    assert.equal(called, true);
  });
});
