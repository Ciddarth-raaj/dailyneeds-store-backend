/**
 * A CRON SCHEDULE WITH THE WRONG NUMBER OF FIELDS MUST BE REFUSED, LOUDLY.
 *
 *   node --test services/cron_service_field_count.test.js
 *
 * `cron.validate` does not check field count. Handed seven fields it answers
 * true and node-cron schedules something anyway, on a cadence nobody asked
 * for. While every schedule in this repository had five fields, an extra one
 * was obvious on sight. The Telegram poller now legitimately uses six, so the
 * gap between a correct six and a typo'd seven is one character - and the
 * failure mode is a job that runs, silently, on the wrong clock.
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const cron = require("node-cron");
const CronService = require("./cron_service");

let errors = [];
let logs = [];
let realError;
let realLog;
let scheduled = [];
let realSchedule;

beforeEach(() => {
  errors = [];
  logs = [];
  scheduled = [];
  realError = console.error;
  realLog = console.log;
  console.error = (...a) => errors.push(a.join(" "));
  console.log = (...a) => logs.push(a.join(" "));
  realSchedule = cron.schedule;
  cron.schedule = (expression) => {
    scheduled.push(expression);
    return { stop() {} };
  };
});

afterEach(() => {
  console.error = realError;
  console.log = realLog;
  cron.schedule = realSchedule;
});

const startWith = (schedule) => {
  const service = new CronService();
  service.register("a_job", schedule, () => {});
  service.start();
  return service;
};

describe("field count", () => {
  it("accepts five fields - every existing schedule in the repo", () => {
    startWith("*/5 * * * *");
    assert.deepEqual(scheduled, ["*/5 * * * *"]);
    assert.deepEqual(errors, []);
  });

  it("accepts six fields - the Telegram poller's seconds-precision schedule", () => {
    startWith("*/3 * * * * *");
    assert.deepEqual(scheduled, ["*/3 * * * * *"]);
    assert.deepEqual(errors, []);
  });

  it("REFUSES seven fields, which cron.validate does not", () => {
    // The precondition for this test existing at all.
    assert.equal(cron.validate("*/3 * * * * * *"), true, "validate still waves it through");
    startWith("*/3 * * * * * *");
    assert.deepEqual(scheduled, [], "nothing may be scheduled from a malformed expression");
    assert.equal(errors.length, 1);
    assert.match(errors[0], /a_job/, "the job's name must be in the message");
    assert.match(errors[0], /expected 5 fields/);
  });

  it("refuses four fields", () => {
    startWith("* * * *");
    assert.deepEqual(scheduled, []);
    assert.equal(errors.length, 1);
  });

  it("refuses an empty or missing schedule instead of throwing", () => {
    startWith("");
    startWith("   ");
    startWith(undefined);
    assert.deepEqual(scheduled, []);
    assert.equal(errors.length, 3);
  });

  it("tolerates irregular spacing in an otherwise valid schedule", () => {
    startWith("  */3   *  * * * * ");
    assert.equal(scheduled.length, 1, "whitespace is not a field");
    assert.deepEqual(errors, []);
  });

  it("a genuinely invalid six-field expression is still caught by cron.validate", () => {
    startWith("*/3 * * * * notaday");
    assert.deepEqual(scheduled, []);
    assert.equal(errors.length, 1);
  });

  it("one bad job does not stop the good ones", () => {
    const service = new CronService();
    service.register("bad", "* * * * * * *", () => {});
    service.register("good", "*/3 * * * * *", () => {});
    service.start();
    assert.deepEqual(scheduled, ["*/3 * * * * *"]);
    assert.equal(errors.length, 1);
  });
});

describe("CRON_DISABLED still short-circuits everything", () => {
  it("schedules nothing and validates nothing", () => {
    const previous = process.env.CRON_DISABLED;
    process.env.CRON_DISABLED = "true";
    try {
      startWith("* * * * * * *");
      assert.deepEqual(scheduled, []);
      assert.deepEqual(errors, [], "a disabled job is not a misconfigured one");
      assert.equal(logs.length, 1);
    } finally {
      if (previous === undefined) delete process.env.CRON_DISABLED;
      else process.env.CRON_DISABLED = previous;
    }
  });
});
