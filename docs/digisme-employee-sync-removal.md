# DigiSME employee sync — removal

**Status: REMOVED.** The integration is gone from the tree: route, cron
registration, service code, hard-coded credentials and the pause switch that
had been holding it off since Stage 0C.

This file was written as the impact report requested before the deletion, and
is kept as the record of what the removal touched and what it deliberately
left behind. Sections below are in the past tense where the work is done; the
two items under **Still open** are not done and are not blocked by the
removal.

The removal was taken before Stage 0C / C2 had handled a real joiner and
resignation end to end, which the original report proposed as the trigger.
That was a deliberate call, not an oversight — recorded here because the
`reconcileEmployeeLifecycle()` gap under **Still open** was its one real
dependency, and it is now explicit rather than implied.

## What it replaced

Before removal the sync was off four times over, independently:

| Guard | Where |
| --- | --- |
| `DIGISME_EMPLOYEE_SYNC` unset/off (default) | `config/lifecycle.js` → `digisme.employeeSync` |
| `LOCAL_EMPLOYEE_MASTER` on (default) | `config/lifecycle.js` → `localEmployeeMaster` |
| `api_sync_cron_config.is_enabled = 0` | database row `employee_sync` |
| HTTP `423 Locked` | `routes/employee.js` `POST /employee/sync` |

The second of those **survives the removal** and is the one to keep: the rule
it enforces was never about DigiSME. No legacy or future importer may write
the employee master while `LOCAL_EMPLOYEE_MASTER` is on. The other three are
gone along with the thing they were restraining.

## What the removal touched

### 1. The route — `routes/employee.js` ✅
`router.post("/sync", ...)` removed, with its `ADD_EMPLOYEES` guard, its 423
pause branch and its `lifecycleConfig` import. `POST /employee/sync` is now a
404.

- `usecase/employee.js#sync` removed, along with `setSynker()` and the
  `this.synker` handle — nothing else on that usecase used the synker. The
  `employeeUsecase.setSynker(this.synker)` wiring in `server.js` went with it.
  (For the record: that method resolved `200` even when
  `syncDigismeEmployees()` returned the `423` pause object, so the route's own
  423 branch was what made the answer honest.)
- `constants/api_sync_types.js` **keeps** its `employee_sync` entry, now with
  a comment saying why: with no route and no cron its `match` can never fire
  again, but the historical `api_sync_log` rows resolve their label through
  this list, and removing the entry would leave them unlabelled.

### 2. The scheduler — `services/synker.js` ✅
All removed:

- the conditional `cronService.register("employee_sync", ...)` block and its
  `else` startup log line;
- `CRON_SYNTAX_EMPLOYEE = "0 7 * * *"`;
- `syncDigismeEmployees()`, `_fetchDigismeEmployees()`, `_authenticateDigisme()`,
  and `getDigismeToken()` — which was defined **twice**, identically, at lines
  144 and 897. Both gone.
- the `DIGISME_API_KEY` / `DIGISME_CUSTOM_KEY` constants (see §4);
- `require("../utils/encryptAES")` and `require("child_process").exec`, both of
  which turned out to be used by the DigiSME code and nothing else. So
  `utils/encryptAES.js` — a committed-key, fixed-IV vendor cipher — now has no
  caller in the shipped tree, which `services/digisme_removal.test.js` pins.
- `require("../config/lifecycle")` and `capitalizeWords`, likewise unused once
  the sync went;
- the `designationUsecase`, `outletUsecase` and `employeeUsecase` constructor
  parameters, which only the sync used. The synker takes eight positional
  arguments now instead of eleven; `server.js` was updated to match. The
  usecases themselves are untouched — only the synker's handles on them.

**Kept, deliberately:**

- `reconcileEmployeeLifecycle()` and its `setEmployeeLifecycleUsecase()`
  wiring. It is Stage 0C / C1c reconciliation, not DigiSME, and the logic
  works — so it was kept rather than deleted. **It now has no caller**, which
  its own doc comment and `services/synker_lifecycle.test.js` both state
  outright. See **Still open**.
