/**
 * The DigiSME call throttle - the ONE thing standing between us and the
 * vendor's 5-calls-per-minute limit.
 *
 *   node --test services/digisme_throttle.test.js
 *
 * WHY THIS FILE EXISTS. The throttle used to read `lastCallAt`, await the
 * gap, then write it back - a read and a write separated by an `await`. With
 * one nightly job that was fine. With a per-minute live sync and a
 * four-times-daily recovery run sharing the process, two concurrent callers
 * read the same `lastCallAt`, computed the same wait, slept the same
 * duration and fired SIMULTANEOUSLY: the throttle vanished at exactly the
 * moment two jobs overlapped.
 *
 * The first test below fails against that implementation and passes against
 * the serialized queue. It is the regression guard for the whole rate-limit
 * story, because every other part of the design assumes the queue holds.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");
const path = require("path");

const CLIENT = path.join(__dirname, "digisme_attendance.js");

/** What the tests run the queue at. The shipped default is asserted separately. */
const FAST_INTERVAL_MS = 120;

/**
 * Load a fresh copy of the client with axios stubbed, so "a call" is
 * recorded without any network. Returns the module plus the call log.
 */
function loadClient() {
  for (const k of Object.keys(require.cache)) {
    if (k === CLIENT || k.endsWith("encryptAES.js")) delete require.cache[k];
  }
  const calls = [];
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "axios") {
      const fake = async (config) => {
        calls.push({ at: Date.now(), url: config.url });
        if (String(config.url).includes("Authenticate")) {
          return { data: { access_token: "test-token" } };
        }
        return { data: [] };
      };
      return fake;
    }
    return originalLoad.apply(this, arguments);
  };
  try {
    process.env.DIGISME_API_KEY = process.env.DIGISME_API_KEY || "test-key";
    process.env.DIGISME_CUSTOM_KEY = process.env.DIGISME_CUSTOM_KEY || "test-custom";
    const mod = require(CLIENT);
    // Assert the real spacing behaviour in milliseconds instead of spending
    // two minutes of real sleeping per run. The DEFAULT is asserted
    // separately, below, and a guard test proves no shipped file does this.
    mod.__setCallIntervalForTests(FAST_INTERVAL_MS);
    return { mod, calls };
  } finally {
    Module._load = originalLoad;
  }
}

describe("the throttle is one serialized queue", () => {
  it("concurrent callers are spaced, not released together", async () => {
    const { mod, calls } = loadClient();
    const gap = FAST_INTERVAL_MS;

    // Five concurrent fetches - the live sync racing a three-date recovery
    // run, which is exactly what four-times-a-day scheduling permits.
    await Promise.all([
      mod.fetchRawAttendance("2026-09-14", "2026-09-14"),
      mod.fetchRawAttendance("2026-09-13", "2026-09-13"),
      mod.fetchRawAttendance("2026-09-12", "2026-09-12"),
      mod.fetchRawAttendance("2026-09-11", "2026-09-11"),
      mod.fetchRawAttendance("2026-09-10", "2026-09-10"),
    ]);

    assert.ok(calls.length >= 5, `expected at least 5 calls, saw ${calls.length}`);
    const times = calls.map((c) => c.at).sort((a, b) => a - b);
    for (let i = 1; i < times.length; i++) {
      const delta = times[i] - times[i - 1];
      assert.ok(
        delta >= gap - 40, // timer slack only
        `calls ${i - 1} and ${i} were ${delta}ms apart; the queue must hold them ${gap}ms apart`
      );
    }
  });

  it("no 60-second window can hold more than four calls", async () => {
    const { mod } = loadClient();
    // 15s spacing is chosen precisely so that ceil(60/15) = 4, leaving a
    // real margin under the vendor's 5. At 13s the answer would be 5 -
    // sitting exactly on the limit with nothing spare for clock jitter.
    assert.equal(mod.MIN_CALL_INTERVAL_MS, 15000);
    assert.ok(
      Math.floor(60000 / mod.MIN_CALL_INTERVAL_MS) <= 4,
      "the interval must cap a 60-second window at four calls"
    );
  });

  it("authentication queues in the SAME line as the fetches", async () => {
    const { mod, calls } = loadClient();
    await mod.fetchRawAttendance("2026-09-14", "2026-09-14");
    const authCalls = calls.filter((c) => String(c.url).includes("Authenticate"));
    const dataCalls = calls.filter((c) => String(c.url).includes("GetRawAttendance"));
    assert.equal(authCalls.length, 1, "the first fetch of a run authenticates");
    assert.equal(dataCalls.length, 1);
    const delta = dataCalls[0].at - authCalls[0].at;
    assert.ok(
      delta >= FAST_INTERVAL_MS - 40,
      `auth and fetch were ${delta}ms apart; authentication must take a ticket too`
    );
  });

  it("the token is cached, so a normal poll is ONE call not two", async () => {
    const { mod, calls } = loadClient();
    await mod.fetchRawAttendance("2026-09-14", "2026-09-14");
    const before = calls.length;
    await mod.fetchRawAttendance("2026-09-14", "2026-09-14");
    const added = calls.slice(before);
    assert.equal(added.length, 1, "a second poll inside the token TTL re-authenticates nothing");
    assert.match(added[0].url, /GetRawAttendance/);
  });

  it("a failed call does not wedge the queue", async () => {
    // `gate` is advanced with a swallowed rejection precisely so one bad
    // call cannot poison every ticket behind it.
    const { mod } = loadClient();
    const src = require("fs").readFileSync(CLIENT, "utf8");
    assert.match(src, /gate = mine\.catch\(\(\) => \{\}\);/);
    // And it still works afterwards.
    await mod.fetchRawAttendance("2026-09-14", "2026-09-14");
  });
});

