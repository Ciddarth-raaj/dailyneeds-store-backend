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

/* ------------------------------------------------ historical pull (SQL) */

describe("historical pull: punch ingest source", () => {
  let pool;
  let store;
  beforeEach(() => {
    pool = fakePool();
    store = createStore(pool);
  });

  it("a live punch is inserted as LIVE with no pull id, in the same statement as before", async () => {
    pool.responses.push({ affectedRows: 1, insertId: 10 }, {});
    await store.insertPunch(punch, derived);
    const ins = pool.log.find((l) => /INSERT INTO biomax_punch /.test(l.sql));
    assert.match(ins.sql, /ingest_source, biomax_historical_pull_id\)/);
    assert.deepEqual(ins.params.slice(-2), ["LIVE", null]);
    assert.match(ins.sql, /ON DUPLICATE KEY UPDATE retransmit_count = retransmit_count \+ 1/);
    assert.ok(!pool.log.some((l) => /SELECT biomax_punch_id FROM biomax_punch/.test(l.sql)), "no pre-check on the live path");
  });

  it("a HISTORICAL_PULL punch that already exists live is a duplicate: no insert, no counter bump", async () => {
    pool.responses.push([{ biomax_punch_id: 77 }]);
    const r = await store.insertPunch(punch, derived, { source: "HISTORICAL_PULL", historicalPullId: 3 });
    assert.deepEqual(r, { outcome: "duplicate", biomax_punch_id: 77 });
    const sqls = pool.log.map((l) => l.sql);
    assert.ok(sqls.some((s) => /SELECT biomax_punch_id FROM biomax_punch WHERE dev_id = \? AND user_id = \? AND io_time_raw = \?/.test(s)));
    assert.ok(!sqls.some((s) => /INSERT INTO biomax_punch /.test(s)));
    assert.ok(!sqls.some((s) => /biomax_punch_derived/.test(s)));
    assert.equal(sqls[sqls.length - 2], "COMMIT");
  });

  it("a new HISTORICAL_PULL punch is inserted with its source and pull id, and gets a derived row", async () => {
    pool.responses.push([], { affectedRows: 1, insertId: 11 }, {});
    const r = await store.insertPunch(punch, derived, { source: "HISTORICAL_PULL", historicalPullId: 3 });
    assert.deepEqual(r, { outcome: "stored", biomax_punch_id: 11 });
    const ins = pool.log.find((l) => /INSERT INTO biomax_punch /.test(l.sql));
    assert.deepEqual(ins.params.slice(-2), ["HISTORICAL_PULL", 3]);
    assert.deepEqual(ins.params.slice(0, 3), [punch.dev_id, punch.user_id, punch.io_time_raw], "same dedup identity");
    assert.ok(pool.log.some((l) => /INSERT INTO biomax_punch_derived/.test(l.sql)));
  });

  it("a HISTORICAL_PULL punch without a pull id is refused before any SQL", async () => {
    await assert.rejects(store.insertPunch(punch, derived, { source: "HISTORICAL_PULL" }), /must name its biomax_historical_pull_id/);
    assert.equal(pool.log.length, 0);
  });
});

