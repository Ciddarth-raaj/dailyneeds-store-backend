/**
 * THE TELEGRAM UPDATE DISPATCHER.
 *
 *   node --test usecase/telegram_update_dispatcher.test.js
 *
 * Two properties are worth more than the rest, and most of this file is about
 * them:
 *
 *   OWNERSHIP SURVIVES FAILURE. A handler that throws or hangs STILL CLAIMS its
 *   update, because the claim is a pure predicate decided before any handler
 *   runs. If it did not, a crashing employee handler would let the password
 *   reset answer the same `/start` with "that link has expired" - a wrong
 *   message delivered precisely when something had already gone wrong.
 *
 *   OWNERSHIP IS NOT ORDERING, AND IS NOT A RETURN VALUE. Two handlers may see
 *   the same update; only the predicate decides who owns it. Re-ordering the
 *   `register` calls cannot move ownership, and a handler returning something
 *   truthy does not thereby own anything.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const build = require("./telegram_update_dispatcher");
const { updateType, UPDATE_TYPES, DEEP_LINK_NAMESPACES } = build;

/** A logger that records instead of printing, so tests can read what was logged. */
const recorder = () => {
  const entries = [];
  return {
    entries,
    LEVEL: { ERROR: "error", DEBUG: "debug", INFO: "info" },
    Log: (entry) => entries.push(entry),
  };
};

const message = (text, extra = {}) => ({
  updateId: 1,
  message: { chat: { id: 10, type: "private" }, text, ...extra },
});

const never = () => {};

/* ------------------------------------------------------------- routing --- */

describe("routing by update type", () => {
  it("delivers a message only to handlers registered for messages", async () => {
    const seen = [];
    const d = build({ log: recorder() });
    d.register({ name: "msg", updateTypes: ["message"], handle: () => seen.push("msg") });
    d.register({
      name: "join",
      updateTypes: ["chat_join_request"],
      handle: () => seen.push("join"),
    });

    const out = await d.dispatch(message("hello"));
    assert.deepEqual(seen, ["msg"]);
    assert.equal(out.type, "message");
    assert.equal(out.delivered, 1);
    assert.equal(out.failed, 0);
  });

  it("hands the handler THE WHOLE UPDATE, not just the message", async () => {
    let got = null;
    const d = build({ log: recorder() });
    d.register({ name: "msg", updateTypes: ["message"], handle: (u) => (got = u) });

    const update = message("hello");
    await d.dispatch(update);
    assert.equal(got, update);
    assert.equal(got.updateId, 1);
  });

  it("delivers to every handler registered for the type, in registration order", async () => {
    const seen = [];
    const d = build({ log: recorder() });
    d.register({ name: "a", updateTypes: ["message"], handle: () => seen.push("a") });
    d.register({ name: "b", updateTypes: ["message"], handle: () => seen.push("b") });

    await d.dispatch(message("hi"));
    assert.deepEqual(seen, ["a", "b"]);
  });

  it("an update type nobody registered for reaches nobody, and is not an error", async () => {
    const log = recorder();
    const d = build({ log });
    d.register({ name: "msg", updateTypes: ["message"], handle: never });

    const out = await d.dispatch({ updateId: 2, chatJoinRequest: { from: { id: 7 } } });
    assert.equal(out.delivered, 0);
    assert.equal(out.claimed, false);
    assert.equal(log.entries.at(-1).level, "debug", "a missing handler is not an error");
  });
});

/* --------------------------------------------------------------- casing --- */

