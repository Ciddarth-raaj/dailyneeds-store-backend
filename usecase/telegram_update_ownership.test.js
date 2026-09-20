/**
 * THERE IS EXACTLY ONE READER OF TELEGRAM'S UPDATE OFFSET.
 *
 *   node --test usecase/telegram_update_ownership.test.js
 *
 * This is the invariant Telegram group detection depends on, and it is not
 * expressible as a unit test of any single module - it is a fact about the
 * whole repository, so it is asserted against the source.
 *
 * WHY IT MATTERS. `getUpdates(offset)` is not a read: passing the offset back
 * ACKNOWLEDGES every update before it, and Telegram then stops sending them.
 * Two callers therefore do not each receive a copy - they race, and each
 * silently eats updates the other needed. The visible symptom would be
 * password-reset linking failing perhaps one time in two, with nothing in any
 * log to say why, and `/setup` detection failing the other half of the time.
 *
 * So: `services/telegram.js` may DEFINE getUpdates, and exactly one usecase
 * may CALL it. Anything else that wants the update stream is handed messages
 * by that owner - which is what `onTelegramMessage` is for.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SKIP_DIRS = new Set(["node_modules", ".git", "migrations", "docs", "keys"]);

/** Every .js file in the backend except tests and the skipped trees. */
function sourceFiles(dir = ROOT, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      sourceFiles(full, out);
    } else if (entry.name.endsWith(".js") && !entry.name.endsWith(".test.js")) {
      out.push(path.relative(ROOT, full).replace(/\\/g, "/"));
    }
  }
  return out;
}

