# Biomax historical pull - backend scaffolding

**Status: preparation only. Nothing here has been exercised against a real
BM70W. No GET_LOG_DATA has been, or can yet be, handed to a physical
terminal: the receiver's command hand-out is behind `BIOMAX_COMMANDS_ENABLED`,
which defaults to off, and the receiver itself is not running in production.**

This document is the design record for the pieces that let dnds.co.in later
ask a terminal for backdated punches and keep, byte for byte, whatever the
terminal answers. It sits beside `biomax-attendance-part1.md`; all Part 1
rules (R1-R18) still hold.

## 1. What exists

| piece | file | role |
|---|---|---|
| migration | `migrations/mysql/migrations/20260912120000-biomax-historical-pull.*` | three tables, two columns on `biomax_punch`, one permission key |
| command rules | `biomax/commands.js` | only GET_LOG_DATA; forbidden list; trans_id; result matching; return-code policy |
| wire | `biomax/protocol.js` | `send_cmd_result` classification, command headers in the envelope, the (assumed) command reply, header listing |
| receiver store | `biomax/store.js` | claim a command once; keep a result block raw; pull status; punch `ingest_source` |
| receiver | `biomax/receiver.js` | poll may carry a claimed command (flag-gated, leased); `send_cmd_result` kept whole then ACKed, refused if it cannot be kept whole |
| API | `repository/`, `usecase/`, `routes/biomax_historical_pull.js`, `server.js` | create / list / view pull requests, admin only |
| fake device | `test_support/biomax/fake-device-http.js` | `MODE=poll EXPECT_CMD=1`, `MODE=cmd_result` |
| tests | `biomax/commands.test.js`, `biomax/historical.test.js`, additions to `biomax/store.test.js` and `biomax/protocol.test.js`, `migrations/biomax_historical_pull.test.js`, `usecase/biomax_historical_pull.test.js`, `routes/biomax_historical_pull.test.js` | |

## 2. Schema (additive only)

`biomax_historical_pull` - one row per request. `biomax_device_id` (FK) and
`dev_id` (the Cloud ID string, copied at request time - results are matched
on the string the device sends). `requested_from` / `requested_to` IST wall
clock. `status` ENUM of exactly the five states below. `trans_id` UNIQUE.
Timestamps `requested_at`, `sent_at`, `first_result_at`, `completed_at`,
`failed_at`; `failure_reason`; counters `punches_returned`, `new_punches`,
`duplicate_punches` (all stay 0 until a decoder exists); `created_at`,
`updated_at`.

`biomax_device_command` - the queue. `trans_id` UNIQUE, `dev_id` (the only
device it may be handed to), `cmd_code ENUM('GET_LOG_DATA')` - a one-value
enum, so a forbidden command cannot even be stored - `begin_time` /
`end_time` as 14-digit device time, `status
ENUM('PENDING','SENT','ANSWERED','FAILED')` (FAILED reserved),
`attempt_count`, `created_at`, `first_sent_at`, `sent_at` (the lease runs
from here), `answered_at`, `sent_to_ip`. FK to the pull.

`biomax_command_result_block` - every `send_cmd_result`, raw. UNIQUE
`(dev_id, trans_id, blk_no)`. Keeps `cmd_id`, `cmd_code`, `cmd_return_code`,
`blk_no`, `blk_len`, `content_length`, `headers_json` (every header, in
order), `body_len`, `body_sha256`, `raw_body MEDIUMBLOB`, `match_status
ENUM('MATCHED','UNKNOWN_TRANS_ID','WRONG_DEVICE')`, `source_ip`,
`received_at`, `duplicate_count`, `conflict_count`, `last_received_at`.
`biomax_historical_pull_id` is NULL when the block could not be matched.

`biomax_punch` gains `ingest_source ENUM('LIVE','HISTORICAL_PULL') NOT NULL
DEFAULT 'LIVE'` and `biomax_historical_pull_id BIGINT UNSIGNED NULL`, both
added through an `information_schema` guard + `PREPARE` (MySQL has no `ADD
COLUMN IF NOT EXISTS`). Every existing row becomes `LIVE`, which is what it
was. The dedup key `(dev_id, user_id, io_time_raw)` is untouched.

Permission `manage_biomax_historical_pull` is declared and granted to no
designation. Down drops the three tables, the two columns and the key, and
nothing from Part 1.

## 3. Pull state flow

```
REQUESTED ──(device polls, command claimed)──► WAITING_DEVICE ──(first MATCHED block)──► RECEIVING ──► COMPLETED
                                                                                                          FAILED (reserved)
```

