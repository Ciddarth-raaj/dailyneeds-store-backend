/**
 * Regression for the 2026-09 biomax-receiver OOM: sustained
 * realtime_enroll_data (25-35 KB bodies) while every diagnostic / last-seen
 * write takes "30 seconds" - here, never finishes until the test lets it.
 *
 *   node --test biomax/receiver.flood.test.js
 *
 * Before the fix each such request replied and then awaited its raw-row
 * INSERT and its touchDevice UPDATE on a 3-connection pool whose waiter
 * queue has no limit, so every request - req, res, socket, body, rebuilt
 * frame - stayed reachable for as long as the database took, and /healthz
 * queued behind all of it. These tests pin down the bounded behaviour and
 * that the punch rules (R1 ACK-after-durable, R2 dedup) did not move.
 *
 * The real-MySQL version with 30 s SLEEP() triggers, used for the
 * before/after numbers, is test_support/biomax/stress/stress.js.
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const v8 = require("v8");
const vm = require("vm");

const { createReceiver } = require("./receiver");
const protocol = require("./protocol");

v8.setFlagsFromString("--expose-gc");
const gc = vm.runInNewContext("gc");

/* ---------------------------------------------------------- fake store -- */

/** Something that settles when released - a DB call "taking 30 seconds". */
function hang() {
  let release;
  let fail;
  const promise = new Promise((res, rej) => {
    release = res;
    fail = rej;
  });
  return { promise, release, fail };
}

function makeStore({ slowHousekeeping = true } = {}) {
  const state = {
    devices: new Set(["C2695C56D30E1430", "AMDB24121401205", "C26044C84F1A1D31"]),
    punches: new Map(),
    raw: [],
    touched: [],
    hanging: [], // housekeeping calls still "in the database"
    insertStarted: 0,
    insertGate: null, // when set, insertPunch waits for it
    failInsert: null,
    rawCalls: 0,
    touchCalls: 0,
  };
  let nextId = 1;
  const slow = (value) => {
    if (!slowHousekeeping) return Promise.resolve(value);
    const h = hang();
    state.hanging.push(h);
    return h.promise;
  };
  const store = {
    state,
    async findDevice(devId) {
      return state.devices.has(devId) ? { biomax_device_id: 1, first_seen_at: null } : null;
    },
    async findEmployee(id) {
      return id === 1952 ? { employee_id: 1952, store_id: 2, department_id: 4, default_work_shift_id: 7 } : null;
    },
    async findShiftAssignments() {
      return [{ employee_work_shift_assignment_id: 1, work_shift_id: 7, effective_from: "2026-09-01" }];
    },
    async findScheduleRow() {
      return { work_shift_weekly_schedule_id: 701, is_working_day: 1, attendance_day_cutoff: "04:00:00" };
    },
    async insertPunch(punch, derived) {
      state.insertStarted += 1;
      if (state.insertGate) await state.insertGate.promise;
      if (state.failInsert) throw state.failInsert;
      const key = `${punch.dev_id}|${punch.user_id}|${punch.io_time_raw}`;
      const existing = state.punches.get(key);
      if (existing) {
        existing.retransmits += 1;
        return { outcome: "duplicate", biomax_punch_id: null };
      }
      const id = nextId++;
      state.punches.set(key, { id, punch, derived, retransmits: 0 });
      return { outcome: "stored", biomax_punch_id: id };
    },
    insertRawRequest(entry) {
      state.rawCalls += 1;
      state.raw.push(entry);
      return slow();
    },
    touchDevice(devId, opts) {
      state.touchCalls += 1;
      state.touched.push([devId, opts]);
      return slow();
    },
    async ping() {
      // The ordinary pool is saturated: a ping on it would wait "30 s".
      return slow(true);
    },
    async lastPunchAt() {
      return slow(null);
    },
    async close() {},
  };
  return store;
}

function makeHealthStore({ hangs = false } = {}) {
  return {
    async ping() {
      if (hangs) return new Promise(() => {});
      return true;
    },
    async lastPunchAt() {
      return "2026-09-26 10:00:00";
    },
  };
}

function makeLog() {
  const lines = [];
  return {
    lines,
    request: (f) => lines.push({ ...f }),
    error: (code, description, ref) => lines.push({ outcome: "ERROR", code, description, ...(ref || {}) }),
    info: () => {},
  };
}

