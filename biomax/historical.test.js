/**
 * Historical pull scaffolding, end to end against a FAKE device and a fake
 * store: real TCP on port 0, frames synthesised with the device's real header
 * set. No real terminal is involved and nothing here can reach one.
 *
 *   node --test biomax/historical.test.js
 *
 * What is proven:
 *   - receive_cmd with nothing queued -> ERROR_NO_CMD exactly as before
 *   - receive_cmd with a queued GET_LOG_DATA -> the command, once
 *   - the right device gets its own command; another device does not
 *   - repeated polls do not hand the same command out twice
 *   - with BIOMAX_COMMANDS_ENABLED off (the default) nothing is ever handed out
 *   - send_cmd_result is matched by dev_id + trans_id, stored raw, ACKed OK
 *   - multi-block storage, duplicate blocks, out-of-order blocks
 *   - unknown trans_id and wrong-device trans_id are kept but not attached
 *   - a failing cmd_return_code fails the pull
 *   - the raw body is preserved byte for byte, including bytes no JSON
 *     parser would accept - nothing decodes it
 *   - a store failure while keeping a block -> NO ACK (R1)
 */
const { describe, it, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const net = require("net");

const { createReceiver } = require("./receiver");
const protocol = require("./protocol");
const commands = require("./commands");

const WH = "C2695C56D30E1430";
const G2 = "AMDB24121401307";

/* ------------------------------------------------------------ fake store */

function makeStore() {
  const state = {
    devices: new Map([[WH, { biomax_device_id: 6 }], [G2, { biomax_device_id: 7 }]]),
    commands: [], // {id, pull_id, trans_id, dev_id, cmd_code, begin_time, end_time, status, sent_to_ip}
    pulls: new Map(), // id -> {status, sent_at, first_result_at, failed_at, failure_reason}
    blocks: new Map(), // `${dev}|${trans}|${blk}` -> {row, duplicate_count, conflict_count}
    raw: [],
    touched: [],
    failBlockInsert: null,
    failClaim: null,
  };
  let nextCommandId = 1;
  const store = {
    state,
    queue({ pull_id, trans_id, dev_id, begin_time, end_time }) {
      const cmd = commands.buildGetLogDataCommand({ trans_id, dev_id, begin_time, end_time });
      state.commands.push({ id: nextCommandId++, pull_id, ...cmd, sent_to_ip: null });
      state.pulls.set(pull_id, { status: "REQUESTED", sent_at: null, first_result_at: null, failed_at: null, failure_reason: null });
      return cmd;
    },
    async findDevice(devId) {
      return state.devices.get(devId) || null;
    },
    async findEmployee() {
      return null;
    },
    async findScheduleRow() {
      return null;
    },
    async insertPunch() {
      throw new Error("no punch expected in this suite");
    },
    async insertRawRequest(entry) {
      state.raw.push(entry);
    },
    async touchDevice(devId, opts) {
      state.touched.push([devId, opts]);
    },
    async claimPendingCommand(devId, sourceIp) {
      if (state.failClaim) throw state.failClaim;
      const cmd = state.commands.find((c) => c.dev_id === devId && c.status === "PENDING");
      if (!cmd) return null;
      cmd.status = "SENT";
      cmd.sent_to_ip = sourceIp;
      const pull = state.pulls.get(cmd.pull_id);
      if (pull.status === "REQUESTED") {
        pull.status = "WAITING_DEVICE";
        pull.sent_at = "now";
      }
      return { biomax_device_command_id: cmd.id, biomax_historical_pull_id: cmd.pull_id, trans_id: cmd.trans_id, dev_id: cmd.dev_id, cmd_code: cmd.cmd_code, begin_time: cmd.begin_time, end_time: cmd.end_time };
    },
    async findCommandByTransId(transId) {
      const cmd = state.commands.find((c) => c.trans_id === transId);
      return cmd ? { biomax_device_command_id: cmd.id, biomax_historical_pull_id: cmd.pull_id, trans_id: cmd.trans_id, dev_id: cmd.dev_id, cmd_code: cmd.cmd_code, status: cmd.status } : null;
    },
    async insertResultBlock(block) {
      if (state.failBlockInsert) throw state.failBlockInsert;
      const key = `${block.dev_id}|${block.trans_id || ""}|${block.blk_no}`;
      const hash = crypto.createHash("sha256").update(block.raw_body).digest("hex");
      const existing = state.blocks.get(key);
      if (existing) {
        if (existing.row.body_sha256 === hash) existing.duplicate_count += 1;
        else existing.conflict_count += 1;
        return { outcome: existing.row.body_sha256 === hash ? "duplicate" : "conflict", body_sha256: hash };
      }
      state.blocks.set(key, { row: { ...block, raw_body: Buffer.from(block.raw_body), body_sha256: hash }, duplicate_count: 0, conflict_count: 0 });
      return { outcome: "stored", body_sha256: hash };
    },
    async markPullReceiving(pullId) {
      const p = state.pulls.get(pullId);
      if (p && (p.status === "REQUESTED" || p.status === "WAITING_DEVICE")) {
        p.status = "RECEIVING";
        p.first_result_at = p.first_result_at || "now";
      }
    },
    async markPullFailed(pullId, reason) {
      const p = state.pulls.get(pullId);
      if (p && p.status !== "COMPLETED" && p.status !== "FAILED") {
        p.status = "FAILED";
        p.failed_at = "now";
        p.failure_reason = reason;
      }
      for (const c of state.commands) if (c.pull_id === pullId) c.status = "FAILED";
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
  return { lines, request: (f) => lines.push({ ...f }), error: (code, description, ref) => lines.push({ outcome: "ERROR", code, description, ...(ref || {}) }), info: () => {} };
}

/* --------------------------------------------------------------- client */

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
      if (e.code === "ECONNRESET") return resolve({ raw: Buffer.concat(chunks), timedOut: false, reset: true });
      reject(e);
    });
  });
}

