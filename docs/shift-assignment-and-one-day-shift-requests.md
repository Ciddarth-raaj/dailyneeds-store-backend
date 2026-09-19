# Shift assignment history, the one-day shift request, and the approval centre

Three connected changes, one sentence each:

1. **Edit Shift Assignment** changes an employee's permanent shift *from a
   stated date*, appending to the dated history rather than overwriting it.
2. **A one-day shift request** lets an employee ask to work another, longer
   shift on one date; the approval chain decides it, and only the final
   approval makes it effective — for that date alone.
3. **The Attendance Approval Centre** is the one screen the three kinds of
   request are decided on.

---

## What already existed, and was reused

| Concept | Where it lives |
| --- | --- |
| Effective-dated permanent shift | `employee_work_shift_assignment`, resolved by `utils/shiftResolution.js#resolveAssignmentForDate` |
| One-date shift override | `attendance_date_shift_override`, resolved by `resolveOverrideForDate`, and it WINS that date |
| Requests and their chain | `attendance_approval_request` / `_step`, `utils/attendance_approval_chain.js` |
| Payroll lock | `utils/attendance_payroll_lock.js` + the `FOR UPDATE` guard in `repository/attendance_calculation.js` |
| Outlet scope | `middlewares/employee_branch_scope.js`, whose rule `repository/employee_scope.js#accessScope` states |
| Telegram | `services/telegram.js`, fanned out by `usecase/telegram_update_dispatcher.js` |

Nothing above was duplicated. The migration
(`20261029120000-shift-change-request`) creates **no table**: it extends five.

## The precedence rule, in full

```
APPROVED ONE-DATE OVERRIDE   beats   EFFECTIVE-DATED PERMANENT ASSIGNMENT
```

for **which shift a date is calculated under** — its expected in and out, its
lunch and break rules, its late and early-going flags, how many punches the day
should contain.

The permanent assignment still decides the **entitlement**:

```
base NRM  = the PERMANENT shift's NRM for that date
Regular   = MIN(worked, base NRM)
OT        = MAX(0, worked - base NRM)
Shortage  = MAX(0, base NRM - worked)
```

`attendance_day_calculation` therefore stores both NRMs. On every date without
an override they are the same number and nothing changes; the engine notices
the two shifts are one shift and takes no other path.

On an override day the late and early-going rules still **run and report** —
they are the temporary shift's and the approver needs to see them — but they do
not **charge**, because they would be measuring against hours the employee was
never entitled to. The day carries a note saying so.

## Only a longer shift may be requested

`requested NRM > base NRM`, enforced in `raiseShiftChangeRequest` and offered
by `shiftChangeOptions`. A shorter shift could not reduce what the employee is
owed — regular pay is measured against the base shift either way — so all it
could do is forgive a late arrival and an early finish. Shortening somebody's
hours is Edit Shift Assignment: dated, audited, and behind a management key.

## The payroll lock is asked three times

| When | Why it is not redundant |
| --- | --- |
| At submission | A date in a settled month could never be approved |
| At approval | The month can close while the request waits in the queue |
| At the write, under a row lock | **The one a race cannot get past** |

A **rejection** is allowed in a locked month: it changes no attendance and pays
nothing, and the alternative is a request nobody can ever close.

### The write-time boundary, precisely

Only the third row is the boundary. The first two hold no lock and a month can
close in the microseconds after either answers. The boundary is
`assertMonthsNotPayrollLocked` — exported from
`repository/attendance_calculation.js` and **shared**, never re-implemented —
called on the caller's own connection inside the caller's transaction, taking
`FOR UPDATE` on the same `payrun_employee_calculation` rows
`payrun_calculation.js#approveAndLock` locks. Both the attendance write and the
effective-dated shift change go through it, so a concurrent approve-and-lock
either commits first (and the write sees `APPROVED_LOCKED` and throws) or waits
behind it. There is no interleaving in which both succeed.

## The dates a shift change actually moves

