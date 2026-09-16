/**
 * EMPLOYEE TELEGRAM IDENTITY - linking an employee's own Telegram account.
 *
 *   node --test usecase/employee_telegram_link.test.js
 *
 * The fake repository below is a small in-memory database rather than a set of
 * stubs, and that is deliberate: the two properties most worth proving are
 * about CONCURRENCY and PERSISTENCE, and neither can be shown by a stub that
 * returns a fixed answer.
 *
 *   `consumeLinkToken` claims by UPDATE. The fake mirrors MySQL's behaviour -
 *   a row already carrying `consumed_at` cannot be claimed again - so the
 *   concurrent-`/start` test exercises the real rule rather than a mock that
 *   was told to say no the second time.
 *
 *   the store outlives the usecase. Rebuilding the usecase against the same
 *   store is exactly what an API restart does to a half-finished verification.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const buildUsecase = require("./employee_telegram_link");
const { parseEmployeeStartPayload } = require("./employee_telegram_link");
const {
  BOT_MESSAGE,
  PENDING_OUTCOME,
  TELEGRAM_STATUS,
  AUDIT_EVENT,
  EMPLOYEE_LINK_PREFIX,
} = require("../constants/employee_telegram");

/* ------------------------------------------------------------- the fakes */

/** A store shared by however many usecase instances a test builds. */
const makeStore = ({ employees = {}, } = {}) => ({
  employees,
  tokens: new Map(),
  identities: [],
  audit: [],
});

/**
 * The repository, with MySQL's claiming semantics preserved where they matter.
 */
const makeRepo = (store) => ({
  store,
  async getEmployeeForVerification(employeeId) {
    return store.employees[employeeId] || null;
  },
  async createLinkToken(employeeId, tokenHash, expiresAt, issuedByUserId, superseded) {
    for (const row of store.tokens.values()) {
      if (row.employee_id !== employeeId) continue;
      if (row.consumed_at === null || row.pending_expires_at !== null) {
        row.consumed_at = row.consumed_at || new Date();
        row.pending_expires_at = null;
        row.pending_outcome = row.pending_outcome || superseded;
      }
    }
    store.tokens.set(tokenHash, {
      token_hash: tokenHash,
      employee_id: employeeId,
      issued_by_user_id: issuedByUserId ?? null,
      expires_at: expiresAt,
      consumed_at: null,
      pending_telegram_user_id: null,
      pending_chat_id: null,
      pending_username: null,
      pending_expires_at: null,
      pending_outcome: null,
      created_at: new Date(),
    });
  },
  // THE CLAIM. One statement, and `consumed_at IS NULL` is part of the match:
  // a second caller finds nothing to claim, exactly as the UPDATE does.
  async consumeLinkToken(tokenHash, { telegramUserId, chatId, username, pendingExpiresAt }) {
    const row = store.tokens.get(tokenHash);
    if (!row) return null;
    if (row.consumed_at !== null) return null;
    if (new Date(row.expires_at).getTime() <= Date.now()) return null;
    row.consumed_at = new Date();
    row.pending_telegram_user_id = telegramUserId;
    row.pending_chat_id = chatId;
    row.pending_username = username ?? null;
    row.pending_expires_at = pendingExpiresAt;
    return row.employee_id;
  },
  async getPendingByTelegramUser(telegramUserId) {
    const live = [...store.tokens.values()].filter(
      (r) =>
        r.pending_telegram_user_id === telegramUserId &&
        r.pending_outcome === null &&
        r.pending_expires_at !== null &&
        new Date(r.pending_expires_at).getTime() > Date.now()
    );
    live.sort((a, b) => new Date(b.consumed_at) - new Date(a.consumed_at));
    return live[0] || null;
  },
  async getLatestPendingForEmployee(employeeId) {
    const rows = [...store.tokens.values()].filter((r) => r.employee_id === employeeId);
    rows.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    return rows[0] || null;
  },
  async closePending(tokenHash, outcome) {
    const row = store.tokens.get(tokenHash);
    if (!row || row.pending_outcome !== null) return false;
    row.pending_outcome = outcome;
    row.pending_expires_at = null;
    return true;
  },
  async getActiveIdentityByEmployee(employeeId) {
    return (
      store.identities.find(
        (i) => i.employee_id === employeeId && i.disconnected_at === null
      ) || null
    );
  },
  async getActiveIdentityByTelegramUser(telegramUserId) {
    return (
      store.identities.find(
        (i) => i.telegram_user_id === telegramUserId && i.disconnected_at === null
      ) || null
    );
  },
  async disconnectActiveIdentity(employeeId, reason) {
    let n = 0;
    for (const i of store.identities) {
      if (i.employee_id === employeeId && i.disconnected_at === null) {
        i.disconnected_at = new Date();
        i.disconnect_reason = reason;
        n += 1;
      }
    }
    return n;
  },
  async createIdentity({ employeeId, telegramUserId, chatId, username, verifiedMobile }) {
    // The three unique keys, as the schema declares them.
    const clash = store.identities.some(
      (i) =>
        i.disconnected_at === null &&
        (i.employee_id === employeeId ||
          i.telegram_user_id === telegramUserId ||
          i.private_chat_id === chatId)
    );
    if (clash) {
      const err = new Error("ER_DUP_ENTRY: Duplicate entry for key 'uq_eti_active_telegram'");
      err.code = "ER_DUP_ENTRY";
      throw err;
    }
    store.identities.push({
      employee_telegram_id: store.identities.length + 1,
      employee_id: employeeId,
      telegram_user_id: telegramUserId,
      private_chat_id: chatId,
      telegram_username: username ?? null,
      verified_mobile: verifiedMobile,
      connected_at: new Date(),
      disconnected_at: null,
      disconnect_reason: null,
    });
  },
  async audit(entry) {
    store.audit.push(entry);
  },
});

