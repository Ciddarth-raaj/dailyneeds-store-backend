/**
 * The receiver end to end: real TCP on port 0, a fake store, the captured
 * frame replayed byte for byte.
 *
 *   node --test biomax/receiver.test.js
 *
 * Every assertion about the reply is on the `response_code` HEADER. An HTTP
 * 200 is never evidence of success here: the device ignores the status line,
 * and a 200 without the header is a retry storm, not a pass.
 */
const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");

const { createReceiver } = require("./receiver");
const protocol = require("./protocol");
const { createFloodGuard } = require("./flood");

const fixtures = path.join(__dirname, "..", "test_support", "biomax");
const captured = fs.readFileSync(path.join(fixtures, "real-punch-request.bin"));

/* ------------------------------------------------------------ fake store */

function makeStore() {
  const calls = [];
  const state = {
    devices: new Map([["C2695C56D30E1430", { biomax_device_id: 6, first_seen_at: null }]]),
    employees: new Map([[1952, { employee_id: 1952, store_id: 2, department_id: 4, default_work_shift_id: 7 }]]),
    // shift 7: every day working, cutoff 04:00
    schedule: new Map([0, 1, 2, 3, 4, 5, 6].map((d) => [`7:${d}`, { work_shift_weekly_schedule_id: 700 + d, is_working_day: 1, attendance_day_cutoff: "04:00:00" }])),
    punches: new Map(), // key -> {punch, derived, retransmits}
    raw: [],
    touched: [],
    failInsert: null,
    failRaw: null,
    failFind: null,
  };
  let nextId = 1;
  const store = {
    state,
    calls,
    async findDevice(devId) {
      calls.push(["findDevice", devId]);
      if (state.failFind) throw state.failFind;
      return state.devices.get(devId) || null;
    },
    async findEmployee(id) {
      calls.push(["findEmployee", id]);
      return state.employees.get(id) || null;
    },
    async findScheduleRow(shift, dow) {
      calls.push(["findScheduleRow", shift, dow]);
      return state.schedule.get(`${shift}:${dow}`) || null;
    },
    async insertPunch(punch, derived) {
      calls.push(["insertPunch", punch, derived]);
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
    async insertRawRequest(entry) {
      calls.push(["insertRawRequest", entry.outcome]);
      if (state.failRaw) throw state.failRaw;
      state.raw.push(entry);
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
    async close() {},
  };
  return store;
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

/* --------------------------------------------------------------- client */

/** Send raw bytes, collect the whole reply until the server closes. */
function send(port, frame, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, "127.0.0.1", () => sock.write(frame));
    const chunks = [];
    const timer = setTimeout(() => {
      sock.destroy();
      resolve({ raw: Buffer.concat(chunks), timedOut: true });
    }, timeoutMs);
    sock.on("data", (d) => chunks.push(d));
    sock.on("close", () => {
      clearTimeout(timer);
      resolve({ raw: Buffer.concat(chunks), timedOut: false });
    });
    sock.on("error", (e) => {
      clearTimeout(timer);
      // A reset after our write is the "no ACK" path; report it as empty.
      if (e.code === "ECONNRESET") return resolve({ raw: Buffer.concat(chunks), timedOut: false, reset: true });
      reject(e);
    });
  });
}