An effective-dated row is open-ended forward **only until the next row that
already exists**. Inserting `15 Aug = C` into

```
01 Aug  A
01 Sep  B
```

moves **15–31 August and nothing else**, because every September date still
resolves through the September row. The lock check, the recalculation and the
message all use that interval (`affectedRangeForNewAssignment`), capped at
today. Treating it as "effective_from → today" would lock and recalculate a
September this change cannot touch — and a locked September would then refuse a
change that was never going to reach it.

## The current shift is resolved, never assumed

`new_employee.default_work_shift_id` is what every legacy and current-state
consumer reads, and it must agree with the dated history. After the insert, and
inside the same transaction, it is set to `resolveAssignmentForDate(history,
today)` — the same pure function the attendance engine uses. Writing the shift
that was just inserted is only correct when nothing later exists: inserting
`05 Sep = C` into a history that already says `15 Sep = B` leaves **B** current.

## Future effective dates are refused

The dated history would resolve them correctly. The column above would not:
**no job, no trigger and no scheduled reconciliation moves
`default_work_shift_id` on a date**, so a future-dated change would be right in
the history and wrong in the column from the day it took effect. Building a
scheduler was not in scope, so the feature refuses what it cannot honour —
`effective_from > today` is a validation error, the date input is capped at
today, and the change is filed on the day it takes effect or backdated
afterwards.

## A failed recalculation is a partial failure, not a save

The assignment commits in its own transaction; the recalculation runs after it.
If that fails, the history is correct and the attendance behind it is **stale** —
still carrying the old shift's NRM, shortage and overtime for dates that no
longer resolve to it, and payroll reads those rows. So the API answers:

| Code | Meaning |
| --- | --- |
| 200 | Saved, and the affected dates were recalculated |
| **207** | **SAVED, and the recalculation FAILED** — carries `recalculation_range` |
| 4xx | Nothing was written |

The screen shows 207 as a red *"Saved, but attendance was NOT recalculated"*
warning with a Retry button over the exact range. Nothing on that path claims
the attendance was recalculated.

## Telegram

Only the **first** approver is messaged, and that is a property of the wiring
rather than a rule to remember: `notifyFirstApprover` is called from one place,
the creation of a request, and `decide` holds no notifier at all. A **role**
chain names a stage and not a person, so nobody is messaged for one and the
request goes to the web queue.

Both buttons call the ordinary `decide`; the only difference reaching the
database is `attendance_approval_step.decision_source = 'TELEGRAM'`. The stale
button needs no new mechanism — `decideStage` updates `AND decision =
'PENDING'`, so the second tap affects no rows and is answered 409.

**Reject asks a question.** A reason is mandatory and a button cannot carry
one, so Reject force-replies and the approver's reply is the reason; the reply
finds its request through the `#id` in the message it replies to, not through
state held in the process.

## Permissions (all granted by migration to NOBODY)

| Key | What it reaches |
| --- | --- |
| `edit_shift_assignment_effective_dated` | The permanent, dated change |
| `raise_shift_change_request` | An employee's own one-day request |
| `approve_shift_change_request` | The decision endpoint — not the authority to decide a stage, which is the chain's |
| `view_shift_change_requests` | The Shift tab |

## Screens

- `/attendance/approval` — Attendance | OT | Shift, with outlet, employee and
  designation filters and "Pending with me" counted under those same filters.
- `/attendance/ot-approval` — a redirect into the OT tab. Not a second queue.
- `/attendance/my` — "Request a shift change".
- `/employee-shift-assignment` — Edit / History per employee.

## Tests

`usecase/shift_assignment_and_one_day_requests.test.js` is the matrix: the
mid-month change, the retroactive one, the locked-month refusals at submit,
approve and recalculate, the approved override and its break rules, the base
NRM behind Regular, OT and shortage, the next day left alone, the first
approver's Telegram and the later approver's silence, the stale button, the
outlet scope failing closed, and the unified filters.
