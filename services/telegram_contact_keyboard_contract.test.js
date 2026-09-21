/**
 * THE SHARE PHONE NUMBER KEYBOARD, PROVED ON THE WIRE.
 *
 *   node --test services/telegram_contact_keyboard_contract.test.js
 *
 * ================================ WHY THIS FILE EXISTS =====================
 *
 * `usecase/employee_telegram_link.test.js` asserts the OBJECT handed to a
 * Telegram double:
 *
 *   replyMarkup.keyboard[0][0].requestContact === true
 *
 * That is camelCase - OUR spelling, not Telegram's. Telegram's Bot API accepts
 * `reply_markup.keyboard[0][0].request_contact`, and a ReplyKeyboardMarkup
 * whose button carries no `request_contact` is not refused: it is delivered as
 * an ORDINARY button that sends its own label as text. The employee would see
 * "Share Phone Number", tap it, send the words "Share Phone Number", and never
 * become Telegram Connected - which is EXACTLY the reported production
 * symptom, and exactly the failure the existing test cannot see.
 *
 * The rename happens inside `messaging-api-telegram`, one layer below every
 * double in this repository. So a double can never prove it happens, and a
 * package upgrade could stop it happening without one test going red.
 *
 * ============================== WHAT IS ACTUALLY ASSERTED ==================
 *
 * The final HTTP request body. `services/telegram.js` is exercised for real -
 * the real constant, the real service method, the real client, the real
 * `snakecaseKeysDeep` - and only the AXIOS ADAPTER is replaced, which is the
 * last point before the socket. Nothing between the constant and that body is
 * simulated, so what this file reads is what Telegram would have received.
 *
 * ============================ WHY THE SEAM IS WHERE IT IS ==================
 *
 * `services/telegram.js` builds ONE client at module load and deliberately
 * does not expose it - the axios instance carries the bot token in its base
 * URL, and a getter for it would be the second place that token is handled.
 * So the seam is placed BENEATH the service instead: the package's client
 * class is subclassed before `services/telegram.js` is first required, and the
 * subclass swaps the adapter on its own axios instance. The service still
 * builds its client exactly as production does, and NO TOKEN IS READ, LOGGED
 * OR ASSERTED ON here - only `config.data`, the request body, is captured.
 *
 * `dist/TelegramClient` rather than the package root, because the root
 * re-exports through getter-only bindings (`Object.defineProperty(exports, …,
 * { get })`) that silently ignore assignment. Patching the root appears to
 * work and does nothing, which is a worse test than no test.
 *
 * ================================= WHAT IS NEVER LOGGED ====================
 *
 * The fixtures below use an obviously fake number and an obviously fake token,
 * and neither is printed. The captured bodies are asserted against, never
 * dumped.
 */