describe("historical pull: command claim", () => {
  let pool;
  let store;
  beforeEach(() => {
    pool = fakePool();
    store = createStore(pool);
  });

  it("nothing deliverable: SELECT ... FOR UPDATE over PENDING or lease-expired SENT under the attempt cap, commit, null", async () => {
    pool.responses.push([]);
    assert.equal(await store.claimPendingCommand("C2695C56D30E1430", "1.2.3.4", { leaseSeconds: 600, maxAttempts: 3 }), null);
    const sel = pool.log.find((l) => /SELECT .* FROM biomax_device_command/.test(l.sql));
    assert.match(sel.sql, /WHERE dev_id = \? AND \( status = 'PENDING' OR \( status = 'SENT' AND sent_at < NOW\(3\) - INTERVAL \? SECOND AND attempt_count < \? \) \) ORDER BY created_at ASC, biomax_device_command_id ASC LIMIT 1 FOR UPDATE/);
    assert.deepEqual(sel.params, ["C2695C56D30E1430", 600, 3]);
    assert.deepEqual(pool.log.map((l) => l.sql).filter((s) => /^(BEGIN|COMMIT|ROLLBACK|RELEASE)$/.test(s)), ["BEGIN", "COMMIT", "RELEASE"]);
  });

  it("deliverable: the claim is an UPDATE guarded on dev_id, status and the attempt_count just read; attempt +1; the pull moves to WAITING_DEVICE", async () => {
    pool.responses.push(
      [{ biomax_device_command_id: 5, biomax_historical_pull_id: 2, trans_id: "T", dev_id: "C2695C56D30E1430", cmd_code: "GET_LOG_DATA", begin_time: "20260901000000", end_time: "20260901235959", status: "SENT", attempt_count: 1 }],
      { affectedRows: 1 },
      { affectedRows: 1 }
    );
    const cmd = await store.claimPendingCommand("C2695C56D30E1430", "1.2.3.4", { leaseSeconds: 600, maxAttempts: 3 });
    assert.deepEqual(cmd, { biomax_device_command_id: 5, biomax_historical_pull_id: 2, trans_id: "T", dev_id: "C2695C56D30E1430", cmd_code: "GET_LOG_DATA", begin_time: "20260901000000", end_time: "20260901235959", attempt_count: 2 });
    const upd = pool.log.find((l) => /UPDATE biomax_device_command SET status = 'SENT'/.test(l.sql));
    assert.match(upd.sql, /sent_at = NOW\(3\), first_sent_at = COALESCE\(first_sent_at, NOW\(3\)\), sent_to_ip = \?, attempt_count = attempt_count \+ 1 WHERE biomax_device_command_id = \? AND dev_id = \? AND status IN \('PENDING', 'SENT'\) AND attempt_count = \?/);
    assert.deepEqual(upd.params, ["1.2.3.4", 5, "C2695C56D30E1430", 1]);
    const pull = pool.log.find((l) => /UPDATE biomax_historical_pull SET status = 'WAITING_DEVICE'/.test(l.sql));
    assert.match(pull.sql, /WHERE biomax_historical_pull_id = \? AND status = 'REQUESTED'/);
    assert.deepEqual(pull.params, [2]);
    assert.equal(pool.log.filter((l) => l.sql === "COMMIT").length, 1);
  });

  it("lost the race (UPDATE hit nothing): rollback and null, nothing handed out", async () => {
    pool.responses.push([{ biomax_device_command_id: 5, biomax_historical_pull_id: 2, trans_id: "T", dev_id: "C2695C56D30E1430", cmd_code: "GET_LOG_DATA", begin_time: "a", end_time: "b", status: "PENDING", attempt_count: 0 }], { affectedRows: 0 });
    assert.equal(await store.claimPendingCommand("C2695C56D30E1430", null, {}), null);
    assert.ok(pool.log.some((l) => l.sql === "ROLLBACK"));
    assert.ok(!pool.log.some((l) => /WAITING_DEVICE/.test(l.sql)));
  });
});

