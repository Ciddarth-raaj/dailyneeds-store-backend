# Attendance v2 — calculation, regularization and payroll consumption

Backend foundations for stages A0–A4 of the approved *Daily Needs — Attendance
& Payroll Handoff v2*. **No frontend screen is built or assumed**: what is here
is a stable set of backend outputs a future UI can consume, and every existing
attendance screen (Attendance List, Punch Audit, Biomax Devices, DigiSME
import) behaves exactly as it did.

## Where the rules live

| Concern | File | Pure? |
|---|---|---|
| Which shift applied on a date | `utils/shiftResolution.js` | yes |
| Worked minutes, breaks, shortage, candidate OT | `utils/attendance_engine.js` | yes |
| Who approves, in what order | `utils/attendance_approval_chain.js` | yes |
| The month, and the statutory base | `utils/attendance_payroll.js` | yes |
| Fetching and shaping | `usecase/attendance_calculation.js`, `usecase/attendance_regularization.js` | no |
| SQL | `repository/attendance_calculation.js`, `repository/attendance_regularization.js` | no |

Every rule that decides a number is a pure function with no database, no clock
and no timezone, which is why the whole of the business rule is testable as
arithmetic.

## A0 — per-date shift resolution

`employee_work_shift_assignment` is effective-dated and **append-only**. A date
resolves to the row with the greatest `effective_from <= attendance_date`, and
among equal dates the greatest id — so a mistake is corrected by appending,
never by editing the row that payroll already read.

