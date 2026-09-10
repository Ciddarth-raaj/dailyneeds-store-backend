/**
 * The store's SQL, against a fake pool that records every statement.
 *
 *   node --test biomax/store.test.js
 *
 * What matters: io_time is converted by STR_TO_DATE from the raw string
 * inside the INSERT and no JS Date is ever bound (R3); dedup is the unique
 * key with a counter bump (R2); the derived row goes in the same transaction
 * and is skipped for a duplicate (R16); the reads ask for exactly the
 * columns date attribution may see (R18) and never for employee 0 (R5).
 */
const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const { createStore, SCHEDULE_CACHE_MS } = require("./store");

function fakePool() {
  const log = [];
  const responses = [];
  const conn = {
    query(sql, params, cb) {
      log.push({ sql: sql.replace(/\s+/g, " ").trim(), params });
      const next = responses.length ? responses.shift() : null;
      if (next instanceof Error) return cb(next);
      cb(null, next === null ? [] : next);
    },
    beginTransaction: (cb) => {
      log.push({ sql: "BEGIN" });
      cb(null);
    },
    commit: (cb) => {
      log.push({ sql: "COMMIT" });
      cb(null);
    },
    rollback: (cb) => {
      log.push({ sql: "ROLLBACK" });
      cb(null);
    },
    release: () => log.push({ sql: "RELEASE" }),
  };
  return {
    log,
    responses,
    query: conn.query,
    getConnection: (cb) => cb(null, conn),
  };
}

const punch = {
  dev_id: "C2695C56D30E1430",
  user_id: "1952",
  io_time_raw: "20260910135741",
  verify_mode: 1073741824,
  io_mode: 16777216,
  fk_bin_data_lib: "FKDataHS102",
  log_image_present: 0,
  cmd_id: "RTLogSendAction",
  blk_no: 0,
  blk_len: 144,
  content_length: 144,
  body_len_prefix: 140,
  raw_json: "{}",
  source_ip: "103.213.194.119",
  source_port: 51234,
};
const derived = {
  attendance_date: "2026-09-10",
  status: "OK",
  employee_id: 1952,
  home_outlet_id: 2,
  department_id: 4,
  work_shift_id: 7,
  work_shift_weekly_schedule_id: 703,
  cutoff_applied: "04:00:00",
};

describe("insertPunch", () => {
  let pool;
  let store;
  beforeEach(() => {
    pool = fakePool();
    store = createStore(pool);
  });

  it("converts io_time with STR_TO_DATE from the raw string and binds no Date", async () => {
    pool.responses.push({ affectedRows: 1, insertId: 42 }, {});
    const r = await store.insertPunch(punch, derived);
    assert.deepEqual(r, { outcome: "stored", biomax_punch_id: 42 });

    const insert = pool.log.find((l) => l.sql.startsWith("INSERT INTO biomax_punch ("));
    assert.match(insert.sql, /STR_TO_DATE\(\?, '%Y%m%d%H%i%s'\)/);
    assert.match(insert.sql, /ON DUPLICATE KEY UPDATE retransmit_count = retransmit_count \+ 1, last_retransmit_at = NOW\(3\)/);
    assert.equal(insert.params[2], "20260910135741");
    assert.equal(insert.params[3], "20260910135741");
    for (const p of insert.params) assert.ok(!(p instanceof Date), "no Date bound");
    assert.equal(insert.params[1], "1952");
  });

  it("writes the derived row in the same transaction, with the date as a string", async () => {
    pool.responses.push({ affectedRows: 1, insertId: 42 }, {});
    await store.insertPunch(punch, derived);
    const sqls = pool.log.map((l) => l.sql);
    assert.equal(sqls[0], "BEGIN");
    assert.ok(sqls[1].startsWith("INSERT INTO biomax_punch ("));
    assert.ok(sqls[2].startsWith("INSERT INTO biomax_punch_derived"));
    assert.equal(sqls[3], "COMMIT");
    assert.equal(sqls[4], "RELEASE");
    const d = pool.log[2];
    assert.deepEqual(d.params, [42, "2026-09-10", "OK", 1952, 2, 4, 7, 703, "04:00:00"]);
    assert.match(d.sql, /derivation_run_id\) VALUES \(\?, \?, \?, \?, \?, \?, \?, \?, \?, NOW\(3\), NULL\)/);
  });

  it("a duplicate (affectedRows 2) writes no derived row and reports duplicate", async () => {
    pool.responses.push({ affectedRows: 2, insertId: 0 });
    const r = await store.insertPunch(punch, derived);
    assert.deepEqual(r, { outcome: "duplicate", biomax_punch_id: null });
    assert.ok(!pool.log.some((l) => l.sql.startsWith("INSERT INTO biomax_punch_derived")));
    assert.ok(pool.log.some((l) => l.sql === "COMMIT"));
  });

  it("rolls back and rethrows when the derived insert fails, so nothing is ACKed", async () => {
    pool.responses.push({ affectedRows: 1, insertId: 42 }, new Error("boom"));
    await assert.rejects(() => store.insertPunch(punch, derived), /boom/);
    assert.ok(pool.log.some((l) => l.sql === "ROLLBACK"));
    assert.equal(pool.log[pool.log.length - 1].sql, "RELEASE");
  });

  it("stores a null attendance_date for an undatable punch", async () => {
    pool.responses.push({ affectedRows: 1, insertId: 1 }, {});
    await store.insertPunch(punch, { ...derived, attendance_date: null, status: "NO_SHIFT", work_shift_id: null, work_shift_weekly_schedule_id: null, cutoff_applied: null });
    assert.deepEqual(pool.log[2].params, [1, null, "NO_SHIFT", 1952, 2, 4, null, null, null]);
  });
});

