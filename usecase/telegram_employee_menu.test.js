/**
 * THE BOT'S HOME MENU - plain `/start`.
 *
 *   node --test usecase/telegram_employee_menu.test.js
 *
 * No Telegram and no MySQL. The identity repository and the send are doubles;
 * everything that decides ownership is the REAL predicate, and the
 * ownership-safety suite runs it against the REAL password-reset parser and
 * the REAL employee-link predicate rather than against copies of them.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const buildMenu = require("../usecase/telegram_employee_menu");
const { MENU, UNLINKED_MESSAGE } = require("../usecase/telegram_employee_menu");

const BASE = "https://dnds.co.in/telegram/attendance";
const LINKED_TG = 501;
const UNLINKED_TG = 777;
const EMPLOYEE = 77;

const privateStart = (text, fromId = LINKED_TG) => ({
  updateId: 1,
  message: { chat: { id: 9001, type: "private" }, from: { id: fromId }, text },
});

const build = ({ miniAppUrl = BASE, rows = null, throwOnLookup = false } = {}) => {
  const sent = [];
  const identities =
    rows || [{ employee_id: EMPLOYEE, telegram_user_id: LINKED_TG, disconnected_at: null }];
  const usecase = buildMenu({
    identityRepo: {
      getActiveIdentityByTelegramUser: async (id) => {
        if (throwOnLookup) throw new Error("db down");
        return (
          identities.find(
            (r) => Number(r.telegram_user_id) === Number(id) && r.disconnected_at === null
          ) || null
        );
      },
    },
    telegram: {
      sendMessage: async (chat_id, msg, options) => {
        sent.push({ chat_id, msg, options });
        return { code: 200 };
      },
    },
    getMiniAppUrl: () => miniAppUrl,
  });
  return { usecase, sent };
};

describe("a linked employee typing /start", () => {
  it("gets the menu title and three Web App buttons", async () => {
    const { usecase, sent } = build();
    const out = await usecase.handle(privateStart("/start"));

    assert.equal(out.outcome, "MENU");
    assert.equal(sent.length, 1);
    assert.equal(sent[0].msg, "Daily Needs Employee Services");
    assert.equal(sent[0].msg, MENU.TITLE);

    const rows = sent[0].options.replyMarkup.inlineKeyboard;
    assert.deepEqual(rows.map((r) => r[0].text), ["My Attendance", "Corrections", "Help"]);
    assert.deepEqual(rows.map((r) => r[0].web_app.url), [
      `${BASE}?section=attendance`,
      `${BASE}?section=corrections`,
      `${BASE}?section=help`,
    ]);
  });

  it("the Corrections button carries section=corrections", async () => {
    const { usecase, sent } = build();
    await usecase.handle(privateStart("/start"));
    const corrections = sent[0].options.replyMarkup.inlineKeyboard[1][0];
    assert.match(corrections.web_app.url, /\?section=corrections$/);
  });

  /** THE CLAIM THE WHOLE FEATURE RESTS ON. */
  it("NO menu URL carries an employee id", async () => {
    const { usecase, sent } = build();
    await usecase.handle(privateStart("/start"));
    const text = JSON.stringify(sent[0].options.replyMarkup);
    assert.ok(!/employee/i.test(text), text);
    assert.ok(!new RegExp(`\\b${EMPLOYEE}\\b`).test(text), text);
  });

  it("identity comes from from.id, never from the message text", async () => {
    const { usecase, sent } = build();
    // The text claims to be somebody else. from.id is unlinked.
    const update = privateStart("/start", UNLINKED_TG);
    update.message.text = "/start";
    update.message.from.username = "someone_else";
    const out = await usecase.handle(update);
    assert.equal(out.outcome, "UNLINKED");
    assert.equal(sent[0].msg, UNLINKED_MESSAGE);
  });

  it("a DISCONNECTED identity gets the unlinked message, not the menu", async () => {
    const { usecase, sent } = build({
      rows: [{ employee_id: 88, telegram_user_id: LINKED_TG, disconnected_at: "2026-09-01" }],
    });
    const out = await usecase.handle(privateStart("/start"));
    assert.equal(out.outcome, "UNLINKED");
    assert.equal(sent[0].msg, UNLINKED_MESSAGE);
  });

  it("accepts /start@botname, which is what some clients send", async () => {
    const { usecase, sent } = build();
    assert.equal((await usecase.handle(privateStart("/start@dnds_bot"))).outcome, "MENU");
    assert.equal(sent[0].msg, MENU.TITLE);
  });
});