const { describe, it, before, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

/* ------------------------------------------------------------ the seam --- */

/**
 * Captured request bodies, newest last. Populated by the adapter installed on
 * every client this process builds.
 */
const captured = [];

/** What `/getUpdates` should answer with on the next poll. Drained when read. */
let pendingUpdates = [];

const clientModule = require("messaging-api-telegram/dist/TelegramClient");
const RealTelegramClient = clientModule.default;

class CapturingTelegramClient extends RealTelegramClient {
  constructor(config) {
    super(config);
    // The adapter is the last thing axios calls before the socket, and
    // `config.data` here has already been through the package's
    // `snakecaseKeysDeep` and axios's own `transformRequest`. It IS the body.
    this.axios.defaults.adapter = (config) =>
      Promise.resolve().then(() => {
        const body = config.data ? JSON.parse(config.data) : {};
        let result = true;
        captured.push({ method: config.url, body });
        if (config.url === "/getUpdates") {
          result = pendingUpdates;
          pendingUpdates = [];
        }
        return {
          data: { ok: true, result },
          status: 200,
          statusText: "OK",
          headers: {},
          config,
        };
      });
  }
}
clientModule.default = CapturingTelegramClient;

// Only AFTER the seam is in place, and only then, is the service required.
process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "000000:test-token";
// IS_TEST would rewrite every chat id to the shared test chat, which would
// destroy the one thing several assertions below turn on: that the reply goes
// to the chat the employee is actually in.
delete process.env.IS_TEST;

const telegramService = require("./telegram");
const { ALLOWED_UPDATES } = require("./telegram");
const {
  CONTACT_REQUEST_KEYBOARD,
  BOT_MESSAGE,
} = require("../constants/employee_telegram");

const lastSendMessage = () => {
  const sends = captured.filter((c) => c.method === "/sendMessage");
  return sends.length === 0 ? null : sends[sends.length - 1];
};

/* --------------------------------------------------- the wire contract --- */

describe("the Share Phone Number keyboard as Telegram receives it", () => {
  let telegram;

  before(() => {
    telegram = telegramService();
  });

  beforeEach(() => {
    captured.length = 0;
    pendingUpdates = [];
  });

  it("is sent as reply_markup, in Telegram's own snake_case", async () => {
    await telegram.sendMessage(4242, BOT_MESSAGE.ASK_FOR_CONTACT, {
      parseMode: null,
      replyMarkup: CONTACT_REQUEST_KEYBOARD,
    });

    const sent = lastSendMessage();
    assert.ok(sent, "sendMessage did not reach the wire at all");
    assert.equal(sent.method, "/sendMessage");

    const markup = sent.body.reply_markup;
    assert.ok(
      markup,
      "no reply_markup on the wire: the keyboard was dropped between the constant and Telegram"
    );
    assert.equal(
      sent.body.replyMarkup,
      undefined,
      "camelCase replyMarkup reached the wire; Telegram ignores it and sends no keyboard"
    );
  });

  it("is a ReplyKeyboardMarkup whose button carries request_contact: true", async () => {
    await telegram.sendMessage(4242, BOT_MESSAGE.ASK_FOR_CONTACT, {
      parseMode: null,
      replyMarkup: CONTACT_REQUEST_KEYBOARD,
    });

    const markup = lastSendMessage().body.reply_markup;

    // `keyboard` is what makes it a REPLY keyboard. An `inline_keyboard` here
    // would be a different Telegram mechanism entirely and cannot request a
    // contact at all.
    assert.ok(Array.isArray(markup.keyboard), "reply_markup.keyboard is not an array");
    assert.equal(markup.inline_keyboard, undefined, "this must not be an inline keyboard");
    assert.ok(markup.keyboard.length >= 1, "the keyboard has no rows");
    assert.ok(Array.isArray(markup.keyboard[0]), "the first row is not an array");

    const button = markup.keyboard[0][0];
    assert.ok(button, "the first row has no button");
    assert.equal(
      typeof button.text,
      "string",
      "the button has no label, so Telegram refuses the whole message"
    );
    assert.notEqual(button.text.trim(), "");

    // THE ONE THAT MATTERS. Without it Telegram delivers an ordinary button
    // that sends its own label as text, and no contact is ever shared.
    assert.equal(
      button.request_contact,
      true,
      "request_contact is not true on the wire: the button sends its label as text instead of a contact"
    );
    assert.equal(
      button.requestContact,
      undefined,
      "camelCase requestContact reached the wire; Telegram ignores it"
    );
  });

  it("is resizable and one-time, in snake_case", async () => {
    await telegram.sendMessage(4242, BOT_MESSAGE.ASK_FOR_CONTACT, {
      parseMode: null,
      replyMarkup: CONTACT_REQUEST_KEYBOARD,
    });

    const markup = lastSendMessage().body.reply_markup;
    assert.equal(markup.resize_keyboard, true, "resize_keyboard is not true on the wire");
    assert.equal(markup.one_time_keyboard, true, "one_time_keyboard is not true on the wire");
    assert.equal(markup.resizeKeyboard, undefined, "camelCase resizeKeyboard reached the wire");
    assert.equal(markup.oneTimeKeyboard, undefined, "camelCase oneTimeKeyboard reached the wire");
  });

  it("carries no parse_mode, so no punctuation in the text can be rejected", async () => {
    await telegram.sendMessage(4242, BOT_MESSAGE.ASK_FOR_CONTACT, {
      parseMode: null,
      replyMarkup: CONTACT_REQUEST_KEYBOARD,
    });

    assert.equal(lastSendMessage().body.parse_mode, undefined);
  });

  it("names no employee, no token and no mobile number", async () => {
    await telegram.sendMessage(4242, BOT_MESSAGE.ASK_FOR_CONTACT, {
      parseMode: null,
      replyMarkup: CONTACT_REQUEST_KEYBOARD,
    });

    const body = JSON.stringify(lastSendMessage().body);
    assert.ok(!/\d{10}/.test(body), "a ten-digit number reached a bot reply");
    assert.ok(!/e_[0-9a-f]{8}/.test(body), "a deep-link token reached a bot reply");
  });

  it("asks Telegram for `message` updates, which is what carries a contact", () => {
    // A contact arrives as `message.contact`. If `message` were not in
    // `allowed_updates` Telegram would DROP it rather than queue it, and the
    // keyboard above would be correct and still useless.
    assert.ok(
      ALLOWED_UPDATES.includes("message"),
      "`message` is not in allowed_updates, so no shared contact is ever delivered"
    );
  });

  it("asks for them on the wire under Telegram's own key", async () => {
    await telegram.getUpdates(undefined);

    const poll = captured.find((c) => c.method === "/getUpdates");
    assert.ok(poll, "getUpdates did not reach the wire");
    // `allowedUpdates` would be ignored by Telegram, which then falls back to
    // its own default set - a silent difference from what this service asked
    // for, and the kind that only shows up as a missing update type.
    assert.ok(
      Array.isArray(poll.body.allowed_updates),
      "allowed_updates is not on the wire in snake_case"
    );
    assert.ok(
      poll.body.allowed_updates.includes("message"),
      "`message` is not in the allowed_updates Telegram actually receives"
    );
    assert.equal(poll.body.allowedUpdates, undefined, "camelCase allowedUpdates reached the wire");
  });
});

/* ------------------------------- both incoming contact shapes are taken --- */

/**
 * THE SHAPE THE CLIENT HANDS BACK IS NOT TELEGRAM'S.
 *
 * `messaging-api-telegram` camelCases every response, so a contact reaches the
 * usecase as `{ phoneNumber, userId }` even though Telegram sent
 * `{ phone_number, user_id }`. The usecase accepts BOTH on purpose: a package
 * upgrade that stopped camelCasing must not silently turn the forwarded-
 * contact check off, because a check that reads `undefined` refuses everybody
 * and a check written the other way round would admit everybody.
 *
 * This drives the REAL service's `getUpdates` so the camelCase shape is
 * produced by the package rather than typed out by hand, and drives the real
 * usecase over a small in-memory repository.
 */
describe("a shared contact verifies through the real service, in either spelling", () => {
  const TELEGRAM_USER_ID = 900900900;
  const CHAT_ID = 900900900;
  const EMPLOYEE_ID = 77;
  // An obviously fake but structurally valid Indian mobile. Never logged.
  const MOBILE = "9000000001";

  const buildWorld = () => {
    let pending = null;
    let identity = null;
    const audits = [];
    const repo = {
      async getEmployeeForVerification() {
        return {
          employee_id: EMPLOYEE_ID,
          status: 1,
          date_of_joining: "2020-01-01",
          resignation_date: null,
          primary_contact_number: MOBILE,
        };
      },
      async consumeLinkToken(tokenHash) {
        pending = { token_hash: tokenHash, employee_id: EMPLOYEE_ID };
        return EMPLOYEE_ID;
      },
      async getPendingByTelegramUser(id) {
        return Number(id) === TELEGRAM_USER_ID ? pending : null;
      },
      async getActiveIdentityByTelegramUser() {
        return identity;
      },
      async closePending() {
        pending = null;
      },
      async finalizeVerification() {
        identity = { employee_id: EMPLOYEE_ID };
        return { outcome: "CONNECTED" };
      },
      async audit(entry) {
        audits.push(entry);
      },
    };

    const telegram = telegramService();
    const dispatcher = require("../usecase/telegram_update_dispatcher")();
    const link = require("../usecase/employee_telegram_link")(repo, telegram, {
      getMiniAppUrl: () => null,
    });
    dispatcher.register({
      name: "employee_telegram_link",
      updateTypes: ["message"],
      claims: (update) => link.claims(update),
      handle: (update) => link.handle(update),
    });

    return { dispatcher, audits, isConnected: () => Boolean(identity) };
  };

  const startUpdate = () => ({
    update_id: 1,
    message: {
      message_id: 1,
      from: { id: TELEGRAM_USER_ID, is_bot: false, first_name: "E" },
      chat: { id: CHAT_ID, type: "private" },
      date: 1,
      text: `/start e_${"a".repeat(48)}`,
    },
  });

  const contactUpdate = (contact) => ({
    update_id: 2,
    message: {
      message_id: 2,
      from: { id: TELEGRAM_USER_ID, is_bot: false, first_name: "E" },
      chat: { id: CHAT_ID, type: "private" },
      date: 2,
      contact,
    },
  });

  beforeEach(() => {
    captured.length = 0;
    pendingUpdates = [];
  });

  it("is delivered to the handler as camelCase by the real getUpdates", async () => {
    const telegram = telegramService();
    pendingUpdates = [contactUpdate({ phone_number: `+91${MOBILE}`, user_id: TELEGRAM_USER_ID })];

    const [update] = await telegram.getUpdates(undefined);

    // This is the shape production actually sees, produced by the package
    // rather than asserted from memory.
    assert.equal(update.message.contact.phoneNumber, `+91${MOBILE}`);
    assert.equal(update.message.contact.userId, TELEGRAM_USER_ID);
    assert.equal(update.message.contact.phone_number, undefined);
  });

  it("verifies on the camelCase shape the client produces today", async () => {
    const world = buildWorld();
    await world.dispatcher.dispatch(startUpdate());
    await world.dispatcher.dispatch(
      contactUpdate({ phoneNumber: `+91${MOBILE}`, userId: TELEGRAM_USER_ID })
    );

    assert.ok(world.isConnected(), "the employee did not become Telegram Connected");
    assert.equal(lastSendMessage().body.text, BOT_MESSAGE.CONNECTED);
  });

  it("verifies on Telegram's own snake_case shape as well", async () => {
    const world = buildWorld();
    await world.dispatcher.dispatch(startUpdate());
    await world.dispatcher.dispatch(
      contactUpdate({ phone_number: `+91${MOBILE}`, user_id: TELEGRAM_USER_ID })
    );

    assert.ok(
      world.isConnected(),
      "a snake_case contact was refused; a package upgrade would break verification silently"
    );
    assert.equal(lastSendMessage().body.text, BOT_MESSAGE.CONNECTED);
  });

  it("still refuses a forwarded contact in either spelling", async () => {
    for (const contact of [
      { phoneNumber: `+91${MOBILE}`, userId: TELEGRAM_USER_ID + 1 },
      { phone_number: `+91${MOBILE}`, user_id: TELEGRAM_USER_ID + 1 },
      // A hand-made contact card carries no owner at all.
      { phoneNumber: `+91${MOBILE}` },
    ]) {
      const world = buildWorld();
      await world.dispatcher.dispatch(startUpdate());
      captured.length = 0;
      await world.dispatcher.dispatch(contactUpdate(contact));

      assert.equal(
        world.isConnected(),
        false,
        "a contact that is not the sender's own verified an employee"
      );
      assert.equal(lastSendMessage().body.text, BOT_MESSAGE.CONTACT_NOT_OWNED);
    }
  });

  it("re-offers the keyboard when it refuses, so the employee can try properly", async () => {
    const world = buildWorld();
    await world.dispatcher.dispatch(startUpdate());
    captured.length = 0;
    await world.dispatcher.dispatch(
      contactUpdate({ phoneNumber: `+91${MOBILE}`, userId: TELEGRAM_USER_ID + 1 })
    );

    const markup = lastSendMessage().body.reply_markup;
    assert.equal(markup.keyboard[0][0].request_contact, true);
    assert.equal(markup.resize_keyboard, true);
    assert.equal(markup.one_time_keyboard, true);
  });

  it("puts the Share Phone Number keyboard on the wire for a real /start", async () => {
    const world = buildWorld();
    await world.dispatcher.dispatch(startUpdate());

    const sent = lastSendMessage();
    assert.equal(sent.body.text, BOT_MESSAGE.ASK_FOR_CONTACT);
    assert.equal(sent.body.chat_id, CHAT_ID);
    assert.equal(sent.body.reply_markup.keyboard[0][0].request_contact, true);
    assert.equal(sent.body.reply_markup.resize_keyboard, true);
    assert.equal(sent.body.reply_markup.one_time_keyboard, true);
  });

  it("never puts a mobile number or a token into anything it sends", async () => {
    const world = buildWorld();
    await world.dispatcher.dispatch(startUpdate());
    await world.dispatcher.dispatch(
      contactUpdate({ phoneNumber: `+91${MOBILE}`, userId: TELEGRAM_USER_ID })
    );

    for (const call of captured) {
      const text = JSON.stringify(call.body.text || "");
      assert.ok(!text.includes(MOBILE), "a mobile number reached a bot reply");
      assert.ok(!/e_[0-9a-f]{8}/.test(text), "a deep-link token reached a bot reply");
    }
  });
});
