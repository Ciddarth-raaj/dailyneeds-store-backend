# Attendance Permission

Management sometimes lets an employee work fewer hours **without a salary
deduction**: leave early on a festival, come in late, step out for part of the
shift. That is a **Permission**.

> **Permission is paid forgiven shortage, never worked time.**
> Payable time = eligible worked time + eligible approved permission time.

It never adds, moves or edits a punch, never changes the shift a date resolves
to, and never creates or increases overtime.

## Two origins, one calculation

| Origin | Who | How it becomes effective | Revoke |
|---|---|---|---|
| `REQUEST` | the employee (for themselves) or a manager (for an employee in their outlets) | the employee's ordinary attendance approval chain; effective only when the request is **APPROVED and SETTLED** | the existing admin revoke on the request (`CANCELLED`) |
| `DIRECT` | an authorised management user: one employee, several, outlets, or everybody in their outlet scope (festival early release) | at once, after a preview the grantor confirms | `revoke_attendance_permission`, per row or per bulk grant |

Both reach the engine as the same windows. The engine does not know, and must
not care, where a window came from.

**Why a direct grant needs no approval chain.** The chain exists so that
somebody other than the employee agrees. For a company decision, the authorised
management user *is* that agreement - exactly as the direct single-date shift
edit needs no request. What replaces the chain is: a grant right (and a separate
bulk right), the outlet scope, the payroll lock, a mandatory preview whose
fingerprint the apply must present, and a full audit trail. The grantor's own
attendance is never a candidate (nobody grants themselves, as nobody approves
their own request).

## The calculation (`CALCULATION_VERSION` 11)

`utils/attendance_engine.js#applyGrace`, in the approved order:

```
grace  ->  permission  ->  the remaining deduction rule
```

1. Windows are merged and **clipped to the date's resolved shift**. Time outside
   the shift covers nothing.
2. Grace runs exactly as before.
3. Permission covers only minutes that are **still chargeable after grace** and
   that fall **inside a window**:
   - late: the overlap with `[shift in + grace-forgiven, first punch)`, capped at
     the late minutes still counted;
   - early out: the overlap with `(last punch, shift end]`, capped at the early
     minutes still counted;
   - away mid-shift: the overlap with the OUT -> IN gaps, capped at the break
     *excess* - the allowance is used up first.
4. The shift's interval deduction rule prices what is left.

So grace and permission never forgive the same minute, and a permission never
reaches time the shortage does not contain (lateness worked off at the end of
the day, an unused break that already absorbed part of an early finish).

On a one-day shift override the shortage is arithmetic against the base NRM;
permission is capped at that arithmetic shortage.

| Day | Permission |
|---|---|
| Absent | nothing - a permission is not leave |
| Odd punch count (Missing Punch) | provisional; applied once the punch is resolved |
| Attendance not required | nothing |
| A window covering the whole shift | refused at creation - that is leave |

### What is stored

`attendance_day_calculation`:

| Column | Meaning |
|---|---|
| `worked_minutes`, `regular_minutes`, every OT column | from punches alone - **identical with or without a permission** |
| `shortage_before_permission_minutes` | the charge without it (NULL on rows written before this release) |
| `permission_minutes` (+ `_late_`, `_early_`, `_away_`) | paid permission actually forgiven |
| `permission_window_minutes`, `permission_ids` | the effective windows and which permissions they were |
| `shortage_minutes` | the charge **after** permission - still the one figure payroll prices |
| `payable_minutes` | base NRM less the charged shortage (OT separate) |

`attendance_monthly_payroll.permission_minutes` is for display; the
missing-minute deduction already reflects it. **No payroll or payrun code
changes**: payroll prices `shortage_minutes` on final days, as it always did.

The test `utils/attendance_permission.test.js` asserts the OT invariant over
several hundred combinations of shift rules, punch patterns and windows.

## Lifecycle and states (derived, never stored)

| Origin | States |
|---|---|
| REQUEST | Pending -> Approved / Rejected; Approved or Rejected -> Revoked (request `CANCELLED`); Pending at payroll lock -> **Closed – Not approved before payroll lock** |
| DIRECT | Approved -> Revoked |

A pending Permission request is **not** a pending correction: the date stays
FINAL and is charged until the request is approved. PERMISSION has its own
open-request group (`PERM`), so it never blocks, and is never blocked by, a
missing-punch or OT request on the same date. A permission may be finally
approved **before** its date is worked (like a shift change); the day is stored
with it once it closes.

There is no in-place edit. A change is revoke + a new grant or request, so
the history of both stays readable.

## Payroll lock

The existing lock and nothing else:

| Action in a locked month | |
|---|---|
| create (request or grant), approve, revoke | **refused** - checked up front (`findPayrollLockedPeriods`) and again at the write under the row lock (`assertMonthsNotPayrollLocked`) |
| reject a pending PERMISSION request | **allowed** - it changes no attendance and pays nothing; no day is written (`allowRejectWhenLocked`, PERMISSION only - every other request type keeps the existing rule that any decision in a locked month is refused) |
| Approve & Lock of the payrun | closes the employee's **pending** PERMISSION requests for the month in the same transaction, as `REJECTED` with `closure_reason = NOT_APPROVED_BEFORE_PAYROLL_LOCK` and every undecided step `SKIPPED` (the OT closure's shape) |