- `designationUsecase.bulkCreate`, `departmentUsecase.bulkCreate`,
  `outletUsecase.bulkCreate`, `employeeUsecase.bulkCreate` — shared with local
  CRUD and the import paths. Only the DigiSME *caller* went.
- Every other cron in `initCronJobs` (product, stock holding, cleaning/packing),
  asserted in two test files.
- The DigiSME **attendance import** (`usecase/attendance_import.js`,
  `biomax/digismeImport.js`, `ingest_source = 'DIGISME_IMPORT'`). Same vendor
  name, entirely different thing: a spreadsheet of punches uploaded by hand,
  with no credentials, no network call and no employee-master write.

### 3. Configuration — `config/lifecycle.js` ✅
`digisme.employeeSync`, `PAUSED_MESSAGE` and the `DIGISME_EMPLOYEE_SYNC` read
are gone. A host whose `.env` still sets that variable is simply not read by
anything; the line can be deleted at leisure.

`localEmployeeMaster` / `LOCAL_MASTER_MESSAGE` **stayed**, for the reason given
at the top of this file.

### 4. Credentials — they were **not** in `.env` ⚠️ ACTION OUTSTANDING
`DIGISME_API_KEY` and `DIGISME_CUSTOM_KEY` were **hard-coded literals in
`services/synker.js` lines 16-19**, not environment variables. Two
consequences:

- there is nothing to remove from `.env` for these, and `.env-sample` carries
  no `DIGISME_*` key at all — so the only DigiSME line a deployed `.env` may
  hold is the `DIGISME_EMPLOYEE_SYNC` switch, which is undocumented there.
  Check the real `.env` on each host rather than the sample;
- **they are in git history and deleting the lines did not un-publish them.**
  The code change cannot do this part: DigiSME must revoke both keys. Until
  they do, the credentials remain live and readable by anyone with repository
  history. `services/digisme_removal.test.js` asserts no shipped file presents
  them any more; it cannot assert anything about history.

If a host's `.env` sets `DIGISME_EMPLOYEE_SYNC`, that line goes with §3.

### 5. Database rows ✅
- `api_sync_cron_config` row `employee_sync` deleted by migration
  `20260927120000-digisme-employee-sync-removed`, which reports how many rows
  it removed and how many historical log rows it kept. Its down migration
  restores the row **disabled**, since re-enabling a schedule whose code is
  gone would be meaningless.
- `api_sync_log` rows of that type are **untouched** — they are the record of
  what the sync did, including the wrong row counts below.
- Nothing else. No table, column or employee row belonged to this integration.

### 6. Tests ✅
Each file that asserted the *pause* now asserts the *removal*, so a revert or
a hand-reinstatement fails loudly rather than passing quietly:

- `services/digisme_pause.p1.test.js` → **replaced** by
  `services/digisme_removal.test.js`, which sweeps every shipped file for the
  sync's functions, credentials, endpoint and flag, checks the route and cron
  are gone, and pins what the removal deliberately keeps.
- `services/synker_lifecycle.test.js` → rewritten around
  `reconcileEmployeeLifecycle()` itself (207 on partial failure, the
  not-wired path) plus a test asserting **it has no caller**.
- `services/purchase_sync_independence.test.js` → the "pause is scoped"
  block became "the sync is gone and took nothing else with it".
- `routes/employee_master.test.js` → the 31/32 DigiSME-guard block became
  "dnds.co.in remains the employee master".
- `routes/employee_updatedata.m1.test.js` → its source slice no longer ends at
  `router.post("/sync"`; it finds the next route instead.
- `middlewares/hr_authorization.b2.test.js` → the two `/employee/sync` entries
  dropped from the permission map.
- `scripts/auth/c1c-lifecycle-rehearsal.js` → left alone; its only mention is
  a comment describing what DigiSME used to send.

