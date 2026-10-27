/**
 * A REAL TAP, AS PRODUCTION RECEIVES IT.
 *
 *   node --test usecase/telegram_callback_camelcase.test.js
 *
 * `messaging-api-telegram` camelCases `getUpdates` deeply, so an Approve tap
 * arrives as `{ updateId, callbackQuery: { message: { messageId } } }`. The
 * dispatcher used to drop "callback_query" from every registration and the
 * handlers read snake_case only, so OT and shift buttons did nothing.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { camelcaseKeysDeep } = require("messaging-api-common");

const asReceived = (snake) => camelcaseKeysDeep(snake);

const wire = () => {
  const calls = { decide: [], answers: [], edits: [], sent: [] };
  const telegram = {
    isConfigured: () => true,
    answerCallbackQuery: async (id, text) => calls.answers.push({ id, text }),
    editMessageReplyMarkup: async (chatId, messageId) => calls.edits.push({ chatId, messageId }),
    sendMessage: async (chatId, text) => calls.sent.push({ chatId, text }) && { message_id: 9 },
  };
  const employeeTelegramRepo = {
    getActiveIdentityByTelegramUser: async (id) => (id === 777 ? { employee_id: 42 } : null),
  };
  const regularizationUsecase = {
    decide: async (args) => {
      calls.decide.push(args);
      return { status: "APPROVED", approved_ot_minutes: args.expected_ot_minutes, attendance_date: "2026-10-26" };
    },
    getRequest: async () => ({ status: "PENDING" }),
  };
  const ot = require("./attendance_ot_telegram")({ regularizationUsecase, employeeTelegramRepo, telegram });
  const shift = require("./attendance_shift_change_telegram")({ regularizationUsecase, employeeTelegramRepo, telegram });
  const dispatcher = require("./telegram_update_dispatcher")({ log: { Log: () => {}, LEVEL: {} } });
  dispatcher.register({ name: "attendance_shift_change", updateTypes: ["callback_query", "message"], claims: shift.claims, handle: shift.handle });
  dispatcher.register({ name: "attendance_ot_approval", updateTypes: ["callback_query", "message"], claims: ot.claims, handle: ot.handle });
  return { dispatcher, calls };
};

describe("an OT button tap through the dispatcher", () => {
  it("approves, answers the tap and retires the buttons", async () => {
    const { dispatcher, calls } = wire();
    const outcome = await dispatcher.dispatch(
      asReceived({
        update_id: 1,
        callback_query: {
          id: "cb1",
          data: "ot:1826:A:33",
          from: { id: 777, is_bot: false },
          message: { message_id: 55, chat: { id: 777, type: "private" } },
        },
      })
    );
    assert.equal(outcome.type, "callback_query");
    assert.equal(outcome.claimedBy, "attendance_ot_approval");
    assert.equal(calls.decide.length, 1);
    assert.equal(calls.decide[0].request_id, 1826);
    assert.equal(calls.decide[0].decision, "APPROVED");
    assert.equal(calls.decide[0].expected_ot_minutes, 33);
    assert.deepEqual(calls.answers, [{ id: "cb1", text: "Approved" }]);
    assert.deepEqual(calls.edits, [{ chatId: 777, messageId: 55 }]);
  });

  it("takes the rejection reason from a camelCased reply", async () => {
    const { dispatcher, calls } = wire();
    const outcome = await dispatcher.dispatch(
      asReceived({
        update_id: 2,
        message: {
          message_id: 60,
          chat: { id: 777, type: "private" },
          from: { id: 777 },
          text: "Not pre-approved by manager",
          reply_to_message: { message_id: 56, text: "Reject OT request #1826\n\nReply to this message with the reason." },
        },
      })
    );
    assert.equal(outcome.claimedBy, "attendance_ot_approval");
    assert.equal(calls.decide.length, 1);
    assert.equal(calls.decide[0].decision, "REJECTED");
    assert.equal(calls.decide[0].remarks, "Not pre-approved by manager");
  });
});

describe("a shift button tap through the dispatcher", () => {
  it("reaches the shift handler", async () => {
    const { dispatcher, calls } = wire();
    const outcome = await dispatcher.dispatch(
      asReceived({
        update_id: 3,
        callback_query: { id: "cb2", data: "sc:91:A", from: { id: 777 }, message: { message_id: 70, chat: { id: 777 } } },
      })
    );
    assert.equal(outcome.claimedBy, "attendance_shift_change");
    assert.equal(calls.decide.length, 1);
    assert.equal(calls.decide[0].request_id, 91);
  });
});