describe("historical pull: result blocks", () => {
  let pool;
  let store;
  beforeEach(() => {
    pool = fakePool();
    store = createStore(pool);
  });
  const body = Buffer.from([0x00, 0xff, 0x7b, 0x0a, 0x00]);
  const block = { biomax_historical_pull_id: 2, dev_id: "C2695C56D30E1430", trans_id: "T", cmd_id: "T", cmd_code: null, cmd_return_code: "OK", blk_no: 1, blk_len: 5, content_length: 5, headers_json: "[]", raw_body: body, match_status: "MATCHED", source_ip: "1.2.3.4" };

  it("a new block: INSERT with the exact bytes, their sha256 and length, keyed on (dev_id, trans_id, blk_no)", async () => {
    pool.responses.push([], { affectedRows: 1 });
    const r = await store.insertResultBlock(block);
    const ins = pool.log.find((l) => /INSERT INTO biomax_command_result_block/.test(l.sql));
    assert.equal(r.outcome, "stored");
    assert.equal(r.body_sha256, require("crypto").createHash("sha256").update(body).digest("hex"));
    assert.equal(Buffer.compare(ins.params[12], body), 0, "raw bytes bound as a Buffer, untouched");
    assert.equal(ins.params[10], 5);
    assert.equal(ins.params[11], r.body_sha256);
    assert.match(ins.sql, /ON DUPLICATE KEY UPDATE duplicate_count = duplicate_count \+ IF\(body_sha256 = VALUES\(body_sha256\), 1, 0\), conflict_count = conflict_count \+ IF\(body_sha256 = VALUES\(body_sha256\), 0, 1\)/);
    assert.ok(!/raw_body = VALUES/.test(ins.sql), "stored bytes are never overwritten");
  });

  it("the same bytes again is a duplicate; different bytes for the same blk_no is a conflict", async () => {
    const hash = require("crypto").createHash("sha256").update(body).digest("hex");
    pool.responses.push([{ body_sha256: hash }], { affectedRows: 2 });
    assert.equal((await store.insertResultBlock(block)).outcome, "duplicate");
    pool.responses.push([{ body_sha256: "0".repeat(64) }], { affectedRows: 2 });
    assert.equal((await store.insertResultBlock(block)).outcome, "conflict");
  });

  it("an absent trans_id is stored as '' so the unique key still holds; blk_no defaults to 0", async () => {
    pool.responses.push([], { affectedRows: 1 });
    await store.insertResultBlock({ ...block, trans_id: null, blk_no: null, match_status: "UNKNOWN_TRANS_ID", biomax_historical_pull_id: null });
    const ins = pool.log.find((l) => /INSERT INTO biomax_command_result_block/.test(l.sql));
    assert.equal(ins.params[0], null);
    assert.equal(ins.params[2], "");
    assert.equal(ins.params[6], 0);
  });

  it("markPullReceiving marks the command ANSWERED (lease over) and the pull RECEIVING; markPullFailed is reserved and only moves ACTIVE pulls", async () => {
    pool.responses.push({}, {}, {}, {});
    await store.markPullReceiving(2, "T");
    await store.markPullFailed(2, "device returned cmd_return_code ERR");
    const ans = pool.log.find((l) => /SET status = 'ANSWERED'/.test(l.sql));
    assert.match(ans.sql, /answered_at = COALESCE\(answered_at, NOW\(3\)\) WHERE biomax_historical_pull_id = \? AND trans_id = \? AND status IN \('PENDING', 'SENT'\)/);
    assert.deepEqual(ans.params, [2, "T"]);
    const rec = pool.log.find((l) => /SET status = 'RECEIVING'/.test(l.sql));
    assert.match(rec.sql, /first_result_at = COALESCE\(first_result_at, NOW\(3\)\)/);
    assert.match(rec.sql, /status IN \('REQUESTED', 'WAITING_DEVICE'\)/);
    const fail = pool.log.find((l) => /SET status = 'FAILED', failed_at = NOW\(3\)/.test(l.sql));
    assert.match(fail.sql, /status IN \('REQUESTED', 'WAITING_DEVICE', 'RECEIVING'\)/);
    assert.deepEqual(fail.params, ["device returned cmd_return_code ERR", 2]);
    assert.ok(!pool.log.some((l) => /'COMPLETED'/.test(l.sql)), "nothing in the store sets COMPLETED");
  });
});

/* -------------------------------------------- DigiSME import (SQL shape) */