const makeTelegram = ({ botUsername = "dnds_bot", failSend = false } = {}) => ({
  sent: [],
  getBotUsername: async () => botUsername,
  sendMessage: async function (chatId, text, options) {
    if (failSend) throw new Error("telegram down");
    this.sent.push({ chatId, text, options });
    return { code: 200 };
  },
});

const ACTIVE = { employee_id: 7, status: 1, primary_contact_number: "+91 98765 43210" };
const RESIGNED = { employee_id: 9, status: 0, primary_contact_number: "9876500000" };

const setup = (overrides = {}) => {
  const store = makeStore({ employees: { 7: { ...ACTIVE }, 9: { ...RESIGNED }, ...(overrides.employees || {}) } });
  const repo = makeRepo(store);
  const telegram = makeTelegram(overrides.telegram);
  const usecase = buildUsecase(repo, telegram);
  return { store, repo, telegram, usecase };
};

/** The token out of the deep link the usecase just returned. */
const tokenFrom = (result) => result.link.split("?start=")[1].slice(EMPLOYEE_LINK_PREFIX.length);

const startMessage = (token, extra = {}) => ({
  chat: { id: 555, type: "private" },
  from: { id: 4242, username: "asha_t" },
  text: `/start ${EMPLOYEE_LINK_PREFIX}${token}`,
  ...extra,
});

const contactMessage = (contact, extra = {}) => ({
  chat: { id: 555, type: "private" },
  from: { id: 4242, username: "asha_t" },
  contact,
  ...extra,
});

/* ----------------------------------------------------------- the payload */

describe("the deep-link payload", () => {
  it("reads an employee token", () => {
    assert.equal(parseEmployeeStartPayload("/start e_abc123"), "abc123");
    assert.equal(parseEmployeeStartPayload("/start@dnds_bot e_abc123"), "abc123");
  });

  it("IGNORES A PASSWORD-RESET TOKEN - 48 bare hex characters, no prefix", () => {
    assert.equal(parseEmployeeStartPayload(`/start ${"a".repeat(48)}`), null);
  });

  it("ignores anything that is not a /start carrying an employee token", () => {
    for (const text of ["/start", "/start ", "e_abc", "hello", "/setup", "/start e_", null, 7]) {
      assert.equal(parseEmployeeStartPayload(text), null);
    }
  });
});

/* -------------------------------------------------------- issuing a link */