## Recalculation

There is no per-employee/date queue in this codebase; approvals write the
recalculated day in their own transaction. Permission does the same:

- request decision / revoke: the day is computed with the change assumed
  (`assume` / `exclude_request_id`) and written with the decision;
- direct grant / revoke: computed with `assume_permissions` (`add` /
  `exclude_ids`) and written in the grant's own transaction;
- an **open** (today or future) day is not stored; it reads as a labelled live
  preview and the daily 06:55 run stores it once it closes.

No calculated figure is ever patched.

### Monthly freshness

Payroll reads `attendance_monthly_payroll`, which only the month persist
(`calculateMonth(persist=true)` -> `saveMonthWithPayroll`) writes. Two things
keep a Permission from being lost between the day and the payslip:

1. **Refresh.** After a Permission is finally approved, granted (per employee)
   or revoked, the usecase re-persists that employee/month through the
   existing month persist (`refreshPersistedMonth`), when a monthly summary
   already exists. The result carries `month_refresh`
   (`{refreshed, year, month}` or `{refreshed:false, reason}`). A failed
   refresh never undoes the committed decision; the guard below still holds.
2. **Guard at Approve & Lock.** Every month persist stores
   `day_rows_fingerprint` - a SHA-256 over the stored day rows it was built
   from (`utils/attendance_month_freshness.js`, read back on the same
   connection after the days are written). Approve & Lock re-reads the monthly
   row and the day rows with `LOCK IN SHARE MODE` inside its transaction and
   recomputes the fingerprint. If it differs (`DAYS_CHANGED`) or is NULL
   (`UNTRACKED`, a summary persisted before this release), that employee is
   **BLOCKED** with `attendance_stale` and a message to recalculate Attendance,
   then payroll, then approve. Nothing is locked and no audit row is written.
   After a refresh, the payrun row reads `SOURCE_MOVED` until payroll is
   recalculated, as for any other attendance change.

The fingerprint is content, not a timestamp: `ON UPDATE CURRENT_TIMESTAMP`
only moves when a value changes, and an identical rewrite must not read as
stale. The share-mode reads matter because Approve & Lock handles several
employees in one transaction and a plain read would see its opening snapshot.

### Lock order

Every writer takes locks in one global order:

    payrun row (payrun_employee_calculation, FOR UPDATE)
      -> employee row (new_employee, FOR UPDATE)
        -> request / step / permission rows

`decideStage`, `revokeRequest` (given the date), `createRequest`, direct grant
and direct revoke all lock the payrun row first; Approve & Lock already takes
it first and then closes the pending PERMISSION requests. Protection is not
weakened: the payroll-lock check still runs under that row lock, and every
path still re-checks under its own row locks. The MariaDB race test
(`repository/attendance_month_freshness.mysql.test.js`) runs 25 rounds of a
decision against a lock transaction; the previous order deadlocked on the
first round, this order has none.

## Rights (all granted by migration to nobody)

| Key | Reaches |
|---|---|
| `view_attendance_permissions` | the register, the bulk log, and the Approval Centre's Permission tab |
| `raise_attendance_permission_request` | a request for **yourself** (`POST /attendance/me/permission-request`) |
| `raise_attendance_permission_for_others` | a request for an employee **in your outlet scope** (`POST /attendance/permission-request`); it still walks their chain and you cannot decide it |
| `approve_attendance_permission` | the decision endpoint for PERMISSION requests (with `approve_attendance_regularization`); who may decide a stage is still `canApprove` |
| `grant_attendance_permission` | a direct grant to **one** named employee |
| `grant_attendance_permission_bulk` | a direct grant to several employees, outlets, or everybody in scope (with the key above) |
| `revoke_attendance_permission` | revoke a direct grant, one or a whole bulk grant, in scope |

Revoking a **requested** permission remains the administrator-only approval
revoke, unchanged. Approval scope follows the existing chain exactly: Store
Manager stages are outlet-bound; Operations Manager / HR stages approve by chain
authority.

Every direct-grant route resolves the caller's outlet scope with
`employeeBranchScope.listFilters` and fails closed without it. An employee named
outside the scope is reported as "not an employee in your outlets on this date" -
one answer whether or not they exist.

## Audit

| Question | Where |
|---|---|
| Who created it, when, why | `attendance_permission.created_by_*`, `created_at`, `reason`, `remarks`; for a request also `attendance_approval_request.requested_by_employee_id` |
| Who approved / rejected, when | `attendance_approval_step` (decider, time, remarks, admin override, source) |
| Who revoked, when, why | direct: `attendance_permission.revoked_by_*`, `revoked_at`, `revoke_reason`, `revoke_bulk_operation_id`; request: `attendance_approval_revocation` |
| What period | `permission_from` / `permission_to` (full date-times), `to_shift_end`, `permission_minutes`; the day row records what it actually covered |
| Individual or bulk | `attendance_permission.bulk_operation_id`; `attendance_permission_bulk_operation` (who, target, date, times, reason, fingerprint, counts) and one `attendance_permission_bulk_item` per employee considered, skips and failures included |
| Closed by the payroll lock | `attendance_approval_request.closure_reason` |

