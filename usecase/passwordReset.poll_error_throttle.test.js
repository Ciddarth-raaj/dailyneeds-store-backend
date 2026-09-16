/**
 * A FAILING TELEGRAM POLL MUST NOT WRITE TWENTY IDENTICAL LINES A MINUTE.
 *
 *   node --test usecase/passwordReset.poll_error_throttle.test.js
 *
 * The poller ticks every three seconds, and the things that make getUpdates
 * fail do not flicker: a webhook registered on the bot stays registered until
 * somebody removes it, a revoked token stays revoked, a blocked egress route
 * stays blocked. One ERROR line per tick is therefore 28,800 identical lines
 * a day, which does not make the fault more visible - it hides every other
 * error in the file behind it.
 *
 * THE FIRST FAILURE IS NEVER DELAYED. It is the one that says what broke.
 * What is collapsed is the repetition, and it is COUNTED rather than thrown
 * away, so the log still says how long it went on.
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const logger = require("../utils/logger");
const buildPasswordReset = require("./passwordReset");

let lines = [];
let realLog;

beforeEach(() => {
  lines = [];
  realLog = logger.Log;
  logger.Log = (entry) => lines.push(entry);
});
afterEach(() => {
  logger.Log = realLog;
});

const pollLines = () => lines.filter((l) => l.code === "USECASE.PASSWORD-RESET.POLL");
const recoveryLines = () => lines.filter((l) => l.code === "USECASE.PASSWORD-RESET.POLL-RECOVERED");

/**
 * A usecase whose clock and getUpdates outcome the test drives directly.
 * `clock.ms` is the wall clock; `state.fail` is what getUpdates does next.
 */
const build = () => {
  const clock = { ms: 1_700_000_000_000 };
  const state = { fail: null };
  const telegram = {
    getBotUsername: async () => "dnds_bot",
    sendMessage: async () => ({ code: 200 }),
    getUpdates: async () => {
      if (state.fail) throw new Error(state.fail);
      return [];
    },
  };
  const usecase = buildPasswordReset({}, {}, telegram, { now: () => new Date(clock.ms) });
  return { usecase, clock, state };
};

/** Tick the poller `count` times, three seconds apart, as the cron does. */
const tick = async (ctx, count) => {
  for (let i = 0; i < count; i += 1) {
    await ctx.usecase.pollTelegramUpdates();
    ctx.clock.ms += 3000;
  }
};

describe("a persistent failure", () => {
  it("logs the FIRST one immediately, in full", async () => {
    const ctx = build();
    ctx.state.fail = "409 Conflict: webhook is active";
    const result = await ctx.usecase.pollTelegramUpdates();

    assert.equal(result.code, 500);
    assert.equal(pollLines().length, 1, "the first failure is never delayed");
    assert.match(pollLines()[0].description, /409 Conflict/);
    assert.match(pollLines()[0].description, /a webhook set on the bot blocks getUpdates/);
    assert.equal(pollLines()[0].level, logger.LEVEL.ERROR);
  });

  it("collapses a minute of identical failures to ONE line, not twenty", async () => {
    const ctx = build();
    ctx.state.fail = "409 Conflict: webhook is active";
    await tick(ctx, 20); // 60 seconds at the real cadence

    assert.equal(pollLines().length, 1, "twenty ticks, one line");
  });

  it("repeats once a minute while it is still broken, and says what it swallowed", async () => {
    const ctx = build();
    ctx.state.fail = "409 Conflict: webhook is active";
    await tick(ctx, 21); // just past the minute

    // Tick 1 logs at t=0. Ticks 2..20 land at t=3s..57s and are inside the
    // quiet minute, so NINETEEN are suppressed. Tick 21 is the first at t=60s
    // and reports them.
    const logged = pollLines();
    assert.equal(logged.length, 2, "silence forever would look like recovery");
    assert.match(logged[1].description, /still failing/);
    assert.match(logged[1].description, /19 identical failure\(s\) suppressed/);
  });

  it("never stops counting - an hour down is still one line a minute", async () => {
    const ctx = build();
    ctx.state.fail = "409 Conflict: webhook is active";
    await tick(ctx, 1200); // one hour

    const logged = pollLines();
    assert.ok(logged.length >= 59 && logged.length <= 61, `expected ~60 lines an hour, got ${logged.length}`);
  });

  it("every tick still returns the failure to its caller - only the LOG is throttled", async () => {
    const ctx = build();
    ctx.state.fail = "409 Conflict: webhook is active";
    for (let i = 0; i < 5; i += 1) {
      const result = await ctx.usecase.pollTelegramUpdates();
      assert.equal(result.code, 500, "suppressing a log line must not fake a success");
      assert.equal(result.linked, 0);
      ctx.clock.ms += 3000;
    }
  });
});