describe("snake_case and camelCase are the same update", () => {
  // `messaging-api-telegram` camelCases what Telegram sends, which production
  // already depends on: the poller reads `update.updateId`, not `update_id`.
  // Which layer renamed what must never become a silent routing bug.
  it("routes camelCase chatJoinRequest to a chat_join_request handler", async () => {
    const seen = [];
    const d = build({ log: recorder() });
    d.register({ name: "join", updateTypes: ["chat_join_request"], handle: () => seen.push("join") });

    const out = await d.dispatch({ updateId: 3, chatJoinRequest: { from: { id: 7 } } });
    assert.deepEqual(seen, ["join"]);
    assert.equal(out.type, "chat_join_request");
  });

  it("routes snake_case chat_join_request to the same handler", async () => {
    const seen = [];
    const d = build({ log: recorder() });
    d.register({ name: "join", updateTypes: ["chat_join_request"], handle: () => seen.push("join") });

    const out = await d.dispatch({ update_id: 4, chat_join_request: { from: { id: 7 } } });
    assert.deepEqual(seen, ["join"]);
    assert.equal(out.type, "chat_join_request");
  });

  it("neither spelling reaches a message-only handler", async () => {
    const seen = [];
    const d = build({ log: recorder() });
    d.register({ name: "msg", updateTypes: ["message"], handle: () => seen.push("msg") });

    await d.dispatch({ updateId: 5, chatJoinRequest: {} });
    await d.dispatch({ updateId: 6, chat_join_request: {} });
    assert.deepEqual(seen, []);
  });

  it("names both spellings for every routable type", () => {
    assert.deepEqual(UPDATE_TYPES, ["message", "chat_join_request", "chat_member", "my_chat_member"]);
    assert.equal(updateType({ chatMember: {} }), "chat_member");
    assert.equal(updateType({ chat_member: {} }), "chat_member");
    assert.equal(updateType({ myChatMember: {} }), "my_chat_member");
    assert.equal(updateType({ my_chat_member: {} }), "my_chat_member");
  });

  it("registering an unknown update type is refused rather than silently ignored", () => {
    const d = build({ log: recorder() });
    assert.throws(() => d.register({ name: "x", updateTypes: ["poll"], handle: never }));
    assert.throws(() => d.register({ name: "x", updateTypes: ["message"] }), /handle function/);
  });
});

/* ---------------------------------------------------------------- claim --- */