function splitReply(raw) {
  const idx = raw.indexOf("\r\n\r\n");
  return { ...protocol.parseReplyHeaders(raw), body: idx === -1 ? Buffer.alloc(0) : raw.subarray(idx + 4) };
}

/** The device's header set. `extra` lines are appended verbatim. */
function frame({ request_code, dev_id = WH, body = Buffer.alloc(0), extra = [] }) {
  const b = Buffer.isBuffer(body) ? body : Buffer.from(body, "latin1");
  const head =
    `POST /hdata.aspx HTTP/1.0\r\n` +
    `User-Agent: Mozilla/4.0\r\n` +
    `Content-Type: application/octet-stream\r\n` +
    `Connection: close\r\n` +
    `request_code: ${request_code}\r\n` +
    `Content-Type: application/octet-stream\r\n` +
    `Content-Length: ${b.length}\r\n` +
    `dev_id: ${dev_id}\r\n` +
    extra.map((l) => `${l}\r\n`).join("") +
    `HOST: 127.0.0.1:7005\r\n\r\n`;
  return Buffer.concat([Buffer.from(head, "latin1"), b]);
}
const poll = (dev_id = WH) => frame({ request_code: "receive_cmd", dev_id, extra: ["blk_no: 0", "blk_len: 0"] });
const result = ({ dev_id = WH, trans_id, blk_no = 0, body, cmd_return_code = "OK", cmd_id }) =>
  frame({
    request_code: "send_cmd_result",
    dev_id,
    body,
    extra: [
      `cmd_id: ${cmd_id === undefined ? trans_id : cmd_id}`,
      `trans_id: ${trans_id}`,
      `cmd_return_code: ${cmd_return_code}`,
      `blk_no: ${blk_no}`,
      `blk_len: ${Buffer.byteLength(body)}`,
    ],
  });

/* ---------------------------------------------------------------- suite */

