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
| reject a pending request | **allowed** - it changes no attendance and pays nothing |
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

1. Run migration `20261107120000-attendance-permission` (additive; the down
   migration refuses to drop the enum value while PERMISSION requests exist).
2. Deploy backend, then frontend.
3. Grant the keys on the designation rights screen.

Stored days keep `calculation_version` 10 until recalculated; nothing is
recalculated on deploy. Until a date carries a permission, version 11 produces
exactly the version-10 figures (the existing suites pass unchanged), so no
recalculation is needed for dates without one.

## Known limits

- **Monthly roll-up freshness.** The payrun reads
  `attendance_monthly_payroll` (`missing_minute_deduction`), and that row is
  written only by the month persist (`calculateMonth(persist=true)` - the
  Recalculate Attendance path). A decision, grant or revoke rewrites the stored
  DAY only, so the month must be re-persisted (and the payrun recalculated)
  before Approve & Lock for the permission to reach pay. This is exactly how
  every existing approval (regularization, OT, shift change) behaves today;
  Permission neither fixes nor worsens it, and it is worth a separate change.
- **Lock ordering.** Approve & Lock now also locks the month's pending PERMISSION
  requests. A permission decision racing Approve & Lock for the same employee
  can deadlock; InnoDB aborts one and the user retries. Neither can commit a
  half state.
- **Replace Approver** moves pending REGULARIZATION/OT steps only (SHIFT_CHANGE
  was already excluded); PERMISSION follows SHIFT_CHANGE.
- No Telegram notification is sent for Permission requests yet.
- An employee's outlet is their current `store_id` (there is no transfer
  history); scope checks use it.
- A bulk preview/apply resolves each employee's shift individually; one grant
  is capped at 1,500 employees.
