#!/usr/bin/env node
/**
 * Biomax N-Series (FK / Fingkey) real-time punch listener — DISCOVERY BUILD.
 *
 * The device is the TCP *client*. It dials out to this server and pushes a
 * punch record, then waits for an acknowledgement.
 *
 * Two modes:
 *   RAW   - log every byte, ack nothing. Use this first, to learn the frame.
 *   PARSE - PROVISIONAL. Blocked until the RAW capture has been reviewed,
 *           because the ACK framing has not been confirmed on the wire.
 *
 * Usage:
 *   MODE=raw PORT=7005 node biomax-listener.js
 *
 * Env:
 *   PORT         default 7005   (must match server_port set on the device)
 *   MODE         raw | parse    default raw
 *   DATA_DIR     default ./data
 *   ALLOW_PARSE  must be "1" to run MODE=parse (safety interlock)
 *
 * RAW mode guarantees:
 *   - binds 0.0.0.0:PORT
 *   - every received byte is appended verbatim to data/raw/<conn>.bin
 *   - every chunk is hex-dumped to data/raw-frames.log
 *   - non-destructive frame analysis (RTLOG00x header, JSON, JPEG markers)
 *   - never writes to the socket (socket.write is disabled)
 *   - never touches a database or any HTTP API
 *
 * What the SDK says (RealSvrOcxTcp.ocx, 2019-11-21 N-Series SDK), to be
 * CONFIRMED by the capture, not assumed:
 *   frame  = "RTLOG001" | "RTLOG002" | "RTLOG003"   (8 bytes ASCII)
 *          + uint32 LE  bodyLen
 *          + body[bodyLen]
 *   body (RTLOG001)          = text
 *   body (RTLOG002/RTLOG003) = uint32 LE textLen + text[textLen]
 *                              [+ uint32 LE imgLen + jpeg[imgLen]]
 */

const net = require('net');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT || '7005', 10);
const MODE = (process.env.MODE || 'raw').toLowerCase();
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const HEX_LIMIT_FILE = 1 << 20;   // full dump to file (1 MiB per chunk)
const HEX_LIMIT_CONSOLE = 2048;   // keep the terminal readable

if (MODE !== 'raw' && MODE !== 'parse') {
  console.error(`Unknown MODE "${MODE}". Use raw or parse.`);
  process.exit(1);
}
if (MODE === 'parse' && process.env.ALLOW_PARSE !== '1') {
  console.error(
    'MODE=parse is blocked: the ACK framing has NOT been confirmed on the wire.\n' +
    'Run MODE=raw first, review data/raw-frames.log, then set ALLOW_PARSE=1 only\n' +
    'after the ACK format has been verified against the capture.'
  );
  process.exit(2);
}

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'raw'), { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'images'), { recursive: true });

const RAW_LOG = path.join(DATA_DIR, 'raw-frames.log');
const PUNCH_LOG = path.join(DATA_DIR, 'punches.ndjson');

const ts = () => new Date().toISOString();
const hex = b => [...b].map(x => x.toString(16).padStart(2, '0')).join(' ');

function log(...args) {
  const line = `[${ts()}] ${args.join(' ')}`;
  console.log(line);
  fs.appendFileSync(RAW_LOG, line + '\n');
}

/* ---------- hex dump ---------- */

