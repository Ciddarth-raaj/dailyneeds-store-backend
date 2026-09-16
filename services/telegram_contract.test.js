/**
 * EVERY TELEGRAM METHOD A USECASE CALLS MUST EXIST ON THE REAL SERVICE.
 *
 *   node --test services/telegram_contract.test.js
 *
 * WHY THIS FILE EXISTS. `usecase/telegram_group_readiness.js` called
 * `telegram.getMe()`, which the service did not expose - `getBotUsername`
 * used the underlying client's `getMe` from inside the service and never
 * published one. On the real object that is `undefined`, so every readiness
 * check threw a TypeError, the catch turned it into TELEGRAM_UNAVAILABLE,
 * and Phase 3B would have been inert in production: every group "temporarily
 * unavailable", no join link ever issuable, nobody ever Telegram Complete -
 * looking exactly like a Telegram outage rather than a bug.
 *
 * EVERY UNIT TEST PASSED, because each one hands its usecase a hand-written
 * double that defines whatever the usecase happens to call. A double can
 * only ever confirm that the code calls what the double was written to
 * answer; it can never notice that the real collaborator has no such method.
 *
 * So this asserts the SEAM rather than the behaviour: the set of methods the
 * usecases invoke on their injected Telegram service, checked against the
 * genuine service instance. It reads the source rather than a list somebody
 * has to remember to update, so a new call added tomorrow is covered the day
 * it is written.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** The real thing, built the way `server.js` builds it. */
const service = require("./telegram")();

/**
 * Files that receive the Telegram service by injection, and the expression
 * they hold it in. Anything matching `<holder>.<method>(` is a call this
 * file requires the service to answer.
 */
const CONSUMERS = [
  { file: "usecase/telegram_group_readiness.js", holder: "this.telegram" },
  { file: "usecase/employee_telegram_membership.js", holder: "this.telegram" },
  { file: "usecase/employee_telegram_join_request.js", holder: "this.telegram" },
  { file: "usecase/employee_telegram_link.js", holder: "this.telegram" },
  { file: "usecase/telegram_group_detection.js", holder: "this.telegram" },
  { file: "usecase/passwordReset.js", holder: "this.telegram" },
];

function calledMethods({ file, holder }) {
  const source = strip(read(file));
  const pattern = new RegExp(`${holder.replace(".", "\\.")}\\.(\\w+)\\s*\\(`, "g");
  return [...new Set([...source.matchAll(pattern)].map((m) => m[1]))];
}

describe("the injected Telegram service answers every call made on it", () => {
  for (const consumer of CONSUMERS) {
    it(`${consumer.file}`, () => {
      const methods = calledMethods(consumer);
      assert.ok(methods.length > 0, `expected ${consumer.file} to call the service at all`);
      for (const method of methods) {
        assert.equal(
          typeof service[method],
          "function",
          `${consumer.file} calls telegram.${method}(), which the real service does not expose`
        );
      }
    });
  }

  it("covers the Phase 3B calls specifically", () => {
    // Named as well as derived, so a refactor that stops matching the
    // pattern above still leaves these asserted.
    for (const method of [
      "getMe",
      "getChat",
      "getChatMember",
      "createChatInviteLink",
      "approveChatJoinRequest",
    ]) {
      assert.equal(typeof service[method], "function", `service.${method} is missing`);
    }
  });

  it("still exposes everything the earlier phases rely on", () => {
    for (const method of [
      "getUpdates",
      "getBotUsername",
      "sendMessage",
      "isConfigured",
    ]) {
      assert.equal(typeof service[method], "function", `service.${method} is missing`);
    }
  });
});

describe("the doubles in the unit tests do not invent methods", () => {
  it("every method a Phase 3B test double defines also exists on the real service", () => {
    // The other half of the same problem: a double that answers a call the
    // real object cannot is a test passing for a reason production will not
    // reproduce.
    const doubles = [
      "usecase/telegram_group_readiness.test.js",
      "usecase/employee_telegram_membership.test.js",
      "usecase/employee_telegram_join_request.test.js",
    ];
    const known = new Set(
      Object.getOwnPropertyNames(Object.getPrototypeOf(service)).concat(Object.keys(service))
    );

    for (const file of doubles) {
      const source = strip(read(file));
      // The `telegram: { ... }` block each double passes in.
      const block = /telegram:\s*\{([\s\S]*?)\n    \},/.exec(source);
      if (!block) continue;
      const defined = [...block[1].matchAll(/^\s{6}(\w+):\s*async/gm)].map((m) => m[1]);
      for (const method of defined) {
        assert.ok(
          known.has(method),
          `${file} stubs telegram.${method}(), which the real service does not have`
        );
      }
    }
  });
});