describe("issuing a link", () => {
  it("returns a namespaced deep link and an expiry", async () => {
    const { usecase } = setup();
    const result = await usecase.startLink(7, { actorUserId: 3 });

    assert.equal(result.code, 200);
    assert.match(result.link, /^https:\/\/t\.me\/dnds_bot\?start=e_[0-9a-f]{48}$/);
    assert.equal(result.expires_in_minutes, 15);
  });

  it("STORES ONLY THE HASH - the token itself is never written down", async () => {
    const { usecase, store } = setup();
    const result = await usecase.startLink(7);
    const token = tokenFrom(result);

    const rows = [...store.tokens.values()];
    assert.equal(rows.length, 1);
    assert.match(rows[0].token_hash, /^[0-9a-f]{64}$/);
    const dumped = JSON.stringify(rows);
    assert.ok(!dumped.includes(token), "the plaintext token must not be stored");
  });

  it("carries no employee id, name or mobile in the link", async () => {
    const { usecase } = setup();
    const result = await usecase.startLink(7);
    const payload = tokenFrom(result);
    assert.ok(!payload.includes("9876543210"), "not the employee's mobile");
    assert.ok(!payload.includes("asha"), "not their name");
    assert.match(payload, /^[0-9a-f]{48}$/, "an opaque secret and nothing else");
  });

  it("A FRESH TOKEN KILLS THE OLD ONE - a printed QR stops working", async () => {
    const { usecase, store } = setup();
    const first = await usecase.startLink(7);
    const second = await usecase.startLink(7);

    const firstToken = tokenFrom(first);
    const outcome = await usecase.onStart(firstToken, startMessage(firstToken));
    assert.equal(outcome.outcome, "TOKEN_REJECTED");

    const secondToken = tokenFrom(second);
    const ok = await usecase.onStart(secondToken, startMessage(secondToken));
    assert.equal(ok.outcome, "AWAITING_CONTACT");
    assert.equal(store.tokens.size, 2, "the superseded row is kept, with its reason");
  });

  it("refuses an inactive employee, and audits the refusal", async () => {
    const { usecase, store } = setup();
    await assert.rejects(
      () => usecase.startLink(9),
      (err) => err.name === "ValidationError" && /not active/.test(err.message)
    );
    assert.ok(store.audit.some((a) => a.event === AUDIT_EVENT.EMPLOYEE_INELIGIBLE));
  });

  it("refuses an employee with no usable mobile, naming the fix", async () => {
    const { usecase } = setup({ employees: { 11: { employee_id: 11, status: 1, primary_contact_number: "123" } } });
    await assert.rejects(
      () => usecase.startLink(11),
      (err) => err.name === "ValidationError" && /mobile number/.test(err.message)
    );
  });

  it("refuses an unknown employee", async () => {
    const { usecase } = setup();
    await assert.rejects(() => usecase.startLink(9999), (err) => err.name === "ValidationError");
  });

  it("says so rather than handing out a broken link when the bot is unreachable", async () => {
    const { usecase } = setup({ telegram: { botUsername: "" } });
    await assert.rejects(() => usecase.startLink(7), (err) => err.name === "ValidationError");
  });
});

/* --------------------------------------------------------- the /start leg */