function hexdump(buf, limit) {
  const slice = buf.subarray(0, limit);
  const lines = [];
  for (let i = 0; i < slice.length; i += 16) {
    const chunk = slice.subarray(i, i + 16);
    const h = hex(chunk).padEnd(47);
    const ascii = [...chunk].map(b => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join('');
    lines.push(`  ${i.toString(16).padStart(6, '0')}  ${h}  |${ascii}|`);
  }
  if (buf.length > limit) lines.push(`  ... ${buf.length - limit} more bytes (full bytes are in data/raw/*.bin)`);
  return lines.join('\n');
}

/* ---------- RTLOG header analysis (SDK-derived, non-destructive) ---------- */

const RTLOG_RE = /RTLOG00[0-9]/;

function analyseRtlog(buf) {
  const s = buf.toString('latin1');
  const m = RTLOG_RE.exec(s);
  if (!m) return null;
  const off = m.index;
  const magic = m[0];
  const out = { magic, offset: off };
  if (buf.length < off + 12) { out.note = 'header incomplete (need 12 bytes)'; return out; }
  out.bodyLen = buf.readUInt32LE(off + 8);
  out.frameLen = 12 + out.bodyLen;
  out.have = buf.length - off;
  out.complete = out.have >= out.frameLen;
  if (magic === 'RTLOG001') {
    out.textStart = off + 12;
    out.textLen = out.bodyLen;
  } else if (buf.length >= off + 16) {
    out.textLen = buf.readUInt32LE(off + 12);
    out.textStart = off + 16;
    const afterText = out.textStart + out.textLen;
    if (out.bodyLen > out.textLen + 4 && buf.length >= afterText + 4) {
      out.imgLen = buf.readUInt32LE(afterText);
      out.imgStart = afterText + 4;
    }
  }
  if (out.textStart !== undefined && out.textLen !== undefined) {
    const t = buf.subarray(out.textStart, Math.min(buf.length, out.textStart + out.textLen));
    out.textEndsWithNul = t.length === out.textLen && t[t.length - 1] === 0x00;
    out.text = t.toString('utf8').replace(/\0+$/, '');
  }
  return out;
}

/* ---------- generic guesses (kept from the prototype) ---------- */

function analyseGeneric(buf, jsonStart, jsonEnd) {
  const notes = [];
  const header = buf.subarray(0, jsonStart);
  const trailer = buf.subarray(jsonEnd);
  const jsonLen = jsonEnd - jsonStart;
  notes.push(`total=${buf.length}B  header=${header.length}B  json=${jsonLen}B  trailer=${trailer.length}B`);
  if (header.length) {
    notes.push(`header hex: ${hex(header.subarray(0, 64))}${header.length > 64 ? ' ...' : ''}`);
    for (let off = 0; off + 2 <= header.length; off++) {
      const cands = [];
      if (off + 4 <= header.length) cands.push(['LE32', header.readUInt32LE(off)], ['BE32', header.readUInt32BE(off)]);
      cands.push(['LE16', header.readUInt16LE(off)], ['BE16', header.readUInt16BE(off)]);
      for (const [kind, val] of cands) {
        if (val === jsonLen) notes.push(`  -> offset ${off} ${kind} = ${val} == JSON length`);
        else if (val === jsonLen + 1) notes.push(`  -> offset ${off} ${kind} = ${val} == JSON length + 1 (NUL?)`);
        else if (val === buf.length) notes.push(`  -> offset ${off} ${kind} = ${val} == total bytes`);
        else if (val === buf.length - jsonStart) notes.push(`  -> offset ${off} ${kind} = ${val} == bytes from JSON start`);
      }
    }
  } else {
    notes.push('header: none — JSON starts at byte 0 (bare or delimiter-framed)');
  }
  if (trailer.length) {
    notes.push(`trailer hex: ${hex(trailer.subarray(0, 32))}${trailer.length > 32 ? ' ...' : ''}`);
    if (trailer[0] === 0x00) notes.push('  -> trailer starts with NUL (NUL-terminated text?)');
    if (trailer.includes(0x0a)) notes.push('  -> trailer contains LF (newline-delimited?)');
  }
  const jpeg = buf.indexOf(Buffer.from([0xff, 0xd8, 0xff]));
  if (jpeg !== -1) {
    const eoi = buf.lastIndexOf(Buffer.from([0xff, 0xd9]));
    notes.push(`  -> JPEG SOI at offset ${jpeg}${eoi > jpeg ? `, EOI at ${eoi} (image ${eoi + 2 - jpeg}B)` : ', EOI not seen yet'}`);
  }
  return notes;
}

/* ---------- JSON extraction ---------- */

function findJson(buf) {
  const start = buf.indexOf(0x7b); // '{'
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < buf.length; i++) {
    const c = buf[i];
    if (esc) { esc = false; continue; }
    if (inStr) {
      if (c === 0x5c) esc = true;
      else if (c === 0x22) inStr = false;
      continue;
    }
    if (c === 0x22) inStr = true;
    else if (c === 0x7b) depth++;
    else if (c === 0x7d) {
      depth--;
      if (depth === 0) {
        const end = i + 1;
        const text = buf.subarray(start, end).toString('utf8');
        try { return { obj: JSON.parse(text), start, end, text }; } catch { return null; }
      }
    }
  }
  return null; // incomplete — wait for more data
}