describe("a DIFFERENT failure is new information", () => {
  it("logs immediately even inside the quiet minute", async () => {
    const ctx = build();
    ctx.state.fail = "409 Conflict: webhook is active";
    await tick(ctx, 3);
    assert.equal(pollLines().length, 1);

    ctx.state.fail = "401 Unauthorized: bot token revoked";
    await ctx.usecase.pollTelegramUpdates();

    const logged = pollLines();
    assert.equal(logged.length, 2, "a new fault must not wait out the previous one's minute");
    assert.match(logged[1].description, /401 Unauthorized/);
    assert.ok(!/still failing/.test(logged[1].description), "it is not a repeat of anything");
  });

  it("then throttles the new one on its own clock", async () => {
    const ctx = build();
    ctx.state.fail = "409 Conflict";
    await tick(ctx, 1);
    ctx.state.fail = "401 Unauthorized";
    await tick(ctx, 10);

    assert.equal(pollLines().length, 2);
  });
});

describe("recovery", () => {
  it("is logged once, so the file says when it stopped", async () => {
    const ctx = build();
    ctx.state.fail = "409 Conflict";
    await tick(ctx, 10);
    ctx.state.fail = null;
    await tick(ctx, 5);

    const recovered = recoveryLines();
    assert.equal(recovered.length, 1, "going quiet is not the same as saying it recovered");
    assert.equal(recovered[0].level, logger.LEVEL.INFO);
    assert.match(recovered[0].description, /working again/);
    assert.match(recovered[0].description, /9 identical failure\(s\) suppressed/);
  });

  it("a healthy poller logs NOTHING - twenty ticks a minute stay silent", async () => {
    const ctx = build();
    await tick(ctx, 40);

    assert.deepEqual(lines, [], "the normal case must not write to the log at all");
  });

  it("a failure AFTER a recovery is logged immediately again", async () => {
    const ctx = build();
    ctx.state.fail = "409 Conflict";
    await tick(ctx, 2);
    ctx.state.fail = null;
    await tick(ctx, 2);
    ctx.state.fail = "409 Conflict";
    await tick(ctx, 1);

    assert.equal(pollLines().length, 2, "recovery resets the throttle; the same fault returning is news");
    assert.ok(!/still failing/.test(pollLines()[1].description));
  });
});

describe("the throttle leaks nothing and breaks nothing", () => {
  it("holds one failure's state, not a growing map", async () => {
    const ctx = build();
    for (let i = 0; i < 50; i += 1) {
      ctx.state.fail = `transient error ${i}`;
      await tick(ctx, 1);
    }
    assert.ok(ctx.usecase.pollFailure, "one slot");
    assert.equal(typeof ctx.usecase.pollFailure.description, "string");
    assert.equal(Object.keys(ctx.usecase.pollFailure).length, 3);
  });

  it("logs no token, chat id or update payload", async () => {
    const ctx = build();
    ctx.state.fail = "409 Conflict: webhook is active";
    await tick(ctx, 30);
    for (const line of lines) {
      assert.ok(!/start=/.test(line.description), "no deep-link token");
      assert.deepEqual(line.ref, {}, "no chat id or update reference");
    }
  });

  it("an unconfigured Telegram is skipped, not logged as a failure", async () => {
    const telegram = {
      isConfigured: () => false,
      getBotUsername: async () => "",
      getUpdates: async () => {
        throw new Error("must not be called");
      },
    };
    const usecase = buildPasswordReset({}, {}, telegram, {});
    const result = await usecase.pollTelegramUpdates();

    assert.equal(result.skipped, "not_configured");
    assert.deepEqual(lines, []);
  });
});