describe("reads are minimal (R18) and never employee 0 (R5)", () => {
  it("findEmployee selects four columns and filters employee_id > 0", async () => {
    const pool = fakePool();
    const store = createStore(pool);
    pool.responses.push([{ employee_id: 1952, store_id: 2, department_id: 4, default_work_shift_id: 7 }]);
    await store.findEmployee(1952);
    const q = pool.log[0];
    assert.match(q.sql, /SELECT employee_id, store_id, department_id, default_work_shift_id FROM new_employee WHERE employee_id = \? AND employee_id > 0/);
    assert.doesNotMatch(q.sql, /salary|bank|aadhaar|employee_name/);
  });

  it("findEmployee refuses 0, null and negatives without touching the database", async () => {
    const pool = fakePool();
    const store = createStore(pool);
    for (const v of [0, null, undefined, -1]) {
      assert.equal(await store.findEmployee(v), null);
    }
    assert.equal(pool.log.length, 0);
  });

  it("findScheduleRow selects exactly the three permitted columns, by shift and weekday, and caches for a minute", async () => {
    let t = 1000;
    const pool = fakePool();
    const store = createStore(pool, { now: () => t });
    pool.responses.push([{ work_shift_weekly_schedule_id: 701, is_working_day: 1, attendance_day_cutoff: "04:00:00" }]);
    const a = await store.findScheduleRow(7, 1);
    const b = await store.findScheduleRow(7, 1);
    assert.deepEqual(a, b);
    assert.equal(pool.log.length, 1, "second read served from cache");
    assert.match(pool.log[0].sql, /SELECT work_shift_weekly_schedule_id, is_working_day, attendance_day_cutoff FROM work_shift_weekly_schedule WHERE work_shift_id = \? AND day_of_week = \?/);
    assert.doesNotMatch(pool.log[0].sql, /in_time|out_time|break_minutes/);
    assert.deepEqual(pool.log[0].params, [7, 1]);

    t += SCHEDULE_CACHE_MS + 1;
    pool.responses.push([]);
    assert.equal(await store.findScheduleRow(7, 1), null);
    assert.equal(pool.log.length, 2, "re-read after the cache expires");
  });
});

describe("housekeeping", () => {
  it("touchDevice updates last_seen (and last_punch for punches) by dev_id only", async () => {
    const pool = fakePool();
    const store = createStore(pool);
    pool.responses.push({}, {});
    await store.touchDevice("X", { punch: false });
    await store.touchDevice("X", { punch: true });
    assert.doesNotMatch(pool.log[0].sql, /last_punch_at/);
    assert.match(pool.log[1].sql, /last_punch_at = NOW\(3\)/);
    assert.match(pool.log[0].sql, /first_seen_at = COALESCE\(first_seen_at, NOW\(3\)\)/);
  });

  it("insertRawRequest caps the frame at 65535 bytes and the reason at 255", async () => {
    const pool = fakePool();
    const store = createStore(pool);
    pool.responses.push({});
    await store.insertRawRequest({ outcome: "oversized", reason: "r".repeat(300), raw_frame: Buffer.alloc(70000), byte_length: 70000, dev_id: "D" });
    const p = pool.log[0].params;
    assert.equal(p[4].length, 255);
    assert.equal(p[6].length, 65535);
    assert.equal(p[3], "oversized");
  });
});
