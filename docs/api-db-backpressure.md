# API database backpressure (the 2026-09 API OOM)

Status: fix on a feature branch, **not merged, not deployed**. Measurements:
`test_support/api_db_stress/` against the real `server.js` on Node 14.21.3.

## Root cause

The API's MySQL pools (`drivers/mysql.js`, `drivers/mysql_gofrugal.js`:
mysqljs 2.18.1, `connectionLimit: 10`) queue every caller that cannot get a
connection in mysqljs's `_connectionQueue`:

- `queueLimit` is 0 - **unlimited**;
- `acquireTimeout` (10 s) bounds connecting and the pre-use ping, **not the
  time a caller waits in that queue** - a waiter waits for ever;
- a caller that gives up (the HTTP client times out, the user closes the Mini
  App) is **not removed**: its callback, its request (req, res, parsed body)
  and its closures stay queued;
- no statement has a timeout and sockets have no keepalive, so a query on a
  silent peer can pin a connection for ever;
- `HttpServer.timeout` / `requestTimeout` are 0, so nothing on the HTTP side
  ends a request that waits either.

When the database is slow or unreachable in the way production saw
("Handshake inactivity timeout": TCP accepted, no MySQL greeting), each of the
10 slots spends 10 s on a doomed handshake, the pool drains ~1 waiter a
second, and the queue grows by the arrival rate. **The bigger blow is
recovery**: when the database answers again, mysqljs runs the ENTIRE backlog -
every abandoned month read performs its queries, its live attendance
calculation and builds its JSON for a client that left minutes ago. That
burst is what takes the heap from ~200 MB to over 1 GB in ~30 s ("young object
promotion failed" / "Ineffective mark-compacts near heap limit"), and it
starves the live users who arrive after recovery.

The recalculation worker is NOT the cause: it is guarded (`workerBusy`), runs
one run per tick and adds ~4 statements a minute when idle. The OOM needs no
cron at all - HTTP traffic alone reproduces it.

## The fix: bounded admission in front of mysqljs

`utils/db_admission.js` - `guardPool(rawPool)` wraps each pool with the same
surface the code uses (`query`, `getConnection`, `escape`, `escapeId`,
`format`, `on`, `end`, `config`, read-only `_*` arrays). Nothing reaches
mysqljs's queue:

| mechanism | what it guarantees |
|---|---|
| permits = `connectionLimit` | at most 10 acquisitions outstanding: mysqljs always has a connection or a slot for whoever it is handed; `_connectionQueue` stays 0 (`queueLimit: 10` is only a backstop) |
| lanes | `interactive` (HTTP), `attendance_read` (the two month reads), `background` (every cron): own cap on connections, own bounded waiter queue, own wait deadline, own default statement timeout |
| wait deadline | a waiter not served in time is **removed from the queue** and failed `DB_ACQUIRE_TIMEOUT`; it never reached mysqljs, so nothing of it runs later |
| waiter bound | a full lane refuses at once, `DB_BUSY` |
| circuit breaker | N consecutive connection-level failures (refused, unreachable, handshake/ping/query inactivity, lost connection) OPEN it: every waiter is failed at once, new callers fail immediately `DB_UNAVAILABLE`; after the open period ONE probe goes through (HALF_OPEN); only the probe's own outcome closes or re-opens it. The probe is whichever caller comes first - an HTTP request or, on a quiet process, a cron tick (the cron gate skips only while OPEN or while the probe is out) |
| per-lane statement timeout | a statement with no `timeout` of its own gets its lane's; transactions included |
| cron gate | a cron tick is skipped (not queued) while a pool the job needs is OPEN; skipped before the job's external call, so nothing fetched is lost |
| overlap guard | a cron tick is skipped while the same job's previous tick still runs |

Errors keep mysqljs's shape (an `Error` with `.code`), through the same
callback, so every existing handler applies; the batch import recognises the
new codes as "database gone" (`usecase/attendance_import.js`).

`DB_ADMISSION=off` restores the previous pool exactly (no guard, no extra
mysqljs options) - the rollback switch.

### Defaults (env)

| setting | default | why |
|---|---|---|
| `DB_CONNECT_TIMEOUT_MS` | 3000 | TCP connect + handshake + ping (mysqljs `connectTimeout`/`acquireTimeout`, was 10000) |
| `DB_INTERACTIVE_MAX_WAITING` / `_WAIT_MS` / `_QUERY_TIMEOUT_MS` | 500 / 5000 / 120000 | HTTP |
| `DB_ATTENDANCE_READ_MAX_ACTIVE` / `_MAX_WAITING` / `_WAIT_MS` / `_QUERY_TIMEOUT_MS` | 5 / 500 / 5000 / 60000 | month reads may hold at most half the pool |
| `DB_BACKGROUND_MAX_ACTIVE` / `_MAX_WAITING` / `_WAIT_MS` / `_QUERY_TIMEOUT_MS` | 4 / 100 / 60000 / 600000 | crons never hold more than 4; reserved 1 |
| `DB_CIRCUIT_FAILURES` / `DB_CIRCUIT_OPEN_MS` / `DB_CIRCUIT_MAX_OPEN_MS` | 3 / 5000 / 10000 | open period doubles on each failed probe, up to 10 s: a recovered database waits at most ~10 s for its probe; costs one handshake per 10 s during an outage |
| `DB_STATS_INTERVAL_MS` | 60000 | `SERVER.RUNTIME.STATS` line |

Worst case waiting, per pool: 500 + 500 + 100 = **1,100 waiters**, each a
closure and a timer (the request it belongs to exists regardless), each gone
within its lane's deadline (5 s / 5 s / 60 s).

## Query timeouts - exactly what gets one

- Every statement run through a guarded pool **that sets no `timeout` of its
  own**: `pool.query`, and every statement on a connection from
  `getConnection` - `BEGIN`, `COMMIT`, `ROLLBACK` and everything between -
  using the timeout of the lane that checked the connection out: interactive
  120 s, attendance_read 60 s, background 10 min. A statement that sets its
  own `timeout` keeps it.
- Long legitimate statements: the batch work (GoFrugal full-table reads,
  5000-row inserts, `price_checker.replaceAll`, the daily recalculation) runs
  from crons or background jobs in the `background` lane (10 min).
  `DB_*_QUERY_TIMEOUT_MS=0` disables a lane's default without redeploying.
- When it fires: mysqljs errors the statement `PROTOCOL_SEQUENCE_TIMEOUT`
  (fatal) and destroys the connection; the permit is returned; it counts as a
  database failure for the circuit.
- **The server can keep executing it.** MySQL notices a vanished client only
  when it next writes to the socket. An open transaction is rolled back when
  the server sees the disconnect; an **autocommit write can still commit
  after the client gave up**. Bound: a timed-out statement returns its permit
  while the server may still be running it, so abandoned statements are not
  capped by the pool size alone. What caps them is the circuit: timeouts count
  as database failures, so after `DB_CIRCUIT_FAILURES` (3) consecutive ones
  it opens. While OPEN nothing is sent; in HALF_OPEN only the single probe
  caller runs (one connection, statements one at a time, and a timed-out
  statement destroys that connection). So per pool at most
  `connectionLimit` (10) statements can be abandoned per CLOSED -> OPEN
  transition, plus at most 1 per failed probe (probes are >= 5 s apart, at
  most one per 10 s once the period has doubled); a new CLOSED -> OPEN
  transition needs a successful probe first. Before, every queued waiter eventually
  ran, however long ago its client left.

## Transactions

Audit: every `getConnection` / `getConnectionAsync` / local copy
(`employee_master`, `employee_salary`, `employee_lifecycle`,
`price_checker`, `hq_offers`, `invoice`, `product_sales`, `stock_received`,
`purchase_acknowledgement`, `utils/batchInsert`, `biomax/store`, attendance,
payrun, work shift, telegram, ...) releases exactly once in a `finally` or
on every callback path, with two exceptions fixed here:

- `repository/stock_holding_report.js#appendItems` released the connection,
  then on a failed post-commit count rolled back and released it **again** -
  possibly another request's connection by then. Now released exactly once.
- `biomax/store.js#insertImportedPunch` (every duplicate punch of the
  per-minute DigiSME sync) read the existing row through the **pool** while
  still holding its own connection - two connections at once, which under a
  saturated pool could wait on itself. Now read on the held connection.

Three admin paths still read through the pool inside a transaction
(`usecase/biomax_device.js` device edits; `usecase/employee_master.js` create
with an Aadhaar verification and `attachAadhaar`). Each needs 2 permits for
one HTTP request; under the admission layer the worst case is a
`DB_ACQUIRE_TIMEOUT` after 5 s, where mysqljs alone could wait for ever.

Semantics: one permit per checked-out connection for the whole transaction;
statements on it take no other; `release()` and `destroy()` return the permit
exactly once (a second `release()` is still mysqljs's own "Connection already
released" error and returns nothing); results, errors and ordering are
mysqljs's. Tested on the real driver: `utils/db_admission.integration.test.js`.

## Crons

Every job touches the main database; two also need GoFrugal. All run in the
`background` lane, with the overlap guard and the per-pool gate checked
BEFORE the task starts.

| job | schedule | pools | external | own guard | during an outage (after the fix) |
|---|---|---|---|---|---|
| purchase_acknowledgement_gofrugal_sync | */5 min | main + gofrugal (full scans) | - | none -> now overlap guard | skipped while either pool is OPEN |
| purchase_ref_cache_warm | 08:15 | main + gofrugal | - | single-flight | skipped while either is OPEN |
| attendance_recalculation_queue | every min | main | - | workerBusy | skipped while main is OPEN; runs resume on the next tick; a run cut mid-way is requeued by the stale-heartbeat recovery (unchanged) |
| attendance_daily_recalculation | 06:55 | main | - | running flag | skipped if main is OPEN at 06:55 (3-day window self-heals next day) |
| telegram_link_poll | every 3 s | main (only per update) | Telegram getUpdates FIRST | polling flag | skipped BEFORE getUpdates: updates stay queued at Telegram, none lost |
| telegram_membership_worker / _sweep | 30 s / hourly | main | Telegram after claim | running / none | skipped while main is OPEN |
| digisme_attendance_live / _recovery | every min / 4x day | main | DigiSME FIRST | live/historical flags | skipped before the fetch: no vendor call wasted, the day is re-fetched next tick |
| sandbox_gst_taxpayer_session_refresh / daily | */2 min / 03:30 | main | GST sandbox after DB read | refresh single-flight | skipped while main is OPEN |
| stock_checker, recurring tasks, overdue reminders, tmp cleanup, break-glass, missing-attendance telegram | daily | main | Telegram / fs after DB | none | skipped while main is OPEN |
| synker product_sync / stock_holding_report_sync | 04:00 / 07:30 | main | Delium | none | skipped while main is OPEN |

Pre-existing, not changed here (reported): `telegram_link_poll` advances its
in-memory Telegram offset before its DB writes, so a DB failure DURING a tick
loses those updates; `recurring_task_generation` can duplicate a task if the
DB fails between its create and its recurrence update.

## Process exit

The old handler (one listener for SIGINT/SIGTERM/SIGQUIT/SIGUSR1/SIGUSR2/
`exit`/`uncaughtException`) called `process.removeAllListeners()`, closed
things without waiting and never called `process.exit`. Measured on Node
14.21.3, crons on (`test_support/api_db_stress/zombie.js`):

| case | old | new |
|---|---|---|
| uncaught exception | exits **0**, logged ERROR | exits **1**, logged ERROR once |
| SIGTERM (pm2 reload/stop) | exits 0, logged **ERROR** (a false crash) | exits 0 in 13 ms, logged INFO |
| uncaught exception while a query is stuck on a silent DB | alive with the HTTP port already closed for 3.5 s, then exits 1 only because a second, unrelated error surfaced | exits 1 at the 5 s deadline |

So the old code does NOT leave a permanent zombie in these tests; the
accurate description is: a fatal error exits with the wrong code, and how
long it lingers half-closed depends on which handles (a stuck DB socket,
`pool.end()` waiting for it) happen to be open. pm2 restarts on any exit
code by default, so it did restart - with the crash logged as a clean exit.

`utils/process_lifecycle.js` replaces it: a fatal error logs once, stops
crons, stops accepting HTTP, ends the pools, and exits **1** within 5 s;
SIGTERM/SIGINT exit **0** after the same cleanup within 1.5 s (under pm2's
kill_timeout) and log at INFO; a crash in the first 5 s of uptime waits out
the rest before exiting, so a boot-time crash restarts every ~5 s rather
than spinning.

## Observability

One `SERVER.RUNTIME.STATS` line a minute (low cardinality: lanes, <= 40 route
labels, no ids): heap used/total, RSS, event-loop p50/p95/p99/max, HTTP in
flight/aborted, per pool: circuit state and open count, DB failures,
admission running/waiting/rejected/timed_out, per-lane detail, mysqljs
all/free/acquiring/queued, per-route DB wait; cron running/skips;
recalculation worker busy/last outcome; process unhandled rejections.

## Measured (Node 14.21.3, real server.js, real MariaDB, fault proxy)

`test_support/api_db_stress/run.js`: 8 `/telegram/attendance/month` + 4
`/designation/permissions` requests a second (open loop, 30 s client
timeout), crons on; 30 s healthy, the fault, then recovery with the load
still on, then 60 s drained. BEFORE = production `c36df29`, AFTER = this
branch, same harness, same machine. Probe: one sample a second inside the
server process (`probe.js`). "outage OK" counts 200s among requests SENT
during the fault (BEFORE's are mostly requests sent in the last 30 s of the
fault and answered after recovery).

| scenario | side | mysql Q peak | app waiters peak (http/att/bg) | heap peak | RSS peak | outage OK | outage month p50/p95/p99 | recover month p50/p95/p99 | recover ordinary p95 | client timeouts+resets | server aborted | exit |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| healthy | before | 0 | 0 (no layer) | 185.1 | 267.5 | 1432/1432 | 10/15/21 | 11/15/19 | 15 | 0 | 0 | ran |
| healthy | after | 0 | 0 (-/-/-) | 157 | 232.7 | 1434/1434 | 11/16/24 | 11/16/25 | 15 | 0 | 0 | ran |
| slow | before | 10,458 | 0 (no layer) | 478.7 | 591.1 | 256/2148 | 30001/30002/30004 | 11/5376/8434 | 4927 | 1892 | 1891 | ran |
| slow | after | 0 | 314 (34/280/2) | 113.5 | 188.1 | 298/2148 | 5004/5007/5011 | 11/17/35 | 11 | 0 | 0 | ran |
| freeze | before | 10,562 | 0 (no layer) | 478.9 | 585 | 247/2149 | 30001/30002/30004 | 11/5974/9079 | 5686 | 1898 | 1898 | ran |
| freeze | after | 0 | 206 (8/198/0) | 112 | 185.9 | 1/2149 | 4/6/2024 | 11/17/21 | 15 | 0 | 0 | ran |
| refuse | before | 0 | 0 (no layer) | 110.7 | 182.9 | 0/1434 | 5/8/12 | 11/16/21 | 16 | 0 | 0 | ran |
| refuse | after | 0 | 2 (0/2/0) | 111.6 | 184 | 0/1434 | 4/5/7 | 12/17/22 | 16 | 0 | 0 | ran |
| unreachable | before | 0 | 0 (no layer) | 111.9 | 182.1 | 1/1434 | 6/10/13 | 11/15/20 | 15 | 0 | 0 | ran |
| unreachable | after | 0 | 37 (0/37/0) | 109 | 184.5 | 0/1434 | 4/6/12 | 11/17/21 | 16 | 0 | 0 | ran |
| long_outage | before | 28,202 | 0 (no layer) | 903.7 | 997.1 | 15/5736 | 30001/30002/30003 | 11/20452/26744 | 20455 | 5715 | 5715 | ran |
| long_outage | after | 0 | 147 (5/142/2) | 113.8 | 185.5 | 0/5733 | 3/5/10 | 12/17/28 | 15 | 0 | 0 | ran |
| heap256 | before | 28,188 | 0 (no layer) | 252.5 | 313.7 | 0/5733 | 30001/30002/30003 | 6581/12520/13021 | 12519 | 5884 | 5511 | OOM SIGABRT @523s |
| heap256 | after | 0 | 155 (6/149/0) | 68.5 | 140.6 | 0/5733 | 3/5/10 | 13/57/60 | 15 | 0 | 0 | ran |

Event-loop delay p95 (per-second samples, median / worst second after boot):
10-11 / <= 23 ms in every run on both sides (the probe's histogram floor is
10 ms) - the event loop is never the bottleneck; memory is.

**480 s handshake-hang outage (the production failure):**
- BEFORE: the mysqljs queue grows ~59 waiters/s (1,763 at 60 s, 15,872 at
  300 s, 28,202 at recovery). Heap 200 MB at recovery, then the backlog
  runs: 256 MB (5 s), 551 MB (15 s), 820 MB (20 s), 904 MB peak, RSS 997 MB;
  back to ~50 MB heap / 185 MB RSS 60 s later. 5,715 requests were aborted
  by their clients while their work stayed queued and later ran; recovery
  p95 20.5 s.
- AFTER: mysqljs queue 0 throughout; app waiters peak 147 (http 5,
  attendance 142, background 2) and 0 at the end; heap <= 114 MB, RSS <= 186
  MB, 49 MB / 104 MB at the end. Circuit: 38 opens (one
  failed probe every <= 10 s), closed ~12 s after the database returned;
  136 requests failed fast in those seconds; after that recovery p95 17 ms.
  Crons: 0 background-lane connection attempts during the outage
  (`telegram_link_poll` skipped 163x, `telegram_membership_worker` 16x,
  `attendance_recalculation_queue` 8x, `sandbox_gst_taxpayer_session_refresh`
  4x, `purchase_acknowledgement_gofrugal_sync` 1x).
- Same run on Node 22 (cross-check): mysqljs queue 0, waiters <= 140, heap
  <= 81 MB, 38 opens, recovery p95 13 ms.

**`--max-old-space-size=256`, same 480 s outage:**
- BEFORE: heap 213 MB at the end of the outage (28,188 waiters); 13 s into
  recovery, with 15,689 dead waiters still queued, `FATAL ERROR: Ineffective
  mark-compacts near heap limit Allocation failed - JavaScript heap out of
  memory` (SIGABRT) - the production signature. Every in-flight request is
  lost with it.
- AFTER: survives; heap peak 68.5 MB, RSS 140.6 MB, final 56.5 / 110 MB;
  recovery p95 57 ms (month) / 15 ms (ordinary).


**Recalculation worker, DB cut mid-run** (`recalcOutage.js`: a real
`WORK_SHIFT_SAVE` run for 300 employees, handshake-hang 3 s after the claim,
180 s outage, no HTTP load):
- BEFORE: the run stays RUNNING, no progress, heartbeat ageing, for the
  whole outage (its statements wait in mysqljs); it resumes 6 s after
  recovery and ends COMPLETED_WITH_ERRORS - 290 done, 10 failed (a manual
  Retry is needed). Heap 67 MB.
- AFTER: the run's first statement fails once the circuit opens; the worker
  records the failure (its FAILED write also fails - the DB is down - so the
  row stays RUNNING, as it would for any DB error before). `workerBusy`
  clears; each later minute tick is either skipped by the gate (OPEN) or is
  the half-open probe (one connection attempt), never overlapping (0
  in-progress skips). The first tick after recovery closes the circuit; the
  existing stale-heartbeat recovery requeues the run 600 s after its last
  heartbeat and attempt 2 completes 300/300. Heap 46-61 MB, no backlog.
  Found and fixed in this test: the cron gate treated HALF_OPEN as
  unavailable, so with no HTTP traffic nothing could ever probe and every
  gated cron skipped for ever (`isUnavailable` now means exactly "acquire
  would refuse"; regression test in `utils/db_admission.test.js`).

**The cost of the fix.** While the circuit is OPEN, callers fail in ~5 ms
instead of hanging 30 s; after the database returns they keep failing fast
until the next probe - measured 6-12 s with the 10 s cap (it was 15-40 s with
a 60 s cap, which is why the cap is 10 s). ECONNREFUSED/EHOSTUNREACH
outages were already fast-failing BEFORE (no queue) and recovered at once;
AFTER adds those seconds. In exchange no outage can grow the heap or queue
work for clients that have left.

**attendance_read cap A/B** (cap 5 vs `DB_ATTENDANCE_READ_MAX_ACTIVE=10`, i.e.
uncapped):

| | capped (5) | uncapped (10) |
|---|---|---|
| healthy: 4 bursts of 30 month reads, all 200 | p50 207 / p95 282 ms | p50 173 / p95 248 ms |
| healthy: steady month / ordinary p95 | 16 / 13 ms | 16 / 15 ms |
| slow DB (2 s): ordinary 200s | 260 / 716 | 237 / 717 |
| slow DB: ordinary app-level 500s | 239 | 284 |
| slow DB: ordinary p50 / p95 | 7.6 s / 17.0 s | 5.0 s / 21.7 s |
| slow DB: month 200s | 38 | 38 |
| slow DB: waiters peak (http / attendance) | 34 / 280 | 34 / 283 |
| DB_BUSY rejections, both | 0 | 0 |

The cap costs a normal morning burst ~35 ms and never rejects; under a slow
database it keeps 5 connections for everything else (more ordinary
requests succeed, shorter tail). It is a guarantee more than a speed-up.

## Secondary risks (not changed here; reported separately)

**1. `bodyParser.json({ limit: "120mb" })`, global, before authentication**
(`server.js:123`; `authMiddleWare` is mounted ~1300 lines later). Every
request - with or without a token - is buffered and `JSON.parse`d before
anything checks who sent it. Measured on the unmodified server, Node 14,
anonymous `POST /user/login` (`test_support/api_db_stress/bodyLimit.js`):

| request | status | heap peak | RSS peak |
|---|---|---|---|
| baseline | - | 54 MB | 120 MB |
| one 100 MB body | 400 (after full parse, 1.5 s) | 272 MB | 381 MB |
| four 30 MB bodies at once | 400 x4 | 639 MB | 759 MB |

Four anonymous requests cost more heap than the 480 s DB outage without the
fix reaches in its first minutes; a handful more reach any heap cap. It is
an independent OOM path from the DB queue.

Routes that legitimately post large JSON (sizes estimated from the frontend
code, not measured): `/price-checker/bulk` (Gofrugal outlet x batch sheet,
no row cap, one request, up to ~90 MB), `/offers-v3/price-upload` (~30 MB),
`/offers-v3/stock-upload` (~20 MB), `/gofrugal-synker/sync` (whole-table
push, unbounded, **unauthenticated**), `/reconciliation/sales|epayment`,
`/purchase/bulk` (a few MB). Every other import is capped at <= 2000 rows
(< ~2 MB). Unauthenticated POST routes include `/user/*`, `/asset`,
`/gofrugal-synker/sync`, `DELETE /gofrugal-synker/table`, `/purchase`,
`/purchase-tally`, `/telegram/attendance/{session,regularization,ot-request}`.

Recommended strategy (a separate change, needs the frontend owners):
global `json({ limit: "2mb" })`; a named large-body parser (`"120mb"`, or
lower once real sizes are logged) mounted only on the four bulk routes, and
only after `authMiddleWare` for those paths; `/gofrugal-synker/*` behind a
shared-secret header before its body is read; the price checker split into
chunks client-side in the longer term.

**2. `HttpServer.timeout = 0` and `requestTimeout = 0`** (`server.js:141-142`).
On Node 14.21.3 both are already the defaults, so the lines change nothing
today; together with the old pool they meant a request waiting on the DB
never ended. With the fix a DB wait ends within its lane deadline (5 s /
60 s), so this is no longer an OOM driver. Setting `requestTimeout` (e.g.
300 s) would also bound slow-upload clients; the comment above it says large
ZIP downloads need long responses - `requestTimeout` covers receiving the
request only, not the response, so it would not cut those.

**3. No pm2 `max_memory_restart`.** Containment only: it restarts the
process after the damage (in-flight requests lost), and does not stop the
growth. If added, set it well above normal peak (e.g. `1500M` against a
~150-270 MB healthy peak) so it never fires in normal operation. Not a
substitute for the fix.

**4. Node 14 is end of life** (April 2023): no security fixes; the
`AsyncResource.bind` bug found here (drops `thisArg`) is a Node 14 bug the
code now works around. The fix is tested on Node 14.21.3 and Node 22.
Upgrading is a separate project.