/* --------------------------------------------------------------- client -- */

function send(port, frame, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const chunks = [];
    let done = false;
    const finish = (extra) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const raw = Buffer.concat(chunks);
      resolve({ raw, ms: Date.now() - t0, headers: raw.length ? protocol.parseReplyHeaders(raw).headers : {}, ...extra });
    };
    const sock = net.connect(port, "127.0.0.1", () => sock.write(frame));
    const timer = setTimeout(() => {
      sock.destroy();
      finish({ timedOut: true });
    }, timeoutMs);
    sock.on("data", (d) => chunks.push(d));
    sock.on("close", () => finish({}));
    sock.on("error", () => finish({ reset: true }));
  });
}

function frame(devId, requestCode, body, extra = "") {
  return Buffer.concat([
    Buffer.from(
      "POST /hdata.aspx HTTP/1.0\r\nUser-Agent: Mozilla/4.0\r\nContent-Type: application/octet-stream\r\nConnection: close\r\n" +
        `request_code: ${requestCode}\r\nContent-Length: ${body.length}\r\ndev_id: ${devId}\r\n${extra}blk_no: 0\r\nblk_len: ${body.length}\r\nHOST: 127.0.0.1:7005\r\n\r\n`,
      "latin1"
    ),
    body,
  ]);
}

function framed(json) {
  const j = Buffer.from(json, "utf8");
  const p = Buffer.alloc(4);
  p.writeUInt32LE(j.length + 2);
  return Buffer.concat([p, j, Buffer.from([0x0a, 0x00])]);
}

/** A 25-35 KB enrolment upload; `variant` picks one of a few fixed bodies per device. */
const enrollCache = new Map();
function enrollFrame(devId, variant = 0) {
  const key = `${devId}:${variant}`;
  if (!enrollCache.has(key)) {
    const size = 25 * 1024 + crypto.randomInt(10 * 1024);
    const template = crypto.randomBytes(Math.floor((size * 3) / 4)).toString("base64");
    const body = framed(JSON.stringify({ user_id: String(1000 + variant), enroll_data_array: [{ backup_number: 12, enroll_data: template }] }));
    enrollCache.set(key, frame(devId, "realtime_enroll_data", body, "cmd_id: RTEnrollDataAction\r\n"));
  }
  return enrollCache.get(key);
}

const punchFrame = (ioTime, devId = "C2695C56D30E1430") =>
  frame(devId, "realtime_glog", framed(`{"fk_bin_data_lib":"FKDataHS102","io_mode":16777216,"io_time":"${ioTime}","log_image":null,"user_id":"1952","verify_mode":1073741824}`), "cmd_id: RTLogSendAction\r\n");

const pollFrame = (devId = "C2695C56D30E1430") => frame(devId, "receive_cmd", Buffer.alloc(0));
const healthz = Buffer.from("GET /healthz HTTP/1.0\r\n\r\n", "latin1");
const healthBody = (r) => JSON.parse(r.raw.subarray(r.raw.indexOf("\r\n\r\n") + 4).toString());

