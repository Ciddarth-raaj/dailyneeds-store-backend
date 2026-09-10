#!/usr/bin/env node
/**
 * Pretends to be a Biomax N-BM70W Pro pushing a punch. Lets you test the
 * listener before you touch the real hardware.
 *
 *   node fake-device.js                    # bare JSON, no wrapper
 *   FRAMING=len32  node fake-device.js     # 4-byte big-endian length prefix
 *   FRAMING=nul    node fake-device.js     # NUL-terminated
 *   FRAMING=rtlog3 node fake-device.js     # SDK-derived RTLOG003 wrapper (see README)
 *   FRAMING=rtlog2 node fake-device.js     # SDK-derived RTLOG002 wrapper
 *   WITHIMAGE=1    node fake-device.js     # append a fake JPEG
 *   SPLIT=1        node fake-device.js     # send in two TCP chunks (reassembly test)
 *   REPEAT=3 RETRY_MS=2000 node fake-device.js   # re-send if no ack (retry simulation)
 *
 * The RTLOG framings are what RealSvrOcxTcp.ocx parses. They are NOT yet
 * confirmed from a real device — that is what the RAW capture is for.
 */

const net = require('net');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = parseInt(process.env.PORT || '7005', 10);
const FRAMING = process.env.FRAMING || 'bare';
const REPEAT = parseInt(process.env.REPEAT || '1', 10);
const RETRY_MS = parseInt(process.env.RETRY_MS || '2000', 10);

function stamp() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const payload = JSON.stringify({
  log_id: String(Date.now()).slice(-8),
  user_id: '1042',
  fk_device_id: '1',
  verify_mode: '1',
  io_mode: '0',
  io_time: stamp(),
  device_port: '5005',
  SerialNo: 'BM70W0012345',
  emergency: 'no',
  is_support_string_id: 'yes',
});

const le32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const json = Buffer.from(payload, 'utf8');
const jpeg = process.env.WITHIMAGE
  ? Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 0x41), Buffer.from([0xff, 0xd9])])
  : null;

let body;
if (FRAMING === 'len32') {
  const hdr = Buffer.alloc(4); hdr.writeUInt32BE(json.length);
  body = Buffer.concat([hdr, json, jpeg || Buffer.alloc(0)]);
} else if (FRAMING === 'nul') {
  body = Buffer.concat([json, Buffer.from([0x00]), jpeg || Buffer.alloc(0)]);
} else if (FRAMING === 'rtlog3' || FRAMING === 'rtlog2') {
  const text = Buffer.concat([json, Buffer.from([0x00])]);       // NUL included in textLen (assumption)
  let inner = Buffer.concat([le32(text.length), text]);
  if (jpeg) inner = Buffer.concat([inner, le32(jpeg.length), jpeg]);
  body = Buffer.concat([Buffer.from(FRAMING === 'rtlog3' ? 'RTLOG003' : 'RTLOG002', 'ascii'), le32(inner.length), inner]);
} else {
  body = Buffer.concat([json, jpeg || Buffer.alloc(0)]);
}

let attempt = 0;
let acked = false;
const sock = net.connect(PORT, HOST, () => {
  console.log(`fake device -> ${HOST}:${PORT} framing=${FRAMING} bytes=${body.length}`);
  send();
});

function send() {
  attempt++;
  console.log(`send attempt ${attempt}/${REPEAT}`);
  if (process.env.SPLIT) {
    const cut = Math.floor(body.length / 2);
    sock.write(body.subarray(0, cut));
    setTimeout(() => sock.write(body.subarray(cut)), 300);
  } else {
    sock.write(body);
  }
  if (attempt < REPEAT) setTimeout(() => { if (!acked) send(); }, RETRY_MS);
  else setTimeout(() => sock.end(), RETRY_MS);
}

sock.on('data', d => {
  acked = true;
  console.log('ACK received:', JSON.stringify(d.toString('utf8')));
  sock.end();
});
sock.on('close', () => console.log('closed'));
sock.on('error', e => console.error('error:', e.message));