describe("historical pull scaffolding (fake device)", () => {
  let store;
  let log;
  let receiver;
  let port;
  const TRANS = "HP20260910120000ABCDEF1234";

  async function start(config) {
    if (receiver) await receiver.close();
    store = makeStore();
    log = makeLog();
    receiver = createReceiver({ store, log, config: { commandsEnabled: true, ...(config || {}) } });
    port = (await receiver.listen(0, "127.0.0.1")).port;
  }
  beforeEach(() => start());
  after(async () => {
    if (receiver) await receiver.close();
  });

  describe("receive_cmd", () => {
    it("no pending command -> ERROR_NO_CMD with the two empty headers, unchanged", async () => {
      const { headers, body } = splitReply((await send(port, poll())).raw);
      assert.equal(headers.response_code, "ERROR_NO_CMD");
      assert.equal(headers.cmd_id, "");
      assert.equal(headers.cmd_code, "");
      assert.equal(headers["content-length"], "0");
      assert.equal(body.length, 0);
    });

    it("pending GET_LOG_DATA -> the command, with its trans_id and the requested window", async () => {
      store.queue({ pull_id: 1, trans_id: TRANS, dev_id: WH, begin_time: "2026-09-01 00:00:00", end_time: "2026-09-02 23:59:59" });
      const { headers, body } = splitReply((await send(port, poll())).raw);
      assert.equal(headers.response_code, "OK");
      assert.equal(headers.cmd_code, "GET_LOG_DATA");
      assert.equal(headers.cmd_id, TRANS);
      assert.equal(headers.trans_id, TRANS);
      assert.equal(headers["content-length"], String(body.length));
      // Body framed the way the device frames its own: uint32 LE + JSON + 0A 00.
      assert.equal(body.readUInt32LE(0), body.length - 4);
      assert.deepEqual([...body.subarray(-2)], [0x0a, 0x00]);
      assert.deepEqual(JSON.parse(body.subarray(4, -2).toString("utf8")), { begin_time: "20260901000000", end_time: "20260902235959" });
      // Bookkeeping: claimed once, pull now waiting on the device.
      assert.equal(store.state.commands[0].status, "SENT");
      assert.equal(store.state.commands[0].sent_to_ip, "127.0.0.1");
      assert.equal(store.state.pulls.get(1).status, "WAITING_DEVICE");
      assert.ok(log.lines.some((l) => l.outcome === "command_sent" && l.trans_id === TRANS));
    });

    it("the right device gets its own command; another device polling gets nothing", async () => {
      store.queue({ pull_id: 1, trans_id: TRANS, dev_id: WH, begin_time: "2026-09-01 00:00:00", end_time: "2026-09-02 23:59:59" });
      const g2 = splitReply((await send(port, poll(G2))).raw);
      assert.equal(g2.headers.response_code, "ERROR_NO_CMD");
      assert.equal(store.state.commands[0].status, "PENDING", "G2's poll did not consume WH's command");
      const wh = splitReply((await send(port, poll(WH))).raw);
      assert.equal(wh.headers.cmd_code, "GET_LOG_DATA");
    });

    it("repeated polls do not hand the same command out twice", async () => {
      store.queue({ pull_id: 1, trans_id: TRANS, dev_id: WH, begin_time: "2026-09-01 00:00:00", end_time: "2026-09-02 23:59:59" });
      const first = splitReply((await send(port, poll())).raw);
      const second = splitReply((await send(port, poll())).raw);
      const third = splitReply((await send(port, poll())).raw);
      assert.equal(first.headers.cmd_code, "GET_LOG_DATA");
      assert.equal(second.headers.response_code, "ERROR_NO_CMD");
      assert.equal(third.headers.response_code, "ERROR_NO_CMD");
      assert.equal(log.lines.filter((l) => l.outcome === "command_sent").length, 1);
    });

    it("two queued commands go out one per poll, oldest first", async () => {
      store.queue({ pull_id: 1, trans_id: TRANS, dev_id: WH, begin_time: "2026-09-01 00:00:00", end_time: "2026-09-01 23:59:59" });
      store.queue({ pull_id: 2, trans_id: "HP20260910120001ABCDEF1235", dev_id: WH, begin_time: "2026-09-02 00:00:00", end_time: "2026-09-02 23:59:59" });
      const a = splitReply((await send(port, poll())).raw);
      const b = splitReply((await send(port, poll())).raw);
      const c = splitReply((await send(port, poll())).raw);
      assert.equal(a.headers.trans_id, TRANS);
      assert.equal(b.headers.trans_id, "HP20260910120001ABCDEF1235");
      assert.equal(c.headers.response_code, "ERROR_NO_CMD");
    });

    it("with commands DISABLED (the default), a queued command is never handed out", async () => {
      await start({ commandsEnabled: false });
      store.queue({ pull_id: 1, trans_id: TRANS, dev_id: WH, begin_time: "2026-09-01 00:00:00", end_time: "2026-09-02 23:59:59" });
      const { headers } = splitReply((await send(port, poll())).raw);
      assert.equal(headers.response_code, "ERROR_NO_CMD");
      assert.equal(store.state.commands[0].status, "PENDING");
      assert.equal(store.state.pulls.get(1).status, "REQUESTED");
    });

    it("the default config has commands disabled", () => {
      assert.equal(require("./receiver").readConfig({}).commandsEnabled, false);
      assert.equal(require("./receiver").readConfig({ BIOMAX_COMMANDS_ENABLED: "0" }).commandsEnabled, false);
      assert.equal(require("./receiver").readConfig({ BIOMAX_COMMANDS_ENABLED: "1" }).commandsEnabled, true);
    });

    it("a store failure while claiming -> ERROR_NO_CMD and the command stays PENDING", async () => {
      store.queue({ pull_id: 1, trans_id: TRANS, dev_id: WH, begin_time: "2026-09-01 00:00:00", end_time: "2026-09-02 23:59:59" });
      store.state.failClaim = new Error("ER_LOCK_WAIT_TIMEOUT");
      const { headers } = splitReply((await send(port, poll())).raw);
      assert.equal(headers.response_code, "ERROR_NO_CMD");
      assert.equal(store.state.commands[0].status, "PENDING");
      assert.ok(log.lines.some((l) => l.code === "COMMAND_CLAIM_FAILED"));
    });

    it("an unknown request_code is still a poll and never carries a command", async () => {
      store.queue({ pull_id: 1, trans_id: TRANS, dev_id: WH, begin_time: "2026-09-01 00:00:00", end_time: "2026-09-02 23:59:59" });
      const { headers } = splitReply((await send(port, frame({ request_code: "upload_photo" }))).raw);
      assert.equal(headers.response_code, "ERROR_NO_CMD");
      assert.equal(store.state.commands[0].status, "PENDING");
    });
  });

  describe("send_cmd_result", () => {
    const issue = async () => {
      store.queue({ pull_id: 1, trans_id: TRANS, dev_id: WH, begin_time: "2026-09-01 00:00:00", end_time: "2026-09-02 23:59:59" });
      await send(port, poll());
    };
    // Bytes no JSON parser accepts and no text encoding round-trips: the
    // point is that we keep them without looking.
    const opaque = Buffer.from([0x00, 0xff, 0x10, 0x00, 0x00, 0x00, 0x7b, 0x22, 0x80, 0x81, 0xfe, 0x0d, 0x0a, 0x00, 0xc0]);

    it("matched by dev_id + trans_id: stored raw, ACKed OK, pull -> RECEIVING", async () => {
      await issue();
      const { headers, body } = splitReply((await send(port, result({ trans_id: TRANS, blk_no: 1, body: opaque }))).raw);
      assert.equal(headers.response_code, "OK");
      assert.equal(headers["content-length"], "0");
      assert.equal(body.length, 0);
      const stored = store.state.blocks.get(`${WH}|${TRANS}|1`);
      assert.ok(stored, "block row exists");
      assert.equal(stored.row.match_status, "MATCHED");
      assert.equal(stored.row.biomax_historical_pull_id, 1);
      assert.equal(stored.row.cmd_return_code, "OK");
      assert.equal(stored.row.blk_no, 1);
      assert.equal(stored.row.blk_len, opaque.length);
      assert.equal(stored.row.content_length, opaque.length);
      assert.equal(store.state.pulls.get(1).status, "RECEIVING");
      assert.equal(store.state.pulls.get(1).first_result_at, "now");
    });

    it("the raw body is preserved byte for byte, and every header is kept", async () => {
      await issue();
      await send(port, result({ trans_id: TRANS, blk_no: 1, body: opaque }));
      const stored = store.state.blocks.get(`${WH}|${TRANS}|1`);
      assert.equal(Buffer.compare(stored.row.raw_body, opaque), 0, "identical bytes");
      assert.equal(stored.row.body_sha256, crypto.createHash("sha256").update(opaque).digest("hex"));
      const headers = JSON.parse(stored.row.headers_json);
      assert.ok(Array.isArray(headers));
      assert.ok(headers.some(([k, v]) => k === "trans_id" && v === TRANS));
      assert.ok(headers.some(([k, v]) => k === "cmd_return_code" && v === "OK"));
      assert.ok(headers.some(([k]) => k === "Content-Type"), "even duplicated / uninteresting headers are kept");
      // Nothing decoded: no punch, no derived row, no attempt.
      assert.ok(!store.state.raw.some((r) => r.outcome === "unparsed"));
    });

    it("multi-block: each block its own row, out of order is fine", async () => {
      await issue();
      for (const n of [3, 1, 2]) {
        const { headers } = splitReply((await send(port, result({ trans_id: TRANS, blk_no: n, body: Buffer.from(`block-${n}`) }))).raw);
        assert.equal(headers.response_code, "OK");
      }
      assert.deepEqual([...store.state.blocks.keys()].sort(), [`${WH}|${TRANS}|1`, `${WH}|${TRANS}|2`, `${WH}|${TRANS}|3`]);
      assert.equal(store.state.blocks.get(`${WH}|${TRANS}|3`).row.raw_body.toString(), "block-3", "an earlier-numbered block arriving later did not disturb block 3");
      assert.equal(store.state.pulls.get(1).status, "RECEIVING", "still RECEIVING: block arrival alone never completes a pull");
      assert.equal(store.state.pulls.get(1).completed_at, undefined);
    });

    it("the same block twice is one row with a duplicate count, both ACKed", async () => {
      await issue();
      const a = splitReply((await send(port, result({ trans_id: TRANS, blk_no: 1, body: opaque }))).raw);
      const b = splitReply((await send(port, result({ trans_id: TRANS, blk_no: 1, body: opaque }))).raw);
      assert.equal(a.headers.response_code, "OK");
      assert.equal(b.headers.response_code, "OK");
      assert.equal(store.state.blocks.size, 1);
      assert.equal(store.state.blocks.get(`${WH}|${TRANS}|1`).duplicate_count, 1);
      assert.ok(log.lines.some((l) => l.block_outcome === "duplicate"));
    });

    it("the same blk_no with DIFFERENT bytes is a conflict; the first bytes stay", async () => {
      await issue();
      await send(port, result({ trans_id: TRANS, blk_no: 1, body: Buffer.from("first") }));
      const { headers } = splitReply((await send(port, result({ trans_id: TRANS, blk_no: 1, body: Buffer.from("second") }))).raw);
      assert.equal(headers.response_code, "OK");
      const stored = store.state.blocks.get(`${WH}|${TRANS}|1`);
      assert.equal(stored.row.raw_body.toString(), "first");
      assert.equal(stored.conflict_count, 1);
      assert.ok(log.lines.some((l) => l.block_outcome === "conflict" && l.error === true));
    });

    it("unknown trans_id: kept as UNKNOWN_TRANS_ID with no pull, ACKed, flagged", async () => {
      const { headers } = splitReply((await send(port, result({ trans_id: "HP00000000000000DEADBEEF00", blk_no: 0, body: opaque }))).raw);
      assert.equal(headers.response_code, "OK");
      const stored = store.state.blocks.get(`${WH}|HP00000000000000DEADBEEF00|0`);
      assert.equal(stored.row.match_status, "UNKNOWN_TRANS_ID");
      assert.equal(stored.row.biomax_historical_pull_id, null);
      assert.equal(store.state.pulls.size, 0);
      assert.ok(store.state.raw.some((r) => /UNKNOWN_TRANS_ID/.test(r.reason)));
      assert.ok(log.lines.some((l) => l.outcome === "cmd_result_unknown_trans_id" && l.error === true));
    });

    it("a result from the WRONG device for a known trans_id is never attached to the pull", async () => {
      await issue();
      const { headers } = splitReply((await send(port, result({ dev_id: G2, trans_id: TRANS, blk_no: 0, body: opaque }))).raw);
      assert.equal(headers.response_code, "OK");
      const stored = store.state.blocks.get(`${G2}|${TRANS}|0`);
      assert.equal(stored.row.match_status, "WRONG_DEVICE");
      assert.equal(stored.row.biomax_historical_pull_id, null);
      assert.equal(store.state.pulls.get(1).status, "WAITING_DEVICE", "WH's pull is untouched by G2's frame");
      assert.ok(log.lines.some((l) => l.outcome === "cmd_result_wrong_device"));
    });

    it("a failing cmd_return_code fails the pull with the code verbatim, block still kept", async () => {
      await issue();
      const { headers } = splitReply((await send(port, result({ trans_id: TRANS, blk_no: 0, body: Buffer.alloc(0), cmd_return_code: "ERROR_NO_DATA" }))).raw);
      assert.equal(headers.response_code, "OK");
      const pull = store.state.pulls.get(1);
      assert.equal(pull.status, "FAILED");
      assert.equal(pull.failure_reason, "device returned cmd_return_code ERROR_NO_DATA");
      assert.equal(store.state.commands[0].status, "FAILED");
      assert.equal(store.state.blocks.get(`${WH}|${TRANS}|0`).row.cmd_return_code, "ERROR_NO_DATA");
    });

    it("no trans_id header at all: kept under an empty trans_id as UNKNOWN_TRANS_ID", async () => {
      const f = frame({ request_code: "send_cmd_result", body: opaque, extra: ["cmd_id: X", "blk_no: 0", `blk_len: ${opaque.length}`] });
      const { headers } = splitReply((await send(port, f)).raw);
      assert.equal(headers.response_code, "OK");
      assert.equal(store.state.blocks.get(`${WH}||0`).row.match_status, "UNKNOWN_TRANS_ID");
    });

    it("no dev_id header: preserved as an unparsed raw request and ACKed, never a block", async () => {
      const f = Buffer.from(`POST /hdata.aspx HTTP/1.0\r\nrequest_code: send_cmd_result\r\ntrans_id: ${TRANS}\r\nContent-Length: 3\r\n\r\nabc`, "latin1");
      const { headers } = splitReply((await send(port, f)).raw);
      assert.equal(headers.response_code, "OK");
      assert.equal(store.state.blocks.size, 0);
      assert.equal(store.state.raw[0].outcome, "unparsed");
    });

    it("R1 - if the block cannot be stored there is NO ACK and the socket is closed", async () => {
      await issue();
      store.state.failBlockInsert = new Error("ER_CONNECTION_LOST");
      const { raw, timedOut } = await send(port, result({ trans_id: TRANS, blk_no: 1, body: opaque }));
      assert.equal(timedOut, false);
      assert.equal(raw.length, 0);
      assert.equal(store.state.pulls.get(1).status, "WAITING_DEVICE");
      assert.ok(log.lines.some((l) => l.outcome === "store_error"));
    });

    it("a live punch is completely unaffected by the command channel", async () => {
      // The captured punch path still needs insertPunch; give it one.
      store.insertPunch = async () => ({ outcome: "stored", biomax_punch_id: 1 });
      store.findEmployee = async () => null;
      const fs = require("fs");
      const path = require("path");
      const captured = fs.readFileSync(path.join(__dirname, "..", "test_support", "biomax", "real-punch-request.bin"));
      const { headers } = splitReply((await send(port, captured)).raw);
      assert.equal(headers.response_code, "OK");
      assert.equal("cmd_code" in headers, false);
    });
  });
});