const files = sourceFiles();
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("the Telegram update stream", () => {
  it("is DEFINED in exactly one place", () => {
    const definers = files.filter((f) => /async getUpdates\s*\(/.test(strip(read(f))));
    assert.deepEqual(definers, ["services/telegram.js"]);
  });

  it("is CALLED by exactly one usecase - the password-reset poller", () => {
    const callers = files.filter((f) => {
      if (f === "services/telegram.js") return false;
      return /\.getUpdates\s*\(/.test(strip(read(f)));
    });
    assert.deepEqual(
      callers,
      ["usecase/passwordReset.js"],
      "a second getUpdates caller would race the first for the shared offset"
    );
  });

  it("is polled by exactly one cron job", () => {
    const server = strip(read("server.js"));
    const polls = server.match(/pollTelegramUpdates\s*\(/g) || [];
    assert.equal(polls.length, 1, "one scheduled poller, not two");
  });

  it("DETECTION FETCHES NOTHING - it is handed messages by the owner", () => {
    const detection = strip(read("usecase/telegram_group_detection.js"));
    assert.ok(!/getUpdates/.test(detection), "detection must never call getUpdates");
    assert.ok(!/setInterval|cron|schedule/i.test(detection), "detection schedules nothing");
    assert.ok(/handleMessage/.test(detection), "it receives messages instead");
  });

  it("the owner hands every update to the dispatcher, before its own branch", () => {
    const poll = strip(read("usecase/passwordReset.js"));
    const loopStart = poll.indexOf("for (const update of updates");
    assert.notEqual(loopStart, -1);
    const body = poll.slice(loopStart, poll.indexOf("return { code: 200, linked }", loopStart));
    const dispatchAt = body.indexOf("this.onTelegramUpdate");
    const linkAt = body.indexOf("parseStartPayload");
    assert.ok(dispatchAt !== -1, "the dispatcher is called");
    assert.ok(
      dispatchAt < linkAt,
      "handlers see the update before the linking branch can `continue` past it"
    );
  });

  it("IT IS HANDED THE WHOLE UPDATE, not just the message", () => {
    const poll = strip(read("usecase/passwordReset.js"));
    assert.match(
      poll,
      /this\.onTelegramUpdate\(update\)/,
      "a join request carries no message, so handlers must receive the update itself"
    );
  });

  it("a dispatcher failure cannot stop linking", () => {
    const poll = strip(read("usecase/passwordReset.js"));
    const call = /if \(this\.onTelegramUpdate\) \{([\s\S]*?)\n        \}/.exec(poll);
    assert.ok(call, "the dispatch call is guarded");
    assert.match(call[1], /try \{/, "it is wrapped in try/catch");
    assert.match(call[1], /catch \(err\)/);
  });

  it("THE CLAIM IS CHECKED AFTER DISPATCH AND BEFORE THE /start BRANCH", () => {
    // This ordering is the whole contract: a `/start` another feature owns
    // must not also be answered here with "that link has expired".
    const poll = strip(read("usecase/passwordReset.js"));
    const loopStart = poll.indexOf("for (const update of updates");
    const body = poll.slice(loopStart, poll.indexOf("return { code: 200, linked }", loopStart));
    const dispatchAt = body.indexOf("this.onTelegramUpdate");
    const claimAt = body.indexOf("if (claimed) continue;");
    const linkAt = body.indexOf("parseStartPayload");
    assert.ok(claimAt !== -1, "the claim is honoured");
    assert.ok(dispatchAt < claimAt && claimAt < linkAt, "dispatch, then claim, then link");
  });

  it("the legacy observer name is still accepted, for one release", () => {
    const poll = strip(read("usecase/passwordReset.js"));
    assert.match(
      poll,
      /deps\.onTelegramMessage/,
      "a stale wiring must keep working rather than deliver updates to nobody"
    );
  });

  it("the offset is still advanced for every update, acted on or not", () => {
    // If detection ever stopped this, an unhandled message would be replayed
    // forever and the poller would never move past it.
    const poll = strip(read("usecase/passwordReset.js"));
    const loopStart = poll.indexOf("for (const update of updates");
    const body = poll.slice(loopStart);
    const offsetAt = body.indexOf("this.updateOffset = Math.max");
    const dispatchAt = body.indexOf("this.onTelegramUpdate");
    assert.ok(offsetAt !== -1 && offsetAt < dispatchAt, "the offset advances first");
  });
});

describe("the dispatcher", () => {
  it("FETCHES NOTHING and schedules nothing - it is handed updates by the owner", () => {
    const src = strip(read("usecase/telegram_update_dispatcher.js"));
    assert.ok(!/getUpdates/.test(src), "the dispatcher must never call getUpdates");
    assert.ok(!/setInterval|cron|schedule/i.test(src), "it schedules nothing");
    assert.ok(!/updateOffset|offset/i.test(src), "and it holds no cursor of its own");
  });

  it("is registered with handlers in ONE place - server.js, at wiring time", () => {
    const registrars = files.filter((f) => /telegramUpdateDispatcher\.register\(/.test(strip(read(f))));
    assert.deepEqual(registrars, ["server.js"], "handlers are wired once, never at runtime");
  });

  it("group detection is registered as an OBSERVER - it claims no deep link", () => {
    const server = strip(read("server.js"));
    const block = /name: "telegram_group_detection"[\s\S]*?\}\);/.exec(server);
    assert.ok(block, "detection is registered on the dispatcher");
    assert.ok(
      !/claims\s*:/.test(block[0]),
      "a claim here would suppress password-reset linking for every /start"
    );
  });

  it("the EMPLOYEE handler claims by namespace", () => {
    const server = strip(read("server.js"));
    const block = /name: "employee_telegram_link"[\s\S]*?\}\);/.exec(server);
    assert.ok(block, "the employee handler is registered on the dispatcher");
    assert.match(block[0], /claims\s*:/, "it declares a claim predicate");
    assert.match(block[0], /updateTypes: \["message"\]/);
  });

  it("the HOME MENU handler claims plain /start, and declares its type", () => {
    const server = strip(read("server.js"));
    const block = /name: "telegram_employee_menu"[\s\S]*?\}\);/.exec(server);
    assert.ok(block, "the menu handler is registered on the dispatcher");
    assert.match(block[0], /claims\s*:/, "it declares a claim predicate");
    assert.match(block[0], /updateTypes: \["message"\]/);
  });

  it("NO TWO CLAIMERS CAN CLAIM THE SAME UPDATE - the invariant itself", () => {
    // ================================================================
    // THIS WAS A COUNT, TWICE OVER, AND IS NOW THE INVARIANT IT STOOD IN FOR.
    //
    // First it counted every `claims:` in the wiring, back when only the
    // employee deep link claimed anything. Phase 3B legitimately claimed
    // `chat_join_request`, so it became a count PER TYPE - because
    // `_resolveClaim` resolves ownership only among the handlers registered
    // for that type.
    //
    // The home menu now legitimately claims `message` alongside the employee
    // deep link, and "one claimer per type" would fail it. But that count was
    // never the property worth having: what the dispatcher logs as a
    // CLAIM-CONFLICT, and what would actually hurt, is TWO HANDLERS CLAIMING
    // ONE UPDATE. Two claimers on the same type are perfectly safe when their
    // predicates cannot both match - and are a bug when they can, which a
    // count can detect in neither direction.
    //
    // So this now RUNS THE REAL PREDICATES over a corpus of representative
    // updates and asserts no update is ever claimed twice. A third `message`
    // claimer that overlapped either existing one would fail this; one that
    // genuinely could not would pass, correctly.
    // ================================================================
    const server = strip(read("server.js"));
    const registrations = server.match(/\.register\(\{[\s\S]*?\n    \}\);/g) || [];
    assert.ok(registrations.length >= 4, `expected the dispatcher registrations, saw ${registrations.length}`);

    const claimersByType = new Map();
    for (const block of registrations) {
      if (!/claims\s*:/.test(block)) continue;
      const types = /updateTypes:\s*\[([^\]]*)\]/.exec(block);
      assert.ok(types, `a claiming handler must declare its update types: ${block.slice(0, 60)}`);
      const name = (/name:\s*"([^"]+)"/.exec(block) || [])[1];
      for (const raw of types[1].split(",")) {
        const type = raw.trim().replace(/^["']|["']$/g, "");
        if (!type) continue;
        claimersByType.set(type, [...(claimersByType.get(type) || []), name]);
      }
    }

    // The claimers we expect, by type. A NEW one appearing here without this
    // test being updated is exactly the review moment worth having.
    assert.deepEqual(
      Object.fromEntries([...claimersByType.entries()].map(([k, v]) => [k, v.sort()])),
      {
        message: [
          "attendance_shift_change",
          "employee_telegram_link",
          "telegram_employee_menu",
        ],
        chat_join_request: ["employee_telegram_join_request"],
        callback_query: ["attendance_shift_change"],
      }
    );

    // ---- the real predicates, over a corpus ----
    const menu = require("../usecase/telegram_employee_menu")({
      identityRepo: { getActiveIdentityByTelegramUser: async () => null },
      telegram: { sendMessage: async () => ({}) },
      getMiniAppUrl: () => null,
    });
    const link = require("../usecase/employee_telegram_link")(
      { getEmployeeForVerification: async () => null },
      { sendMessage: async () => ({}) }
    );
    // The shift request claims a `message` ONLY when it is a reply to its own
    // reject prompt, which is why it can share the type with the two above.
    const shift = require("../usecase/attendance_shift_change_telegram")({
      regularizationUsecase: {},
      employeeTelegramRepo: {},
      telegram: { isConfigured: () => false, sendMessage: async () => ({}) },
    });

    const privateMsg = (text, extra = {}) => ({
      message: { chat: { id: 1, type: "private" }, from: { id: 5 }, text, ...extra },
    });
    const corpus = [
      privateMsg("/start"),
      privateMsg("/start "),
      privateMsg("/start@dnds_bot"),
      privateMsg("/start e_abcdef"),
      privateMsg(`/start ${"a".repeat(48)}`),
      privateMsg("/start one two"),
      privateMsg("/setup"),
      privateMsg("hello"),
      // A reply to the reject prompt, and a reply to something else - the
      // second must be claimed by nobody rather than by the shift handler.
      privateMsg("Not enough cover that day", {
        reply_to_message: { text: "Reject shift request #77\n\nReply to this message with the reason." },
      }),
      privateMsg("Not enough cover that day", { reply_to_message: { text: "Some other message" } }),
      privateMsg(undefined, { contact: { phone_number: "1" } }),
      { message: { chat: { id: -100, type: "supergroup" }, from: { id: 5 }, text: "/start" } },
      { message: { chat: { id: -100, type: "group" }, from: { id: 5 }, text: "/setup" } },
      {},
      { message: null },
    ];

    const messageClaimers = [
      ["telegram_employee_menu", (u) => menu.claims(u)],
      ["employee_telegram_link", (u) => link.claims(u)],
      ["attendance_shift_change", (u) => shift.claims(u)],
    ];

    for (const update of corpus) {
      const owners = messageClaimers.filter(([, p]) => p(update) === true).map(([n]) => n);
      assert.ok(
        owners.length <= 1,
        `${JSON.stringify(update)} claimed by ${owners.join(" AND ")} - a CLAIM-CONFLICT`
      );
    }

    // Not vacuous: each claimer really does own its own case.
    assert.equal(menu.claims(privateMsg("/start")), true);
    assert.equal(link.claims(privateMsg("/start e_abcdef")), true);
    assert.equal(
      shift.claims(
        privateMsg("Not enough cover that day", {
          reply_to_message: { text: "Reject shift request #77" },
        })
      ),
      true
    );
    assert.equal(shift.claims({ callback_query: { data: "sc:77:A" } }), true);
    assert.equal(shift.claims({ callback_query: { data: "approve_po_5" } }), false);
  });

  it("THE CLAIM PREDICATE IS SYNCHRONOUS AND TOUCHES NO REPOSITORY", () => {
    // The dispatcher decides ownership BEFORE any handler runs precisely so a
    // crash cannot hand an employee deep link back to password reset. A
    // predicate that awaited a database read could not offer that, and a slow
    // database would start producing false expired-link replies.
    const src = strip(read("usecase/employee_telegram_link.js"));
    const claims = /\n  claims\(update\) \{([\s\S]*?)\n  \}/.exec(src);
    assert.ok(claims, "claims() is defined");
    assert.ok(!/await|async|this\.repo|Promise/.test(claims[1]), "it is pure and synchronous");
  });

  it("asks Telegram for the approved update types and NOTHING else", () => {
    const service = strip(read("services/telegram.js"));
    const list = /const ALLOWED_UPDATES = (\[[^\]]*\])/.exec(service);
    assert.ok(list, "the allowed updates are one named constant");
    assert.deepEqual(JSON.parse(list[1].replace(/'/g, '"')), [
      "message",
      "chat_join_request",
      // The shift request's Approve / Reject buttons. A callback query exists
      // only when somebody taps a button this backend put there, so it adds
      // no ambient traffic to the one stream.
      "callback_query",
    ]);
    assert.ok(
      !/chat_member/.test(list[1]),
      "chat_member belongs to the membership phase that consumes it"
    );
  });
});

describe("the bot token", () => {
  it("is read only by the Telegram service, and never by detection or the routes", () => {
    for (const f of ["usecase/telegram_group_detection.js", "routes/telegram_group_registry.js"]) {
      const src = read(f);
      assert.ok(!/TELEGRAM_BOT_TOKEN|process\.env/.test(src), `${f} must not read the token or env`);
    }
  });

  it("is never logged by the detection path", () => {
    const detection = read("usecase/telegram_group_detection.js");
    assert.ok(!/token/i.test(detection.replace(/linkToken|link token/gi, "")));
  });
});
