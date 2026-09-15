# DigiSME attendance API sync

Automated replacement for the manual DigiSME Excel upload. Punches reach
`dnds.co.in` about one to two minutes after they happen:

```
employee punch -> DigiSME -> this sync -> insertPunch -> dnds.co.in
```

The Excel importer is **unchanged and still available** as the manual
fallback. Nothing here removes or disables it.

## Why it exists

The manual workflow failed silently. 11-14 Sep 2026 were never uploaded,
attendance recalculation read the missing punches as real absence, and
roughly **208 phantom absences a day** were produced until someone noticed.
Every monitoring decision below follows from that: the design goal is not
"sync attendance", it is "never fail quietly again".

## There is only one insertion path

This sync inserts nothing of its own. Every punch goes through
`biomax/store.js insertPunch`, the same code, tables and dedup as an Excel
import and a live device punch.

| Concern | Owner |
|---|---|
| identity + attendance date | `usecase/attendance_import.js` resolver (reused, not forked) |
| the write | `biomax/store.js insertImportedPunch` |
| duplicate protection | `biomax_punch.import_dedup_key`, UNIQUE |
| audit | `biomax_attendance_import_batch` / `_item` |

## ingest_source vs source_type

**Punch rows from the API are `ingest_source = 'DIGISME_IMPORT'`, exactly like
Excel ones.** This is deliberate and load-bearing:

```sql
import_dedup_key = CONCAT(ingest_source, '|', user_id, '|', io_time_raw)  -- UNIQUE
```

A separate `DIGISME_API` value would give **the same real punch two different
keys**, letting it exist twice - once from each route. It would also
misclassify API punches as device punches in five places that compare
`ingest_source === 'DIGISME_IMPORT'` (`attendance_raw`, `attendance_punch_void`,
`attendance_dashboard`, `attendance_calculation`, `repository/attendance_import`),
one of which writes a permanent snapshot.

The Excel/API distinction is carried on the **batch** instead -
`source_type = 'DIGISME_API_PULL'` vs `'DIGISME_ATD_DAILY'` - which has no
dedup, calculation or label consumer.

## The two jobs

| | live | recovery |
|---|---|---|
| schedule | `* * * * *` | `45 6,12,18,23 * * *` |
| window | today only | today-3, today-2, yesterday |
| zero punches | see below | **loud failure** |

Both `Asia/Kolkata`, registered in `server.js initServices()`.

**Today is self-healing.** The live job fetches the *whole* current day every
minute, not a delta, so a minute lost to a restart, a deploy or a vendor blip
is recovered by the next poll. That is why the recovery window excludes today.

`:45` for recovery because every other in-process cron sits at `:00`, `:15`
or `:30`.

## Write volume: the pre-filter

Fetching the whole day every minute means ~525 punches per poll by closing
time. Staging all of them the way the Excel preview does would write
**~756,000 `biomax_attendance_import_item` rows a day** to describe 525 real
punches. So each run:

```
fetch -> client dedup -> existingImportKeys pre-filter -> ONLY new punches
      -> lazy batch creation -> insertPunch
```

**No new punches means no batch and no items at all.** The pre-filter is a
write-volume optimisation only; the UNIQUE `import_dedup_key` remains the
correctness guarantee and still settles anything the pre-filter misses (a
race with the recovery job, a punch inserted between the read and the write).

## Rate limiting

The vendor allows **5 calls/minute**. Every DigiSME call - authentication,
live fetch, recovery fetch, the 401 refresh and its retry - queues behind
**one serialized throttle** in `services/digisme_attendance.js` at
`MIN_CALL_INTERVAL_MS = 15000`, capping any 60-second window at four calls.

No caller reasons about the limit; the queue makes it structural.

> The throttle previously read `lastCallAt`, awaited the gap, then wrote it
> back. Two concurrent callers read the same value, slept the same duration
> and fired **simultaneously** - the throttle vanished exactly when two jobs
> overlapped. It now reserves its slot before awaiting.
> `services/digisme_throttle.test.js` is the regression guard.

Typical consumption:

| scenario | calls that minute |
|---|---|
| normal live poll | **1** (the token is cached for 50 min) |
| live poll on a token-refresh minute | 2 |
| live + recovery overlapping | 4 |

## ⚠️ Topology

