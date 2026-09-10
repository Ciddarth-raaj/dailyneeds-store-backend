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

## No `receive_cmd` request was captured

Its reply was. The synthesised poll frame in the script uses the same
header set with `request_code: receive_cmd` and an empty body. The receiver
keys on `request_code` alone and does not depend on anything else in a poll.

## The capture proxy

`biomax-proxy-minimal.js` from the original handoff is deliberately **not**
in this repository. It was a capture tool; Part 1 builds no proxy and the
migration method is decided separately.