describe("/start", () => {
  it("opens a pending verification and ASKS FOR THE CONTACT WITH A BUTTON", async () => {
    const { usecase, telegram } = setup();
    const token = tokenFrom(await usecase.startLink(7));

    const outcome = await usecase.onStart(token, startMessage(token));

    assert.equal(outcome.outcome, "AWAITING_CONTACT");
    const reply = telegram.sent.at(-1);
    assert.equal(reply.text, BOT_MESSAGE.ASK_FOR_CONTACT);
    // The library camelCases outgoing options and snakecases them on the wire,
    // so this is `reply_markup.keyboard[0][0].request_contact` at Telegram.
    assert.equal(reply.options.replyMarkup.keyboard[0][0].requestContact, true);
    assert.match(reply.options.replyMarkup.keyboard[0][0].text, /Share Phone Number/);
  });

  it("NOTHING IS WRITTEN TO THE IDENTITY TABLE YET - the mobile is unverified", async () => {
    const { usecase, store } = setup();
    const token = tokenFrom(await usecase.startLink(7));
    await usecase.onStart(token, startMessage(token));
    assert.deepEqual(store.identities, [], "a half-verified identity is not a state");
  });

  it("an expired token is refused", async () => {
    const { usecase, store } = setup();
    const token = tokenFrom(await usecase.startLink(7));
    for (const row of store.tokens.values()) row.expires_at = new Date(Date.now() - 1000);

    const outcome = await usecase.onStart(token, startMessage(token));
    assert.equal(outcome.outcome, "TOKEN_REJECTED");
    assert.equal(store.identities.length, 0);
  });

  it("a token is spent ONCE - a replayed deep link does nothing", async () => {
    const { usecase } = setup();
    const token = tokenFrom(await usecase.startLink(7));

    assert.equal((await usecase.onStart(token, startMessage(token))).outcome, "AWAITING_CONTACT");
    assert.equal((await usecase.onStart(token, startMessage(token))).outcome, "TOKEN_REJECTED");
  });

  it("CONCURRENT /start CONSUMES EXACTLY ONCE", async () => {
    // A slow first scan and an impatient second tap arrive together. Exactly
    // one may open the session; the loser is told the link is spent.
    const { usecase, store } = setup();
    const token = tokenFrom(await usecase.startLink(7));

    const results = await Promise.all([
      usecase.onStart(token, startMessage(token)),
      usecase.onStart(token, startMessage(token)),
      usecase.onStart(token, startMessage(token)),
    ]);

    const opened = results.filter((r) => r.outcome === "AWAITING_CONTACT");
    const rejected = results.filter((r) => r.outcome === "TOKEN_REJECTED");
    assert.equal(opened.length, 1, "exactly one caller establishes the pending session");
    assert.equal(rejected.length, 2);
    assert.equal(
      store.audit.filter((a) => a.event === AUDIT_EVENT.TOKEN_CONSUMED).length,
      1
    );
  });

  it("refuses an employee who resigned after the QR was generated", async () => {
    const { usecase, store, telegram } = setup();
    const token = tokenFrom(await usecase.startLink(7));
    store.employees[7].status = 0;

    const outcome = await usecase.onStart(token, startMessage(token));

    assert.equal(outcome.outcome, "EMPLOYEE_INELIGIBLE");
    assert.equal(telegram.sent.at(-1).text, BOT_MESSAGE.EMPLOYEE_INELIGIBLE);
    assert.equal(store.identities.length, 0);
  });
});

/* -------------------------------------------------------- the contact leg */

