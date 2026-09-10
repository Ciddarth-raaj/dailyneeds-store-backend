# Biomax BM70W fixtures

Byte-exact captures from device `C2695C56D30E1430` (Warehouse terminal
"WH"), outlet public IP `103.213.194.119`, taken on 2026-09-10 while the
device was temporarily routed through a capture proxy on `dnds-be`
(AWS Lightsail, `3.109.76.230`). All seven terminals have since been
restored to DigiSME (`4.247.27.112:82`); nothing here changes that.

| file | bytes | what it is |
|---|---|---|
| `real-punch-request.bin` | 645 | a real punch, exactly as the device sent it |
| `digisme-reply-ok.bin` | 592 | DigiSME's reply to a punch (`response_code: OK`) |
| `digisme-reply-error-no-cmd.bin` | 624 | DigiSME's reply to a `receive_cmd` poll |
| `fake-device-http.js` | - | replays a punch or a poll and **asserts the `response_code` header** |

The two reply sizes differ by exactly 32 bytes: the `cmd_id: ` and
`cmd_code: ` headers plus the difference between `ERROR_NO_CMD` and `OK`.
That is what confirms the OK reply carries no command headers.

## Use these; do not hand-write frames

`real-punch-request.bin` carries the device's real quirks: HTTP/1.0, a
duplicated `Content-Type` header, a `HOST` header naming the receiver, and
the `uint32 LE length + JSON + 0x0A 0x00` body. `biomax/protocol.test.js`
and `biomax/receiver.test.js` read it directly.

## Replaying against a running receiver

The receiver is started only by the approved activation step
(`pm2 start ecosystem.biomax.config.js`); a normal backend deploy never
starts it. For a local run: `BIOMAX_PORT=7005 node biomax/receiver.js`.

```
HOST=127.0.0.1 PORT=7005 node test_support/biomax/fake-device-http.js            # punch, fresh io_time
HOST=127.0.0.1 PORT=7005 RAW=1 node test_support/biomax/fake-device-http.js      # the captured bytes exactly
HOST=127.0.0.1 PORT=7005 MODE=poll node test_support/biomax/fake-device-http.js  # receive_cmd
```

Exit code `0` means the protocol header was right. `1` means the header was
wrong or missing **even if the status line said 200**. `2` means no reply,
which is what a real device experiences as "retry in 3 minutes".

`nc 127.0.0.1 7005 < real-punch-request.bin` also works, but proves nothing
unless you read the reply headers yourself.

Variables: `DEV_ID`, `USER_ID` (**not** `USER`, which is your login name),
`IO_TIME` (14 digits), `VERIFY`, `IOMODE`, `TIMEOUT_MS`.

### Historical pull scaffolding (fake device only)

```
MODE=poll EXPECT_CMD=1 node test_support/biomax/fake-device-http.js        # expects a GET_LOG_DATA back
MODE=cmd_result TRANS_ID=HP... BLK_NO=1 node test_support/biomax/fake-device-http.js   # a raw result block
MODE=cmd_result TRANS_ID=HP... RETURN_CODE=ERROR_NO_DATA node test_support/biomax/fake-device-http.js
```

`EXPECT_CMD=1` only passes against a receiver started with
`BIOMAX_COMMANDS_ENABLED=1` **and** a pull queued for that `DEV_ID`; with the
flag off (the default, and the only state the production receiver has ever
had) the poll is answered `ERROR_NO_CMD` exactly as before. The `cmd_result`
body is deliberately opaque bytes: the FKDataHS102 historical record layout
has not been captured and the receiver decodes nothing. No `send_cmd_result`
and no command reply has been captured from real hardware either; see
`docs/biomax-historical-pull.md`, section 9. Never point this script at a
real terminal's server address; it only ever talks to the receiver.

## No `receive_cmd` request was captured

Its reply was. The synthesised poll frame in the script uses the same
header set with `request_code: receive_cmd` and an empty body. The receiver
keys on `request_code` alone and does not depend on anything else in a poll.

## Runtime

The receiver (`biomax/receiver.js`) targets **Node 14.21.3**, the interpreter
the API already runs on under `ec2-user` on the production host. Do not use
APIs newer than Node 14 in `biomax/` (no `fetch`, no `node:` import prefix,
no `??=`, no `replaceAll`, no `Array.prototype.at`). The test suite itself
uses `node:test` and runs on a developer machine with Node 18+. Node 14 is
end-of-life (April 2023); upgrading the host runtime is recorded as
technical debt outside Part 1.

## The capture proxy

`biomax-proxy-minimal.js` from the original handoff is deliberately **not**
in this repository. It was a capture tool; Part 1 builds no proxy and the
migration method is decided separately.
