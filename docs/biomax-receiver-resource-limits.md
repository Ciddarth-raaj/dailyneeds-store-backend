# Biomax receiver: resource limits (the 2026-09 OOM)

## What happened

`biomax-receiver` grew to ~450 MB of JS heap and died with
`FATAL ERROR: Ineffective mark-compacts near heap limit`, after GC pauses of
73–124 s. Port 7005 still accepted TCP, but `/healthz` returned zero bytes.
Several terminals were sending `request_code: realtime_enroll_data` over and
over, 26–35 KB a frame; the receiver logged each as `UNKNOWN_REQUEST_CODE`
with a `duration_ms` of 27–30 **seconds**, while `receive_cmd` polls logged
0–1 ms. A clean restart sat at ~9.75 MiB.

## Root cause

The production code (a2a50d7) did this for every non-punch request:

```
handlePoll()
  reply(res, ERROR_NO_CMD)                       // device is answered...
  await safeRaw(insertRawRequest(full frame))    // ...then the request waits
  logger.request({ duration_ms })                // measured AFTER the INSERT
  await safe(touchDevice(dev_id))                // and waits again
```

and every one of those awaits went through `mysql.createPool({ connectionLimit: 3 })`,
whose waiter queue is **unbounded** (`queueLimit` defaults to 0) and whose
`acquireTimeout` covers connecting only, **not** time spent in the queue.

1. A terminal that sends `realtime_enroll_data` gets `ERROR_NO_CMD`, not
   `OK`, so it sends it again. Each retry cost one full-frame BLOB INSERT
   (~30 KB) plus one `biomax_device` UPDATE, and every poll another UPDATE.
2. Three connections cannot keep up once arrivals exceed what three
   connections can serve (each acquire also pings the connection first, so
   every statement is two round trips). The excess waits in the pool's queue.
3. A waiting handler keeps its whole request reachable: `ctx` (req, res,
   socket, `body`), the rebuilt `frame`, and the queued `Query` holding the
   frame as a bound value. ~10 KB of JS heap plus ~90 KB of Buffers per
   waiting request, forever growing while the backlog grows.
4. `/healthz` ran `store.ping()` and `store.lastPunchAt()` on the same pool,
   so it queued behind the whole backlog: TCP accepted, zero bytes back.
5. Real punches queued behind it too. `findDevice` could not get a
   connection before the 15 s socket timeout, so the punch was never ACKed
   (correctly, per R1) - but also never stored while the backlog lasted.
6. As the heap neared its limit, GC ran back to back and stalled the event
   loop, which stretched every `duration_ms` further, until the OOM.

**Why "30 seconds".** The `duration_ms` on an unknown-code line was taken
*after* `await safeRaw(...)`, so it is pool-queue wait + the INSERT + any GC
stall - not the SQL time. The poll lines were taken *before*
`touchDevice`, which is why they read 0–1 ms while their own UPDATEs were
queued just as long. Nothing in the code proves the INSERT itself was slow;
to see the database side in production:

```sql
-- how much the diagnostic table grew (one ~30 KB row per retry)
SELECT DATE_FORMAT(received_at, '%Y-%m-%d %H:00') hr, request_code, outcome, COUNT(*) n, SUM(byte_length) bytes
  FROM biomax_raw_request WHERE received_at > NOW() - INTERVAL 2 DAY
 GROUP BY hr, request_code, outcome ORDER BY hr;
SELECT data_length, index_length FROM information_schema.TABLES
 WHERE table_schema = DATABASE() AND table_name = 'biomax_raw_request';
-- statement latency, if performance_schema is on
SELECT digest_text, count_star, avg_timer_wait/1e9 avg_ms, max_timer_wait/1e9 max_ms
  FROM performance_schema.events_statements_summary_by_digest
 WHERE digest_text LIKE '%biomax_raw_request%' OR digest_text LIKE '%UPDATE `biomax_device`%';
```

## What `realtime_enroll_data` is

**Not confirmed.** There is no captured `realtime_enroll_data` frame and no
protocol definition for it in this repository. From the name and the
vendor's request-code vocabulary it is *believed* to be the terminal pushing
user enrollment/profile data to its server, and it is **treated as
potentially biometric/sensitive until a protocol capture confirms its
structure**. It is not the punch code (`realtime_glog` is the only one), so
nothing in it is turned into attendance. The body is therefore **not
persisted and not logged**: it is read, hashed and discarded; a diagnostic
row keeps the headers, the size and the hash. A deliberate, access-controlled
capture is what would settle what it contains.