- `REQUESTED`: the API wrote the pull and its PENDING command in one transaction.
- `WAITING_DEVICE`: the receiver handed the command over (`sent_at`). Under
  the delivery lease (section 5) it may be handed over again with the same
  trans_id; the pull stays WAITING_DEVICE.
- `RECEIVING`: the first MATCHED block was stored (`first_result_at`),
  whatever its `cmd_return_code` says.
- `COMPLETED`: **set by nothing yet.** Block arrival alone never completes a
  pull, because the protocol's end-of-data signal has not been observed.
- `FAILED`: **reserved, set by nothing yet.** The device's `cmd_return_code`
  vocabulary has not been captured, so no value is read as a failure (or as
  a success). `store.markPullFailed` exists for an operator action or for
  the semantics a real capture will justify.

## 4. Command queue

`biomax/commands.js` is the only place a command is shaped.
`buildGetLogDataCommand` validates the device id, the trans_id, both times
and their order, and calls `assertAllowedCommand`, which refuses
`CLEAR_LOG_DATA`, `CLEAR_ENROLL_DATA`, `DELETE_USER`, `RESET_FK`,
`SET_WEB_SERVER_INFO` by name with a message saying why, and anything else
as unsupported. `newTransId()` mints `HP` + 14-digit UTC stamp + 10 hex chars
from a CSPRNG (26 characters, header-safe). One command per pull; one pull
per command; one `dev_id` per command.

Ownership from request to result: `trans_id` is UNIQUE on both the pull and
the command; `matchResult` accepts a `send_cmd_result` as MATCHED only when
its `trans_id` is a known command **and** its `dev_id` equals the device the
command was issued to. Anything else is kept (`UNKNOWN_TRANS_ID` /
`WRONG_DEVICE`) with `biomax_historical_pull_id = NULL`, so a result from
device B can never move device A's pull.

## 5. `receive_cmd`

Unchanged by default: `response_code: ERROR_NO_CMD` with the two empty
`cmd_id:` / `cmd_code:` headers, as captured from DigiSME.

With `BIOMAX_COMMANDS_ENABLED=1` in the receiver process, a genuine
`receive_cmd` from an identified `dev_id` calls
`store.claimPendingCommand(dev_id, ip, { leaseSeconds, maxAttempts })`. That
is one transaction: `SELECT ... FOR UPDATE` the oldest *deliverable* command
**for that dev_id**, then `UPDATE ... SET status='SENT', sent_at=NOW(3),
attempt_count=attempt_count+1 WHERE ... AND status IN ('PENDING','SENT') AND
attempt_count = <the value just read>`. Only the poll whose UPDATE hit a row
gets the command (the pull moves to WAITING_DEVICE in the same transaction).

Deliverable means `PENDING`, or `SENT` with `sent_at` older than
`BIOMAX_COMMAND_LEASE_SECONDS` (default 600) and `attempt_count` below
`BIOMAX_COMMAND_MAX_ATTEMPTS` (default 3). So:

- racing polls cannot both receive a command (row lock + guarded UPDATE);
- a hand-out whose HTTP reply never reached the device is not lost: once the
  lease expires and no result has arrived, the next poll gets it again with
  the **same trans_id** (GET_LOG_DATA is read-only; its result blocks
  deduplicate on `(dev_id, trans_id, blk_no)`);
- there is no rapid resend loop: at most one hand-out per lease period, at
  most `maxAttempts` in total; after that the command stays `SENT` with its
  `attempt_count` visible in the pull's details for an operator, and is not
  offered again;
- the first MATCHED result block marks the command `ANSWERED`
  (`answered_at`), which ends the lease for good.

A store error during the claim logs and answers ERROR_NO_CMD; the command
is untouched. An unknown `request_code` is still answered as a plain poll
and never carries a command.

The reply that carries a command (`protocol.buildCommandReply`) is an
**assumption**, see section 9.

## 6. `send_cmd_result`

Classified by `request_code: send_cmd_result` **before** the body is read,
because its body limit is its own: `BIOMAX_COMMAND_RESULT_MAX_BODY`, default
4 MB, hard-capped just under the 16 MB a `MEDIUMBLOB` holds, separate from
the 64 KB punch limit (`BIOMAX_MAX_BODY`). Order of operations, per R1:

1. `Content-Length` above the result limit -> refused before a byte is
   buffered: no reply, socket closed, the device retries later (and the
   limit can be raised deliberately). Logged `oversized_refused`.
2. body read; if it overran the limit anyway (no or false Content-Length)
   -> refused the same way. Never stored truncated, never ACKed.