/** A punch frame with the device's real header set and a fresh JSON body. */
function punchFrame({ dev_id = "C2695C56D30E1430", user_id = "1952", io_time = "20260915023000", verify = 1073741824, iomode = 16777216, request_code = "realtime_glog", body } = {}) {
  let bodyBuf;
  if (body !== undefined) {
    bodyBuf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  } else {
    const json = `{"fk_bin_data_lib":"FKDataHS102","io_mode":${iomode},"io_time":"${io_time}","log_image":null,"user_id":${JSON.stringify(user_id)},"verify_mode":${verify}}`;
    const j = Buffer.from(json, "utf8");
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32LE(j.length + 2);
    bodyBuf = Buffer.concat([prefix, j, Buffer.from([0x0a, 0x00])]);
  }
  const headers =
    `POST /hdata.aspx HTTP/1.0\r\n` +
    `Accept: image/gif, image/x-xbitmap, image/jpeg, image/pjpeg, application/vnd.ms-excel, application/msword, application/vnd.ms-powerpoint, */*\r\n` +
    `Accept-Language: en-us\r\n` +
    `Accept-Encoding: gzip, deflate\r\n` +
    `User-Agent: Mozilla/4.0\r\n` +
    `Content-Type: application/octet-stream\r\n` +
    `Connection: close\r\n` +
    `request_code: ${request_code}\r\n` +
    `Content-Type: application/octet-stream\r\n` +
    `Content-Length: ${bodyBuf.length}\r\n` +
    `cmd_id: RTLogSendAction\r\n` +
    `dev_id: ${dev_id}\r\n` +
    `blk_no: 0\r\n` +
    `blk_len: ${bodyBuf.length}\r\n` +
    `HOST: 127.0.0.1:7005\r\n\r\n`;
  return Buffer.concat([Buffer.from(headers, "latin1"), bodyBuf]);
}

function pollFrame({ dev_id = "C2695C56D30E1430", request_code = "receive_cmd" } = {}) {
  return Buffer.from(
    `POST /hdata.aspx HTTP/1.0\r\n` +
      `User-Agent: Mozilla/4.0\r\n` +
      `Content-Type: application/octet-stream\r\n` +
      `Connection: close\r\n` +
      `request_code: ${request_code}\r\n` +
      `Content-Length: 0\r\n` +
      `dev_id: ${dev_id}\r\n` +
      `blk_no: 0\r\n` +
      `blk_len: 0\r\n` +
      `HOST: 127.0.0.1:7005\r\n\r\n`,
    "latin1"
  );
}

/* ---------------------------------------------------------------- suite */

