/**
 * THE EMPLOYEE DEEP LINK AND PASSWORD-RESET LINKING, THROUGH THE REAL POLLER.
 *
 *   node --test usecase/employee_telegram_dispatch.test.js
 *
 * This is the test the whole claim contract was built for, and it uses the
 * REAL dispatcher, the REAL poller and the REAL employee handler rather than
 * stubs - the bug it guards against lives precisely in how those three fit
 * together.
 *
 * THE BUG, STATED PLAINLY. `pollTelegramUpdates` parses EVERY `/start
 * <payload>` and hands it to `completeLink`, which looks the payload up in
 * `telegram_link_tokens` and, on a miss, replies "That link has expired or was
 * already used." An employee deep link is also a `/start`. So without the
 * claim, an employee scanning their QR would be connected correctly by the
 * employee handler AND THEN TOLD BY THE PASSWORD-RESET BRANCH THAT THEIR LINK
 * HAD EXPIRED.
 *
 * And the claim must hold when the employee handler FAILS, which is why it is
 * a synchronous predicate rather than a handler's return value - see the last
 * two tests.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const buildDispatcher = require("./telegram_update_dispatcher");
const buildPasswordReset = require("./passwordReset");
const buildEmployeeTelegram = require("./employee_telegram_link");
const { EMPLOYEE_LINK_PREFIX, BOT_MESSAGE } = require("../constants/employee_telegram");

const sha256 = (v) => require("crypto").createHash("sha256").update(String(v)).digest("hex");

/* ------------------------------- the password-reset side, as it is today */

const makeUserRepo = () => ({
  getByUsername: async () => null,
  setModernPassword: async () => {},
});

const makeResetRepo = () => {
  const calls = { saved: [], consumed: [] };
  return {
    calls,
    getLinkByUserId: async () => null,
    saveLink: async (userId, chatId) => calls.saved.push({ userId, chatId }),
    createLinkToken: async () => {},
    // Only the password-reset token is known here. An employee token is
    // exactly the "unknown payload" that produces the expired-link reply.
    consumeLinkToken: async (hash) => (hash === sha256("reset-token") ? 7 : null),
  };
};

/* ------------------------------------------- the employee side, in memory */

const makeEmployeeStore = () => ({
  employees: { 7: { employee_id: 7, status: 1, primary_contact_number: "9876543210" } },
  tokens: new Map(),
  identities: [],
  audit: [],
});

const makeEmployeeRepo = (store) => ({
  async getEmployeeForVerification(id) {
    return store.employees[id] || null;
  },
  async createLinkToken(employeeId, tokenHash, expiresAt) {
    store.tokens.set(tokenHash, {
      token_hash: tokenHash,
      employee_id: employeeId,
      expires_at: expiresAt,
      consumed_at: null,
      pending_outcome: null,
      pending_expires_at: null,
      pending_telegram_user_id: null,
    });
  },
  async consumeLinkToken(tokenHash, { telegramUserId, chatId, pendingExpiresAt }) {
    const row = store.tokens.get(tokenHash);
    if (!row || row.consumed_at !== null) return null;
    if (new Date(row.expires_at).getTime() <= Date.now()) return null;
    row.consumed_at = new Date();
    row.pending_telegram_user_id = telegramUserId;
    row.pending_chat_id = chatId;
    row.pending_expires_at = pendingExpiresAt;
    return row.employee_id;
  },
  async getPendingByTelegramUser() {
    return null;
  },
  async getLatestPendingForEmployee() {
    return null;
  },
  async closePending() {
    return true;
  },
  async getActiveIdentityByEmployee() {
    return null;
  },
  async getActiveIdentityByTelegramUser() {
    return null;
  },
  async disconnectActiveIdentity() {
    return 0;
  },
  async createIdentity() {},
  async audit(entry) {
    store.audit.push(entry);
  },
});

const makeTelegram = (updates = []) => ({
  sent: [],
  isConfigured: () => true,
  getBotUsername: async () => "dnds_bot",
  getUpdates: async () => updates,
  sendMessage: async function (chatId, text, options) {
    this.sent.push({ chatId, text, options });
    return { code: 200 };
  },
});

/**
 * The whole wiring, exactly as `server.js` builds it: one poller, one
 * dispatcher, the employee handler registered with its claim predicate.
 */
