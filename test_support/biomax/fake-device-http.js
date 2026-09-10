#!/usr/bin/env node
/**
 * Fake BM70W: replays the frame captured from device C2695C56D30E1430 against
 * a receiver and ASSERTS THE PROTOCOL REPLY, not the HTTP status line.
 *
 * The device ignores the status line and reads the custom `response_code`
 * header. An HTTP 200 without that header is a retry storm, not a success,
 * so this script exits non-zero unless the header is exactly right:
 *
 *   MODE=punch (default)   requires  response_code: OK
 *   MODE=poll              requires  response_code: ERROR_NO_CMD
 *                          AND the headers cmd_id and cmd_code present (empty)
 *
 * Exit codes: 0 pass; 1 wrong or missing response_code; 2 no reply within
 * the timeout (the device would retry this in ~3 minutes); 3 socket error.
 *
 *   HOST=127.0.0.1 PORT=7005 node fake-device-http.js
 *   USER_ID=1952 node fake-device-http.js            # note: USER_ID, not USER
 *   IO_TIME=20260915023000 node fake-device-http.js   # fixed timestamp
 *   DEV_ID=UNKNOWNTEST01 node fake-device-http.js     # unregistered device
 *   MODE=poll node fake-device-http.js                # receive_cmd
 *   RAW=1 node fake-device-http.js                    # the captured 645 bytes, byte for byte
 *
 * Do NOT "fix" USER_ID to USER: `process.env.USER` is the shell login name on
 * every Unix box and would silently send `ec2-user` as the employee code.
 *
 * The punch frame keeps the device's real quirks: HTTP/1.0, the duplicated
 * Content-Type header, the HOST header naming the receiver, alphabetical
 * JSON keys, and the `uint32 LE length + JSON + 0x0A 0x00` body. The poll
 * frame is SYNTHESISED (no receive_cmd request was captured verbatim; its
 * reply was): same header set, `request_code: receive_cmd`, empty body.
 */

const net = require("net");
const fs = require("fs");
const path = require("path");

const HOST = process.env.HOST || "127.0.0.1";
const PORT = parseInt(process.env.PORT || "7005", 10);
const MODE = (process.env.MODE || "punch").toLowerCase();
const DEV_ID = process.env.DEV_ID || "C2695C56D30E1430";
const USER_ID = process.env.USER_ID || "1952";
const VERIFY = process.env.VERIFY ? Number(process.env.VERIFY) : 1073741824;
const IOMODE = process.env.IOMODE ? Number(process.env.IOMODE) : 16777216;
const TIMEOUT_MS = parseInt(process.env.TIMEOUT_MS || "8000", 10);

function stamp() {
  if (process.env.IO_TIME) return process.env.IO_TIME;
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

function commonHeaders(requestCode, bodyLength) {
  return (
    `POST /hdata.aspx HTTP/1.0\r\n` +
    `Accept: image/gif, image/x-xbitmap, image/jpeg, image/pjpeg, ` +
    `application/vnd.ms-excel, application/msword, ` +
    `application/vnd.ms-powerpoint, */*\r\n` +
    `Accept-Language: en-us\r\n` +
    `Accept-Encoding: gzip, deflate\r\n` +
    `User-Agent: Mozilla/4.0\r\n` +
    `Content-Type: application/octet-stream\r\n` +
    `Connection: close\r\n` +
    `request_code: ${requestCode}\r\n` +
    `Content-Type: application/octet-stream\r\n` +
    `Content-Length: ${bodyLength}\r\n` +
    (requestCode === "realtime_glog" ? `cmd_id: RTLogSendAction\r\n` : "") +
    `dev_id: ${DEV_ID}\r\n` +
    `blk_no: 0\r\n` +
    `blk_len: ${bodyLength}\r\n` +
    `HOST: ${HOST}:${PORT}\r\n\r\n`
  );
}

function punchFrame() {
  if (process.env.RAW === "1") {
    return { frame: fs.readFileSync(path.join(__dirname, "real-punch-request.bin")), json: "(captured bytes)" };
  }
  // Key order matches the device exactly (alphabetical).
  const json =
    `{"fk_bin_data_lib":"FKDataHS102",` +
    `"io_mode":${IOMODE},` +
    `"io_time":"${stamp()}",` +
    `"log_image":null,` +
    `"user_id":${JSON.stringify(USER_ID)},` +
    `"verify_mode":${VERIFY}}`;
  const jsonBuf = Buffer.from(json, "utf8");
  const tail = Buffer.from([0x0a, 0x00]);
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32LE(jsonBuf.length + tail.length);
  const body = Buffer.concat([prefix, jsonBuf, tail]);
  return { frame: Buffer.concat([Buffer.from(commonHeaders("realtime_glog", body.length), "latin1"), body]), json };
}

function pollFrame() {
  return { frame: Buffer.from(commonHeaders("receive_cmd", 0), "latin1"), json: "(no body)" };
}

function parseReply(buf) {
  const text = buf.toString("latin1");
  const end = text.indexOf("\r\n\r\n");
  const lines = (end === -1 ? text : text.slice(0, end)).split("\r\n");
  const statusLine = lines.shift() || "";
  const headers = {};
  for (const line of lines) {
    const i = line.indexOf(":");
    if (i === -1) continue;
    const name = line.slice(0, i).trim().toLowerCase();
    if (headers[name] === undefined) headers[name] = line.slice(i + 1).trim();
  }
  return { statusLine, headers, headerBlock: lines };
}

const expected = MODE === "poll" ? "ERROR_NO_CMD" : "OK";
const { frame, json } = MODE === "poll" ? pollFrame() : punchFrame();

console.log(`fake BM70W (${MODE}) -> ${HOST}:${PORT}  ${frame.length} bytes  dev_id=${DEV_ID}`);
console.log(`  ${json}`);

const sock = net.connect(PORT, HOST, () => sock.write(frame));
let got = Buffer.alloc(0);
let finished = false;

function finish(code, message) {
  if (finished) return;
  finished = true;
  console.log(message);
  sock.destroy();
  process.exit(code);
}

sock.on("data", (d) => {
  got = Buffer.concat([got, d]);
});
sock.on("close", () => {
  if (!got.length) return finish(2, "FAIL: NO REPLY - the device would retry this in ~3 minutes");
  const { statusLine, headers, headerBlock } = parseReply(got);
  console.log("server replied:");
  console.log(`  ${statusLine}`);
  for (const l of headerBlock) console.log(`  ${l}`);

  const code = headers.response_code;
  if (code !== expected) {
    return finish(1, `FAIL: expected response_code: ${expected}, got ${code === undefined ? "NO response_code HEADER" : JSON.stringify(code)} (status line alone proves nothing)`);
  }
  if (MODE === "poll" && (!("cmd_id" in headers) || !("cmd_code" in headers))) {
    return finish(1, "FAIL: ERROR_NO_CMD reply must carry empty cmd_id and cmd_code headers");
  }
  if (MODE === "poll" && (headers.cmd_id !== "" || headers.cmd_code !== "")) {
    return finish(1, "FAIL: cmd_id / cmd_code must be EMPTY");
  }
  finish(0, `PASS: response_code: ${code}`);
});
sock.on("error", (e) => finish(3, `FAIL: socket error ${e.message}`));
setTimeout(() => finish(2, "FAIL: timed out waiting for a reply"), TIMEOUT_MS);