function analyse(buf) {
  const notes = [];
  const rt = analyseRtlog(buf);
  if (rt) {
    notes.push(`RTLOG header: magic=${rt.magic} at offset ${rt.offset}` +
      (rt.bodyLen !== undefined ? `  bodyLen=${rt.bodyLen}  frameLen=${rt.frameLen}  have=${rt.have}  complete=${rt.complete}` : `  ${rt.note}`));
    if (rt.textLen !== undefined) notes.push(`  text: start=${rt.textStart} len=${rt.textLen} endsWithNul=${rt.textEndsWithNul}`);
    if (rt.imgLen !== undefined) notes.push(`  image: start=${rt.imgStart} len=${rt.imgLen} (SOI ${buf[rt.imgStart] === 0xff && buf[rt.imgStart + 1] === 0xd8 ? 'present' : 'NOT at expected offset'})`);
  } else {
    notes.push('RTLOG header: none found');
  }
  const found = findJson(buf);
  if (found) {
    notes.push(`JSON (${found.end - found.start}B, at ${found.start}): ${found.text.slice(0, 600)}`);
    notes.push(`JSON keys: ${Object.keys(found.obj).join(', ')}`);
    notes.push(...analyseGeneric(buf, found.start, found.end));
  } else {
    notes.push('JSON: no complete {...} object yet');
  }
  return { notes, found, rt };
}

/* ---------- punch handling (PARSE mode only; PROVISIONAL, gated by ALLOW_PARSE) ---------- */

const VERIFY_MODE = { 1: 'fingerprint', 2: 'password', 3: 'card', 20: 'face' };
const IO_MODE = { 0: 'io', 1: 'in', 2: 'out' };

