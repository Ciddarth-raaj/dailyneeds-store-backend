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

  it("the owner hands every message to the observer, before its own branch", () => {
    const poll = strip(read("usecase/passwordReset.js"));
    const loopStart = poll.indexOf("for (const update of updates");
    assert.notEqual(loopStart, -1);
    const body = poll.slice(loopStart, poll.indexOf("return { code: 200, linked }", loopStart));
    const observerAt = body.indexOf("this.onTelegramMessage");
    const linkAt = body.indexOf("parseStartPayload");
    assert.ok(observerAt !== -1, "the observer is called");
    assert.ok(
      observerAt < linkAt,
      "the observer sees the message before the linking branch can `continue` past it"
    );
  });

  it("an observer failure cannot stop linking", () => {
    const poll = strip(read("usecase/passwordReset.js"));
    const call = /if \(this\.onTelegramMessage && message\) \{([\s\S]*?)\n        \}/.exec(poll);
    assert.ok(call, "the observer call is guarded");
    assert.match(call[1], /try \{/, "it is wrapped in try/catch");
    assert.match(call[1], /catch \(err\)/);
  });

  it("the offset is still advanced for every update, acted on or not", () => {
    // If detection ever stopped this, an unhandled message would be replayed
    // forever and the poller would never move past it.
    const poll = strip(read("usecase/passwordReset.js"));
    const loopStart = poll.indexOf("for (const update of updates");
    const body = poll.slice(loopStart);
    const offsetAt = body.indexOf("this.updateOffset = Math.max");
    const observerAt = body.indexOf("this.onTelegramMessage");
    assert.ok(offsetAt !== -1 && offsetAt < observerAt, "the offset advances first");
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
