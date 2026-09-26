/**
 * CronService tick rules added for DB backpressure (docs/api-db-backpressure.md).
 *
 *   node --test services/cron_service_backpressure.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const CronService = require("./cron_service");
const { currentContext } = require("../utils/db_admission");

const quiet = (fn) => {
  const log = console.log;
  console.log = () => {};
  try {
    return fn();
  } finally {
    console.log = log;
  }
};

describe("cron ticks under a sick database", () => {
  it("a tick arriving while the previous one still runs is skipped, not stacked", async () => {
    const svc = new CronService();
    let started = 0;
    let finish;
    const task = () => {
      started += 1;
      return new Promise((r) => (finish = r));
    };
    const first = svc._tick("purchase_acknowledgement_gofrugal_sync", task);
    for (let i = 0; i < 10; i += 1) quiet(() => svc._tick("purchase_acknowledgement_gofrugal_sync", task));
    await new Promise((r) => setImmediate(r)); // the task starts on the next microtask
    assert.equal(started, 1, "one run in flight, however many ticks");
    assert.equal(svc.stats().skips.purchase_acknowledgement_gofrugal_sync.overlap, 10);
    finish();
    await first;
    await svc._tick("purchase_acknowledgement_gofrugal_sync", async () => (started += 1));
    assert.equal(started, 2, "runs again once the previous tick is done");
  });

  it("while the database is unavailable a tick is skipped, and runs normally once it is back", async () => {
    const svc = new CronService();
    let down = true;
    svc.setDbUnavailableProbe(() => down);
    let ran = 0;
    for (let i = 0; i < 5; i += 1) quiet(() => svc._tick("attendance_recalculation_queue", async () => (ran += 1)));
    assert.equal(ran, 0);
    assert.equal(svc.stats().skips.attendance_recalculation_queue.db_unavailable, 5);
    down = false;
    await svc._tick("attendance_recalculation_queue", async () => (ran += 1));
    assert.equal(ran, 1);
  });

  it("the gate is per pool: a GoFrugal outage skips only the jobs that need GoFrugal", async () => {
    const svc = new CronService();
    const down = new Set(["gofrugal"]);
    svc.setDbUnavailableProbe((pool) => down.has(pool));
    let mainOnly = 0;
    let both = 0;
    await svc._tick("attendance_recalculation_queue", async () => (mainOnly += 1), ["main"]);
    quiet(() => svc._tick("purchase_acknowledgement_gofrugal_sync", async () => (both += 1), ["main", "gofrugal"]));
    assert.equal(mainOnly, 1, "a main-only job is not gated on GoFrugal");
    assert.equal(both, 0);
    down.clear();
    down.add("main");
    quiet(() => svc._tick("attendance_recalculation_queue", async () => (mainOnly += 1), ["main"]));
    quiet(() => svc._tick("purchase_acknowledgement_gofrugal_sync", async () => (both += 1), ["main", "gofrugal"]));
    assert.equal(mainOnly, 1);
    assert.equal(both, 0);
  });

  it("register() records the pools a job needs, default main", () => {
    const svc = new CronService();
    svc.register("a", "* * * * *", () => {});
    svc.register("b", "* * * * *", () => {}, { requires: ["main", "gofrugal"] });
    assert.deepEqual(svc.jobs.map((j) => j.requires), [["main"], ["main", "gofrugal"]]);
  });

  it("the gate is checked BEFORE the task starts (an external fetch never runs when its data could not be stored)", async () => {
    const svc = new CronService();
    svc.setDbUnavailableProbe(() => true);
    let fetched = false;
    quiet(() => svc._tick("telegram_link_poll", async () => { fetched = true; }));
    await new Promise((r) => setImmediate(r));
    assert.equal(fetched, false);
  });

  it("the task runs in the background DB lane", async () => {
    const svc = new CronService();
    let lane = null;
    await svc._tick("x", async () => {
      await Promise.resolve();
      lane = currentContext() && currentContext().lane;
    });
    assert.equal(lane, "background");
  });

  it("a task that throws is logged, never escapes, and does not wedge the job", async () => {
    const svc = new CronService();
    const err = console.error;
    console.error = () => {};
    try {
      await svc._tick("boom", () => {
        throw new Error("sync throw");
      });
      await svc._tick("boom", async () => {
        throw new Error("async throw");
      });
    } finally {
      console.error = err;
    }
    let ran = false;
    await svc._tick("boom", async () => (ran = true));
    assert.equal(ran, true);
  });
});