describe("the shared contact", () => {
  const openSession = async () => {
    const ctx = setup();
    const token = tokenFrom(await ctx.usecase.startLink(7));
    await ctx.usecase.onStart(token, startMessage(token));
    ctx.telegram.sent.length = 0;
    return ctx;
  };

  it("connects when the contact is the sender's own and the number matches", async () => {
    const { usecase, store, telegram } = await openSession();

    const outcome = await usecase.onContact(
      contactMessage({ phoneNumber: "+919876543210", userId: 4242, firstName: "Asha" })
    );

    assert.equal(outcome.outcome, PENDING_OUTCOME.VERIFIED);
    assert.equal(store.identities.length, 1);
    assert.equal(store.identities[0].employee_id, 7);
    assert.equal(store.identities[0].telegram_user_id, 4242);
    assert.equal(store.identities[0].verified_mobile, "9876543210");
    assert.equal(telegram.sent.at(-1).text, BOT_MESSAGE.CONNECTED);
    assert.ok(store.audit.some((a) => a.event === AUDIT_EVENT.CONNECTED));
  });

  it("accepts Telegram's own snake_case contact shape too", async () => {
    // Guards against a client upgrade silently changing the field names and
    // turning the ownership check into a no-op.
    const { usecase, store } = await openSession();

    const outcome = await usecase.onContact(
      contactMessage({ phone_number: "+919876543210", user_id: 4242 })
    );

    assert.equal(outcome.outcome, PENDING_OUTCOME.VERIFIED);
    assert.equal(store.identities.length, 1);
  });

  it("A FORWARDED CONTACT NEVER VERIFIES ANYBODY", async () => {
    // The whole feature defeated in one message if this check is missing:
    // employee A shares employee B's contact card and becomes B.
    const { usecase, store, telegram } = await openSession();

    const outcome = await usecase.onContact(
      contactMessage({ phoneNumber: "+919876543210", userId: 9999 })
    );

    assert.equal(outcome.outcome, PENDING_OUTCOME.CONTACT_NOT_OWNED);
    assert.deepEqual(store.identities, []);
    assert.equal(telegram.sent.at(-1).text, BOT_MESSAGE.CONTACT_NOT_OWNED);
    assert.ok(store.audit.some((a) => a.event === AUDIT_EVENT.CONTACT_NOT_OWNED));
  });

  it("a contact with NO owner id is refused - a hand-made card proves nothing", async () => {
    const { usecase, store } = await openSession();

    const outcome = await usecase.onContact(
      contactMessage({ phoneNumber: "+919876543210", firstName: "Asha" })
    );

    assert.equal(outcome.outcome, PENDING_OUTCOME.CONTACT_NOT_OWNED);
    assert.deepEqual(store.identities, []);
  });

  it("a rejected forward LEAVES THE SESSION OPEN so the button still works", async () => {
    const { usecase, store } = await openSession();
    await usecase.onContact(contactMessage({ phoneNumber: "+919876543210", userId: 9999 }));

    const outcome = await usecase.onContact(
      contactMessage({ phoneNumber: "+919876543210", userId: 4242 })
    );
    assert.equal(outcome.outcome, PENDING_OUTCOME.VERIFIED);
    assert.equal(store.identities.length, 1);
  });

  it("a MISMATCH does not connect, and names NEITHER number", async () => {
    const { usecase, store, telegram } = await openSession();

    const outcome = await usecase.onContact(
      contactMessage({ phoneNumber: "+919999911111", userId: 4242 })
    );

    assert.equal(outcome.outcome, PENDING_OUTCOME.MOBILE_MISMATCH);
    assert.deepEqual(store.identities, []);

    const reply = telegram.sent.at(-1);
    assert.equal(reply.text, BOT_MESSAGE.MOBILE_MISMATCH);
    assert.ok(!reply.text.includes("9999911111"), "not the number Telegram shared");
    assert.ok(!reply.text.includes("9876543210"), "and not the number on file");
    assert.ok(!/\d{4,}/.test(reply.text), "no run of digits that could be either");
    assert.ok(store.audit.some((a) => a.event === AUDIT_EVENT.MOBILE_MISMATCH));
  });

  it("a mismatch closes the session - it is not 'still pending'", async () => {
    const { usecase, store } = await openSession();
    await usecase.onContact(contactMessage({ phoneNumber: "+919999911111", userId: 4242 }));

    const row = [...store.tokens.values()].at(-1);
    assert.equal(row.pending_outcome, PENDING_OUTCOME.MOBILE_MISMATCH);

    const again = await usecase.onContact(
      contactMessage({ phoneNumber: "+919876543210", userId: 4242 })
    );
    assert.equal(again, null, "a fresh link is needed, exactly as the design says");
  });

  it("an employee who resigned mid-flow is not connected", async () => {
    const { usecase, store, telegram } = await openSession();
    store.employees[7].status = 0;

    const outcome = await usecase.onContact(
      contactMessage({ phoneNumber: "+919876543210", userId: 4242 })
    );

    assert.equal(outcome.outcome, PENDING_OUTCOME.EMPLOYEE_INELIGIBLE);
    assert.deepEqual(store.identities, []);
    assert.equal(telegram.sent.at(-1).text, BOT_MESSAGE.EMPLOYEE_INELIGIBLE);
  });

  it("a contact with no pending verification is ignored entirely", async () => {
    const { usecase, telegram } = setup();
    const outcome = await usecase.onContact(
      contactMessage({ phoneNumber: "+919876543210", userId: 4242 })
    );
    assert.equal(outcome, null);
    assert.deepEqual(telegram.sent, [], "it says nothing that implies a flow exists");
  });

  it("an expired pending verification cannot be finished", async () => {
    const { usecase, store } = await openSession();
    for (const row of store.tokens.values()) {
      if (row.pending_expires_at) row.pending_expires_at = new Date(Date.now() - 1000);
    }

    const outcome = await usecase.onContact(
      contactMessage({ phoneNumber: "+919876543210", userId: 4242 })
    );
    assert.equal(outcome, null);
    assert.deepEqual(store.identities, []);
  });

  it("PENDING STATE SURVIVES A RESTART - it is in the database, not in memory", async () => {
    const store = makeStore({ employees: { 7: { ...ACTIVE } } });
    const telegram = makeTelegram();

    const before = buildUsecase(makeRepo(store), telegram);
    const token = tokenFrom(await before.startLink(7));
    await before.onStart(token, startMessage(token));

    // Everything the process was holding is gone; only the store remains.
    const after = buildUsecase(makeRepo(store), makeTelegram());
    const outcome = await after.onContact(
      contactMessage({ phoneNumber: "+919876543210", userId: 4242 })
    );

    assert.equal(outcome.outcome, PENDING_OUTCOME.VERIFIED);
    assert.equal(store.identities.length, 1);
  });
});

