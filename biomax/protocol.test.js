/**
 * The BM70W wire protocol, proven against the bytes a real device sent.
 *
 *   node --test biomax/protocol.test.js
 *
 * test_support/biomax/real-punch-request.bin is the 645-byte frame captured
 * from C2695C56D30E1430 on 2026-09-10, unmodified. The two DigiSME replies
 * are what the devices are known to accept. Nothing here is hand-written to
 * look like the protocol; that is how a fixture drifts from the hardware.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const protocol = require("./protocol");

const fixtures = path.join(__dirname, "..", "test_support", "biomax");
const frame = fs.readFileSync(path.join(fixtures, "real-punch-request.bin"));
const replyOk = fs.readFileSync(path.join(fixtures, "digisme-reply-ok.bin"));
const replyNoCmd = fs.readFileSync(path.join(fixtures, "digisme-reply-error-no-cmd.bin"));

/** Split the captured request the way an HTTP server would. */
function splitFrame(buf) {
  const idx = buf.indexOf("\r\n\r\n");
  const head = buf.subarray(0, idx).toString("latin1").split("\r\n");
  const requestLine = head.shift();
  const headers = {};
  for (const line of head) {
    const i = line.indexOf(":");
    const name = line.slice(0, i).toLowerCase();
    const value = line.slice(i + 1).trim();
    if (headers[name] === undefined) headers[name] = value;
  }
  return { requestLine, headers, body: buf.subarray(idx + 4) };
}

describe("the captured frame", () => {
  const { requestLine, headers, body } = splitFrame(frame);

  it("is the 645 bytes the device sent", () => {
    assert.equal(frame.length, 645);
    assert.equal(requestLine, "POST /hdata.aspx HTTP/1.0");
  });

  it("classifies as a punch by request_code alone", () => {
    assert.deepEqual(protocol.classifyRequest(headers), {
      kind: "punch",
      code: "realtime_glog",
      unknown: false,
    });
  });

  it("reads the envelope headers", () => {
    assert.deepEqual(protocol.readEnvelope(headers), {
      dev_id: "C2695C56D30E1430",
      cmd_id: "RTLogSendAction",
      blk_no: 0,
      blk_len: 144,
      content_length: 144,
      // The command channel is absent on a live punch.
      trans_id: null,
      cmd_code: null,
      cmd_return_code: null,
    });
  });

  it("parses the body to the exact fields, user_id as a string", () => {
    const parsed = protocol.parsePunchBody(body);
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.warnings, []);
    assert.deepEqual(parsed.punch, {
      user_id: "1952",
      io_time_raw: "20260910135741",
      verify_mode: 1073741824,
      io_mode: 16777216,
      fk_bin_data_lib: "FKDataHS102",
      log_image_present: 0,
      body_len_prefix: 140,
      raw_json:
        '{"fk_bin_data_lib":"FKDataHS102","io_mode":16777216,"io_time":"20260910135741","log_image":null,"user_id":"1952","verify_mode":1073741824}',
    });
    assert.equal(typeof parsed.punch.user_id, "string");
  });

  it("body framing: prefix 140 = JSON + LF + NUL, and 4 + 140 = Content-Length", () => {
    assert.equal(body.length, 144);
    assert.equal(body.readUInt32LE(0), 140);
    assert.equal(body[body.length - 2], 0x0a);
    assert.equal(body[body.length - 1], 0x00);
  });
});

describe("classifyRequest", () => {
  it("is case-insensitive on the header name and trims the value", () => {
    assert.equal(protocol.classifyRequest({ Request_Code: " receive_cmd " }).kind, "poll");
    assert.equal(protocol.classifyRequest({ REQUEST_CODE: "realtime_glog" }).kind, "punch");
  });

  it("answers anything else as a poll, flagged unknown", () => {
    assert.deepEqual(protocol.classifyRequest({}), { kind: "poll", code: "", unknown: true });
    assert.deepEqual(protocol.classifyRequest({ request_code: "something_new" }), {
      kind: "poll",
      code: "something_new",
      unknown: true,
    });
  });
});