describe("DigiSME import: insertPunch with source DIGISME_IMPORT", () => {
  let pool;
  let store;
  beforeEach(() => {
    pool = fakePool();
    store = createStore(pool);
  });
  const imported = { user_id: "1952", io_time_raw: "20260910091500" };

  it("inserts with NULL dev_id, NULL raw_json, no BM70W fields, source DIGISME_IMPORT and the batch id; derived row in the same transaction", async () => {
    pool.responses.push({ affectedRows: 1, insertId: 501 }, {});
    const r = await store.insertPunch(imported, derived, { source: "DIGISME_IMPORT", importBatchId: 7 });
    assert.deepEqual(r, { outcome: "stored", biomax_punch_id: 501 });
    const ins = pool.log.find((l) => /INSERT INTO biomax_punch /.test(l.sql));
    // raw_json is a PLACEHOLDER now, not a literal NULL: the DigiSME API
    // pull has a vendor row worth preserving (PunchAction, Source,
    // ClockLocation) and passes it. An Excel import passes nothing and the
    // bound value is still null, which is what this case asserts - a
    // spreadsheet cell has no payload. Every other BM70W field stays a
    // literal NULL: none of them is ever invented for an imported punch.
    assert.match(ins.sql, /VALUES \(NULL, \?, \?, STR_TO_DATE\(\?, '%Y%m%d%H%i%s'\), NULL, NULL, NULL, 0, NULL, NULL, NULL, NULL, NULL, \?, NULL, NULL, \?, NULL, \?\)/);
    assert.ok(!/ON DUPLICATE KEY UPDATE/.test(ins.sql), "no retransmit bump for an import");
    assert.deepEqual(ins.params, ["1952", "20260910091500", "20260910091500", null, "DIGISME_IMPORT", 7]);
    assert.ok(pool.log.some((l) => /INSERT INTO biomax_punch_derived/.test(l.sql)));
    assert.deepEqual(pool.log.map((l) => l.sql).filter((s) => /^(BEGIN|COMMIT|ROLLBACK|RELEASE)$/.test(s)), ["BEGIN", "COMMIT", "RELEASE"]);
  });

  it("a DigiSME API punch stores the vendor row in raw_json, and io_mode stays NULL", async () => {
    // PunchAction and Source are preserved here rather than mapped onto
    // `io_mode`: that column is a BIGINT the Part 1 schema documents as "NOT
    // a direction flag", and the engine pairs punches by position on
    // purpose. Keeping the payload costs no schema change and decides
    // nothing downstream.
    pool.responses.push({ affectedRows: 1, insertId: 502 }, {});
    const vendor = JSON.stringify({ Code: "1952", PunchAction: "IN", Source: "Device" });
    const r = await store.insertPunch(
      { ...imported, raw_json: vendor },
      derived,
      { source: "DIGISME_IMPORT", importBatchId: 8 }
    );
    assert.deepEqual(r, { outcome: "stored", biomax_punch_id: 502 });
    const ins = pool.log.find((l) => /INSERT INTO biomax_punch /.test(l.sql));
    assert.deepEqual(ins.params, ["1952", "20260910091500", "20260910091500", vendor, "DIGISME_IMPORT", 8]);
    // io_mode is the 6th column in the VALUES list and is a literal NULL.
    assert.match(ins.sql, /STR_TO_DATE\(\?, '%Y%m%d%H%i%s'\), NULL, NULL, NULL, 0,/);
  });

  it("ER_DUP_ENTRY from the import dedup key -> duplicate with the existing id, transaction rolled back, no derived row", async () => {
    const dup = Object.assign(new Error("Duplicate entry"), { code: "ER_DUP_ENTRY" });
    pool.responses.push(dup, [{ biomax_punch_id: 321 }]);
    const r = await store.insertPunch(imported, derived, { source: "DIGISME_IMPORT", importBatchId: 7 });
    assert.deepEqual(r, { outcome: "duplicate", biomax_punch_id: 321 });
    assert.ok(pool.log.some((l) => l.sql === "ROLLBACK"));
    assert.ok(!pool.log.some((l) => /biomax_punch_derived/.test(l.sql)));
    const look = pool.log.find((l) => /SELECT biomax_punch_id FROM biomax_punch WHERE dev_id IS NULL AND ingest_source = \?/.test(l.sql));
    assert.deepEqual(look.params, ["DIGISME_IMPORT", "1952", "20260910091500"]);
  });

  it("any other error propagates and rolls back", async () => {
    pool.responses.push(Object.assign(new Error("boom"), { code: "ER_DATA_TOO_LONG" }));
    await assert.rejects(store.insertPunch(imported, derived, { source: "DIGISME_IMPORT", importBatchId: 7 }), /boom/);
    assert.ok(pool.log.some((l) => l.sql === "ROLLBACK"));
  });

  it("refuses an import without a batch id before any SQL", async () => {
    await assert.rejects(store.insertPunch(imported, derived, { source: "DIGISME_IMPORT" }), /import_batch_id/);
    assert.equal(pool.log.length, 0);
  });

  it("the LIVE path is untouched: same statement, same ON DUPLICATE KEY UPDATE retransmit bump, LIVE and NULL pull id", async () => {
    pool.responses.push({ affectedRows: 1, insertId: 10 }, {});
    await store.insertPunch(punch, derived);
    const ins = pool.log.find((l) => /INSERT INTO biomax_punch /.test(l.sql));
    assert.match(ins.sql, /source_ip, source_port, ingest_source, biomax_historical_pull_id\) VALUES/);
    assert.match(ins.sql, /ON DUPLICATE KEY UPDATE retransmit_count = retransmit_count \+ 1, last_retransmit_at = NOW\(3\)/);
    assert.equal(ins.params[0], punch.dev_id);
    assert.deepEqual(ins.params.slice(-2), ["LIVE", null]);
  });
});