describe("receiver", () => {
  let store;
  let log;
  let receiver;
  let port;
  let spoolDir;

  before(async () => {
    spoolDir = fs.mkdtempSync(path.join(os.tmpdir(), "biomax-spool-"));
  });
  after(() => {
    fs.rmSync(spoolDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    if (receiver) await receiver.close();
    store = makeStore();
    log = makeLog();
    receiver = createReceiver({
      store,
      log,
      flood: createFloodGuard({ limits: { perMinute: 3, perDay: 5, devicesPerDay: 2 } }),
      config: { spoolDir, maxBodyBytes: 2048 },
    });
    port = (await receiver.listen(0, "127.0.0.1")).port;
  });
  after(async () => {
    if (receiver) await receiver.close();
  });

  describe("the captured frame, byte for byte", () => {
    it("is acknowledged with response_code OK, Content-Length 0, and the socket closed", async () => {
      const { raw, timedOut } = await send(port, captured);
      assert.equal(timedOut, false, "server closed the connection");
      const { statusLine, headers } = protocol.parseReplyHeaders(raw);
      assert.match(statusLine, /^HTTP\/1\.1 200/);
      assert.equal(headers.response_code, "OK", "the protocol header, not the status line, is the ACK");
      assert.equal(headers["content-length"], "0");
      assert.equal(headers.connection, "close");
      assert.equal("cmd_id" in headers, false);
      assert.equal(raw.subarray(raw.indexOf("\r\n\r\n") + 4).length, 0, "empty body");
    });

    it("stores exactly the fields the device sent, and dates it under the previous day's cutoff", async () => {
      await send(port, captured);
      const [stored] = [...store.state.punches.values()];
      assert.equal(stored.punch.dev_id, "C2695C56D30E1430");
      assert.equal(stored.punch.user_id, "1952");
      assert.equal(stored.punch.io_time_raw, "20260910135741");
      assert.equal(stored.punch.verify_mode, 1073741824);
      assert.equal(stored.punch.io_mode, 16777216);
      assert.equal(stored.punch.cmd_id, "RTLogSendAction");
      assert.equal(stored.punch.blk_len, 144);
      assert.equal(stored.punch.content_length, 144);
      assert.equal(stored.punch.body_len_prefix, 140);
      assert.equal(stored.punch.source_ip, "127.0.0.1");
      // 13:57 is after the 04:00 cutoff -> its own calendar date.
      assert.equal(stored.derived.attendance_date, "2026-09-10");
      assert.equal(stored.derived.status, "OK");
      assert.equal(stored.derived.employee_id, 1952);
      assert.equal(stored.derived.home_outlet_id, 2);
      assert.equal(stored.derived.department_id, 4);
      assert.equal(stored.derived.work_shift_id, 7);
      assert.equal(stored.derived.cutoff_applied, "04:00:00");
      // The previous day of 2026-09-10 (Thu) is Wed = 3.
      assert.deepEqual(store.calls.find((c) => c[0] === "findScheduleRow"), ["findScheduleRow", 7, 3]);
    });

    it("logs one line with dev_id, request_code, outcome and source_ip", async () => {
      await send(port, captured);
      const line = log.lines.find((l) => l.outcome === "stored");
      assert.ok(line);
      assert.equal(line.dev_id, "C2695C56D30E1430");
      assert.equal(line.request_code, "realtime_glog");
      assert.equal(line.source_ip, "127.0.0.1");
      assert.equal(line.user_id, "1952");
      assert.equal(line.io_time_raw, "20260910135741");
      assert.equal(typeof line.duration_ms, "number");
    });
  });

  describe("poll", () => {
    it("receive_cmd -> ERROR_NO_CMD with EMPTY cmd_id and cmd_code headers present", async () => {
      const { raw } = await send(port, pollFrame());
      const { headers } = protocol.parseReplyHeaders(raw);
      assert.equal(headers.response_code, "ERROR_NO_CMD");
      assert.equal(headers.cmd_id, "");
      assert.equal(headers.cmd_code, "");
      assert.equal(headers["content-length"], "0");
      assert.equal(store.state.raw.length, 0, "a normal poll is not recorded");
      assert.deepEqual(store.state.touched, [["C2695C56D30E1430", { punch: false }]]);
    });

    it("an unknown request_code is answered as a poll and preserved verbatim", async () => {
      const { raw } = await send(port, pollFrame({ request_code: "upload_photo" }));
      assert.equal(protocol.parseReplyHeaders(raw).headers.response_code, "ERROR_NO_CMD");
      assert.equal(store.state.raw[0].outcome, "unknown_request_code");
      assert.ok(store.state.raw[0].raw_frame.toString("latin1").includes("request_code: upload_photo"));
    });

    it("a missing request_code is answered as a poll", async () => {
      const frame = Buffer.from("POST /hdata.aspx HTTP/1.0\r\nContent-Length: 0\r\ndev_id: X\r\n\r\n", "latin1");
      const { raw } = await send(port, frame);
      assert.equal(protocol.parseReplyHeaders(raw).headers.response_code, "ERROR_NO_CMD");
    });
  });

  describe("retransmission (R2)", () => {
    it("the same punch twice: both OK, one row, counted as duplicate", async () => {
      const a = await send(port, captured);
      const b = await send(port, captured);
      assert.equal(protocol.parseReplyHeaders(a.raw).headers.response_code, "OK");
      assert.equal(protocol.parseReplyHeaders(b.raw).headers.response_code, "OK");
      assert.equal(store.state.punches.size, 1);
      assert.equal([...store.state.punches.values()][0].retransmits, 1);
      assert.ok(log.lines.some((l) => l.outcome === "duplicate"));
    });
  });

  describe("R1 - ACK only what is durable", () => {
    it("store failure: NO response_code, socket closed, frame spooled, error logged", async () => {
      store.state.failInsert = new Error("ER_CONNECTION_LOST");
      const { raw, timedOut } = await send(port, captured);
      assert.equal(timedOut, false);
      assert.equal(raw.length, 0, "nothing at all is written back");
      const line = log.lines.find((l) => l.outcome === "store_error");
      assert.ok(line);
      assert.match(line.error, /ER_CONNECTION_LOST/);
      assert.ok(fs.existsSync(line.spooled));
      assert.equal(fs.readFileSync(line.spooled).length, captured.length);
    });

    it("lookup failure before the insert is also a no-ACK", async () => {
      store.state.failFind = new Error("db down");
      const { raw } = await send(port, captured);
      assert.equal(raw.length, 0);
      assert.equal(store.state.punches.size, 0);
    });

    it("unparseable body: preserved in biomax_raw_request, then OK", async () => {
      const { raw } = await send(port, punchFrame({ body: Buffer.from("\x8c\x00\x00\x00garbage without braces") }));
      assert.equal(protocol.parseReplyHeaders(raw).headers.response_code, "OK");
      assert.equal(store.state.raw[0].outcome, "unparsed");
      assert.match(store.state.raw[0].reason, /no JSON/);
      assert.equal(store.state.punches.size, 0);
    });

    it("unparseable body AND raw table failing: no ACK", async () => {
      store.state.failRaw = new Error("raw table gone");
      const { raw } = await send(port, punchFrame({ body: Buffer.from("nope") }));
      assert.equal(raw.length, 0);
    });

    it("oversized body: truncated frame preserved as oversized, no punch, OK", async () => {
      const big = Buffer.alloc(5000, 0x41);
      const { raw } = await send(port, punchFrame({ body: big }));
      assert.equal(protocol.parseReplyHeaders(raw).headers.response_code, "OK");
      assert.equal(store.state.raw[0].outcome, "oversized");
      assert.ok(store.state.raw[0].raw_frame.length < 5000);
      assert.equal(store.state.punches.size, 0);
    });

    it("a punch without dev_id is preserved, not stored as a punch", async () => {
      const frame = Buffer.from(
        "POST /hdata.aspx HTTP/1.0\r\nrequest_code: realtime_glog\r\nContent-Length: 2\r\n\r\n{}",
        "latin1"
      );
      const { raw } = await send(port, frame);
      assert.equal(protocol.parseReplyHeaders(raw).headers.response_code, "OK");
      assert.equal(store.state.raw[0].outcome, "unparsed");
      assert.match(store.state.raw[0].reason, /missing dev_id/);
    });
  });

  describe("attendance date at ingest (R18, A3)", () => {
    it("Tue 02:30 under Monday's 04:00 cutoff -> Monday", async () => {
      await send(port, punchFrame({ io_time: "20260915023000" }));
      const [p] = [...store.state.punches.values()];
      assert.equal(p.derived.attendance_date, "2026-09-14");
      assert.equal(p.derived.status, "OK");
    });

    it("unmatched employee code: stored, dated null, UNMATCHED, no shift read", async () => {
      await send(port, punchFrame({ user_id: "999999" }));
      const [p] = [...store.state.punches.values()];
      assert.equal(p.derived.attendance_date, null);
      assert.equal(p.derived.status, "UNMATCHED");
      assert.equal(p.derived.employee_id, null);
      assert.equal(p.punch.user_id, "999999");
      assert.ok(!store.calls.some((c) => c[0] === "findScheduleRow"));
    });

    it("never matches employee 0 or a non-numeric code", async () => {
      for (const id of ["0", "000", "A123", "12 "]) {
        store.state.punches.clear();
        store.calls.length = 0;
        await send(port, punchFrame({ user_id: id, io_time: "2026091502300" + (id.length % 10) }));
        assert.ok(!store.calls.some((c) => c[0] === "findEmployee"), `${id}: no employee lookup`);
        const [p] = [...store.state.punches.values()];
        assert.equal(p.derived.status, "UNMATCHED", id);
        assert.equal(p.punch.user_id, id, "raw code preserved verbatim");
      }
    });

    it("no assigned shift: NO_SHIFT, dated null", async () => {
      store.state.employees.set(77, { employee_id: 77, store_id: 3, department_id: 1, default_work_shift_id: null });
      await send(port, punchFrame({ user_id: "77" }));
      const [p] = [...store.state.punches.values()];
      assert.equal(p.derived.status, "NO_SHIFT");
      assert.equal(p.derived.attendance_date, null);
      assert.equal(p.derived.home_outlet_id, 3, "posting still snapshotted");
    });

    it("working previous day without a cutoff: MISSING_CUTOFF, dated null, config error recorded once per hour", async () => {
      store.state.schedule.set("7:1", { work_shift_weekly_schedule_id: 701, is_working_day: 1, attendance_day_cutoff: null });
      await send(port, punchFrame({ io_time: "20260915023000" }));
      await send(port, punchFrame({ io_time: "20260915023100" }));
      const rows = [...store.state.punches.values()];
      assert.equal(rows.length, 2);
      for (const p of rows) {
        assert.equal(p.derived.status, "MISSING_CUTOFF");
        assert.equal(p.derived.attendance_date, null);
        assert.equal(p.derived.work_shift_weekly_schedule_id, 701);
      }
      assert.equal(store.state.raw.filter((r) => r.outcome === "config_error").length, 1);
      assert.ok(log.lines.filter((l) => l.derivation_status === "MISSING_CUTOFF" && l.error).length >= 2);
    });

    it("previous day a rest day: own date, no cutoff applied", async () => {
      store.state.schedule.set("7:1", { work_shift_weekly_schedule_id: 701, is_working_day: 0, attendance_day_cutoff: null });
      await send(port, punchFrame({ io_time: "20260915010000" }));
      const [p] = [...store.state.punches.values()];
      assert.equal(p.derived.status, "OK");
      assert.equal(p.derived.attendance_date, "2026-09-15");
      assert.equal(p.derived.cutoff_applied, null);
    });
  });

  describe("unregistered devices (D3, R13)", () => {
    it("first punch: stored, OK, one first-seen raw row, error-level log line", async () => {
      const { raw } = await send(port, punchFrame({ dev_id: "UNKNOWN0001" }));
      assert.equal(protocol.parseReplyHeaders(raw).headers.response_code, "OK");
      assert.equal(store.state.punches.size, 1);
      assert.equal(store.state.raw.filter((r) => r.outcome === "unregistered_device_first_seen").length, 1);
      const line = log.lines.find((l) => l.outcome === "stored_unregistered");
      assert.ok(line && line.error);
      // Not touched: there is no device row to touch.
      assert.equal(store.state.touched.length, 0);
    });

    it("second punch from the same unknown device adds no second first-seen row", async () => {
      await send(port, punchFrame({ dev_id: "UNKNOWN0001", io_time: "20260915023000" }));
      await send(port, punchFrame({ dev_id: "UNKNOWN0001", io_time: "20260915023100" }));
      assert.equal(store.state.raw.filter((r) => r.outcome === "unregistered_device_first_seen").length, 1);
      assert.equal(store.state.punches.size, 2);
    });

    it("beyond the per-minute cap: not stored, still OK, one flood_capped row", async () => {
      for (let i = 0; i < 5; i += 1) {
        const { raw } = await send(port, punchFrame({ dev_id: "FLOOD00001", io_time: `2026091502300${i}` }));
        assert.equal(protocol.parseReplyHeaders(raw).headers.response_code, "OK", `frame ${i}`);
      }
      assert.equal(store.state.punches.size, 3, "cap of 3 per minute in this test");
      assert.equal(store.state.raw.filter((r) => r.outcome === "flood_capped").length, 1);
      assert.ok(log.lines.some((l) => l.outcome === "flood_capped" && l.error));
    });

    it("beyond the distinct-devices cap: the third unknown device is capped", async () => {
      await send(port, punchFrame({ dev_id: "NEWDEV0001" }));
      await send(port, punchFrame({ dev_id: "NEWDEV0002" }));
      const { raw } = await send(port, punchFrame({ dev_id: "NEWDEV0003" }));
      assert.equal(protocol.parseReplyHeaders(raw).headers.response_code, "OK");
      assert.equal(store.state.punches.size, 2);
    });

    it("a registered device is never capped", async () => {
      for (let i = 0; i < 6; i += 1) await send(port, punchFrame({ io_time: `2026091502300${i}` }));
      assert.equal(store.state.punches.size, 6);
      assert.equal(store.state.raw.filter((r) => r.outcome === "flood_capped").length, 0);
    });
  });

  describe("health", () => {
    it("GET /healthz answers JSON with ok:true", async () => {
      const { raw } = await send(port, Buffer.from("GET /healthz HTTP/1.0\r\n\r\n", "latin1"));
      const body = raw.subarray(raw.indexOf("\r\n\r\n") + 4).toString();
      assert.deepEqual(JSON.parse(body).ok, true);
    });
  });
});