describe("parsePunchBody, leniently framed and strictly checked", () => {
  const good = (json) => {
    const j = Buffer.from(JSON.stringify(json));
    const p = Buffer.alloc(4);
    p.writeUInt32LE(j.length + 2);
    return Buffer.concat([p, j, Buffer.from([0x0a, 0x00])]);
  };
  const base = {
    fk_bin_data_lib: "FKDataHS102",
    io_mode: 16777216,
    io_time: "20260910135741",
    log_image: null,
    user_id: "1952",
    verify_mode: 1073741824,
  };

  it("still parses when the length prefix disagrees, with a warning", () => {
    const b = good(base);
    b.writeUInt32LE(999, 0);
    const parsed = protocol.parsePunchBody(b);
    assert.equal(parsed.ok, true);
    assert.match(parsed.warnings[0], /length prefix 999 disagrees/);
  });

  it("coerces a numeric user_id to its string, with a warning", () => {
    const parsed = protocol.parsePunchBody(good({ ...base, user_id: 1952 }));
    assert.equal(parsed.ok, true);
    assert.equal(parsed.punch.user_id, "1952");
    assert.match(parsed.warnings[0], /user_id arrived as a JSON number/);
  });

  it("keeps user_id verbatim: leading zeros, spaces, letters are all preserved", () => {
    for (const id of ["0042", "12 ", "A123", "0"]) {
      assert.equal(protocol.parsePunchBody(good({ ...base, user_id: id })).punch.user_id, id);
    }
  });

  it("rejects a missing, non-string, empty or over-long user_id", () => {
    for (const bad of [undefined, null, true, {}, "", "x".repeat(33)]) {
      const parsed = protocol.parsePunchBody(good({ ...base, user_id: bad }));
      assert.equal(parsed.ok, false, JSON.stringify(bad));
    }
  });

  it("rejects an io_time that is not 14 digits or not a real date", () => {
    for (const bad of [undefined, 20260910135741, "2026-09-10 13:57:41", "2026091013574", "20260230120000", "20261301000000", "20260910245959", "19990101000000"]) {
      const parsed = protocol.parsePunchBody(good({ ...base, io_time: bad }));
      assert.equal(parsed.ok, false, JSON.stringify(bad));
      assert.match(parsed.reason, /io_time/);
    }
    assert.equal(protocol.isRealTimestamp("20280229000000"), true);
    assert.equal(protocol.isRealTimestamp("20270229000000"), false);
  });

  it("rejects an empty body, a body with no JSON, and broken JSON", () => {
    assert.equal(protocol.parsePunchBody(Buffer.alloc(0)).ok, false);
    assert.match(protocol.parsePunchBody(Buffer.from("hello")).reason, /no JSON/);
    assert.match(protocol.parsePunchBody(Buffer.from('{"user_id":')).reason, /no JSON|parse/);
    assert.match(protocol.parsePunchBody(Buffer.from("{not json}")).reason, /parse failed/);
    assert.match(protocol.parsePunchBody(Buffer.from("[1,2]")).reason, /no JSON/);
  });

  it("records a present log_image without storing it", () => {
    const parsed = protocol.parsePunchBody(good({ ...base, log_image: "base64..." }));
    assert.equal(parsed.punch.log_image_present, 1);
    assert.ok(!("log_image" in parsed.punch));
  });
});

describe("buildAckHeaders reproduces the headers DigiSME sends", () => {
  it("OK: response_code OK and no command headers, Content-Length 0, Connection close", () => {
    const h = protocol.buildAckHeaders(protocol.ACK_OK);
    assert.deepEqual(h, [
      ["Cache-Control", "private"],
      ["Content-Length", "0"],
      ["Content-Type", "application/octet-stream"],
      ["response_code", "OK"],
      ["Connection", "close"],
    ]);
    const captured = protocol.parseReplyHeaders(replyOk).headers;
    assert.equal(captured.response_code, "OK");
    assert.equal(captured["content-length"], "0");
    assert.equal("cmd_id" in captured, false);
  });

  it("ERROR_NO_CMD: adds empty cmd_id and cmd_code, in that order", () => {
    const h = protocol.buildAckHeaders(protocol.ACK_NO_CMD);
    assert.deepEqual(h.slice(3, 6), [
      ["response_code", "ERROR_NO_CMD"],
      ["cmd_id", ""],
      ["cmd_code", ""],
    ]);
    const captured = protocol.parseReplyHeaders(replyNoCmd).headers;
    assert.equal(captured.response_code, "ERROR_NO_CMD");
    assert.equal(captured.cmd_id, "");
    assert.equal(captured.cmd_code, "");
  });

  it("the two captured replies differ by exactly the 32 bytes of the command headers", () => {
    assert.equal(replyNoCmd.length - replyOk.length, 32);
  });

  it("refuses an unknown ack kind rather than sending something the device has never seen", () => {
    assert.throws(() => protocol.buildAckHeaders("MAYBE"));
  });
});