/* ------------------------------------------------------------- uniqueness */

describe("one Telegram account, one employee", () => {
  const connect = async (ctx, employeeId, telegramUserId, chatId, mobile) => {
    const token = tokenFrom(await ctx.usecase.startLink(employeeId));
    await ctx.usecase.onStart(token, {
      chat: { id: chatId, type: "private" },
      from: { id: telegramUserId },
      text: `/start ${EMPLOYEE_LINK_PREFIX}${token}`,
    });
    return ctx.usecase.onContact({
      chat: { id: chatId, type: "private" },
      from: { id: telegramUserId },
      contact: { phoneNumber: mobile, userId: telegramUserId },
    });
  };

  it("REFUSES a Telegram account already linked to another employee, naming nobody", async () => {
    const ctx = setup({
      employees: { 8: { employee_id: 8, status: 1, primary_contact_number: "9876543210" } },
    });
    await connect(ctx, 7, 4242, 555, "+919876543210");
    ctx.telegram.sent.length = 0;

    // Employee 8 happens to have the same number on file; the Telegram account
    // is nonetheless already somebody else's.
    const outcome = await connect(ctx, 8, 4242, 556, "+919876543210");

    assert.equal(outcome.outcome, PENDING_OUTCOME.DUPLICATE_IDENTITY);
    assert.equal(ctx.store.identities.filter((i) => i.disconnected_at === null).length, 1);
    const reply = ctx.telegram.sent.at(-1);
    assert.equal(reply.text, BOT_MESSAGE.DUPLICATE_IDENTITY);
    assert.ok(!/\b7\b|employee/i.test(reply.text.replace("employee record", "")), "it names no record");
    assert.ok(ctx.store.audit.some((a) => a.event === AUDIT_EVENT.DUPLICATE_IDENTITY));
  });

  it("a unique-key violation is reported as a duplicate, not as a crash", async () => {
    const ctx = setup({
      employees: { 8: { employee_id: 8, status: 1, primary_contact_number: "9876543210" } },
    });
    // An identity appears between the check and the insert - the database is
    // the authority, and its refusal must read like the check's refusal.
    ctx.repo.getActiveIdentityByTelegramUser = async () => null;
    await connect(ctx, 7, 4242, 555, "+919876543210");

    const outcome = await connect(ctx, 8, 4242, 556, "+919876543210");
    assert.equal(outcome.outcome, PENDING_OUTCOME.DUPLICATE_IDENTITY);
    assert.ok(
      ctx.store.audit.some(
        (a) => a.event === AUDIT_EVENT.DUPLICATE_IDENTITY && a.detail === "unique_violation"
      )
    );
  });

  it("the same employee re-verifying the same account changes nothing", async () => {
    const ctx = setup();
    await connect(ctx, 7, 4242, 555, "+919876543210");
    const outcome = await connect(ctx, 7, 4242, 555, "+919876543210");

    assert.equal(outcome.outcome, PENDING_OUTCOME.VERIFIED);
    assert.equal(ctx.store.identities.length, 1, "no second row");
  });

  it("RECONNECT with a different account retires the old identity, keeping history", async () => {
    const ctx = setup();
    await connect(ctx, 7, 4242, 555, "+919876543210");
    await connect(ctx, 7, 7777, 556, "+919876543210");

    const active = ctx.store.identities.filter((i) => i.disconnected_at === null);
    assert.equal(active.length, 1, "at most one active identity per employee");
    assert.equal(active[0].telegram_user_id, 7777);
    assert.equal(ctx.store.identities.length, 2, "the old row is kept as history");
    assert.equal(ctx.store.identities[0].disconnect_reason, "RECONNECT");
  });
});