const wire = ({ updates = [], employeeHandlerOverrides = {} } = {}) => {
  const store = makeEmployeeStore();
  const telegram = makeTelegram(updates);
  const employee = buildEmployeeTelegram(makeEmployeeRepo(store), telegram);
  Object.assign(employee, employeeHandlerOverrides);

  const dispatcher = buildDispatcher({ timeoutMs: 50 });
  dispatcher.register({
    name: "employee_telegram_link",
    updateTypes: ["message"],
    claims: (update) => employee.claims(update),
    handle: (update) => employee.handle(update),
  });

  const resetRepo = makeResetRepo();
  const poller = buildPasswordReset(makeUserRepo(), resetRepo, telegram, {
    onTelegramUpdate: (update) => dispatcher.dispatch(update),
  });

  return { store, telegram, employee, dispatcher, poller, resetRepo };
};

const privateMessage = (text) => ({
  chat: { id: 555, type: "private" },
  from: { id: 4242, username: "asha_t" },
  text,
});

/* -------------------------------------------------------------- the tests */

describe("an employee deep link through the real poller", () => {
  it("IS NEVER ANSWERED WITH THE EXPIRED-LINK MESSAGE", async () => {
    const setup = wire();
    const link = await setup.employee.startLink(7);
    const token = link.link.split("?start=")[1];

    setup.telegram.getUpdates = async () => [
      { updateId: 1, message: privateMessage(`/start ${token}`) },
    ];
    setup.telegram.sent.length = 0;

    const result = await setup.poller.pollTelegramUpdates();

    assert.equal(result.linked, 0, "password reset linked nobody");
    assert.deepEqual(setup.resetRepo.calls.saved, [], "and wrote no link row");
    const texts = setup.telegram.sent.map((s) => s.text);
    assert.ok(
      !texts.some((t) => /expired or was already used/.test(t)),
      "THE BUG: the employee must not be told their link has expired"
    );
    assert.ok(texts.includes(BOT_MESSAGE.ASK_FOR_CONTACT), "they are asked for their number");
  });

  it("a PASSWORD-RESET /start still links exactly as it did before", async () => {
    const setup = wire({
      updates: [{ updateId: 2, message: privateMessage("/start reset-token") }],
    });

    const result = await setup.poller.pollTelegramUpdates();

    assert.equal(result.linked, 1);
    assert.deepEqual(setup.resetRepo.calls.saved, [{ userId: 7, chatId: 555 }]);
  });

  it("an unknown /start still gets the expired-link message - unchanged behaviour", async () => {
    const setup = wire({
      updates: [{ updateId: 3, message: privateMessage(`/start ${"a".repeat(48)}`) }],
    });

    await setup.poller.pollTelegramUpdates();

    assert.ok(setup.telegram.sent.some((s) => /expired or was already used/.test(s.text)));
  });

  it("THE CLAIM HOLDS WHEN THE EMPLOYEE HANDLER THROWS", async () => {
    // The dangerous case: a crash must not hand the employee's `/start` back
    // to password reset, which would answer it with the wrong message.
    const setup = wire({
      employeeHandlerOverrides: {
        handle: async () => {
          throw new Error("employee handler is broken");
        },
      },
      updates: [{ updateId: 4, message: privateMessage(`/start ${EMPLOYEE_LINK_PREFIX}whatever`) }],
    });

    const result = await setup.poller.pollTelegramUpdates();

    assert.equal(result.linked, 0);
    assert.deepEqual(setup.telegram.sent, [], "nothing at all is said to the employee");
    assert.equal(setup.poller.updateOffset, 5, "and the offset still advanced");
  });

  it("THE CLAIM HOLDS WHEN THE EMPLOYEE HANDLER HANGS", async () => {
    const setup = wire({
      employeeHandlerOverrides: { handle: () => new Promise(() => {}) },
      updates: [{ updateId: 6, message: privateMessage(`/start ${EMPLOYEE_LINK_PREFIX}whatever`) }],
    });

    const result = await setup.poller.pollTelegramUpdates();

    assert.equal(result.linked, 0);
    assert.deepEqual(setup.telegram.sent, []);
    assert.equal(setup.poller.polling, false, "the re-entrancy guard is released");
  });

  it("a group /setup is claimed by nobody and still reaches password reset's branch", async () => {
    const setup = wire({
      updates: [
        {
          updateId: 7,
          message: { chat: { id: -1001, type: "supergroup" }, from: { id: 1 }, text: "/setup" },
        },
      ],
    });

    const result = await setup.poller.pollTelegramUpdates();
    assert.equal(result.code, 200);
    assert.equal(result.linked, 0);
    assert.deepEqual(setup.telegram.sent, [], "a /setup is not a /start and nothing replies");
  });
});