function parseIoTime(s) {
  if (!s || s.length < 14) return s;
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)} ${s.slice(8, 10)}:${s.slice(10, 12)}:${s.slice(12, 14)}`;
}

function normalise(obj) {
  return {
    received_at: ts(),
    log_id: obj.log_id ?? null,
    user_id: obj.user_id ?? null,         // Daily Needs: user_id == dnds.co.in employee_id
    device_id: obj.fk_device_id ?? null,
    serial_no: obj.SerialNo ?? null,
    device_port: obj.device_port ?? null,
    verify_mode: obj.verify_mode ?? null,
    verify_mode_label: VERIFY_MODE[Number(obj.verify_mode)] ?? String(obj.verify_mode ?? ''),
    io_mode: obj.io_mode ?? null,
    io_mode_label: IO_MODE[Number(obj.io_mode) & 0x0f] ?? String(obj.io_mode ?? ''),
    io_time_raw: obj.io_time ?? null,
    io_time: parseIoTime(obj.io_time),
    raw: obj,
  };
}

/* ---------- server ---------- */

let connCount = 0;

const server = net.createServer(socket => {
  connCount++;
  const id = connCount;
  const peer = `${socket.remoteAddress}:${socket.remotePort}`;
  const opened = Date.now();
  const binFile = path.join(DATA_DIR, 'raw', `${ts().replace(/[:.]/g, '-')}-conn${id}-${peer.replace(/[^0-9a-zA-Z.]/g, '_')}.bin`);
  let buf = Buffer.alloc(0);
  let chunks = 0;
  let endedByPeer = false;

  log(`CONNECT #${id} from ${peer}  (raw bytes -> ${path.relative(process.cwd(), binFile)})`);

  if (MODE === 'raw') {
    // Hard guarantee: RAW mode never sends anything back.
    socket.write = () => { throw new Error('RAW mode: socket.write is disabled'); };
  }

  socket.on('data', chunk => {
    chunks++;
    buf = Buffer.concat([buf, chunk]);
    fs.appendFileSync(binFile, chunk);

    const head = `\n===== CHUNK #${chunks} conn#${id} from ${peer} @ ${ts()} =====\nbytes: ${chunk.length} (connection total: ${buf.length})\n`;
    fs.appendFileSync(RAW_LOG, head + hexdump(chunk, HEX_LIMIT_FILE) + '\n');
    if (MODE === 'raw') console.log(head + hexdump(chunk, HEX_LIMIT_CONSOLE));

    const { notes, found, rt } = analyse(buf);
    const block = `ANALYSIS conn#${id} after chunk #${chunks}\n  ${notes.join('\n  ')}`;
    fs.appendFileSync(RAW_LOG, block + '\n');
    console.log(block);

    if (MODE === 'raw') return; // learn only — no ack, no store, keep accumulating

    /* --- parse mode (PROVISIONAL — only reachable with ALLOW_PARSE=1) --- */
    if (!found) return;
    if (rt && !rt.complete) return; // wait for the whole frame (image may follow)
    const punch = normalise(found.obj);
    fs.appendFileSync(PUNCH_LOG, JSON.stringify(punch) + '\n');
    log(`PUNCH user=${punch.user_id} ${punch.io_mode_label} at ${punch.io_time} via ${punch.verify_mode_label} dev=${punch.serial_no}`);
    log('ACK NOT SENT: acknowledgement format is UNKNOWN until confirmed from the RAW capture.');
    buf = Buffer.alloc(0);
  });

  socket.on('end', () => { endedByPeer = true; });
  socket.on('error', err => log(`SOCKET ERROR conn#${id} ${peer}: ${err.message}`));
  socket.on('close', hadErr => {
    const secs = ((Date.now() - opened) / 1000).toFixed(3);
    log(`DISCONNECT #${id} ${peer}  duration=${secs}s chunks=${chunks} bytes=${buf.length} endedByPeer=${endedByPeer} error=${hadErr}`);
    if (buf.length) {
      const { notes } = analyse(buf);
      const block = `CONNECTION SUMMARY conn#${id}\n  ${notes.join('\n  ')}\n  first 64B: ${hex(buf.subarray(0, 64))}\n  last 32B: ${hex(buf.subarray(Math.max(0, buf.length - 32)))}`;
      fs.appendFileSync(RAW_LOG, block + '\n');
      console.log(block);
    }
  });
});

server.on('error', err => {
  log(`SERVER ERROR: ${err.message}`);
  if (err.code === 'EADDRINUSE') log(`Port ${PORT} is already in use.`);
  process.exit(1);
});

server.listen(PORT, '0.0.0.0', () => {
  log(`Biomax listener up on 0.0.0.0:${PORT}  mode=${MODE}`);
  log(`raw frames  -> ${RAW_LOG}`);
  log(`raw bytes   -> ${path.join(DATA_DIR, 'raw')}/*.bin`);
  if (MODE === 'raw') log('RAW mode: capturing only, NOT acknowledging, NOT storing. Punch once, then read the ANALYSIS blocks.');
  else log(`punches     -> ${PUNCH_LOG}  (PROVISIONAL parse mode; no ACK is sent)`);
});

process.on('SIGINT', () => { log('shutting down'); server.close(() => process.exit(0)); });
process.on('SIGTERM', () => { log('shutting down'); server.close(() => process.exit(0)); });