/* ----------------------------------------------------------------- status */

describe("status", () => {
  it("is PENDING for an employee nobody has started", async () => {
    const { usecase } = setup();
    const { data } = await usecase.getStatus(7);
    assert.equal(data.status, TELEGRAM_STATUS.PENDING);
    assert.equal(data.connected, false);
    assert.equal(data.mobile_verified, false);
  });

  it("is AWAITING_CONTACT between /start and the shared contact", async () => {
    const { usecase } = setup();
    const token = tokenFrom(await usecase.startLink(7));
    await usecase.onStart(token, startMessage(token));

    const { data } = await usecase.getStatus(7);
    assert.equal(data.status, TELEGRAM_STATUS.AWAITING_CONTACT);
    assert.equal(data.connected, false);
  });

  it("is MOBILE_MISMATCH after one, so the screen can say why", async () => {
    const { usecase } = setup();
    const token = tokenFrom(await usecase.startLink(7));
    await usecase.onStart(token, startMessage(token));
    await usecase.onContact(contactMessage({ phoneNumber: "+919999911111", userId: 4242 }));

    const { data } = await usecase.getStatus(7);
    assert.equal(data.status, TELEGRAM_STATUS.MOBILE_MISMATCH);
    assert.equal(data.mobile_verified, false);
  });

  it("is CONNECTED once verified, with the four answers kept separate", async () => {
    const { usecase } = setup();
    const token = tokenFrom(await usecase.startLink(7));
    await usecase.onStart(token, startMessage(token));
    await usecase.onContact(contactMessage({ phoneNumber: "+919876543210", userId: 4242 }));

    const { data } = await usecase.getStatus(7);
    assert.equal(data.status, TELEGRAM_STATUS.CONNECTED);
    assert.equal(data.connected, true);
    assert.equal(data.mobile_verified, true);
    assert.equal(data.telegram_username, "asha_t");
    assert.ok(data.connected_at);
  });

  it("DISCLOSES NO IDENTIFIER - no chat id, no Telegram user id, no mobile", async () => {
    const { usecase } = setup();
    const token = tokenFrom(await usecase.startLink(7));
    await usecase.onStart(token, startMessage(token));
    await usecase.onContact(contactMessage({ phoneNumber: "+919876543210", userId: 4242 }));

    const { data } = await usecase.getStatus(7);
    const dumped = JSON.stringify(data);
    for (const secret of ["4242", "555", "9876543210"]) {
      assert.ok(!dumped.includes(secret), `${secret} must not be returned`);
    }
    assert.deepEqual(Object.keys(data).sort(), [
      "connected",
      "connected_at",
      "mobile_verified",
      "status",
      "telegram_username",
    ]);
  });
});

/* ------------------------------------------------------------- disconnect */

describe("disconnect", () => {
  it("retires the identity, keeps the row, and audits it", async () => {
    const { usecase, store } = setup();
    const token = tokenFrom(await usecase.startLink(7));
    await usecase.onStart(token, startMessage(token));
    await usecase.onContact(contactMessage({ phoneNumber: "+919876543210", userId: 4242 }));

    const result = await usecase.disconnect(7, { actorUserId: 3, reason: "MANUAL" });

    assert.equal(result.disconnected, true);
    assert.equal(store.identities.length, 1, "history is not deleted");
    assert.notEqual(store.identities[0].disconnected_at, null);
    assert.ok(store.audit.some((a) => a.event === AUDIT_EVENT.DISCONNECTED));
    assert.equal((await usecase.getStatus(7)).data.status, TELEGRAM_STATUS.PENDING);
  });

  it("is harmless when there is nothing to disconnect", async () => {
    const { usecase, store } = setup();
    const result = await usecase.disconnect(7);
    assert.equal(result.disconnected, false);
    assert.ok(!store.audit.some((a) => a.event === AUDIT_EVENT.DISCONNECTED));
  });
});

/* ----------------------------------------------------- the claim contract */

