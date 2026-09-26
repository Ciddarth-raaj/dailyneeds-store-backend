/**
 * An oversized realtime_glog is REFUSED, never ACKed on a truncated copy.
 *
 *   node --test biomax/receiver.oversized.test.js
 *
 * The invariant (R1, as amended 2026-09): a realtime_glog gets `OK` only
 * when EITHER the punch itself is durably stored / deduplicated, OR the
 * COMPLETE received frame is durably preserved. A body over
 * BIOMAX_MAX_BODY (64 KB; a real punch is ~144 bytes) is abnormal and we do
 * not hold it whole, so it gets no reply at all and the terminal keeps and
 * retries it. Only bounded metadata is recorded.
 *
 * Runs with the production default limit (64 KB), not a test-sized one.
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
const { createStore, RAW_FRAME_MAX_BYTES } = require("./store");

v8.setFlagsFromString("--expose-gc");
const gc = vm.runInNewContext("gc");

const LIMIT = protocol.DEFAULT_MAX_BODY_BYTES; // 65536

function makeStore() {
  const state = { punches: new Map(), raw: [], rawOptions: [], touched: [], spooled: 0 };
  let nextId = 1;
  return {
    state,
    async findDevice(devId) {
      return devId === "C2695C56D30E1430" ? { biomax_device_id: 6, first_seen_at: null } : null;
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
    async insertRawRequest(entry, options) {
      state.raw.push(entry);
      state.rawOptions.push(options || {});
    },
    async touchDevice(devId, opts) {
      state.touched.push([devId, opts]);
    },
    async ping() {
      return true;
    },
    async lastPunchAt() {
      return null;
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

function send(port, bytes, timeoutMs = 5000) {
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
    const sock = net.connect(port, "127.0.0.1", () => sock.write(bytes));
    const timer = setTimeout(() => {
      sock.destroy();
      finish({ timedOut: true });
    }, timeoutMs);
    sock.on("data", (d) => chunks.push(d));
    sock.on("close", () => finish({}));
    sock.on("error", (e) => finish({ reset: e.code }));
  });
}

const headers = (devId, len, extra = "") =>
  "POST /hdata.aspx HTTP/1.0\r\nUser-Agent: Mozilla/4.0\r\nContent-Type: application/octet-stream\r\nConnection: close\r\n" +
  `request_code: realtime_glog\r\n${len === null ? "" : `Content-Length: ${len}\r\n`}cmd_id: RTLogSendAction\r\ndev_id: ${devId}\r\nblk_no: 0\r\n${extra}HOST: 127.0.0.1:7005\r\n\r\n`;

const glog = (body, devId = "C2695C56D30E1430") => Buffer.concat([Buffer.from(headers(devId, body.length), "latin1"), body]);

/** A VALID punch body padded (inside the JSON, with spaces) to exactly `size` bytes. */
function validPunchBody(size, ioTime = "20260926120000") {
  const core = `{"fk_bin_data_lib":"FKDataHS102","io_mode":16777216,"io_time":"${ioTime}","log_image":null,"user_id":"1952","verify_mode":1073741824`;
  const pad = size - 4 - core.length - 1 - 2; // prefix, "}", 0x0A 0x00
  assert.ok(pad >= 0);
  const json = Buffer.from(`${core}${" ".repeat(pad)}}`, "utf8");
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32LE(json.length + 2);
  const body = Buffer.concat([prefix, json, Buffer.from([0x0a, 0x00])]);
  assert.equal(body.length, size);
  return body;
}