`new_employee.default_work_shift_id` keeps its present meaning and its present
readers (the assignment screen, the Biomax receiver's ingest-time dating). The
HR assignment flow, its permissions and its response are unchanged; the only
difference is that assigning now also **appends** a history row, effective from
the date the assignment is made.

### The backfill boundary, stated explicitly

* One row per employee who already has a `default_work_shift_id`, dated
  **2026-09-01** — the Attendance v2 cutover, and the earliest date any punch in
  this system can belong to.
* **Nothing is invented before that date.** No shift history exists in this
  database for July or August, so a pre-cutover date resolves to
  `NO_SHIFT_FOR_DATE` and the engine reports it rather than producing a number.
* Employees with no current work shift get no row at all: *unassigned* is a real
  answer and stays distinguishable from *assigned to something we guessed*.

A date's calculation stores a **snapshot** of the schedule and OT configuration
it consumed, plus a 32-character hash of it. A recomputation that comes out
differently can therefore be traced to the configuration change that caused it.

## A1 — the calculation engine

* **Pairing** is chronological and positional: 1st IN, 2nd OUT, 3rd IN, 4th OUT.
  The device's `io_mode` is not read — the Part 1 schema already documents it as
  *not* a direction flag.
* **Attendance date**: a punch after midnight but before the previous working
  day's Attendance Day Cutoff belongs to the previous date. A 10:00–22:00
  employee finishing at 00:30 stays on the shift date.
* **NRM** = shift span − allowed break. Exact integer minutes throughout; there
  is no 15- or 30-minute attendance rounding anywhere.
* **Two-punch day**: `break_deducted = max(0, min(allowed_break, span − 360))`,
  `worked = span − break_deducted`. Credited minutes never fall as the span
  grows (asserted minute-by-minute in the test matrix).
* **Four or more punches**: every OUT → next IN gap is summed and charged. No gap
  is labelled "the lunch one". The old separate 15-minute extra-break allowance
  does not exist.
* **Two-punch OT guard**: OT on a two-punch day is limited to time worked beyond
  the shift span, because an unused break has no OUT/IN evidence. Asserted
  exhaustively over every finish minute up to the rostered end.
* **Odd punch count** → `REVIEW_REQUIRED` / `MISSING_PUNCH`, not final. Raw
  punches are preserved unchanged.
* **Presence** is binary: present at all (even ten minutes) is
  `attendance_day_count = 1`; the shortfall is minute-based and separate. No
  Full Day / Half Day / Quarter Day classification exists in payroll logic, and
  the legacy `missed_clock_in_treatment` column is preserved but not read.
* **Late and early minutes are reported, never charged.** The shortage already
  is the deduction; a second monetary penalty would deduct the same minute
  twice.
* **Employee break override** replaces the shift break (it does not add to it)
  and therefore changes NRM.

## A2 — the test matrix

`utils/attendance_engine.test.js` carries all sixteen required cases, numbered
in the test titles. Cases 9, 11 and 12 (midnight overrun, historical shift
resolution, cross-device aggregation) reach into `attendanceDateForPunch` and
the A0 resolver alongside the engine.

## A3 — regularization and OT approval

* **Only a missing punch may be regularized.** A request is refused for a date
  whose effective punch count is already even, and there is no field anywhere on
  this path for the id of an existing punch — an existing Biomax punch cannot be
  edited because this feature cannot name one.
* The approved manual punch is a row in `attendance_regularized_punch`, marked
  `REGULARIZED` so a future display can say *Missed Punch – Regularized*. It
  becomes part of the effective punch list only when its request is `APPROVED`;
  the calculation's own query joins on that status.
* **One date, one request, one pass.** A date with both a missing punch and
  resulting OT raises one `REGULARIZATION_WITH_OT` request; the final approval
  approves both. OT with no missing punch walks the same chain — approval is
  after the work, never before it.
* **Chains**: store employee → own Store Manager → Operations Manager → HR;
  manager → Operations Manager → HR; head → Admin. A Store Manager's own request
  follows the Manager chain by construction, so the first approver is somebody
  else rather than themselves-with-a-check. Nobody approves their own request,
  administrators included.
* **Audit**: every stage is written `PENDING` when the request is created, so the
  whole chain is visible while it is still open, and stamped once with its
  decider, timestamp, remarks and whether it was an administrator override.
* Writes are transactional and guarded on the state they expect, so two
  approvers clicking at the same instant cannot both succeed.

### Designation → role mapping, and the conservative default

`attendance_approval_role` maps a designation to an approver role and a
requester class. The migration seeds **only** `HR EXECUTIVE`, the one
designation name this codebase already relies on; Store Manager, Operations
Manager and Head are not guessed from designation text, because which
designations those are is a business fact nobody has recorded.

Until an administrator maps them:

* An unmapped designation's **own requests** follow `STORE_EMPLOYEE`, the
  longest and strictest chain — an unmapped designation can never get an easier
  path than a mapped one.
* An unmapped designation holds **no approver role at all**. Authority is
  granted, never defaulted. Those stages are decidable only by an administrator,
  visibly, as a recorded override.

## A4 — monthly payroll consumption

```
available_dates = dates in the month the employee could have worked,
                  bounded by joining date and last working date
notional_offs   = floor(available_dates / 7)
base_days       = available_dates - notional_offs
salary_days     = min(attended_days, base_days)
extra_days      = max(attended_days - base_days, 0)

daily_rate      = Monthly Gross / 26
per-minute rate = daily_rate / THAT DATE'S NRM minutes
```

* Total attendance pay is `attended_days × daily_rate` either way; the split
  only decides how much of it is the statutory base.
* The missing-hour deduction is separate and minute-based. A day is never
  downgraded to a half.
* OT base hourly rate is `(Gross/26) / NRM hours`, calculated in minutes, times
  the Work Shift's weekday OT rate. **Only finally approved OT enters payroll.**
* Extra-day pay and approved OT can both apply on the same date and stay
  separate line items.

### The statutory handoff

`statutory_base_earnings` (= `salary_earnings`, the Salary Days line) is the
PF/ESI salary-day base. Extra-day earnings are excluded from it by
construction.

**No PF or ESI formula is recomputed here.** `utils/salary_engine.js` owns that
law and is untouched by this work. What A4 exposes is the wage base that engine
should be given for a period, named explicitly so the handoff is a field rather
than an inference. Wiring it into a filing run is a later task, and doing it
needs a decision this work deliberately did not take on its own: the existing
engine calculates PF/ESI from a *monthly* gross, whereas a salary-day base for a
part-attended month is a different number. That is flagged rather than silently
resolved.

### The Monthly Gross a month is priced on

The existing effective-dated resolver — the latest `APPROVED` `employee_salary`
row effective on or before the date — read **as of the last day of the period**.
A revision effective mid-month is a question v2 does not answer, so the month is
priced on one rate and the choice is stated here rather than buried.

## Data safety

* Raw `biomax_punch` rows are immutable. Nothing in this work INSERTs, UPDATEs or
  DELETEs them; the receiver remains their only writer.
* Recalculation is deterministic and idempotent: `attendance_day_calculation` is
  unique on `(employee_id, attendance_date)` and
  `attendance_monthly_payroll` on `(employee_id, period_year, period_month)`, so
  a retried run updates the same rows rather than adding more.
* A regularized punch is unique per request, so a retried approval cannot insert
  it twice.
* Only one **open** request may exist per employee and date, enforced by a
  generated column that is the date while `PENDING` and NULL afterwards — so a
  date can be regularized again after a rejection without ever having two live
  requests.

## Running the tests

```
cd dailyneeds-store-backend && IS_TEST=true node --test
```