async function flood(port, total, concurrency, makeFrame) {
  let next = 0;
  const replies = [];
  async function worker() {
    while (next < total) {
      const i = next++;
      replies.push(await send(port, makeFrame(i)));
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return replies;
}

const DEVICES = ["C2695C56D30E1430", "AMDB24121401205", "C26044C84F1A1D31"];

/* ---------------------------------------------------------------- suite -- */

describe("realtime_enroll_data flood against a database that takes 30 s", () => {
  let store;
  let log;
  let receiver;
  let port;
  let spoolDir;

  beforeEach(async () => {
    spoolDir = fs.mkdtempSync(path.join(os.tmpdir(), "biomax-flood-"));
    store = makeStore();
    log = makeLog();
    receiver = createReceiver({
      store,
      log,
      health: makeHealthStore(),
      config: { spoolDir, housekeeping: { concurrency: 1, maxPending: 50 } },
    });
    port = (await receiver.listen(0, "127.0.0.1")).port;
  });
  afterEach(async () => {
    await receiver.close({ serverTimeoutMs: 500, housekeepingTimeoutMs: 100 });
    // Let anything still "in the database" finish so the test can exit.
    store.state.hanging.forEach((h) => h.release());
    fs.rmSync(spoolDir, { recursive: true, force: true });
  });

  it("every request is answered at once, pending work stays bounded, memory does not grow", async () => {
    // Warm up so first-use allocations are not counted as growth.
    await flood(port, 60, 10, (i) => enrollFrame(DEVICES[i % 3], i % 3));
    gc();
    const before = process.memoryUsage();

    const replies = await flood(port, 1500, 30, (i) => enrollFrame(DEVICES[i % 3], i % 3));
    gc();
    const after = process.memoryUsage();

    assert.equal(replies.length, 1500);
    assert.ok(replies.every((r) => r.headers.response_code === "ERROR_NO_CMD"), "answered exactly as before: ERROR_NO_CMD");
    assert.ok(Math.max(...replies.map((r) => r.ms)) < 2000, "no request waits on the database");

    const hk = receiver.stats().housekeeping;
    assert.ok(hk.running <= 1, `running ${hk.running}`);
    assert.ok(hk.pending <= 50, `pending ${hk.pending}`);
    // ~1560 frames, three devices, three distinct bodies each: one raw row
    // per identical frame per window - not one per retry.
    assert.ok(store.state.rawCalls <= 9, `raw rows attempted: ${store.state.rawCalls}`);
    // Coalesced last-seen: one per device per interval.
    assert.ok(store.state.touchCalls <= 3, `touches attempted: ${store.state.touchCalls}`);
    // What IS retained while the DB hangs: headers only, never the biometric body.
    for (const r of store.state.raw) assert.ok(r.raw_frame.length < 1024, `raw_frame ${r.raw_frame.length} bytes`);

    // Before the fix: ~1500 x (30 KB body + 30 KB frame + request objects)
    // retained = well over 100 MB. Allow generous noise, nothing like that.
    const grew = after.heapUsed + after.arrayBuffers - (before.heapUsed + before.arrayBuffers);
    assert.ok(grew < 15 * 1024 * 1024, `heap+buffers grew ${(grew / 1048576).toFixed(1)} MB`);

    const s = receiver.stats();
    assert.equal(s.requests_by_code.realtime_enroll_data, 1560);
    assert.ok(s.diagnostics.suppressed_identical >= 1500);
  });

  it("/healthz answers promptly during the flood, from its own DB check", async () => {
    const flooding = flood(port, 600, 20, (i) => enrollFrame(DEVICES[i % 3], i % 3));
    const probes = [];
    for (let i = 0; i < 5; i += 1) {
      probes.push(await send(port, healthz, 800));
      await new Promise((r) => setTimeout(r, 50));
    }
    await flooding;
    for (const p of probes) {
      assert.equal(p.timedOut, undefined, "answered within the API's 800 ms budget");
      assert.ok(p.raw.length > 0, "not zero bytes");
    }
    const body = healthBody(probes[probes.length - 1]);
    assert.equal(body.ok, true);
    assert.equal(body.db, true);
    assert.equal(body.last_punch_received, "2026-09-26 10:00:00");
    assert.equal(body.process.ok, true);
    assert.equal(typeof body.process.memory.heap_used_mb, "number");
    assert.equal(typeof body.housekeeping.pending, "number");
    assert.equal(typeof body.housekeeping.dropped, "number");
    assert.ok(body.requests_by_code.realtime_enroll_data > 0);
  });

  it("/healthz reports db:false within its budget when the DB check itself hangs", async () => {
    await receiver.close({ serverTimeoutMs: 100, housekeepingTimeoutMs: 10 });
    receiver = createReceiver({ store, log, health: makeHealthStore({ hangs: true }), config: { spoolDir, health: { dbBudgetMs: 200 } } });
    port = (await receiver.listen(0, "127.0.0.1")).port;
    const r = await send(port, healthz, 800);
    assert.equal(r.timedOut, undefined);
    assert.match(r.raw.toString("latin1"), /^HTTP\/1\.1 503/);
    const body = healthBody(r);
    assert.equal(body.ok, false);
    assert.equal(body.db, false);
    assert.equal(body.db_check.error, "timeout");
    assert.equal(body.process.ok, true, "the process itself is fine and says so");
    assert.ok(r.ms < 700, `${r.ms} ms`);
  });

  it("a real punch during the flood is ACKed OK only after insertPunch returns (R1)", async () => {
    const flooding = flood(port, 300, 15, (i) => enrollFrame(DEVICES[i % 3], i % 3));
    store.state.insertGate = hang();
    const pending = send(port, punchFrame("20260926101500"), 5000);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(store.state.insertStarted, 1, "the punch reached its durable write despite the flood");
    assert.equal(store.state.punches.size, 0);
    store.state.insertGate.release();
    const r = await pending;
    await flooding;
    assert.equal(r.headers.response_code, "OK");
    assert.equal(store.state.punches.size, 1);
    // The ACK did not wait for last-seen upkeep, which is still "in the DB".
    assert.ok(r.ms < 2000);
  });

  it("while the durable write has not returned, nothing at all is sent back", async () => {
    store.state.insertGate = hang();
    const r = await send(port, punchFrame("20260926101600"), 400);
    assert.equal(r.timedOut, true);
    assert.equal(r.raw.length, 0, "no byte before the punch is durable");
    store.state.insertGate.release();
  });

  it("a punch whose durable write fails gets NO reply (R1), flood or not", async () => {
    store.state.failInsert = new Error("BIOMAX_POOL_ACQUIRE_TIMEOUT");
    const r = await send(port, punchFrame("20260926101700"));
    assert.equal(r.raw.length, 0);
    assert.ok(log.lines.some((l) => l.outcome === "store_error"));
  });

  it("a retransmitted punch is still OK and still one row (R2)", async () => {
    const f = punchFrame("20260926101800");
    const a = await send(port, f);
    const b = await send(port, f);
    const c = await send(port, f);
    assert.deepEqual([a, b, c].map((r) => r.headers.response_code), ["OK", "OK", "OK"]);
    assert.equal(store.state.punches.size, 1);
    assert.equal([...store.state.punches.values()][0].retransmits, 2);
    assert.ok(log.lines.some((l) => l.outcome === "duplicate"));
  });

  it("every punch still asks for last_punch_at, without waiting for it", async () => {
    const replies = [];
    for (const t of ["20260926101900", "20260926102000", "20260926102100"]) replies.push(await send(port, punchFrame(t)));
    assert.deepEqual(replies.map((r) => r.headers.response_code), ["OK", "OK", "OK"]);
    // The first is "in the database" (running), the second waits behind it,
    // the third is absorbed into the second: one queued write, not a pile.
    assert.deepEqual(store.state.touched, [["C2695C56D30E1430", { punch: true }]]);
    const hk = receiver.stats().housekeeping;
    assert.equal(hk.running, 1);
    assert.equal(hk.pending, 1);
    assert.equal(hk.coalesced, 1);
  });
});

describe("last_seen_at upkeep is coalesced", () => {
  it("polls write at most once per device per interval; a punch always writes", async () => {
    let t = 1000000;
    const store = makeStore({ slowHousekeeping: false });
    const receiver = createReceiver({ store, log: makeLog(), health: makeHealthStore(), now: () => t, config: { spoolDir: os.tmpdir(), deviceTouchIntervalMs: 60000 } });
    const { port } = await receiver.listen(0, "127.0.0.1");
    try {
      for (let i = 0; i < 10; i += 1) await send(port, pollFrame());
      assert.deepEqual(store.state.touched, [["C2695C56D30E1430", { punch: false }]]);
      t += 59000;
      await send(port, pollFrame());
      assert.equal(store.state.touched.length, 1, "still inside the interval");
      t += 2000;
      await send(port, pollFrame());
      assert.equal(store.state.touched.length, 2, "interval passed");
      await send(port, punchFrame("20260926103000"));
      assert.deepEqual(store.state.touched[2], ["C2695C56D30E1430", { punch: true }]);
      assert.ok(receiver.stats().device_touch.skipped_interval >= 10);
    } finally {
      await receiver.close();
    }
  });
});

describe("unknown request codes are preserved, but not once per retry", () => {
  it("20 identical frames -> one raw row; distinct frames capped per device; the count is carried", async () => {
    let t = 0;
    const store = makeStore({ slowHousekeeping: false });
    const receiver = createReceiver({ store, log: makeLog(), health: makeHealthStore(), now: () => t, config: { spoolDir: os.tmpdir(), diag: { windowMs: 1000, perSource: 3 } } });
    const { port } = await receiver.listen(0, "127.0.0.1");
    try {
      const same = frame("C2695C56D30E1430", "upload_photo", Buffer.from("same bytes"));
      for (let i = 0; i < 20; i += 1) {
        const r = await send(port, same);
        assert.equal(r.headers.response_code, "ERROR_NO_CMD");
      }
      assert.equal(store.state.raw.length, 1);
      assert.ok(store.state.raw[0].raw_frame.toString("latin1").includes("same bytes"), "still verbatim");
      for (let i = 0; i < 5; i += 1) await send(port, frame("C2695C56D30E1430", "upload_photo", Buffer.from(`different ${i}`)));
      assert.equal(store.state.raw.length, 3, "perSource cap");
      // What was not written is reported on the next row for that source.
      assert.match(store.state.raw[1].reason, /\+19 suppressed/);
      t = 1000;
      await send(port, same);
      assert.equal(store.state.raw.length, 4, "a new window writes again");
      assert.match(store.state.raw[3].reason, /\+3 suppressed/);
    } finally {
      await receiver.close();
    }
  });
});

describe("realtime_enroll_data", () => {
  it("is classified on its own, never stored whole, and the reply is configurable", async () => {
    assert.equal(protocol.classifyRequest({ request_code: "realtime_enroll_data" }).kind, "enroll");
    const store = makeStore({ slowHousekeeping: false });
    const receiver = createReceiver({ store, log: makeLog(), health: makeHealthStore(), config: { spoolDir: os.tmpdir(), enrollReply: "OK" } });
    const { port } = await receiver.listen(0, "127.0.0.1");
    try {
      const f = enrollFrame("C2695C56D30E1430", 7);
      const r = await send(port, f);
      assert.equal(r.headers.response_code, "OK");
      assert.equal(store.state.raw.length, 1);
      const row = store.state.raw[0];
      assert.equal(row.outcome, "unknown_request_code", "an existing ENUM value - no migration");
      assert.equal(row.request_code, "realtime_enroll_data");
      assert.match(row.reason, /biometric enrolment, not attendance.*NOT stored/);
      assert.ok(row.raw_frame.length < 1024, "headers only");
      assert.ok(!row.raw_frame.toString("latin1").includes("enroll_data_array"), "no body bytes");
      assert.equal(row.byte_length, f.length, "the size of what arrived is still recorded");
      assert.equal(store.state.punches.size, 0);
    } finally {
      await receiver.close();
    }
  });
});

describe("shutdown", () => {
  it("close() returns promptly with housekeeping stuck in the DB, and nothing runs or logs afterwards", async () => {
    const store = makeStore();
    const log = makeLog();
    const receiver = createReceiver({ store, log, health: makeHealthStore(), config: { spoolDir: os.tmpdir(), housekeeping: { concurrency: 1, maxPending: 50 } } });
    const { port } = await receiver.listen(0, "127.0.0.1");
    await flood(port, 200, 10, (i) => enrollFrame(`DEV${String(i).padStart(10, "0")}`, 0));
    const before = receiver.stats().housekeeping;
    assert.ok(before.pending > 0, "work is waiting");
    const calls = store.state.rawCalls + store.state.touchCalls;

    const t0 = Date.now();
    const summary = await receiver.close({ serverTimeoutMs: 500, housekeepingTimeoutMs: 100 });
    assert.ok(Date.now() - t0 < 1500, "bounded");
    assert.equal(summary.pending, 0);
    assert.ok(summary.dropped_on_shutdown > 0);

    // The pool is ended: the stuck call fails with POOL_CLOSED, as mysql does.
    store.state.hanging.forEach((h) => h.fail(Object.assign(new Error("Pool is closed."), { code: "POOL_CLOSED" })));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(store.state.rawCalls + store.state.touchCalls, calls, "nothing started after close");
    assert.equal(log.lines.filter((l) => l.code === "HOUSEKEEPING_FAILED").length, 0, "no 'Pool is closed' loop");
  });
});