## API

| Route | Right |
|---|---|
| `POST /attendance/me/permission-request` | `raise_attendance_permission_request` + self |
| `POST /attendance/permission-request` | `raise_attendance_permission_for_others` + scope |
| `GET /attendance/approvals?request_type=PERMISSION` (+ count, bulk-targets) | `view_attendance_approvals` + `view_attendance_permissions` |
| `POST /attendance/regularization/:id/decision` (PERMISSION) | `approve_attendance_regularization` + `approve_attendance_permission` |
| `POST /attendance/approvals/bulk` (`request_type: PERMISSION`) | as the decision route; REVOKE admin-only |
| `POST /attendance/approvals/:id/revoke` | administrator |
| `POST /attendance/permissions/preview` / `apply` | `grant_attendance_permission` (+ `_bulk` beyond one employee) |
| `GET /attendance/permissions` | `view_attendance_permissions` |
| `POST /attendance/permissions/:id/revoke` | `revoke_attendance_permission` |
| `GET /attendance/permissions/bulk-operations[/:id]` | `view_attendance_permissions` |
| `POST /attendance/permissions/bulk-operations/:id/revoke` | `revoke_attendance_permission` |

Every calculated day now carries `permissions` (each window with its derived
state and origin) beside the figures.

## Deploying

1. Merge and deploy backend, then frontend (`main-autodeploy`). The backend
   deploy runs `db-migrate up`, which applies
   `20261107120000-attendance-permission` (additive; the down migration
   refuses to drop the enum value while PERMISSION requests exist).
2. Verify the migration is recorded (`migrations` table) and the columns exist.
3. **Bootstrap the unlocked monthly summaries** (below).
4. Recalculate payroll for the affected month (Payrun > Calculation & Review
   > Recalculate) so its source markers match the re-stored attendance.
5. Grant the keys on the designation rights screen, to the intended
   designations only.

### Bootstrap: no SQL backfill

Every monthly summary stored before this migration has
`day_rows_fingerprint = NULL` and is refused at Approve & Lock as `UNTRACKED`.
It is **never** given a fingerprint by SQL: a summary may already be stale
against its day rows, and a fingerprint written over today's days without
rebuilding the totals would certify figures nobody rebuilt. Each unlocked
summary is instead stored again through the normal path,
`calculateMonth({ ..., persist: true })`, which rebuilds the totals and takes
the fingerprint from the days the same transaction stored:

    # inventory: months with summaries, how many untracked / payroll locked
    NODE_ENV=production node scripts/attendance/month-fingerprint-bootstrap.js
    # dry run for the open month(s): who would be re-stored, who is locked
    NODE_ENV=production node scripts/attendance/month-fingerprint-bootstrap.js --month 2026-09
    # apply
    NODE_ENV=production node scripts/attendance/month-fingerprint-bootstrap.js --month 2026-09 --apply

The script writes no SQL of its own. A payroll-locked month is skipped and
never unlocked; one locked while it runs is refused by the persist's own
`FOR UPDATE` check and reported. It exits 1 if any employee-month failed or
was left without a fingerprint. `--employee <id>` re-runs one employee.

A single employee-month can also be stored through the API the script calls:
`GET /attendance/payroll/monthly?employee_id=&year=&month=&persist=true`
(`view_attendance_payroll` + `recalculate_attendance`).

**Recalculate Attendance (the bulk screen and the daily run) stores DAY rows
only; it does not store the monthly summary.** A summary refused as stale is
fixed by storing the month (the script, or the API above), then
recalculating payroll.

The migration keeps the repository's forward sequence: identifiers here run
ahead of the calendar (`20261106120000` was added before it), so the name
sorts after every existing migration and collides with none.

Stored days keep `calculation_version` 10 until recalculated; nothing is
recalculated on deploy. Until a date carries a permission, version 11 produces
exactly the version-10 figures (the existing suites pass unchanged), so no
recalculation is needed for dates without one.

## Known limits

- **Months persisted before deploy** are `UNTRACKED` and must be stored once
  through the bootstrap before they can be approved and locked (see Deploying).
- **No screen stores the monthly summary.** The Recalculate Attendance screen
  writes days only; storing a month is the script or the monthly API (as
  before this release).
- **Refresh is best effort.** If the month re-persist after a decision fails
  (for example the month is locked meanwhile), the decision stands and the
  guard refuses the lock until the month is recalculated.
- **Replace Approver** moves pending REGULARIZATION/OT steps only (SHIFT_CHANGE
  was already excluded); PERMISSION follows SHIFT_CHANGE (follow-up).
- No Telegram notification is sent for Permission requests yet (follow-up).
- An employee's outlet is their current `store_id` (there is no transfer
  history); scope checks use it (historical outlet scope is a follow-up).
- A bulk preview/apply resolves each employee's shift individually; one grant
  is capped at 1,500 employees.