/* ======================== /healthz: the receiver's own reception ======= */

describe("lastPunchAt answers for the RECEIVER, not for attendance at large", () => {
  it("counts only LIVE rows that carry a dev_id", async () => {
    const pool = fakePool();
    const store = createStore(pool);
    pool.responses.push([{ last_received: "2026-09-20 12:34:18" }]);
    const got = await store.lastPunchAt();

    const q = pool.log[pool.log.length - 1];
    assert.match(q.sql, /FROM biomax_punch WHERE ingest_source = \? AND dev_id IS NOT NULL/);
    assert.deepEqual(q.params, ["LIVE"]);
    assert.equal(got, "2026-09-20 12:34:18");
  });

  it("a DigiSME import or API sync cannot advance it", () => {
    // DIGISME_IMPORT rows are written with dev_id NULL (insertImportedPunch),
    // so they are excluded twice over - by the source and by the Cloud ID.
    const pool = fakePool();
    const store = createStore(pool);
    return store.lastPunchAt().then(() => {
      const { sql, params } = pool.log[pool.log.length - 1];
      assert.ok(!params.includes("DIGISME_IMPORT"));
      assert.ok(!/MAX\(received_at\)[\s\S]*FROM biomax_punch\s*$/.test(sql), "the unscoped form is what this replaces");
      assert.match(sql, /dev_id IS NOT NULL/);
    });
  });

  it("a historical pull is backfill, not reception, and is excluded too", async () => {
    const pool = fakePool();
    const store = createStore(pool);
    await store.lastPunchAt();
    assert.deepEqual(pool.log[pool.log.length - 1].params, ["LIVE"]);
  });

  it("no punch at all still reads as null, not as an error", async () => {
    const pool = fakePool();
    const store = createStore(pool);
    pool.responses.push([{ last_received: null }]);
    assert.equal(await store.lastPunchAt(), null);
  });
});

/* ============== deadlines and pool visibility (the 2026-09 OOM) ======== */