3. body shorter than its `Content-Length` (link dropped mid-block) ->
   refused (`incomplete_refused`). A partial block is never a block.
4. no `dev_id` header -> preserved as an `unparsed` raw request, ACKed.
5. look up the command by `trans_id`; compute `match_status`.
6. `store.insertResultBlock(...)` with `dev_id`, `trans_id`, `cmd_id`,
   `cmd_code`, `cmd_return_code` **verbatim**, `blk_no`, `blk_len`,
   `content_length`, every header as JSON, the complete body bytes, their
   sha256, `match_status`, `source_ip`. **If this fails there is no ACK and
   the socket is closed**, exactly as for a punch.
7. `response_code: OK`.
8. bookkeeping: MATCHED -> command `ANSWERED`, pull `RECEIVING`. Nothing is
   inferred from `cmd_return_code`: not success, not failure. UNKNOWN /
   WRONG device -> also a `biomax_raw_request` row with the whole frame.

Punches keep their Part 1 behaviour (a truncated punch frame is preserved
as `oversized` and ACKed, so a malformed frame cannot block a device).

Nothing decodes the body. There is no historical punch decoder, no
`punches_returned` increment, and no row is written to `biomax_punch` from a
block.

## 7. Multi-block handling

Each block is its own row under `(dev_id, trans_id, blk_no)`. Out-of-order
arrival is just rows with different `blk_no`. The INSERT is `ON DUPLICATE
KEY UPDATE duplicate_count = duplicate_count + IF(body_sha256 =
VALUES(body_sha256), 1, 0), conflict_count = conflict_count + IF(...,0,1),
last_received_at = NOW(3)`: the same bytes again is one row with a counter,
different bytes for the same `blk_no` is a counted conflict and the first
bytes stay. No block count, no "last block" flag and no `blk_no` value is
taken as completion.

## 8. Ingestion source

`store.insertPunch(punch, derived, { source, historicalPullId })`. The live
path is unchanged apart from binding `'LIVE', NULL` for the two new
columns. A `HISTORICAL_PULL` insert first SELECTs the dedup key; if the punch
already exists (from live ingestion or an earlier pull) it returns
`duplicate` with the existing id and writes **nothing** - not even the
retransmission counter, which means "the device re-sent a live punch".
Otherwise it inserts with `ingest_source='HISTORICAL_PULL'` and the pull id
and writes the derived row as usual. This path is tested but has no caller
yet; the decoder that would call it does not exist.

## 9. Unknowns - what has NOT been proven on hardware

1. **The command reply shape.** No capture exists of any server issuing a
   command to a BM70W. `buildCommandReply` sends `response_code: OK`,
   `cmd_id: <trans_id>`, `cmd_code: GET_LOG_DATA`, `trans_id: <trans_id>` and
   a body framed like the device's own (`uint32 LE length + JSON + 0x0A
   0x00`) holding `{"begin_time","end_time"}` in 14-digit device time. Any
   of the header names, the body framing, the time format, or whether the
   window belongs in headers rather than the body may be wrong. Until a
   capture proves it, the flag stays off.
2. **The `send_cmd_result` header names.** `trans_id`, `cmd_return_code`,
   `cmd_code` are read by those names. If the device spells them otherwise,
   `headers_json` still has them; matching would need the mapping fixed.
3. **`cmd_return_code` vocabulary.** Unobserved. The value is stored
   verbatim on every block and nothing is inferred from it; FAILED semantics
   are added only after a real capture shows the codes.
4. **Completion semantics.** How the device signals "no more blocks" (a
   final empty block, a header, a count, or nothing) is unknown, so
   `COMPLETED` is never set automatically.
5. **The FKDataHS102 historical record layout.** Deliberately not guessed.
   Blocks are stored raw for a decoder to be written against real captures.
6. **`trans_id` length.** Whether a 26-character id is echoed intact.
7. **Block size.** Unknown. `BIOMAX_COMMAND_RESULT_MAX_BODY` (4 MB default,
   under 16 MB hard cap) bounds what is accepted; a larger block is refused
   whole (no ACK) and logged `oversized_refused`, never stored truncated.
   Raise the limit deliberately if a capture shows bigger blocks.
8. **Lease and attempt defaults.** 600 s and 3 are a conservative guess at
   how long a terminal takes to answer GET_LOG_DATA; tune from a capture.

## 10. Safe activation later (not now)

Separate approvals, in order: run the migration (a normal backend deploy);
activate the receiver for live parallel testing with the flag still off;
capture one command exchange against one terminal with the flag on for that
terminal's queued pull only; correct sections 5/6/9 from the capture; only
then write a decoder against the stored blocks.