describe("oversized realtime_glog (production 64 KB limit)", () => {
  let store;
  let log;
  let receiver;
  let port;
  let spoolDir;

  beforeEach(async () => {
    spoolDir = fs.mkdtempSync(path.join(os.tmpdir(), "biomax-oversized-"));
    store = makeStore();
    log = makeLog();
    receiver = createReceiver({ store, log, config: { spoolDir } });
    assert.equal(receiver.config.maxBodyBytes, LIMIT, "the default limit, not raised");
    port = (await receiver.listen(0, "127.0.0.1")).port;
  });
  afterEach(async () => {
    await receiver.close({ serverTimeoutMs: 200, housekeepingTimeoutMs: 50 });
    fs.rmSync(spoolDir, { recursive: true, force: true });
  });

  describe("64 KB or smaller: unchanged", () => {
    it("the normal 144-byte punch is stored and ACKed", async () => {
      const captured = fs.readFileSync(path.join(__dirname, "..", "test_support", "biomax", "real-punch-request.bin"));
      const r = await send(port, captured);
      assert.equal(r.headers.response_code, "OK");
      assert.equal(store.state.punches.size, 1);
    });

    it("a VALID punch whose body is exactly 64 KB is stored and ACKed (the punch row is the durability)", async () => {
      const r = await send(port, glog(validPunchBody(LIMIT)));
      assert.equal(r.headers.response_code, "OK");
      assert.equal(store.state.punches.size, 1);
      assert.equal(store.state.raw.length, 0, "no raw row needed or written");
    });

    it("a retransmission of it is still OK and still one row", async () => {
      const f = glog(validPunchBody(LIMIT, "20260926120100"));
      assert.equal((await send(port, f)).headers.response_code, "OK");
      assert.equal((await send(port, f)).headers.response_code, "OK");
      assert.equal(store.state.punches.size, 1);
      assert.equal([...store.state.punches.values()][0].retransmits, 1);
    });

    it("an unparseable frame that fits raw_frame whole is preserved COMPLETE, then ACKed", async () => {
      const body = Buffer.alloc(60000, 0x41); // no JSON
      const f = glog(body);
      assert.ok(f.length <= RAW_FRAME_MAX_BYTES);
      const r = await send(port, f);
      assert.equal(r.headers.response_code, "OK");
      assert.equal(store.state.raw.length, 1);
      const row = store.state.raw[0];
      assert.equal(row.outcome, "unparsed");
      assert.equal(row.raw_frame.length, f.length, "the whole frame, byte for byte");
      assert.ok(row.raw_frame.equals(f));
      assert.equal(store.state.rawOptions[0].requireComplete, true, "the store is told it must not truncate");
    });
  });

  describe("over 64 KB: zero ACK bytes", () => {
    it("64 KB + 1 byte: nothing written back, socket closed, no punch, no durability row", async () => {
      const body = validPunchBody(LIMIT + 1, "20260926120200");
      const r = await send(port, glog(body));
      assert.equal(r.timedOut, undefined, "closed, not left hanging");
      assert.equal(r.raw.length, 0, "zero bytes - not even a status line");
      assert.equal(store.state.punches.size, 0, "a valid-looking punch over the limit is not parsed into a row either");
      assert.equal(store.state.raw.filter((x) => x.outcome !== "oversized").length, 0);
      assert.equal(fs.readdirSync(spoolDir).length, 0, "the body is not spooled");
    });

    it("records bounded metadata with the sha256 of the COMPLETE body, computed while streaming", async () => {
      const body = crypto.randomBytes(200 * 1024);
      await send(port, glog(body, "AMDB24121401205"));
      const line = log.lines.find((l) => l.code === "OVERSIZED_PUNCH_REFUSED");
      assert.ok(line, "explicit OVERSIZED_PUNCH_REFUSED");
      assert.equal(line.dev_id, "AMDB24121401205");
      assert.equal(line.content_length, body.length);
      assert.equal(line.bytes_received, body.length);
      assert.equal(line.source_ip, "127.0.0.1");
      assert.match(line.received_at, /^\d{4}-\d{2}-\d{2}T/);
      assert.equal(line.body_sha256, crypto.createHash("sha256").update(body).digest("hex"));
      assert.equal(line.limit, LIMIT);
      await receiver.housekeeping.idle();
      const diagRow = store.state.raw.find((x) => x.outcome === "oversized");
      assert.ok(diagRow, "a diagnostic row");
      assert.match(diagRow.reason, /^REFUSED, NOT ACKNOWLEDGED/);
      assert.ok(diagRow.raw_frame.length < 1024, "headers only - never the body");
      assert.equal(receiver.stats().oversized_punch_refused.total, 1);
    });

    it("a body declared over the 1 MB hashing cap is refused without reading it", async () => {
      const f = Buffer.concat([Buffer.from(headers("C2695C56D30E1430", 5 * 1024 * 1024), "latin1"), Buffer.alloc(64 * 1024)]);
      const r = await send(port, f);
      assert.equal(r.raw.length, 0);
      const line = log.lines.find((l) => l.code === "OVERSIZED_PUNCH_REFUSED");
      assert.equal(line.why, "declared_over_hash_limit");
      assert.equal(line.bytes_received, 0);
      assert.equal(line.body_sha256, null);
    });

    it("a chunked body with no Content-Length is cut off at the hashing cap", async () => {
      const head = headers("C2695C56D30E1430", null).replace("HTTP/1.0", "HTTP/1.1").replace("Connection: close\r\n", "Connection: close\r\nTransfer-Encoding: chunked\r\n");
      const chunk = Buffer.alloc(256 * 1024, 0x42);
      const parts = [Buffer.from(head, "latin1")];
      for (let i = 0; i < 8; i += 1) parts.push(Buffer.from(`${chunk.length.toString(16)}\r\n`, "latin1"), chunk, Buffer.from("\r\n", "latin1"));
      parts.push(Buffer.from("0\r\n\r\n", "latin1"));
      const r = await send(port, Buffer.concat(parts));
      assert.equal(r.raw.length, 0);
      const line = log.lines.find((l) => l.code === "OVERSIZED_PUNCH_REFUSED");
      assert.equal(line.why, "stream_over_hash_limit");
      assert.equal(line.body_sha256, null, "not the hash of a partial body");
    });

    it("OVERSIZED_PUNCH_REFUSED is rate-limited per device; every refusal is still counted", async () => {
      const f = glog(Buffer.alloc(LIMIT + 10, 0x41));
      for (let i = 0; i < 25; i += 1) assert.equal((await send(port, f)).raw.length, 0);
      assert.equal(log.lines.filter((l) => l.code === "OVERSIZED_PUNCH_REFUSED").length, 1);
      assert.equal(receiver.stats().oversized_punch_refused.total, 25);
      await receiver.housekeeping.idle();
      assert.equal(store.state.raw.filter((x) => x.outcome === "oversized").length, 1, "one diagnostic row for an identical frame");
    });
  });

  describe("no truncated row is ever sufficient for an ACK", () => {
    it("an unparseable body UNDER the limit whose frame cannot fit raw_frame whole gets NO reply", async () => {
      // 64 KB exactly: within BIOMAX_MAX_BODY, but headers + body > 65535.
      const f = glog(Buffer.alloc(LIMIT, 0x41));
      assert.ok(f.length > RAW_FRAME_MAX_BYTES);
      const r = await send(port, f);
      assert.equal(r.raw.length, 0, "a truncated copy would not be the frame; no OK");
      assert.equal(store.state.raw.filter((x) => x.outcome !== "oversized").length, 0, "no durability row attempted");
      const line = log.lines.find((l) => l.code === "OVERSIZED_PUNCH_REFUSED");
      assert.equal(line.why, "frame_too_large_to_preserve");
    });

    it("the same holds for a header-less or flood-capped frame (every preserveAndAck path)", async () => {
      const noDev = Buffer.concat([Buffer.from(headers("", LIMIT).replace("dev_id: \r\n", ""), "latin1"), Buffer.alloc(LIMIT, 0x41)]);
      assert.equal((await send(port, noDev)).raw.length, 0);
      assert.equal(store.state.raw.filter((x) => x.outcome !== "oversized").length, 0);
    });

    it("every row an ACK rested on holds the complete frame (byte_length === raw_frame.length)", async () => {
      await send(port, glog(Buffer.from("\x8c\x00\x00\x00garbage")));
      await send(port, glog(Buffer.alloc(30000, 0x41)));
      await send(port, glog(Buffer.alloc(LIMIT + 100, 0x41)));
      await send(port, glog(Buffer.alloc(LIMIT, 0x41)));
      store.state.raw.forEach((row, i) => {
        if (store.state.rawOptions[i].requireComplete) assert.equal(row.raw_frame.length, row.byte_length, row.outcome);
      });
      assert.equal(store.state.rawOptions.filter((o) => o.requireComplete).length, 2, "only the two that fit");
    });

    it("the store itself refuses to 'preserve' a frame it would have to truncate", async () => {
      const issued = [];
      const pool = { query: (sql, params, cb) => (issued.push(sql), cb(null, [])), getConnection: (cb) => cb(new Error("unused")) };
      const s = createStore(pool);
      await assert.rejects(
        s.insertRawRequest({ outcome: "unparsed", raw_frame: Buffer.alloc(RAW_FRAME_MAX_BYTES + 1) }, { requireComplete: true }),
        (err) => err.code === "BIOMAX_FRAME_TOO_LARGE_TO_PRESERVE"
      );
      assert.equal(issued.length, 0, "nothing written");
      await s.insertRawRequest({ outcome: "unparsed", raw_frame: Buffer.alloc(RAW_FRAME_MAX_BYTES) }, { requireComplete: true });
      assert.equal(issued.length, 1, "a frame that fits is written");
    });
  });

  describe("memory during repeated oversized frames", () => {
    it("2 x 300 x 512 KB oversized punches, 20 at a time: zero ACK bytes, nothing retained", async (t) => {
      const body = crypto.randomBytes(512 * 1024);
      const f = glog(body);
      // Client and server share this process: let closed sockets and their
      // write buffers actually be released before measuring.
      const settle = async () => {
        for (let i = 0; i < 4; i += 1) {
          gc();
          await new Promise((r) => setTimeout(r, 25));
        }
        const m = process.memoryUsage();
        return m.heapUsed + m.arrayBuffers;
      };
      const batch = async (n) => {
        let next = 0;
        const results = [];
        await Promise.all(
          Array.from({ length: 20 }, async () => {
            while (next < n) {
              next += 1;
              results.push(await send(port, f));
            }
          })
        );
        await receiver.housekeeping.idle();
        return results;
      };
      await batch(20); // warm-up
      const m0 = await settle();
      const r1 = await batch(300);
      const m1 = await settle();
      const r2 = await batch(300);
      const m2 = await settle();
      const mb = (b) => (b / 1048576).toFixed(2);
      t.diagnostic(`oversized flood: 600 x ${f.length} B frames (${mb(600 * f.length)} MB received); zero-byte replies ${[...r1, ...r2].every((r) => r.raw.length === 0)}; heap+buffers after batch 1 ${mb(m1 - m0)} MB, after batch 2 ${mb(m2 - m0)} MB (batch-2 delta ${mb(m2 - m1)} MB); refused_total ${receiver.stats().oversized_punch_refused.total}; OVERSIZED_PUNCH_REFUSED lines ${log.lines.filter((l) => l.code === "OVERSIZED_PUNCH_REFUSED").length}`);
      assert.ok([...r1, ...r2].every((r) => r.raw.length === 0), "zero ACK bytes, every time");
      // Retention would scale with frames: 300 frames x 512 KB = 150 MB a batch.
      assert.ok(m2 - m1 < 10 * 1024 * 1024, `second batch grew ${mb(m2 - m1)} MB`);
      assert.ok(m2 - m0 < 25 * 1024 * 1024, `total growth ${mb(m2 - m0)} MB for ${mb(600 * f.length)} MB received`);
      assert.equal(store.state.punches.size, 0);
      assert.ok(store.state.raw.length <= 1, "one headers-only diagnostic row, not one per frame");
    });
  });
});
