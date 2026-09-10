# Biomax BM70W raw protocol test — SDK findings and capture procedure

Status: **SDK analysis complete. Physical one-device capture NOT yet performed.**
Nothing in this document authorises production integration. The listener
in `tools/biomax-listener/` is discovery tooling only.

Daily Needs rule: Biomax `user_id` = dnds.co.in `employee_id`. No mapping
table.

---

## 1. SDK findings (`N Series SDK.rar` → `20191121_CS_SDK_biomax_new`)

Sources examined:

- `CS_SDK_Manual.docx` (sections on RealSvrOcxTcp.ocx, REALTIMEINFO,
  GetServerInfo/SetServerNetInfo, JsonCommand)
- `Samples/FKRealTimeLog/c#/Form1.cs` (the real-time push sample)
- `Samples/FK623Attend/c#/frmNetInfo.cs`, `FKAttendDLL.cs` (server settings)
- `Execute&Dll/RealSvrOcxTcp.ocx` (imports, strings, and the frame
  parser/builder code, disassembled)
- `Execute&Dll/Log.txt` (only a rendered grid from the demo, not a wire capture)

### Push mechanism

The device pushes attendance logs directly to a remote server. The server
address is a device setting (`server_ip`, `server_port`), written either
from the device menu or with the JSON command
`{"cmd":"cs_serverinfo_set","param":{"server_ip":"…","server_port":"…"}}`
over the device command port (5005). The SDK's own receiver
(`FKRealSvrOcxTcpCSSample.exe`) defaults to port **7005**.

The device-side upload timing is the `REALTIMEINFO` structure
(`Valid`, `AckTime`, `WaitTime`, `SendPos`, time zones), readable via
`GetRealTimeInfo`. Its values are device configuration and are not
documented; the retry interval has to be measured.

### Transport

Raw TCP. `RealSvrOcxTcp.ocx` imports `socket, bind, listen, WSAAccept,
WSARecv, WSASend, shutdown, closesocket, WSAEventSelect` from WS2_32 and
nothing UDP-related. The device is the client; the PC/server listens.

### Framing (from the OCX parser, functions at 0x10002f10 / 0x10002ff0 / 0x100030d0)

    frame = magic[8] + uint32LE bodyLen + body[bodyLen]
    magic ∈ { "RTLOG001", "RTLOG002", "RTLOG003" }

    RTLOG001 body = text[bodyLen]
    RTLOG002 body = uint32LE textLen + text[textLen] [+ uint32LE imgLen + jpeg[imgLen]]
    RTLOG003 body = same layout as RTLOG002

- The parser scans the receive buffer for the magic (it need not be at
  offset 0) and waits until `12 + bodyLen` bytes have arrived.
- Sanity limits: `textLen ≤ 0x8000`, `imgLen ≤ 0xA00000`.
- Multiple frames on one connection are possible: after handling a frame
  the OCX erases exactly `frameLen` bytes from the buffer and re-scans.
- RTLOG002 raises `OnReceiveGLogTextAndImage`; RTLOG003 raises
  `OnReceiveGLogTextOnDoorOpen`; RTLOG001 raises `OnReceiveGLogText`.
- A separate older binary protocol (magic bytes `33 99`, 16-byte header)
  feeds `OnReceiveGLogData/Extend`. Not JSON. Only relevant if the BM70W
  turns out to use it.

### Payload (JSON keys read by the SDK sample)

| key | meaning | notes |
|---|---|---|
| `log_id` | device log id | echoed back in the ACK |
| `user_id` | enrol number | = dnds.co.in employee_id; `0` = unenrolled person |
| `fk_device_id` | device id | |
| `verify_mode` | 1 FP, 2 password, 3 card, 20 face, … | full enum in sample |
| `io_mode` | low nibble: 0 io, 1 in1, 2 out1, 3 in2, 4 out2 …; upper bytes: door mode | see `GetIoModeAndDoorMode` |
| `io_time` | `YYYYMMDDHHMMSS` | |
| `device_port` | device command port | |
| `SerialNo` | device serial | identifies the outlet |
| `emergency` | `yes`/`no` | door-control models |
| `is_support_string_id` | `yes`/`no` | |

Images: RTLOG002/003 can carry a JPEG after the text (the OCX hex-encodes
it into `astrLogImage`). Whether the BM70W sends one is unknown.

### ACK (from the OCX builders at 0x100014e0 / 0x10001560 / 0x100015f0)

The sample replies `{"log_id":"<same>","result":"OK","mode":"nothing"}` via
`SendRtLogResponseV3`. The OCX wraps that as:

    SendRtLogResponseV3: "RTLOG003" + uint32LE(len+1+4) + uint32LE(len+1) + json + 0x00
    SendResponse:        "RTLOG002" + uint32LE(len+1+4) + uint32LE(len+1) + json + 0x00
    SendRtLogResponseV1: "RTLOG001" + uint32LE(len+1) + json + 0x00