describe("the deep-link claim contract", () => {
  it("claims NOTHING when no handler declares a predicate - the Phase 1 state", async () => {
    const d = build({ log: recorder() });
    d.register({ name: "detection", updateTypes: ["message"], handle: never });

    const out = await d.dispatch(message("/start abc"));
    assert.equal(out.claimed, false);
    assert.equal(out.claimedBy, null);
  });

  it("reports the handler whose predicate claimed the update", async () => {
    const d = build({ log: recorder() });
    d.register({
      name: "employee_link",
      updateTypes: ["message"],
      claims: (u) => String(u.message?.text || "").startsWith("/start e_"),
      handle: never,
    });

    const out = await d.dispatch(message("/start e_token"));
    assert.equal(out.claimed, true);
    assert.equal(out.claimedBy, "employee_link");
  });

  it("does not claim a payload outside its namespace", async () => {
    const d = build({ log: recorder() });
    d.register({
      name: "employee_link",
      updateTypes: ["message"],
      claims: (u) => String(u.message?.text || "").startsWith(`/start ${DEEP_LINK_NAMESPACES.EMPLOYEE_LINK}`),
      handle: never,
    });

    // A password-reset token is 48 bare hex characters and can carry no prefix.
    const out = await d.dispatch(message(`/start ${"a".repeat(48)}`));
    assert.equal(out.claimed, false);
  });

  it("A HANDLER THAT THROWS STILL CLAIMS", async () => {
    const log = recorder();
    const d = build({ log });
    d.register({
      name: "employee_link",
      updateTypes: ["message"],
      claims: () => true,
      handle: () => {
        throw new Error("boom");
      },
    });

    const out = await d.dispatch(message("/start e_token"));
    assert.equal(out.claimed, true, "a crash must not hand the update back to password reset");
    assert.equal(out.claimedBy, "employee_link");
    assert.equal(out.failed, 1);
  });

  it("A HANDLER THAT REJECTS STILL CLAIMS", async () => {
    const d = build({ log: recorder() });
    d.register({
      name: "employee_link",
      updateTypes: ["message"],
      claims: () => true,
      handle: async () => {
        throw new Error("async boom");
      },
    });

    const out = await d.dispatch(message("/start e_token"));
    assert.equal(out.claimed, true);
    assert.equal(out.failed, 1);
  });

  it("A HANDLER THAT TIMES OUT STILL CLAIMS", async () => {
    const d = build({ log: recorder(), timeoutMs: 20 });
    d.register({
      name: "employee_link",
      updateTypes: ["message"],
      claims: () => true,
      handle: () => new Promise(() => {}),
    });

    const out = await d.dispatch(message("/start e_token"));
    assert.equal(out.claimed, true);
    assert.equal(out.failed, 1);
  });

  it("A TRUTHY RETURN VALUE IS NOT A CLAIM - group detection returns a detection object", async () => {
    const d = build({ log: recorder() });
    d.register({
      name: "detection",
      updateTypes: ["message"],
      handle: () => ({ chat_id: "-100123", claimed: true }),
    });

    const out = await d.dispatch(message("/setup"));
    assert.equal(out.claimed, false, "ownership is the predicate, never the return value");
  });

  it("a predicate that throws is treated as NOT CLAIMED, and is logged", async () => {
    const log = recorder();
    const d = build({ log });
    d.register({
      name: "broken",
      updateTypes: ["message"],
      claims: () => {
        throw new Error("bad predicate");
      },
      handle: never,
    });

    const out = await d.dispatch(message("/start abc"));
    assert.equal(out.claimed, false);
    assert.ok(log.entries.some((e) => e.code.endsWith("CLAIM-PREDICATE")));
  });

  it("two claimers: the first wins, the conflict is logged, and BOTH still run", async () => {
    const log = recorder();
    const seen = [];
    const d = build({ log });
    d.register({
      name: "first",
      updateTypes: ["message"],
      claims: () => true,
      handle: () => seen.push("first"),
    });
    d.register({
      name: "second",
      updateTypes: ["message"],
      claims: () => true,
      handle: () => seen.push("second"),
    });

    const out = await d.dispatch(message("/start e_token"));
    assert.equal(out.claimedBy, "first");
    assert.deepEqual(seen, ["first", "second"], "claiming decides who answers, not who runs");
    assert.ok(log.entries.some((e) => e.code.endsWith("CLAIM-CONFLICT")));
  });

  it("TWO HANDLERS OBSERVE THE SAME UPDATE, AND ONLY THE PRECOMPUTED CLAIM DECIDES OWNERSHIP", async () => {
    // The acceptance test: handler ORDER must not be able to change ownership.
    // An observer registered before or after the owner sees the update either
    // way, and the answer is identical.
    const order = [];
    const owner = {
      name: "employee_link",
      updateTypes: ["message"],
      claims: () => true,
      handle: () => order.push("owner"),
    };
    const observer = {
      name: "detection",
      updateTypes: ["message"],
      handle: () => order.push("observer"),
    };

    const ownerFirst = build({ log: recorder() });
    ownerFirst.register({ ...owner });
    ownerFirst.register({ ...observer });
    const a = await ownerFirst.dispatch(message("/start e_token"));

    order.length = 0;
    const observerFirst = build({ log: recorder() });
    observerFirst.register({ ...observer });
    observerFirst.register({ ...owner });
    const b = await observerFirst.dispatch(message("/start e_token"));

    assert.deepEqual(order, ["observer", "owner"], "both observed it, in registration order");
    assert.equal(a.claimed, b.claimed);
    assert.equal(a.claimedBy, b.claimedBy);
    assert.equal(a.claimedBy, "employee_link", "the predicate owns it, not the position");
    assert.equal(a.delivered, 2);
    assert.equal(b.delivered, 2);
  });
});

/* ------------------------------------------------------------ isolation --- */