### 7. Frontend — `dailyneeds-store` ✅
`helper/employee.js#sync` removed. No component called it (`pages/`,
`components/`, `customHooks/` all searched, before and after), so there was no
button and no UI change.

## Related bug: `row_count: 0` on every run

Real, independent of the removal, and **now fixed** — though not where this
file first said it was.

`utils/api_sync_logger.js#wrapCron` asks `extractRowCount(req, payload)`
(`utils/api_sync_log_helpers.js`) for a count, and that helper reads it off the
**return value** of the wrapped function. `syncDigismeEmployees()` returned
none of the keys it looks for: it `await`ed
`employeeUsecase.bulkCreate(formattedEmployees)` and discarded the result, then
returned whatever `reconcileEmployeeLifecycle()` returned.

This file originally concluded that the helper therefore "yields `null`, which
the log screen shows as `0`". That was wrong about the mechanism. The helper's
candidate list ended with `Array.isArray(p.data) ? p.data.length : null`, and
`Number(null)` is `0` — a finite number `>= 0`, so it was **returned as a real
count of zero**. The `return null` after the loop was unreachable for any
object payload. The screen was reporting faithfully; the helper was producing
a fabricated zero, and did so for every job whose result carries no recognised
key, not just this one.

Fixed in `extractRowCount` by skipping absent candidates, so "nobody counted"
(`null`) and "counted, and it was none" (`0`) are different values again. See
`utils/api_sync_logger.test.js`.

Checking the other crons, as this file proposed, found two more defects in the
same path — both affecting `stock_holding_report_sync`, a live nightly job:

- its cron body was `async () => { await fn(); }` rather than
  `return await fn();`, so `wrapCron` saw `undefined` and logged from nothing;
- `wrapCron` decided status from `result.warnings` alone, so a run returning
  `{ code: 400, message: "No valid stock holding rows to import" }` was logged
  as **success / 200**. Only a thrown error was ever a failure.

The second is why the first had to be fixed second: adding the `return` alone
would have made the job start recording its refusals as clean runs.
`wrapCron` now applies `isSuccess` — the same rule the HTTP middleware already
applies to the same table — and `data.item_count`, the stock sync's own word
for its row count, is a recognised candidate.

One thing that has not changed: these are reporting bugs, not evidence that a
sync did nothing. Historical `employee_sync` rows showing `row_count: 0` are
not proof of no writes.

## Still open

Neither of these is caused by the removal, and neither is fixed by it.

1. **DigiSME must revoke the two credentials** (§4). The only item here that
   code cannot close. Start it now if it has not been started.
   Noticed while removing them, and **left in place**: a commented-out
   `GOFRUGAL_API_KEY` literal sits immediately above them in
   `services/synker.js`, with two commented-out REST calls further down that
   reference it. Nothing reads it — the live GoFrugal path is a direct MySQL
   connection — but it was committed in plaintext, so **GoFrugal should revoke
   it too**. Deleting the line would not change that; only revocation does.
   Flagged here rather than acted on: it is unrelated to this removal and
   outside its scope.
2. **`reconcileEmployeeLifecycle()` has no caller.** Nothing reconciles
   employment periods on a schedule. This is *not* a regression from the
   removal: its only caller was a sync disabled at two switches for the whole
   of Stage 0C, so it was not running in production before either. But it is
   now a visible gap where it used to be a hidden one. Options: its own cron,
   or have the local Resign / Rejoin actions call it directly — the second is
   probably right, since those are the events it reconciles.
3. **Verify the stock holding sync was actually working.** The logging fixes
   above mean its runs are recorded truthfully from now on, but they say
   nothing about the past: every historical row reads `success` with
   `row_count: 0` whether the run imported 216 items or refused with code 400.
   Query `api_sync_log` for `log_type = 'stock_holding_report_sync'` and check
   the outcome against `stock_holding_report` rows for the same dates.