describe("the claim contract", () => {
  it("claims an employee deep link in a private chat", async () => {
    const { usecase } = setup();
    assert.equal(usecase.claims({ message: startMessage("abc") }), true);
  });

  it("DOES NOT CLAIM A PASSWORD-RESET /start", async () => {
    const { usecase } = setup();
    const message = { chat: { id: 1, type: "private" }, text: `/start ${"a".repeat(48)}` };
    assert.equal(usecase.claims({ message }), false);
  });

  it("does not claim /setup, a group message, or an ordinary contact", async () => {
    const { usecase } = setup();
    assert.equal(usecase.claims({ message: { chat: { id: -100, type: "supergroup" }, text: "/setup" } }), false);
    assert.equal(
      usecase.claims({ message: { chat: { id: -100, type: "supergroup" }, text: "/start e_abc" } }),
      false,
      "an employee link is a private conversation"
    );
    assert.equal(usecase.claims({ message: contactMessage({ phoneNumber: "1", userId: 1 }) }), false);
  });

  it("IS PURE AND SYNCHRONOUS - it touches no repository and returns a boolean", async () => {
    const { usecase, repo } = setup();
    for (const key of Object.keys(repo)) {
      if (typeof repo[key] === "function") {
        repo[key] = () => {
          throw new Error(`claims() must not call repo.${key}`);
        };
      }
    }
    const answer = usecase.claims({ message: startMessage("abc") });
    assert.equal(answer, true);
    assert.equal(typeof answer, "boolean", "not a promise");
  });

  it("handle() never throws, whatever it is handed", async () => {
    const { usecase } = setup();
    for (const bad of [undefined, null, {}, { message: null }, { message: {} }, { message: { chat: {} } }]) {
      assert.equal(await usecase.handle(bad), null);
    }
  });

  it("handle() routes /start and contacts, and ignores other chatter", async () => {
    const { usecase } = setup();
    const token = tokenFrom(await usecase.startLink(7));

    assert.equal((await usecase.handle({ message: startMessage(token) })).outcome, "AWAITING_CONTACT");
    assert.equal(
      (await usecase.handle({
        message: contactMessage({ phoneNumber: "+919876543210", userId: 4242 }),
      })).outcome,
      PENDING_OUTCOME.VERIFIED
    );
    assert.equal(await usecase.handle({ message: { chat: { id: 1, type: "private" }, text: "hello" } }), null);
  });

  it("a Telegram send failure does not stop the identity being written", async () => {
    const store = makeStore({ employees: { 7: { ...ACTIVE } } });
    const usecase = buildUsecase(makeRepo(store), makeTelegram({ failSend: true }));
    const token = tokenFrom(await usecase.startLink(7));

    await usecase.onStart(token, startMessage(token));
    const outcome = await usecase.onContact(
      contactMessage({ phoneNumber: "+919876543210", userId: 4242 })
    );

    assert.equal(outcome.outcome, PENDING_OUTCOME.VERIFIED);
    assert.equal(store.identities.length, 1);
  });
});

/* ---------------------------------------------------------------- logging */

describe("what is audited, and what is never recorded", () => {
  it("the audit carries identifiers only - no token, no mobile, no message", async () => {
    const { usecase, store } = setup();
    const result = await usecase.startLink(7, { actorUserId: 3 });
    const token = tokenFrom(result);
    await usecase.onStart(token, startMessage(token));
    await usecase.onContact(contactMessage({ phoneNumber: "+919876543210", userId: 4242 }));

    const dumped = JSON.stringify(store.audit);
    for (const secret of [token, "9876543210", "/start", "Share Phone Number"]) {
      assert.ok(!dumped.includes(secret), `${secret} must never be audited`);
    }
    for (const entry of store.audit) {
      assert.deepEqual(
        Object.keys(entry).filter((k) => !["employeeId", "event", "telegramUserId", "actorUserId", "detail"].includes(k)),
        [],
        "the audit has no field a secret could be written into"
      );
    }
  });

  it("records the events the design names", async () => {
    const { usecase, store } = setup();
    const token = tokenFrom(await usecase.startLink(7, { actorUserId: 3 }));
    await usecase.onStart(token, startMessage(token));
    await usecase.onContact(contactMessage({ phoneNumber: "+919876543210", userId: 4242 }));

    const events = store.audit.map((a) => a.event);
    assert.deepEqual(events, [
      AUDIT_EVENT.TOKEN_ISSUED,
      AUDIT_EVENT.TOKEN_CONSUMED,
      AUDIT_EVENT.CONNECTED,
    ]);
  });
});