where `len` = byte length of the JSON text. The ACK is written back on the
same accepted socket (looked up by client IP:port), so the device is
expected to keep the connection open until it gets the ACK.

**Not observed on a device. Until the RAW capture confirms which magic the
BM70W sends, ACK FORMAT: UNKNOWN.**

### Contradictions with the prototype (`biomax-listener.js` from Claude Chat)

1. The prototype's PARSE mode wrote a **bare** JSON ACK with no wrapper.
   The SDK shows the ACK is wrapped in an `RTLOG00x` header with length
   fields and a trailing NUL. A bare ACK would most likely be ignored,
   leaving the punch queued on the device. PARSE mode is now interlocked.
2. The prototype's `VERIFY_MODE` map (`1 fp, 2 card, 3 password, 4 face`)
   disagreed with the SDK (`1 fp, 2 password, 3 card, 20 face`). Corrected.
3. The prototype's `IO_MODE` map (`0 in, 1 out`) disagreed with the SDK
   (`0 io, 1 in1, 2 out1, …`, low nibble only). Corrected.
4. The prototype README said `user_id` maps to the employee via a DB
   table. For Daily Needs `user_id` **is** the employee_id. Corrected.
5. The prototype's frame analysis had no knowledge of the RTLOG header and
   would have reported "header 16B, no length match" (its inner length
   includes the NUL). The analyser now decodes the RTLOG header directly.
6. The prototype dropped the buffer as soon as it saw a complete JSON
   object, so an image arriving in later TCP chunks would have been logged
   as unexplained bytes. The listener now keeps the whole connection's
   bytes and also writes them verbatim to `data/raw/*.bin`.

7. `set-server.js` sends bare JSON to the device command port 5005. In the
   SDK that command goes through `FK_ConnectNet` (machine number, port,
   timeout, protocol, device password) and then `FK_HS_ExecJsonCmd`, i.e.
   inside the DLL's own command protocol, which is not documented at byte
   level. The helper is unverified; set the server from the device menu.

Not contradicted: device = TCP client, listener on 7005, RAW mode logging
and no ACK.

---

## 2. One-device RAW capture procedure (to be done on site)

Prerequisites

- A test machine on the outlet LAN (or reachable from it) with Node ≥ 18.
- Its LAN IP noted (`hostname -I` / `ipconfig`). Firewall open on TCP 7005.
- Exactly one BM70W. Leave every other device on DigiSME.

Step A — record the current DigiSME settings **before touching anything**

From the device menu (Comm → Server / Cloud settings) or via
`GetServerInfo` in the SDK test tool, write down:

    Server IP        : ____________
    Server Port      : ____________
    Realtime/Push    : ____________ (enabled/disabled, and any interval)
    Device serial    : ____________
    Device IP        : ____________
    Time on device   : ____________

Photograph the settings screen. Do not proceed without this.

Step B — start the listener

    cd tools/biomax-listener
    MODE=raw PORT=7005 node biomax-listener.js 2>&1 | tee console-$(date +%Y%m%d-%H%M%S).log

Confirm the first lines show `up on 0.0.0.0:7005 mode=raw`.

Step C — point the device at the listener

    Server IP    = <test machine IP>
    Server Port  = 7005
    Realtime/Push = enabled

Step D — make exactly ONE punch. Note the wall-clock time and the
employee_id used.

Step E — wait. The listener sends no ACK, so the device should retry.
Wait at least 5 minutes (longer if nothing retries) and note every
`CONNECT` / `DISCONNECT` line and its timestamp.

Step F — restore DigiSME settings immediately (Server IP, Port, Realtime),
verify the device reconnects to DigiSME, and confirm the test punch reaches
DigiSME (the device should still have it queued because it was never
acknowledged).

Step G — collect `console-*.log`, `data/raw-frames.log`, `data/raw/*.bin`.
Do not edit them. Employee/device IDs are fine to share; no names.

---

## 3. Result template (fill in after the capture)

### RAW Test

    Listener host:
    Listener port: 7005
    Device model: BM70W
    Original DigiSME settings preserved: (IP/port/realtime recorded? photo?)
    Punch captured:
    Retry observed: (count, interval)
    Device restored to DigiSME:

### Transport

    Connection pattern: (persistent / one connection per punch / one per retry)
    Retry behaviour:
    Frames per connection:

### Framing

    Total frame bytes:
    Header: (magic seen: RTLOG001 / 002 / 003 / none)
    Length encoding: (uint32 LE bodyLen at +8; textLen at +12; NUL included?)
    JSON/text start:
    Trailer:
    Image attached: (imgLen, JPEG SOI/EOI offsets)

### Payload

    Exact field names:
    user_id:
    io_time format:
    io_mode:
    verify_mode:
    log_id:
    device serial field:

### ACK

    Confirmed format: (only if a DigiSME/SDK capture or device behaviour confirms it)
    Source of confirmation:
    If unknown: UNKNOWN