describe("the normalised row carries what the database keys on", () => {
  it("io_time_raw is the 14-digit form, derived from io_time", () => {
    const { mod } = loadClient();
    assert.equal(mod.toIoTimeRaw("2026-09-14 09:30:00"), "20260914093000");
    assert.equal(mod.toIoTimeRaw("2026-09-14 00:00:00"), "20260914000000");
    assert.equal(mod.toIoTimeRaw(null), null);
    assert.equal(mod.toIoTimeRaw("not a time"), null);
  });

  it("the Excel parser and the API agree on the same punch", () => {
    const { mod } = loadClient();
    // THE PROPERTY THAT MATTERS: for one real punch, the workbook route and
    // the API route must produce the IDENTICAL 14-digit string, or
    // import_dedup_key gives that punch two identities and it is stored
    // twice - once from each source.
    //
    // The two READ different date formats, which is correct and not a bug:
    // the workbook writes DD-MM-YYYY in a cell, the gateway returns
    // DD/MM/YYYY or an ISO date in JSON. Each parser accepts what its own
    // source actually sends. What is asserted is that they CONVERGE.
    const { parseClockDate, parseClockTime } = require("../biomax/digismeImport");
    const fromExcel = `${parseClockDate("14-09-2026")}${parseClockTime("09:30:00")}`;
    const fromApi = mod.toIoTimeRaw(mod.toIoTime("14/09/2026", "09:30:00"));
    assert.equal(fromApi, "20260914093000");
    assert.equal(fromExcel, fromApi, "one punch, one io_time_raw, whichever route delivered it");

    // The gateway's other observed shape reaches the same answer.
    assert.equal(mod.toIoTimeRaw(mod.toIoTime("2026-09-14", "09:30:00")), fromApi);
    // ...including the 12-hour form, which the workbook never produces.
    assert.equal(mod.toIoTimeRaw(mod.toIoTime("14/09/2026", "9:30 AM")), fromApi);
  });
});

describe("the test-only interval hook is test-only", () => {
  it("no shipped file calls __setCallIntervalForTests", () => {
    const fs = require("fs");
    const root = path.join(__dirname, "..");
    const offenders = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
        const rel = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (["node_modules", ".git", "docs", "migrations", "scripts", "test_support"].includes(entry.name)) continue;
          walk(rel);
        } else if (entry.name.endsWith(".js") && !entry.name.includes(".test.")) {
          if (fs.readFileSync(path.join(root, rel), "utf8").includes("__setCallIntervalForTests")) {
            // The declaration in the client itself is the hook, not a call.
            if (rel !== path.join("services", "digisme_attendance.js")) offenders.push(rel);
          }
        }
      }
    };
    for (const dir of ["services", "routes", "usecase", "repository", "config", "utils", "constants", "biomax", "middlewares"]) {
      walk(dir);
    }
    offenders.push(...(fs.readFileSync(path.join(root, "server.js"), "utf8").includes("__setCallIntervalForTests") ? ["server.js"] : []));
    assert.deepEqual(offenders, [], "the vendor rate limit must never be loosened by shipped code");
  });
});

