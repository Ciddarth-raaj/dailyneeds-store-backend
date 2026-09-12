# DigiSME employee sync — what removal would touch

**Status: nothing is removed yet.** This is the impact report requested before
the deletion. The trigger for acting on it is Stage 0C / C2 having handled a
real joiner and a real resignation end to end; until then the integration stays
where it is, disabled at both switches it already has.

Today it is off twice over, independently:

| Guard | Where | Effect |
| --- | --- | --- |
| `DIGISME_EMPLOYEE_SYNC` unset/off (default) | `config/lifecycle.js` → `digisme.employeeSync` | the `employee_sync` cron is **never registered**; `syncDigismeEmployees()` returns `423` before authenticating, fetching or writing |
| `LOCAL_EMPLOYEE_MASTER` on (default) | `config/lifecycle.js` → `localEmployeeMaster` | refuses the employee-master write **even if** the flag above were turned back on |
| `api_sync_cron_config.is_enabled = 0` | database row `employee_sync` | the operator-facing schedule is disabled |
| HTTP `423 Locked` | `routes/employee.js` `POST /employee/sync` | the button, if pressed, is told why nothing happened |

## What the removal would touch

### 1. The route — `routes/employee.js`
`router.post("/sync", ...)` (the `ADD_EMPLOYEES` guard, the 423 pause branch and
the `this.employeeUsecase.sync()` call). Removing it makes the path a 404.

- `usecase/employee.js#sync` (line 316) is the route's only body: it calls
  `synker.syncDigismeEmployees()` and resolves `{ code: 200 }`. It becomes dead
  with the route, and so does the `setSynker(synker)` wiring (line 13) if
  nothing else on that usecase uses the synker — check before deleting.
  Note while it lives that it resolves `200` even when
  `syncDigismeEmployees()` returns the `423` pause object, so the route's own
  423 branch is what makes the answer honest.
- `constants/api_sync_types.js` carries the `employee_sync` entry matched on
  `/employee/sync`. With no route and no cron it matches nothing; leaving it
  keeps the **historical log rows** readable on the API Sync Log screen, which
  is the reason to leave it. Decide explicitly rather than by omission.

### 2. The scheduler — `services/synker.js`
- the `if (lifecycleConfig.digisme.employeeSync) { cronService.register("employee_sync", ...) }`
  block and its `else` startup log line;
- `CRON_SYNTAX_EMPLOYEE = "0 7 * * *"`;
- `syncDigismeEmployees()`, `_fetchDigismeEmployees()`, `_authenticateDigisme()`,
  and **`getDigismeToken()` — which is defined twice, at lines 144 and 897**,
  identically. Both go.
- the `DIGISME_API_KEY` / `DIGISME_CUSTOM_KEY` constants (see §4);
- `require("../utils/encryptAES")` and `require("child_process").exec` become
  unused **if** no other method needs them — `exec` is used elsewhere in the
  file, `encryptAES` should be checked (`utils/encryptAES.js` itself is a
  committed-key vendor cipher that nothing else should be using).

**Not to be removed with it:**

- `reconcileEmployeeLifecycle()` — called at the end of `syncDigismeEmployees()`
  but it is Stage 0C / C1c lifecycle reconciliation, not DigiSME. It needs a
  new caller (its own cron, or the local lifecycle actions) **before** the sync
  goes, or employment-period reconciliation silently stops running. This is the
  one genuine behavioural risk in the whole removal.
- `designationUsecase.bulkCreate`, `departmentUsecase.bulkCreate`,
  `outletUsecase.bulkCreate`, `employeeUsecase.bulkCreate` — shared with local
  CRUD and the import paths. Only the DigiSME *caller* goes.
- Every other cron in `initCronJobs` (product, stock holding, cleaning/packing).

### 3. Configuration — `config/lifecycle.js`
`digisme.employeeSync`, `PAUSED_MESSAGE` and the `DIGISME_EMPLOYEE_SYNC` read.