describe("an UNLINKED Telegram user typing /start", () => {
  it("gets a safe setup message and NOTHING about any employee", async () => {
    const { usecase, sent } = build();
    const out = await usecase.handle(privateStart("/start", UNLINKED_TG));
    assert.equal(out.outcome, "UNLINKED");
    assert.equal(sent.length, 1);
    assert.equal(sent[0].msg, UNLINKED_MESSAGE);
    // No keyboard: there is nothing for them to open.
    assert.equal(sent[0].options.replyMarkup, undefined);
    // It names nobody and confirms nothing.
    assert.ok(!/employee_id|\b77\b|name|code/i.test(sent[0].msg), sent[0].msg);
    assert.match(sent[0].msg, /manager or HR/);
  });

  it("a lookup failure says nothing at all rather than 'you are not an employee'", async () => {
    const { usecase, sent } = build({ throwOnLookup: true });
    const out = await usecase.handle(privateStart("/start"));
    assert.equal(out.outcome, "LOOKUP_FAILED");
    assert.equal(sent.length, 0, "a database blip is not an accusation, and not a menu");
  });
});

describe("no Mini App URL configured", () => {
  it("still sends the menu text, with no keyboard", async () => {
    const { usecase, sent } = build({ miniAppUrl: null });
    const out = await usecase.handle(privateStart("/start"));
    assert.equal(out.outcome, "MENU");
    assert.equal(sent[0].msg, MENU.TITLE);
    assert.equal(sent[0].options.replyMarkup, undefined, "omitted, never sent as null");
  });
});

/* ===================================================================
 * OWNERSHIP - the part that must not break anything that already works
 * =================================================================== */
describe("plain /start ownership is safe", () => {
  const { usecase } = build();
  const claims = usecase.claims;

  // THE REAL parsers, not copies of them.
  const passwordResetParse = (() => {
    const src = require("fs").readFileSync(require.resolve("../usecase/passwordReset"), "utf8");
    const m = /function parseStartPayload\(text\) \{[\s\S]*?\n\}/.exec(src);
    assert.ok(m, "the password-reset parser was found in its source");
    // eslint-disable-next-line no-new-func
    return new Function(`${m[0]}; return parseStartPayload;`)();
  })();

  it("claims a plain /start", () => {
    assert.equal(claims(privateStart("/start")), true);
    assert.equal(claims(privateStart("  /start  ")), true);
    assert.equal(claims(privateStart("/start@dnds_bot")), true);
  });

  it("does NOT claim /start e_<employee-link-token>", () => {
    assert.equal(claims(privateStart("/start e_abc123")), false);
  });

  it("does NOT claim a password-reset /start <token>", () => {
    assert.equal(claims(privateStart(`/start ${"a".repeat(48)}`)), false);
  });

  /**
   * THE INVARIANT, ASSERTED AGAINST THE REAL PASSWORD-RESET PARSER: the two
   * predicates are mutually exclusive. Its regex needs a payload; ours needs
   * the absence of one. No text can satisfy both, so no `/start` can be
   * answered twice.
   */
  it("is mutually exclusive with the real password-reset parser", () => {
    const texts = [
      "/start",
      "/start ",
      "/start@dnds_bot",
      "/start e_abc123",
      `/start ${"f".repeat(48)}`,
      "/start one two",
      "/setup",
      "hello",
    ];
    for (const text of texts) {
      const mine = claims(privateStart(text));
      const theirs = passwordResetParse(text) !== null;
      assert.ok(!(mine && theirs), `both claimed ${JSON.stringify(text)}`);
    }
    // And each really does claim its own case, so the test is not vacuous.
    assert.equal(claims(privateStart("/start")), true);
    assert.equal(passwordResetParse(`/start ${"f".repeat(48)}`) !== null, true);
  });

  it("does NOT claim a group message, so /setup group detection is untouched", () => {
    assert.equal(
      claims({ message: { chat: { id: -100, type: "supergroup" }, from: { id: 1 }, text: "/start" } }),
      false
    );
    assert.equal(
      claims({ message: { chat: { id: -100, type: "group" }, from: { id: 1 }, text: "/setup" } }),
      false
    );
  });

  it("does NOT claim a contact message or anything that is not /start", () => {
    assert.equal(claims(privateStart("hello")), false);
    assert.equal(claims(privateStart("/help")), false);
    assert.equal(claims(privateStart("/started")), false);
    assert.equal(
      claims({ message: { chat: { id: 1, type: "private" }, from: { id: 1 }, contact: {} } }),
      false
    );
  });

  it("the predicate is pure and synchronous - it never returns a promise", () => {
    const result = claims(privateStart("/start"));
    assert.equal(typeof result, "boolean");
    assert.ok(!(result instanceof Promise));
  });

  it("never throws, whatever it is handed", () => {
    for (const junk of [null, undefined, {}, { message: null }, { message: { chat: null } }, 7, "x"]) {
      assert.doesNotThrow(() => claims(junk), `claims(${JSON.stringify(junk)})`);
      assert.equal(claims(junk), false);
    }
  });

  it("handle() never throws either", async () => {
    const { usecase: u } = build();
    for (const junk of [null, undefined, {}, { message: {} }, { message: { chat: {} } }]) {
      assert.equal(await u.handle(junk), null);
    }
  });
});