describe("handler isolation", () => {
  it("one handler throwing does not stop the next", async () => {
    const seen = [];
    const d = build({ log: recorder() });
    d.register({
      name: "bad",
      updateTypes: ["message"],
      handle: () => {
        throw new Error("boom");
      },
    });
    d.register({ name: "good", updateTypes: ["message"], handle: () => seen.push("good") });

    const out = await d.dispatch(message("hi"));
    assert.deepEqual(seen, ["good"]);
    assert.equal(out.delivered, 1);
    assert.equal(out.failed, 1);
  });

  it("one handler hanging does not stop the next, and dispatch still settles", async () => {
    const seen = [];
    const d = build({ log: recorder(), timeoutMs: 20 });
    d.register({ name: "hung", updateTypes: ["message"], handle: () => new Promise(() => {}) });
    d.register({ name: "good", updateTypes: ["message"], handle: () => seen.push("good") });

    const out = await d.dispatch(message("hi"));
    assert.deepEqual(seen, ["good"]);
    assert.equal(out.failed, 1);
    assert.equal(out.delivered, 1);
  });

  it("dispatch NEVER throws, whatever it is handed", async () => {
    const d = build({ log: recorder() });
    d.register({ name: "msg", updateTypes: ["message"], handle: never });

    for (const bad of [undefined, null, {}, 7, "update", [], { message: null }, { updateId: 9 }]) {
      const out = await d.dispatch(bad);
      assert.equal(out.claimed, false);
      assert.equal(out.delivered, 0);
      assert.equal(out.type, null);
    }
  });

  it("a broken logger cannot stop a handler running", async () => {
    const seen = [];
    const d = build({
      log: {
        LEVEL: { ERROR: "error", DEBUG: "debug" },
        Log: () => {
          throw new Error("logger down");
        },
      },
    });
    d.register({
      name: "bad",
      updateTypes: ["message"],
      handle: () => {
        throw new Error("boom");
      },
    });
    d.register({ name: "good", updateTypes: ["message"], handle: () => seen.push("good") });

    await d.dispatch(message("hi"));
    assert.deepEqual(seen, ["good"]);
  });
});

/* -------------------------------------------------------------- logging --- */

describe("what is logged", () => {
  it("records the handler name, the update type and the update id - and the error", async () => {
    const log = recorder();
    const d = build({ log });
    d.register({
      name: "bad",
      updateTypes: ["message"],
      handle: () => {
        throw new Error("boom");
      },
    });

    await d.dispatch({ updateId: 42, message: { chat: { id: 1 }, text: "/start secret-token" } });
    const entry = log.entries.find((e) => e.code.endsWith("HANDLER"));
    assert.ok(entry);
    assert.equal(entry.ref.handler, "bad");
    assert.equal(entry.ref.type, "message");
    assert.equal(entry.ref.update_id, 42);
    assert.match(entry.description, /boom/);
  });

  it("NEVER records the message text, the /start payload or a shared contact", async () => {
    const log = recorder();
    const d = build({ log, timeoutMs: 20 });
    d.register({
      name: "bad",
      updateTypes: ["message"],
      claims: () => {
        throw new Error("predicate boom");
      },
      handle: () => {
        throw new Error("handler boom");
      },
    });

    await d.dispatch({
      updateId: 43,
      message: {
        chat: { id: 1, title: "ECR Attendance" },
        from: { id: 555, username: "someone" },
        text: "/start e_supersecrettoken",
        contact: { phone_number: "+919876543210", user_id: 555, first_name: "Asha" },
      },
    });

    const dumped = JSON.stringify(log.entries);
    for (const secret of [
      "supersecrettoken",
      "/start",
      "919876543210",
      "Asha",
      "someone",
      "ECR Attendance",
    ]) {
      assert.ok(!dumped.includes(secret), `${secret} must never be logged`);
    }
  });

  it("the module itself never reaches for a message body, a token or a contact", () => {
    const src = fs
      .readFileSync(path.join(__dirname, "telegram_update_dispatcher.js"), "utf8")
      // The header explains WHY these must not be logged; that prose is not a read.
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    for (const forbidden of ["message.text", ".contact", "payload", ".title", ".username"]) {
      assert.ok(!src.includes(forbidden), `the dispatcher must not touch ${forbidden}`);
    }
  });
});