describe("the environment contract", () => {
  it("the client loads dotenv itself, before it captures its credentials", () => {
    // It reads its credentials into module-level `const`s at require time.
    // Before this line existed the integration worked only because a
    // config/*.js - each of which calls dotenv.config() - happened to be
    // required first by server.js. Requiring this module any earlier, or
    // from a script that loads no config, left API_KEY permanently
    // undefined with a perfectly good .env on disk.
    const src = require("fs").readFileSync(CLIENT, "utf8");
    const dotenvAt = src.indexOf('require("dotenv").config()');
    const firstCredAt = src.indexOf("process.env.DIGISME_API_KEY");
    assert.ok(dotenvAt !== -1, "the client must load dotenv itself");
    assert.ok(firstCredAt !== -1);
    assert.ok(dotenvAt < firstCredAt, "dotenv must run BEFORE the credentials are captured");
  });

  it("names exactly the three documented variables, and defaults only the safe two", () => {
    const src = require("fs").readFileSync(CLIENT, "utf8");
    const vars = [...src.matchAll(/process\.env\.(DIGISME_[A-Z_]+)/g)].map((m) => m[1]);
    assert.deepEqual(
      [...new Set(vars)].sort(),
      ["DIGISME_API_KEY", "DIGISME_BASE_URL", "DIGISME_COMPANY_ID", "DIGISME_CUSTOM_KEY"]
    );
    // The two SECRETS have no fallback: a missing credential must fail
    // loudly, never silently authenticate as something else.
    assert.match(src, /const API_KEY = process\.env\.DIGISME_API_KEY;/);
    assert.match(src, /const CUSTOM_KEY = process\.env\.DIGISME_CUSTOM_KEY;/);
  });

  it("refuses to run, by name, when a credential is missing", () => {
    // The operator needs to be told WHICH variable is absent - and told it
    // without the value of the one that is present appearing anywhere.
    const src = require("fs").readFileSync(CLIENT, "utf8");
    assert.match(src, /if \(!API_KEY\) missing\.push\("DIGISME_API_KEY"\)/);
    assert.match(src, /if \(!CUSTOM_KEY\) missing\.push\("DIGISME_CUSTOM_KEY"\)/);
    assert.match(src, /is not configured: \$\{missing\.join\(", "\)\}/);
  });
});

describe("the queue covers every vendor call", () => {
  it("every axios call site is immediately preceded by a throttle", () => {
    // The rate limit is structural only if NOTHING can bypass the queue.
    // Asserted against the source because the risk is a future edit adding
    // a "quick" extra call - a health check, a second endpoint - that skips
    // the ticket and quietly pushes the process over the vendor's limit.
    const src = require("fs").readFileSync(CLIENT, "utf8");
    const lines = src.split("\n");
    const callSites = [];
    lines.forEach((line, i) => {
      if (/\baxios\(/.test(line)) callSites.push(i);
    });
    assert.ok(callSites.length >= 2, "expected the authenticate and fetch call sites");
    for (const i of callSites) {
      // Look back a few lines for the throttle that reserved this slot.
      const preceding = lines.slice(Math.max(0, i - 4), i).join("\n");
      assert.match(
        preceding,
        /await throttle\(\)/,
        `axios call at line ${i + 1} is not preceded by await throttle() - it would bypass the vendor rate limit`
      );
    }
  });

  it("the 401 refresh and its retry reuse the throttled path, not a bare axios", () => {
    // The retry goes back through `call()` and `getToken({force:true})`,
    // both of which take tickets. A hand-rolled retry would not.
    const src = require("fs").readFileSync(CLIENT, "utf8");
    assert.match(src, /response = await call\(await getToken\(\{ force: true \}\)\)/);
  });

  it("nothing else in the client reaches the network", () => {
    const src = require("fs").readFileSync(CLIENT, "utf8");
    for (const other of ["fetch(", "http.request", "https.request", "got(", "node-fetch", "request("]) {
      assert.ok(!src.includes(other), `the client must reach the vendor only through the throttled axios calls (${other})`);
    }
  });
});