describe("deadlines: off by default, enforced when the receiver asks", () => {
  it("without options a store queries exactly as before (the API's import store)", async () => {
    const pool = fakePool();
    const store = createStore(pool);
    await store.ping();
    assert.equal(pool.log[0].sql, "SELECT 1");
  });

  it("acquireTimeoutMs: a saturated pool fails fast with BIOMAX_POOL_ACQUIRE_TIMEOUT, and a late connection goes straight back", async () => {
    let late = null;
    let released = 0;
    const pool = { getConnection: (cb) => (late = cb) };
    const store = createStore(pool, { acquireTimeoutMs: 30, queryTimeoutMs: 1000 });
    const t0 = Date.now();
    await assert.rejects(store.insertRawRequest({ outcome: "unparsed" }), (err) => err.code === "BIOMAX_POOL_ACQUIRE_TIMEOUT");
    assert.ok(Date.now() - t0 < 500);
    late(null, { release: () => released++, query() {} });
    assert.equal(released, 1);
  });

  it("a punch that cannot get a connection in time is an error - the receiver's no-ACK path (R1)", async () => {
    const pool = { getConnection() {} };
    const store = createStore(pool, { acquireTimeoutMs: 20 });
    await assert.rejects(store.insertPunch(punch, derived), /BIOMAX_POOL_ACQUIRE_TIMEOUT|no database connection/);
  });

  it("queryTimeoutMs is passed to every statement, inside the punch transaction too", async () => {
    const seen = [];
    const conn = {
      query(opts, params, cb) {
        seen.push(typeof opts === "object" ? opts.timeout : "none");
        cb(null, { affectedRows: 1, insertId: 5 });
      },
      beginTransaction: (cb) => cb(null),
      commit(opts, cb) {
        seen.push(`commit:${opts.timeout}`);
        cb(null);
      },
      rollback: (cb) => cb(null),
      release() {},
    };
    const store = createStore({ getConnection: (cb) => cb(null, conn) }, { acquireTimeoutMs: 100, queryTimeoutMs: 1234 });
    const got = await store.insertPunch(punch, derived);
    assert.equal(got.outcome, "stored");
    assert.deepEqual(seen, [1234, 1234, "commit:1234"]);
  });

  it("poolStats reads the mysql pool's counters, and nulls for anything else", () => {
    const pool = { config: { connectionLimit: 3, queueLimit: 50 }, _allConnections: [1, 2, 3], _freeConnections: [], _acquiringConnections: [], _connectionQueue: [1, 2] };
    assert.deepEqual(createStore(pool).poolStats(), { connection_limit: 3, queue_limit: 50, all: 3, free: 0, acquiring: 0, queued: 2, closed: false });
    assert.equal(createStore(fakePool()).poolStats().queued, null);
  });

  it("after close() nothing reaches the pool, and close({timeoutMs}) destroys a connection stuck in a statement", async () => {
    let destroyed = 0;
    let ended = 0;
    const stuck = { destroy: () => destroyed++ };
    const pool = { _allConnections: [stuck], end: () => ended++, getConnection: () => assert.fail("pool used after close") };
    const store = createStore(pool, { acquireTimeoutMs: 100 });
    await store.close({ timeoutMs: 20 });
    assert.equal(ended, 1);
    assert.equal(destroyed, 1);
    await assert.rejects(store.touchDevice("X", {}), (err) => err.code === "POOL_CLOSED");
  });
});

describe("createPool", () => {
  it("keeps connectionLimit 3 and sets a bounded waiter queue when asked", () => {
    const { createPool } = require("./store");
    const pool = createPool({ host: "127.0.0.1", username: "u", password: "p", database: "d", port: 3306 }, { queueLimit: 50, acquireTimeoutMs: 5000 });
    assert.equal(pool.config.connectionLimit, 3);
    assert.equal(pool.config.queueLimit, 50);
    assert.equal(pool.config.acquireTimeout, 5000);
    const unchanged = createPool({ host: "127.0.0.1", username: "u", password: "p", database: "d", port: 3306 });
    assert.equal(unchanged.config.connectionLimit, 3);
    assert.equal(unchanged.config.queueLimit, 0);
    pool.end(() => {});
    unchanged.end(() => {});
  });
});