What the device expects back has not been captured. `ERROR_NO_CMD` (what it
got before, and still gets by default) apparently makes it re-send.
`BIOMAX_ENROLL_DATA_REPLY=OK` answers `response_code: OK` instead, which is
what DigiSME presumably did; enable it after a capture of DigiSME's reply to
this code confirms, or as a controlled trial on one terminal. Either way the
receiver's cost per frame is now a read, a hash and a reply.

## The bounded design

| Where | Before | Now |
|---|---|---|
| Post-reply work (last-seen, raw rows, pull status) | awaited in the handler | `biomax/housekeeping.js`: at most `BIOMAX_HOUSEKEEPING_CONCURRENCY` (1) running, both lanes together. **Ordinary lane** (last-seen, diagnostics): at most `BIOMAX_HOUSEKEEPING_MAX_PENDING` (100) jobs / `..._MAX_PENDING_BYTES` (4 MB) waiting. **Critical lane** (pull status): at most `BIOMAX_HOUSEKEEPING_MAX_CRITICAL_PENDING` (32) jobs / `..._MAX_CRITICAL_PENDING_BYTES` (64 KB, each job charged >= 256 B) waiting, always started first, coalesced per (pull, trans_id). Beyond either lane's bounds: **dropped, counted, logged once a minute** (`HOUSEKEEPING_DROPPED` / `CRITICAL_DROPPED`). Worst case waiting: 132 jobs, ~4.06 MB of payload |
| `last_seen_at` | UPDATE on every request | at most once per device per `BIOMAX_DEVICE_TOUCH_INTERVAL_MS` (60 s) for non-punch traffic; every punch still writes (`last_punch_at`); a repeat while one is queued is coalesced |
| Unknown request codes | full raw row per request | raw row (verbatim, as before) once per identical frame per `BIOMAX_DIAG_WINDOW_MS` (1 h), at most `BIOMAX_DIAG_PER_SOURCE` (6) per device+code and `BIOMAX_DIAG_MAX_PER_WINDOW` (120) in all; the next row says `+N suppressed` |
| `realtime_enroll_data` | "unknown", full BLOB row per retry | own kind; body never kept; same rate limits; headers-only row |
| Pool waiters | unbounded | `BIOMAX_DB_QUEUE_LIMIT` (50), then `POOL_ENQUEUELIMIT` |
| Waiting for a connection | forever | `BIOMAX_DB_ACQUIRE_TIMEOUT_MS` (5000) |
| One statement | forever | `BIOMAX_DB_QUERY_TIMEOUT_MS` (10000) |
| `/healthz` | same pool, no deadline | **no DB I/O at all**: reports the last result of a background probe (`biomax/healthMonitor.js`) with its age. The probe runs on its own 1-connection pool, one at a time, `BIOMAX_HEALTH_PROBE_INTERVAL_MS` (5000) after the previous one *settled*, recorded as failed after `BIOMAX_HEALTH_PROBE_TIMEOUT_MS` (2000); a result older than 3 x interval + timeout reports `db:false`, `stale` |
| Flood-capped unregistered punch | ACKed; one raw row per hour, the rest discarded | awaited `flood_capped` raw row **before** `OK`; no reply if it fails (R1) |
| Sockets | unlimited | `BIOMAX_MAX_CONNECTIONS` (200) - each holds at most `BIOMAX_MAX_BODY` |
| Shutdown | pool ended under queued work: one `Pool is closed` error line per queued job | server closed -> housekeeping closed (waiting jobs dropped and counted; nothing new starts) -> pools ended, a statement still running after 500 ms has its connection destroyed |

`connectionLimit` is still **3**. Timeouts apply to the receiver's store only
(`createRuntime` passes them); the API's DigiSME import builds a store on
the API pool without them and is unchanged.

### What did not change

