# Biomax N-Series punch listener (discovery build)

Phase 2 of the HR system: receiving live attendance punches from the
Biomax N-BM70W Pro devices.

No dependencies. Node 18 or newer. Nothing to install.

**Status: RAW capture only.** Nothing here writes to the Daily Needs
database, calls a dnds.co.in API, or starts attendance processing. The
wire protocol below is derived from the vendor SDK and still has to be
confirmed against one real device before anything else is built.

## What the SDK says

Source: `20191121_CS_SDK_biomax_new` (CS_SDK_Manual.docx, the
`FKRealTimeLog` C# sample, and `RealSvrOcxTcp.ocx`).

- The device is the TCP **client**. It pushes to `server_ip:server_port`
  set on the device (`cs_serverinfo_set` / `SetServerNetInfo`). The SDK
  demo listens on **7005**. The device's own command port is **5005**.
- Transport is plain TCP (the OCX imports `listen`/`WSAAccept`/`WSARecv`/
  `WSASend`; no UDP).
- The OCX (not the C# sample) owns the byte wrapper. From its parser:

      "RTLOG001" | "RTLOG002" | "RTLOG003"   8 bytes ASCII magic
      uint32 LE  bodyLen
      body[bodyLen]

      body (RTLOG001)          = text
      body (RTLOG002/RTLOG003) = uint32 LE textLen + text[textLen]
                                 [+ uint32 LE imgLen + jpeg[imgLen]]

  The parser scans for the magic anywhere in the receive buffer, then
  waits until `12 + bodyLen` bytes are present. Limits in the OCX:
  textLen <= 0x8000, imgLen <= 0xA00000.
- The text is JSON. Keys read by the sample:
  `log_id, user_id, fk_device_id, verify_mode, io_mode, io_time (YYYYMMDDHHMMSS),
  device_port, SerialNo, emergency, is_support_string_id`.
- The sample replies with `{"log_id": "<same>", "result": "OK", "mode": "nothing"}`
  via `SendRtLogResponseV3`. The OCX wraps that reply as

      "RTLOG003" | uint32 LE (len+1+4) | uint32 LE (len+1) | json | 0x00

  (`SendResponse` uses `RTLOG002`, `SendRtLogResponseV1` uses `RTLOG001`
  with no inner length.) **This has not been observed on the wire.**
  Until it is, the ACK format is UNKNOWN and this listener sends nothing.
- Retry/ack timing lives on the device (`REALTIMEINFO.AckTime/WaitTime`);
  the SDK does not document the values. Measure it.

## Daily Needs rule

`user_id` from the device **is** the dnds.co.in `employee_id`. There is no
separate mapping table and none should be built.

## Step 1 — RAW capture (do this once, with ONE device)

    MODE=raw PORT=7005 node biomax-listener.js

Then point one BM70W at this machine and punch once. See
`docs/biomax-raw-protocol-findings.md` for the full procedure, including
recording and restoring the DigiSME server settings.

RAW mode:

- binds `0.0.0.0:7005`
- appends every byte, verbatim, to `data/raw/<time>-conn<n>-<peer>.bin`
- hex-dumps every TCP chunk to `data/raw-frames.log`
- prints an ANALYSIS block after each chunk (RTLOG header fields, JSON,
  JPEG markers, generic length-prefix guesses) and a CONNECTION SUMMARY
  on disconnect (duration, chunk count, whether the device closed)
- has `socket.write` disabled, so it cannot acknowledge by accident
- writes nothing else anywhere

Because nothing is acknowledged the device should retry. Leave the
listener running long enough to see the retry interval and count.

## Step 2 — PARSE mode (blocked)

`MODE=parse` exits unless `ALLOW_PARSE=1` is set, and even then it sends
no ACK. Do not enable it until the RAW capture has been reviewed and the
ACK format confirmed.

## Testing without hardware

    node fake-device.js                          # bare JSON
    FRAMING=rtlog3 node fake-device.js           # SDK-derived wrapper
    FRAMING=rtlog3 WITHIMAGE=1 SPLIT=1 node fake-device.js
    REPEAT=3 RETRY_MS=2000 node fake-device.js   # retry simulation

## Settings

| Env | Default | Meaning |
|---|---|---|
| `PORT` | 7005 | port the devices push to |
| `MODE` | raw | `raw` or `parse` (parse is interlocked) |
| `DATA_DIR` | ./data | where captures are written |
| `ALLOW_PARSE` | unset | must be `1` to run parse mode |

`set-server.js` sends `cs_serverinfo_set` to a device's command port
(5005). Only use it after the current DigiSME settings have been recorded
(see the findings doc). Setting the server from the device menu is the
safer option for the one-device test.