The re-entrancy guards **and the throttle queue** are in-process. That is
sound only because the API runs as a single pm2 fork-mode instance
(`ecosystem.config.js` declares no `instances`/`exec_mode`;
`docs/auth-stage0a-preproduction-readiness.md` verifies `pm_id=0,
exec_mode=fork_mode, instances=1`).

**Clustering or scaling the API to multiple instances gives every instance
its own crons and its own throttle queue.** Vendor traffic multiplies by the
instance count and breaches the limit with *no error anywhere in our logs*.
Revisit this design first - a cross-process lock, or one designated worker.
`services/digisme_cron_topology.test.js` fails if `ecosystem.config.js`
starts declaring instances.

## Monitoring

Three cases, deliberately distinguished:

| case | example | treatment |
|---|---|---|
| **A** rows returned, nothing new | `vendor=525 inserted=0 duplicate=525` | normal success, never alerts |
| **B** current-day dataset empty | `vendor=0` | alert only after **15 consecutive polls**, only **10:00-22:00 IST** |
| **C** historical date empty | `vendor=0` | **loud failure** - `code: 500` + Telegram |

**Stale feed.** At one-minute granularity "zero new inserts" is meaningless -
several quiet minutes are normal. The signal is whether the vendor's own
latest punch is **advancing**. If the API returns success but
`latest_vendor_punch_ts` has not moved for **90 minutes** inside the window,
that is flagged.

90 minutes is deliberately loose: punches cluster at shift boundaries and a
genuinely quiet afternoon can run 45-60 minutes. **Revisit after ~2 weeks of
real `latest_vendor_punch_ts` data.**

All alerts share a **60-minute cooldown** per condition - a per-minute poll
must not spam Telegram.

### Where the alerts go

**A single personal Telegram chat, not the shared alerts group.**
`DIGISME_ATTENDANCE_ALERT_CHAT_ID` in `constants/telegram.js`, injected into
the sync from `server.js`.

This is deliberate and **temporary**. The shared `ALERTS_TELEGRAM_CHAT_ID` -
accounts, purchase orders, break-glass - is for things the whole team acts
on; ten days of vendor-feed noise there would teach everyone to ignore the
channel, which is how a silent failure happens in the first place. Those
destinations are untouched.

Unlike every other id in that file, it does **not** fall back to the test
chat under `IS_TEST`: the destination was given explicitly for this bridge,
and an alert quietly delivered somewhere nobody watches is the exact failure
this sync exists to prevent. A non-production instance is silenced by
`CRON_DISABLED`, which stops the jobs rather than rerouting their alerts.

**Only exceptional conditions send anything.** A quiet minute, and a poll
whose punches are all already stored, are ordinary successes and send
nothing. `usecase/digisme_alert_destination.test.js` pins all of this -
including that 60 minutes of healthy polling is completely silent, and that
no other file may use this chat.

**Remove the constant with the bridge**, along with
`usecase/digisme_attendance_sync.js`, `services/digisme_attendance.js`, the
two crons in `server.js` and the `SANCTIONED` entry in the removal
guardrail.

### Log volume

One `api_sync_log` row per run would be ~525,000 rows a year and would bury
every other sync on the operator screen. Rows are persisted when:

- something was inserted, **or**
- the run failed / was rejected, **or**
- the dataset was empty *during opening hours*, **or**
- the 15-minute heartbeat is due.

Every run still logs to the application log at INFO. The heartbeat carries
the full metric set, so the stale-feed signal stays queryable:
`attendance_date, api_ok, vendor_row_count, client_deduped_count,
inserted_count, duplicate_count, rejected_count, latest_vendor_punch_ts,
stored_punch_count, latest_stored_punch_ts, last_successful_fetch_at,
last_nonempty_dataset_at, consecutive_zero_polls, consecutive_failures`.

Monitoring state is in memory on purpose: a restart means the app was down,
which is separately visible, and the first poll re-establishes the baseline
from the vendor's own dataset. No new monitoring table.

## What this sync does NOT do

- **It does not recalculate attendance.** Neither does the Excel commit path.
  Recalculating a date from inside a sync that has not finished its window
  would recalculate against knowingly incomplete punch data - the exact
  failure this integration exists to end. Recalculation stays operator-driven.
- **It exposes no route.** Phase 1 is cron-only; the live job self-heals and
  recovery runs four times a day, so a manual endpoint would be new
  permission surface for no requirement. `usecase/digisme_attendance_sync.js`
  is callable as-is when one is wanted.
