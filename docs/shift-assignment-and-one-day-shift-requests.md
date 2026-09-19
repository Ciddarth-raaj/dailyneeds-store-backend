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
| At the write, under a row lock | The one a race cannot get past |

A **rejection** is allowed in a locked month: it changes no attendance and pays
nothing, and the alternative is a request nobody can ever close.

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