- **R1.** A punch is ACKed `OK` only after `insertPunch` has returned, or,
  for an unparseable, header-less or flood-capped frame, after
  `insertRawRequest` has committed the **complete** frame
  (`requireComplete`; a frame longer than `raw_frame`'s 65535 bytes is
  refused, never cut to fit). A body over `BIOMAX_MAX_BODY` (64 KB - a real
  punch is ~144 bytes) is **refused with zero reply bytes** - no truncated
  copy is kept or counted as durable - and recorded as bounded metadata only:
  `OVERSIZED_PUNCH_REFUSED` (error level, once a minute per device, with
  dev_id, Content-Length, bytes received, source IP, time and the sha256 of
  the complete body streamed through without being kept, up to
  `BIOMAX_OVERSIZED_PUNCH_HASH_MAX`, 1 MB; a body declared larger is refused
  unread), `oversized_punch_refused` in `/healthz` and STATS, and a
  rate-limited headers-only `oversized` diagnostic row whose reason starts
  `REFUSED, NOT ACKNOWLEDGED`. (Before 2026-09 an oversized punch was stored
  truncated and ACKed.) Those writes are awaited *before* the
  reply, on the receiver pool, never through the droppable housekeeping
  queue. (The flood-capped case is a change: before 2026-09 it was ACKed
  with at most one raw row per hour.) If a limit above stops them - pool queue
  full, no connection in 5 s, statement over 10 s - that is a store error:
  frame spooled, socket closed, **no reply**, device retries. That is the
  same path a dead database always took.
- **R2.** Dedup is still the unique key `(dev_id, user_id, io_time_raw)` with
  the retransmit counter; a retransmitted punch is still `OK`. A punch
  committed server-side whose reply was lost to a timeout is retransmitted
  and lands on that key.
- **Historical pull.** `send_cmd_result` is still stored whole before `OK`;
  `markPullReceiving` is now a *critical* housekeeping job (own bounded lane,
  started before ordinary work, coalesced per pull). If that lane is full it
  is dropped and counted; the next matched block for the pull submits it
  again, and a command left SENT is at worst re-sent after its lease
  (harmless - GET_LOG_DATA is read-only and blocks are deduplicated). Command claim on `receive_cmd` is unchanged.
- Replies to every request code are byte-for-byte what they were
  (`ERROR_NO_CMD` for enrolment unless `BIOMAX_ENROLL_DATA_REPLY=OK`).
- No schema change: enrolment rows use the existing
  `outcome = 'unknown_request_code'` value with an explanatory `reason`.

### Known limit

A query timeout ends the statement on the **client** side (the connection is
destroyed). MySQL may keep executing it until it next talks to the socket,
so against a database that takes 30 s per statement, housekeeping can leave
up to ~3 (30 s / 10 s x concurrency 1) abandoned statements running there.
It is bounded by that ratio, not by traffic.

## Watching it

`GET /healthz` (loopback, port 7005) now also returns `process`
(uptime, heap/RSS/external MB, in-flight requests), `db_check` (ok, error,
stale, checked_at, age_ms, latency, consecutive failures, probe in flight), `pool` (connection_limit, queue_limit, all, free,
acquiring, **queued**), `housekeeping` (pending, running, pending_bytes,
critical_pending, **dropped**, **critical_dropped**, coalesced, failed), `diagnostics` (rows written, suppressed as
identical / by rate) and `requests_by_code`. `ok`, `db` and
`last_punch_received` mean what they meant; the API's
`utils/biomax_receiver_health.js` passes on only those.

Every `BIOMAX_STATS_INTERVAL_MS` (60 s) the receiver logs one
`BIOMAX.RECEIVER.STATS` line with the full snapshot (plus per-job
housekeeping counts and device-touch counts).

Error-level lines to alert on: `BIOMAX.RECEIVER.HOUSEKEEPING_DROPPED` (queue
full - the database is not keeping up), `BIOMAX.RECEIVER.CRITICAL_DROPPED`
(critical lane full), `BIOMAX.RECEIVER.HEALTH_DB_FAILED` (background probe
failing; first failure then every 12th), `BIOMAX.RECEIVER.HOUSEKEEPING_FAILED`
(job name + error; at most 10 a minute, the next line carries the count of
the rest), `BIOMAX.RECEIVER.STORE_ERROR` (a punch was refused - the device
will retry).

## Stress harness

`test_support/biomax/stress/stress.js` floods a receiver (any revision, via
`IMPL_DIR`) with 25–35 KB `realtime_enroll_data` at `RATE`/s alongside polls,
fresh punches and retransmissions, while `SLEEP()` triggers make every
`biomax_raw_request` INSERT and `biomax_device` UPDATE take `SLOW_MS`
(optionally `SLOW_PUNCH_MS` for `biomax_punch` too), and probes `/healthz`
every second with the API's 800 ms budget. It needs a throwaway MySQL/MariaDB
database whose name ends in `_test` (it drops and recreates its tables).
`biomax/receiver.flood.test.js` is the same scenario against a fake store and
runs with the normal test suite.