`localEmployeeMaster` / `LOCAL_MASTER_MESSAGE` **stay**: that guard is about who
owns the employee master, not about DigiSME, and it is the thing that keeps any
future importer out.

### 4. Credentials — they are **not** in `.env`
`DIGISME_API_KEY` and `DIGISME_CUSTOM_KEY` are **hard-coded literals in
`services/synker.js` lines 16-19**, not environment
variables. Two consequences:

- there is nothing to remove from `.env` for these, and `.env-sample` carries
  no `DIGISME_*` key at all — so the only DigiSME line a deployed `.env` may
  hold is the `DIGISME_EMPLOYEE_SYNC` switch, which is undocumented there.
  Check the real `.env` on each host rather than the sample;
- they are in git history and cannot be un-published by deleting the lines.
  **Have DigiSME revoke both, rather than treating deletion as removal.** That
  is a vendor action with a lead time, so start it before the code change.

If a host's `.env` sets `DIGISME_EMPLOYEE_SYNC`, that line goes with §3.

### 5. Database rows
- `api_sync_cron_config` row `('employee_sync', 'Employee Sync', 'sync', '0 7 * * *', 1)`
  seeded by `20260614120000-api-sync-log-up.sql`, currently `is_enabled = 0`.
  Deleting it removes the schedule from the operator screen; **keep the
  `api_sync_log` history rows** either way — they are the record of what the
  sync did, including the wrong row counts below.
- Nothing else. No table, column or employee row belongs to this integration.

### 6. Tests and scripts that assert the pause exists
These are *about* the pause, so they change shape or go with it:

- `services/digisme_pause.p1.test.js` (whole file — asserts nothing is called
  and 423 is returned)
- `services/synker_lifecycle.test.js`, `services/purchase_sync_independence.test.js`
- `routes/employee_master.test.js` (the 423 assertion around line 415)
- `routes/employee_updatedata.m1.test.js` (slices source **up to**
  `router.post("/sync"` — this one breaks outright when the route goes)
- `middlewares/hr_authorization.b2.test.js`, `scripts/auth/c1c-lifecycle-rehearsal.js`

### 7. Frontend — `dailyneeds-store`
`helper/employee.js` exports `sync: () => API.post("/employee/sync")`. **No
component calls it** (searched `pages/`, `components/`, `customHooks/`), so
there is no button to remove — only the dead helper.

## Related bug: `row_count: 0` on every run

Real, and independent of the removal. `utils/api_sync_logger.js#wrapCron` asks
`extractRowCount(req, payload)` (`utils/api_sync_log_helpers.js`) for a count,
and that helper reads it off the **return value** of the wrapped function —
`row_count`, `rows_processed`, `rows_imported`, `inserted`, `count`, `total`.

`syncDigismeEmployees()` returns none of them. It `await`s
`employeeUsecase.bulkCreate(formattedEmployees)` and **discards the result**,
then returns whatever `reconcileEmployeeLifecycle()` returns — `{ code: 200,
lifecycle: {...} }`. So the helper finds no candidate and yields `null`, which
the log screen shows as `0`. The rows were written; nothing counted them.

Two things follow:

1. the same flaw hits any other cron whose function does not return a count —
   worth checking `product_sync` and `stock_holding_report_sync` against the
   candidate key list rather than assuming this was DigiSME-specific;
2. it is a reporting bug, not evidence that the sync inserted nothing. Do not
   read historical `employee_sync` log rows as proof of no writes.

Fixing it for DigiSME is not worth doing if the sync is being deleted; fixing
`wrapCron`'s contract — or having each cron return `{ row_count }` — is.

## Suggested order

1. DigiSME revokes the two keys (§4). Vendor lead time; start first.
2. Give `reconcileEmployeeLifecycle()` its own caller (§2) and prove it runs.
3. Confirm Stage 0C / C2 has handled a real joiner and a real resignation.
4. Then remove §1-§3, §6, §7 in one reviewable change, and decide §5 explicitly.