- **It does not map `PunchAction` to `io_mode`.** That column is a BIGINT the
  Part 1 schema documents as *"NOT a direction flag"*, nothing reads it, and
  the engine pairs punches by position on purpose because staff press the
  wrong side of a terminal. `MISSING_PUNCH` is raised by an **odd punch
  count** (`utils/attendance_engine.js`), which direction data cannot fix - an
  absent punch stays absent. The whole vendor row is preserved in `raw_json`
  instead, so the question can be answered from data later.

## Credentials

`DIGISME_API_KEY`, `DIGISME_CUSTOM_KEY`, `DIGISME_COMPANY_ID` come from the
environment and are never logged. An axios error carries
`config.headers.Authorization` - the bearer - so **every error leaving the
sync goes through `safeError()`**, which reduces it to status + message.
Never log `err.config`, `err.request`, or `JSON.stringify(err)`.

## Tests

```
node --test usecase/digisme_attendance_sync.test.js   # dedup, idempotency, recovery, alerts, volume
node --test services/digisme_throttle.test.js         # the queue, spacing, token caching
node --test services/digisme_cron_topology.test.js    # single-process assumption, schedules, no route
```

## Environment

Required on the API host **before the sync can run**:

| variable | notes |
|---|---|
| `DIGISME_API_KEY` | no default - missing means refuse, loudly |
| `DIGISME_CUSTOM_KEY` | no default |
| `DIGISME_COMPANY_ID` | optional, defaults to `1` |
| `DIGISME_BASE_URL` | optional, defaults to the live gateway |

Documented in `.env-sample`. These are **not** the removed employee sync's
credentials - those were hard-coded literals now being revoked
(`docs/digisme-employee-sync-removal.md` §4).

`services/digisme_attendance.js` calls `require("dotenv").config()` itself,
before capturing them. It previously relied on a `config/*.js` having been
required first by `server.js` - an implicit load-order coupling that would
have left the credentials `undefined` if the module were ever required
earlier, or from a script or test harness that loads no config.

Without them the live cron reports *"not configured"* every minute and pulls
nothing. That is loud in the log but only if someone is reading it - **set
them before enabling the crons.**

## The removal guardrail, and why this integration is allowed past it

`services/digisme_removal.test.js` pins the removal of the *employee* sync.
It originally banned the vendor's host, both credential names and
`utils/encryptAES.js` outright - correct the day the sync was deleted, and a
direct collision once the approved attendance integration landed.

It is now split in two:

- **`GONE_EVERYWHERE`** - the employee sync's own function names, its feature
  flag, and `GetEmployeeDetails`. Banned in every shipped file **with no
  exception, including this integration's own client.**
- **`GONE_UNLESS_SANCTIONED`** - the gateway host, the two credential names
  and the cipher. These are the *vendor's*, not the employee sync's. Allowed
  in exactly one file: `services/digisme_attendance.js`.

The allowance is worth only as much as its narrowness, so the test also
asserts the sanctioned list stays one integration file, that the file still
exists, that it calls `GetRawAttendance`, and that it never touches the
employee master (`bulkCreate`, `new_employee`, the employee usecases).

**Adding a file to `SANCTIONED` is not a formality.** Ask whether it
genuinely needs to speak the vendor's protocol, or is reaching for
credentials it should not have.

## `utils/encryptAES.js` - vendor protocol, not a security primitive

Every DigiSME `/api/<Endpoint>` call carries its parameters as
`{ str: encryptAES(payload) }`. The key and IV are fixed **by the gateway** -
the IV is the gateway vendor's own name in ASCII - so they are protocol
constants, not a key we chose. Changing them gets requests rejected.

It offers **no confidentiality**: the values are in the file, so anyone who
can read the repo can decrypt, and the fixed IV means identical payloads
give identical ciphertext.

Therefore the rule, enforced by tests: encode **non-secret request
parameters** (`CompanyId`, `fromDate`, `toDate`) and nothing else. Never a
credential, token or personal data. DigiSME credentials travel in request
headers over TLS and never pass through it. `config/aadhaar.js` documents in
its own header why it uses a real cipher instead - follow that example.

> **Provenance.** That these exact values are gateway-mandated is established
> by the integration working against the live gateway, **not** by a vendor
> specification held in this repository. The vendor's manual is not in the
> tree. Treat them as protocol constants to change only on the vendor's
> instruction.
