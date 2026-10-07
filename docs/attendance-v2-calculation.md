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
| Which **version** of that shift applied | `utils/shift_config_version.js` | yes |
| Worked minutes, breaks, shortage, candidate OT | `utils/attendance_engine.js` | yes |
| Who approves, in what order | `utils/attendance_approval_chain.js` | yes |
| The month's neutral wage components | `utils/attendance_payroll.js` | yes |
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
* **Missing Punch and OT are two requests** (finalized OT flow, see the last
  section). A regularization carries the proposed punch and the reason and
  corrects attendance only; the OT the corrected day earns is claimed by the
  employee separately, afterwards. `REGULARIZATION_WITH_OT` is no longer
  created; the enum value stays so historical rows read.
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
  only says how many attended days fell inside the month's base and how many
  fell beyond it. It is not a statutory determination — see below.
* The missing-hour deduction is separate and minute-based. A day is never
  downgraded to a half.
* OT base hourly rate is `(Gross/26) / NRM hours`, calculated in minutes, times
  the Work Shift's weekday OT rate. **Only finally approved OT enters payroll.**
* Extra-day pay and approved OT can both apply on the same date and stay
  separate line items.

### The statutory handoff — what Attendance does NOT decide

**Attendance exposes neutral wage components. It does not decide which of them
legally enter the PF or ESI base.**

| Field | What it is |
|---|---|
| `salary_day_earnings` | attended days inside the month's base × daily rate |
| `extra_day_earnings` | attended days beyond that base × daily rate |
| `approved_ot_earnings` | fully approved overtime only |
| `missing_minute_deduction` | the minute-based shortfall |

There is deliberately **no** `statutory_base_earnings` and no
`statutory_base_days`, on the response or in the database. An earlier draft
named the Salary Days line as the PF/ESI base and excluded Extra Days from it by
construction — which is a determination of law made inside an attendance
calculator. `utils/salary_engine.js` is the statutory authority, it is untouched
by this work, and **integrating these components into it is a separate,
separately reviewed step.**

Nothing here should be read as saying which components are PF- or ESI-bearing.
When that integration is designed it will also have to settle a question this
work does not: the existing engine calculates PF/ESI from a *monthly* gross,
whereas a salary-day base for a part-attended month is a different number.

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

---

# The review fixes

What follows is the second pass over the above, correcting the implementation
mismatches ChatGPT's review found. The A0–A4 structure and every behaviour that
still matched the approved v2 handoff are preserved.

## 1. Recalculation genuinely re-dates raw punches

The first implementation had `attendanceDateForPunch()` and tested it, but the
production path read `biomax_punch_derived.attendance_date` and grouped by that
stored value — so a "recalculation" could never actually correct a mis-dated
punch.

`repository/attendance_calculation.js#getRawPunchesByCalendarWindow` now filters
on `biomax_punch.punch_date`, the raw calendar date the device stamped, over a
window widened by **one day at the end and none at the start** (the cutoff rule
can only move a punch backwards). `usecase/attendance_calculation.js` then
derives each punch's attendance date itself, from the dated shift assignment and
that shift **version**'s own cutoff.

`biomax_punch_derived` is preserved untouched and the receiver keeps writing it;
its `attendance_date` is carried through the query as `ingest_attendance_date`
so ingest and recalculation can be compared rather than one silently overwriting
the other. A punch ingest could not date at all is now datable by the engine.

## 2. Work Shift configuration is effective-dated

A0 dated the employee → shift *assignment*. It did not date the *shift*, so
editing a break, a cutoff or an OT rule changed the live tables in place and the
next recalculation of a settled September date read October's configuration.

`work_shift_config_version` is an append-only, effective-dated JSON snapshot of
the whole definition of a shift — the master row's attendance/OT columns plus
all seven weekly rows. Resolution for a date now answers **both** halves:
which shift (the dated assignment) and which version of it.

* Saving a Work Shift writes the live tables **exactly as before** — screen,
  endpoint, response and every existing reader are unchanged — and additionally
  appends a version *when the content actually changed*, effective today. A typo
  fix in a shift name appends nothing.
* No prior version is ever updated or deleted.
* The migration **seeds** one version per existing shift at the v2 cutover
  (2026-09-01). Without that seed the fix would not hold: a September date with
  no version yet would fall back to the live tables and read the new edit.
* A stored `attendance_day_calculation` row records
  `work_shift_config_version_id`, so a historical recalculation reproduces the
  same row rather than silently replacing the audit artifact with today's
  settings.

## 3. A missing-punch request carries the OT its proposed punch creates

An odd punch count leaves the engine *before* overtime is calculated, so asking
the incomplete day for its overtime always answered zero. A missing 00:30 OUT
that plainly earns two hours could therefore enter approval showing none.

`calculateProposedDay()` builds a **proposed effective punch list in memory**
(raw punches plus the proposed manual punch), runs the same engine over it, and
the request carries that day's candidate OT. Nothing is stored: the punch row
stays invisible to the calculation until the chain finishes, and the final
approval makes the punch and its OT effective in one pass.

Refused: a proposed punch that does not resolve to the requested attendance date
under the historical cutoff, and one that leaves the punch set still odd.

## 4. A final decision and its recalculated day commit together

The approval used to commit and *then* recalculate. If the recalculation failed,
a request could be APPROVED — its OT payable — against a stored day still
showing the punches as they were.

`decide()` now computes the corrected day **before** opening the transaction
and hands the rows to `decideStage`, which writes them on its own connection
inside the same transaction via `writeCalculationsOnConnection`. A storage
failure rolls the decision back with it. `finalization_state` records the
invariant in the data: it reaches `SETTLED` in the same commit as `APPROVED` or
`REJECTED`, so a row that is APPROVED but not SETTLED cannot exist.

Intermediate stages remain ordinary audit writes and settle nothing.

## 5. Every Shift Management OT rule is consumed

The snapshot and the engine now read the whole finalized rule set:
`overtime_allowed`, `overtime_minimum_minutes`,
`overtime_minimum_threshold_only`, `overtime_rounding_method`,
`overtime_rounding_interval_minutes`, `maximum_ot_minutes_per_day`, the four
`pre_shift_overtime_*` columns, `late_offset_against_overtime`,
`early_exit_offset_against_overtime`, and the weekday `ot_rate`.

```
split the earned surplus into its pre-shift and post-shift parts
  -> apply the offsets (post-shift first, then pre-shift)
  -> apply each side's own minimum and rounding
  -> add them
  -> apply the per-day cap to the TOTAL
```

* **Pre-shift time is not overtime by default.** With
  `pre_shift_overtime_allowed` off it is excluded from the candidate entirely,
  rather than falling through into the post-shift figure.
* The pre-shift minimum is a **qualifying threshold only** — Shift Management has
  no `..._threshold_only` column for it, and reading it as a floor would pay for
  minutes nobody worked.
* "Post-shift" means *the rest of it*: time after the out-time plus, on a
  four-or-more-punch day, the minutes of an unused break. Those are ordinary
  overtime and take the ordinary rules.
* The offsets subtract from **overtime only**, never below zero, and create no
  second wage deduction. The old Full/Half/Quarter Day payroll rules and the
  monetary late/early deductions are **not** revived.

## 6. Routine OT does NOT queue itself (superseded)

The first review pass had a recalculation raise an OT approval request
automatically whenever it found candidate OT. **That behaviour is removed.**
Candidate OT is reported on the day as *OT Available* and the employee raises
the OT request with a reason — see *The finalized OT flow* at the end of this
document. `auto_created` is no longer used to create routine OT requests.

## 7. The break override is one current field

The product contract gives Employee Master one `Special Break Duration
Override`, nullable, with **no Effective From**. The first implementation built
an effective-dated `employee_break_override` table, inventing a second temporal
business rule the product does not have.

That table is gone. The field is
`new_employee.special_break_override_minutes` — the same shape
`default_work_shift_id` already uses — read as one current value for every date
the engine calculates. `NULL` means no override; `0` is the real setting "charge
this employee no break at all", and the two stay distinguishable. No
effective-date semantics exist on any path.

**It needs a complete punched sequence.** Four or more punches AND an even
number of them — 4, 6, 8 — the same precondition Extra Break Hours has, from
the same predicate. Until `CALCULATION_VERSION` 8 the override asked only for
`>= 4`, so a five- or seven-punch day was charged the employee's personal
break while the engine was simultaneously reporting it as `MISSING_PUNCH` with
provisional figures. Such a day is now calculated on the shift's own break:
`break_allowance_source` is `SHIFT`, `break_override_minutes_applied` is
`NULL`, and the missing-punch status, reason and note are exactly what they
have always been. Historical rows keep whatever they were stored with; only an
explicit, permitted recalculation produces a version-8 row.

## 7a. Extra Break Hours add to the day's allowance

`new_employee.extra_break_hours` (DECIMAL, hours) is an **Employee Master**
field — Employment Details, edited under the ordinary `employee_edit` right,
reported through the Employee Master field catalogue like any other column. It
is read the same way the override above is read: **one current value, no
Effective From**, for every date the engine calculates.

It does not replace the shift's break; it is added to whatever allowance the
day already resolved:

```
employeeAllowedBreak = resolvedAllowedBreak + extraBreakHours
effectiveNrm         = shiftSpan - employeeAllowedBreak
```

so a 12-hour shift with a 1-hour break and an extra 0.5 hour has a permitted
break of 1.5 hours and an effective NRM of 10.5 hours. The Shift Master is
never modified: this is an employee/date adjustment.

**It is credited only on a COMPLETE punched sequence of four or more** — 4, 6,
8 and so on — because every punched break is an OUT followed by an IN. An odd
count (5, 7 …) is a day with a punch missing: the engine returns
`MISSING_PUNCH` for it and its figures are provisional, so it is calculated on
the unextended allowance. **The override obeys the same rule** since
`CALCULATION_VERSION` 8 — both settings read one shared `completeSequence`
predicate, so they cannot drift apart again. A two-punch day ignores it completely and keeps the phased
break rule of §above unchanged; an odd-punch or absent day likewise. The actual
break charged is still the sum of the OUT → IN gaps, so only the minutes beyond
the combined allowance become a shortage, and an unused allowance feeds the
existing OT rules rather than a new one. `NULL` and `0` both mean "nothing
extra" and produce exactly today's numbers.

### The safety invariant

```
resolvedAllowedBreak + extraBreak < shiftSpan
```

A permitted break as long as the shift would leave NRM at zero, which
`utils/attendance_payroll.js` cannot price and `utils/payrun_calculation.js`
discards — so an Employee Master typo could otherwise turn a working day into
an unpayable one in silence. Where a configured Extra Break Hours would cause
that, the value is **not applied and not capped**: the date becomes a
`REVIEW_REQUIRED` day carrying `BREAK_EXCEEDS_SHIFT`, is **not final**, and so
has its shortage and its OT held out of payroll like any unsettled day. The
row keeps the day's own unextended allowance and NRM. The screens report it in
the existing **Shift Setup Issue** bucket.

The check is made against the DATE's resolved span rather than trusted to the
Employee Master's input validation alone, because a shift can be shortened long
after the hours were recorded. A span of zero is left alone: there is nothing
to exceed and the day already produces nothing.

## 7b. A read returns the stored history; only Recalculate replaces it

Every attendance screen used to RECALCULATE the date it was asked for, from
the punches and the employee's settings **as they are now**. That made a
stored row decorative: a month calculated with no Extra Break Hours showed a
different permitted break and a different NRM the moment somebody set the
field today, with nothing recalculated and no record that anything had
changed.

The read rule, in one place (`utils/attendance_stored_read.js`):

| | |
|---|---|
| stored row exists **and** the date has closed | `STORED` - the row, reproduced field for field |
| open / today, or no stored row | `LIVE_PREVIEW` - the engine's answer, labelled |

"Closed" is `isDayClosed` from `utils/attendance_dashboard.js` - the same
boundary the dashboard already gated its verdicts on, not a second one. Every
day carries `calculation_source` so a caller can tell a settled figure from a
projection, and it is a property of the RESPONSE, not a stored column.

Applied by `/attendance/calculated` (with `?preview=true` for the engine's
answer), `/attendance/me`, the monthly read, and the Attendance Dashboard -
which reads the same rows in one batched query and resolves them through the
same module, so the two screens cannot disagree about one date.

**Reads write nothing.** A date that has drifted is corrected by somebody
running Recalculate, which is also the only thing that replaces a stored row:
it calculates from punches, dated shift configuration and the employee's
current settings and persists the result.

## 7c. A payroll-locked month cannot be touched

`payrun_employee_calculation.status = 'APPROVED_LOCKED'` is the one
authoritative lock, and nothing here defines a second one. Locking the payrun
froze the PAY; it did not freeze the attendance rows the pay was computed
from, so a recalculation could rewrite the NRM, the shortage and the approved
OT behind an approved month.

The gate is in `repository/attendance_calculation.js`, on the caller's
connection, inside the caller's transaction, in front of both statements that
can modify persisted attendance - `writeCalculationsOnConnection` and the
reconciling DELETE - so every path reaches it: single recalculation, bulk
recalculation, monthly `persist=true`, the single-date shift correction, and
the A3 approval that rewrites a day inside its own transaction. A locked month
raises a `ValidationError` with `code: PAYROLL_MONTH_LOCKED` (a 422 naming the
month), writes nothing, and rolls back.

**It takes the row lock, it does not merely look.** A read that only searched
for an already-locked row left a window: attendance checks and finds nothing,
payrun approval locks the row and sets `APPROVED_LOCKED`, attendance writes -
and attendance has been modified after payroll was locked. So the gate locks
the same rows `payrun_calculation.js#approveAndLock` locks, the same way:

```sql
SELECT employee_id, period_year, period_month, status
  FROM payrun_employee_calculation
 WHERE period_year = ? AND period_month = ? AND employee_id IN (?)
 FOR UPDATE
```

The status is **not** in the predicate - `WHERE status = 'APPROVED_LOCKED' FOR
UPDATE` would lock only rows that are already locked, leaving a `CALCULATED`
row free to be approved underneath the write. The row is located by identity,
locked, and its status inspected afterwards in application code; the lock is
held until the attendance transaction commits or rolls back, so the two
transactions serialize on one key.

Scope is exactly the `(employee, year, month)` combinations the write touches:
one statement per period naming only that period's employees, visited in a
fixed order so overlapping attendance writes cannot deadlock. Another month,
or another employee, is never locked. An employee/month with no
`payrun_employee_calculation` row has nothing that could be approved, so
attendance proceeds.

### The other ordering: an approval may not be granted against moved attendance

The row lock settles one direction - approval first, attendance refused. The
other needs the approval to look again. `_assemble`/`_present` decide readiness
BEFORE the approval's transaction opens, and `calculation_hash` only says
whether the PAYRUN row was recalculated, which an attendance write never
touches. So:

1. the usecase assembles and finds the employee READY;
2. an attendance write takes the payrun row `FOR UPDATE`, rewrites attendance,
   commits;
3. the approval wakes, takes the row lock, finds the hash unchanged;
4. without a re-read it would approve stale figures.

`repository/payrun_calculation.js#approve` therefore re-reads the **attendance
sources** on its own connection, inside its own transaction, AFTER the row lock
and before the status changes, and compares them with the markers the stored
calculation carries -
`utils/payrun_calculation.js#attendanceSourceChanges` over
`ATTENDANCE_SOURCE_KEYS`, a named subset of the existing `SOURCE_KEYS`, not a
second definition of freshness. A mismatch is the `SOURCE_MOVED` outcome,
reported as BLOCKED with "recalculate this employee for the month, then
approve". Nothing is approved, and no audit row is written.

### One month, one transaction

`calculateMonth(persist=true)` writes the day rows and the monthly roll-up
under one lock in one transaction:

```
BEGIN
SELECT payrun_employee_calculation ... FOR UPDATE   (the one gate)
INSERT ... attendance_day_calculation               (the days)
INSERT ... attendance_monthly_payroll               (the month)
COMMIT
```

They were two calls, which left an approval able to land between them and a
failed monthly write able to leave a month whose halves disagreed. The lock
covers the employee/month explicitly as well as every date the day rows touch,
so a month with no day rows is still gated. There is no public
`saveMonthlyPayroll` any more: the only writer of `attendance_monthly_payroll`
is private to the guarded month save.

## 7d. What a stored row now records about the two break settings

`break_allowance_minutes` is a total, and with both employee settings in play
it cannot be split back into them - neither setting has any change history, so
once somebody edits one, a historical date could no longer explain its own
NRM. Two columns record what was APPLIED:

* `break_override_minutes_applied` - the override that replaced the shift
  break, or `NULL` if none was applied (an applied `0` is a real setting and
  is not `NULL`)
* `extra_break_minutes_applied` - the Extra Break Hours added, in minutes;
  `0` on every day that did not credit them

Rows written before those columns existed keep `NULL` in both. There is no
backfill: what an old calculation applied cannot be proven after the fact, and
a guess dressed as provenance is worse than a blank.

## 8. Neutral wage components — see *The statutory handoff* above.

## 9. Permission grants

| Key | Granted by migration to |
|---|---|
| `view_calculated_attendance` | HR EXECUTIVE |
| `view_attendance_payroll` | **nobody** |
| `recalculate_attendance` | **nobody** |
| `manage_employee_break_override` | **nobody** |
| `correct_employee_shift_assignment` | **nobody** |

Seeing how long a colleague worked is an attendance question and stays with HR.
What those minutes are *worth* is a payroll report, assigned deliberately per
designation on the existing rights screen. `recalculate_attendance` is withheld
for a different reason: re-running the engine rewrites the rows payroll reads,
so it is a write dressed as a refresh.

## The shift-assignment correction path

The ordinary assignment route dates every change **today** and has no field for
any other date — moving somebody to a new shift must not rewrite yesterday. But
the append-only resolver explicitly supports a same-date correction, and a
genuine historical mistake has to be fixable by an authorized person.

`POST /work-shift-assignments/correction` is that path, and nothing else is:

* its own key, `correct_employee_shift_assignment`, granted to nobody;
* an **explicit** `effective_from` with no default and no "today" fallback, so
  nothing can be backdated by accident, and no future date;
* a mandatory note, stored on the appended row;
* `source = 'CORRECTION'`, distinguishable forever after;
* one employee at a time — a bulk backdate is not a correction;
* `default_work_shift_id` is **not** touched;
* affected dates are **not** recalculated as a side effect; that is a separate
  deliberate act by somebody holding `recalculate_attendance`.

An inactive shift is accepted here and refused on the ordinary route: a
correction records what was true then.

**No frontend field is added.** This is the safe backend path the append-only
resolver has always implied, made explicit and audited.

## Tests added for the review fixes

| File | Covers |
|---|---|
| `usecase/attendance_v2_review_fixes.test.js` | fixes 1, 2, 3, 4, 6, 7 through the **real** usecases wired as `server.js` wires them |
| `utils/attendance_overtime_rules.test.js` | fix 5 — every OT rule, in its on and off positions |
| `utils/shift_config_version.test.js` | fix 2 — version documents, fingerprints and date resolution |
| `migrations/attendance_v2_migrations.test.js` | fixes 2, 5, 7, 8, 9 — schema and grants |
| `usecase/employee_work_shift.test.js` | the correction path |

---

# The first frontend screens, and what they needed from the backend

Three screens now consume the above - My Attendance, the Attendance Day
Detail and the Missing Punch Regularization form - plus the single-date Edit
Shift action for authorized users. The backend additions are deliberately
small.

## Self-only attendance read: `GET /attendance/me`

Query `from_date`, `to_date`. The employee is `req.decoded.employee_id` and
nothing else: the schema has no employee field and Joi refuses unknown keys, so
`?employee_id=` is a 400, never a way to read a colleague. No permission key is
needed - reading your own month is not `view_calculated_attendance` - but an
employee identity is, so a system account is refused. It is the same preview
path as `GET /attendance/calculated`: it stores nothing and queues nothing.
The HR read of another employee stays behind `view_calculated_attendance`.

## Self-only regularization: `POST /attendance/me/regularization`

Body `attendance_date`, `punch_time`, `reason`. Raised for and by the caller;
`requested_for_employee_id` is refused, and there is still no field anywhere
that names an existing punch. Every rule of `raiseRequest` applies unchanged:
odd punch count only, the proposed time must land on the date under the
historical cutoff, one open request per date, and any OT the corrected day
creates rides the same request.

## Single-date Edit Shift: `POST /attendance/calculated/date-shift`

Body `employee_id`, `attendance_date`, `work_shift_id`; key
`edit_attendance_date_shift`, granted to nobody by migration. The dropdown's
options come from `GET /attendance/calculated/date-shift/options`, same key.

`attendance_date_shift_override` is an append-only table of (employee, date,
shift, previous shift, changed by, created at). The resolver reads it for
exactly the attendance date being calculated and lets the newest row for that
date win over the dated assignment history - for that date only. The day
before and the day after resolve as they did, `default_work_shift_id` is not
read or written, and nothing is appended to `employee_work_shift_assignment`,
whose effective-from rows would have moved every later date as well. That is
why this is not the `/hr/work-shift-assignments/correction` path.

The day is calculated under the new shift first, and then the override row and
the recalculated day are written in one transaction, so the shift can never be
changed with stored attendance still showing the old one. A retry for a shift
the date already resolves to appends no second row and simply re-stores the
same calculation. Nothing is queued for approval: if the recalculated day now
earns overtime, it shows as *OT Available* for the employee to request.

## Status mapping the screens use

| Backend | Screen |
|---|---|
| `REVIEW_REQUIRED` with `MISSING_PUNCH` | Missing Punch (with Regularize) |
| `REGULARIZATION_PENDING` | Regularization Pending |
| `NO_SHIFT_FOR_DATE` | No Shift Assigned |
| `NO_SCHEDULE_ROW` | Shift Setup Issue |
| `ABSENT` | Absent |
| `FINAL` | no badge |

"Review Required" is never shown to staff. A punch whose `source` is
`REGULARIZED` is shown as *Missed Punch – Regularized*. `OT_PENDING` is no
longer produced by the engine (see below); the OT claim has its own state.

---

# Automatic pending OT (supersedes "the employee requests OT" below)

```
employee punches -> attendance engine calculates eligible OT
  -> PENDING OT approval (raised by the system) -> approver approves / rejects
     (DnDS or Telegram, same record) -> only APPROVED OT is paid
```

Employees no longer request OT. `POST /attendance/me/ot-request` and
`POST /telegram/attendance/ot-request` answer **410 `OT_REQUEST_NOT_REQUIRED`**
and create nothing. Historical OT requests are untouched.

**Where it happens.** `attendance_regularization#syncAutoOt`, called after
every committed write that stores a day: `recalculateRange` (manual, bulk, the
06:55 daily run, shift propagation, assignment edits, punch voids), a one-date
shift edit, a final decision that rewrote the day (regularization, shift
change, permission), an admin revoke, a device time correction and a direct
permission grant. It never runs inside the write and never fails it.

**The OT record is the existing one**: an `attendance_approval_request` row,
`request_type = OT`, `auto_created = 1`, the employee's ordinary approval
chain. Eligibility is exactly what `raiseOtRequest` used to accept from an
employee: a closed, complete, FINAL day; its *claimable* minutes
(`excess_ot_minutes` — on a shift-changed date only the part outside the
approved shift); not Present/Absent Only; inside employment.

| On the date | The sync |
|---|---|
| no OT record, eligible OT > 0 | creates it PENDING (audit `CREATED`) |
| PENDING, minutes changed | follows the engine (audit `MINUTES_CHANGED`); an **increase** is held once any stage has approved |
| PENDING **system** record, OT gone | withdraws it: CANCELLED, steps SKIPPED (audit `WITHDRAWN`) |
| PENDING record an employee raised, OT gone | left for an approver (approval is clamped to 0) |
| APPROVED / REJECTED / payroll-lock closure | never touched — an approval is clamped by the engine to the day's eligible OT on every recalculation, and payroll flags `APPROVED_OT_CHANGED` (the existing correction path) |

**Gates.** Nothing is *created* before the cutover date
(`attendance_ot_auto_pending_setting.auto_pending_from_date`, seeded by
migration 20261124120000 to the deploy date), older than the 45-day request
window, on an open day, or in a payroll-locked month (checked before, and again
under `FOR UPDATE` inside the insert). `enabled = 0` on that row is the kill
switch. The cutover and the window gate **creation only**: a record that
already exists (for example one the backfill raised before the cutover) is
still followed — its minutes updated or withdrawn — by later recalculations.
The backfill never moves the cutover; it passes its own per-employee start
date (`allow_creation_from`) on each call, so its historical window can never
widen ongoing automatic creation for anyone.

**Idempotent and race-safe.** One OT record per date; the open-request key
(`uq_aareq_open_per_employee_date`) refuses a second PENDING one, and the loser
of a race is reported as `duplicate_prevented`. Minute updates and withdrawals
are guarded `FOR UPDATE` on the exact state the sync saw; a decision that
commits first wins and the sync leaves the record alone.

**Decisions.** Unchanged: `decide`, from DnDS (`WEB`) or Telegram
(`TELEGRAM`, `usecase/attendance_ot_telegram.js`). `decide` now answers an
already-processed request with `409 already_decided` up front, and accepts an
optional `expected_ot_minutes` — a Telegram Approve button carries the minutes
it showed, so a figure that moved since the message was sent is refused
(`409 ot_minutes_changed`) and a fresh card is sent.

**Telegram.** A newly raised OT messages the employee's first approver when
their chain names a person (Attendance Approver Setup), exactly like a shift
request. Any approver can send `/ot` to the bot to list the pending OT they may
decide now, with Approve / Reject buttons. Reject asks for a reason by reply.

**Payroll.** Unchanged for an open month: only APPROVED + SETTLED OT is in
`approved_ot_minutes`. Pending OT is counted by `listPendingApprovals` and
blocks Approve & Lock as `PENDING_OT_APPROVAL` unless HR closes the employee's
attendance for payroll. OT decided after its month is locked is settled forward
as **Prior-Month OT** (below).

**Deploy backfill.** `scripts/attendance/ot-auto-pending-backfill.js` — preview
by default (read-only), `--apply` to write, through the same sync; approved and
rejected preserved; idempotent.

*"Previous 5 attendance days"*, not 5 calendar days. **Source of truth: the
persisted attendance days** — `attendance_day_calculation.attendance_day_count
> 0`, the same figure payroll counts as Salary Days. It counts effective
punches (approved regularized punches included) and excludes voided and
duplicate-ignored punches, which a raw punch-date list (the alternative
compared) would wrongly count. Per employee the window is their **5 most
recent attended dates** up to yesterday (at most 31 days back, `--lookback`),
and **every date** from the oldest of those to yesterday is evaluated — a
weekly off, holiday, leave or absence in between can never hide OT. Fewer than
5 attended dates (or dates never persisted): the whole lookback is evaluated.
The preview prints each employee's attended dates, the raw last-5 punch dates,
`sources_differ`, and `dates_evaluated`. The cutover is **not** moved: each
backfill call carries its own `allow_creation_from` (see Gates).

The preview reports: dates covered, employees checked, eligible OT days, already
approved / rejected / pending, new pending, pending whose minutes would change,
minutes added to the queue, eligible OT in payroll-locked months (not raised,
with minutes), and every employee whose new OT would have **no active approver**
(a named approver who has left, or a role stage nobody active holds).

**Telegram volume.** The backfill sends **no per-date cards**: each named first
approver gets one summary (*"12 OT approvals pending from previous days … send
/ot"*). Day-to-day OT raised by recalculation still sends one card per OT to
the first approver. `/ot` lists 10 at a time.

**Revoke.** Approved → Revoke → a new PENDING OT, and Rejected → Revoke → a new
PENDING OT, when the engine still finds eligible OT; none when it is zero. The
revoked record stays (CANCELLED, its steps and decision untouched) with its
revocation row; the new record's creation is logged `REVOKE_OT`.

## Prior-Month OT carry-forward (late approval after payroll lock)

OT still PENDING when its month is locked stays PENDING (nothing closes it).
It may then be **approved** or **rejected** — from DnDS or Telegram, on the
same record, through the same guarded `decide` — and the decision never
touches the locked month: no attendance summary, calculation, payslip or net
pay is rewritten. A late **approval** is paid forward, in the next eligible
open payroll, as a separate *Prior-Month OT* line. It does **not** use the
manual `ARREARS` adjustment.

**Two statuses, kept apart.** The request keeps its approval status
(`PENDING` → `APPROVED` / `REJECTED`). Settlement lives in its own table:

```
attendance_ot_late_settlement   (one row per OT request: UNIQUE attendance_approval_request_id)
  employee_id, attendance_date, source_year, source_month
  eligible_ot_minutes, approved_ot_minutes
  source_payrun_calculation_id, source_daily_rate, nrm_minutes, ot_hourly_rate, amount
  settlement_status  PENDING_SETTLEMENT -> INCLUDED -> SETTLED   (or CANCELLED)
  settlement_year, settlement_month, settlement_payrun_calculation_id
  approved_by, approved_at, included_at, settled_at, cancelled_at
attendance_ot_late_settlement_log   (every transition, actor, note)
payrun_employee_calculation.prior_month_ot_amount / prior_month_ot (JSON breakdown)
```

| Event | Settlement status |
|---|---|
| final approval while the source month is locked | row created `PENDING_SETTLEMENT`, priced |
| a later open month is calculated (save) | claimed `INCLUDED` for that month, under `FOR UPDATE`; a row already claimed elsewhere rolls the whole save back (`PRIOR_MONTH_OT_MOVED`) |
| that month is recalculated | stays `INCLUDED` for the same month (re-read, not re-claimed) |
| that month's calculation is reset | back to `PENDING_SETTLEMENT` |
| that month is Approved & Locked | `SETTLED` |
| that month is unlocked | back to `INCLUDED` |
| revoke | refused once `SETTLED` (`PRIOR_MONTH_OT_SETTLED`); otherwise `CANCELLED` |

The unique request key plus the claim-under-lock make paying the same OT twice
impossible; a later month never reads a row settled elsewhere. The day itself
shows the OT as approved but pays 0 minutes, and keeps paying 0 even if the
source month is later unlocked.

**Pricing — exactly normal OT's formula, on the source month's basis:**

```
daily_rate  = the locked source-month calculation's daily rate (monthly gross / 26)
hourly_rate = daily_rate / (nrm_minutes / 60)        nrm_minutes = that day's stored NRM
amount      = round((approved_ot_minutes / 60) * hourly_rate)   (in paise)
```

Priced once at approval (`utils/payrun_calculation#priceLateOt`, the same
`otAmountPaise` the monthly OT groups use) and stored; an unpriceable item
refuses the approval with a sentence rather than paying 0.

**Statutory treatment — the same as normal OT (DnDS payroll rule).**
Current-month OT and Prior-Month OT are earnings: both are added to total
earnings (gross) and net pay. Neither enters the ESI wage (the existing
ESI-applicable wage: eligible normal salary earnings) nor the PF, EPS or EDLI
wage, so neither changes any employee or employer ESI or PF contribution.
Example: ESI wage 18,500, current OT 1,250, Prior-Month OT 1,000 → earnings
include all 2,250; ESI is still charged on 18,500. There is no TDS or
professional-tax module.

**Payslip.** One line per source month, e.g.
`Prior-Month OT — Sep 2026: 180 min   ₹xxx.xx`, with the per-request detail
(date, minutes, rate, amount) under `attendance.prior_month_ot` in the
snapshot and in the calculation breakup. Payroll reports gain
`prior_month_ot_amount`.

**Messages.** A late approval answers, in DnDS (single and bulk) and Telegram:
*"Approved — will be settled in the next eligible payroll as Prior-Month OT"*.

---

# The finalized OT flow (historical: employee-requested OT)

```
system calculates OT -> employee requests OT with reason -> OT approval
  -> approved / rejected -> payroll lock closes all OT not requested or not
     finally approved
```

## Attendance state and OT claim state are separate

`attendance_day_calculation.status` describes the attendance: a complete valid
day is `FINAL` whether or not its overtime has been claimed. The engine no
longer produces `OT_PENDING` (the enum value remains for stored rows). Beside
every calculated day the usecase derives an **OT claim state** from the OT
request against that date:

| `ot_claim_state` | Meaning | Screen |
|---|---|---|
| `NONE` | no candidate OT, nothing requested | nothing |
| `AVAILABLE` | candidate OT > 0 on a FINAL day, not yet requested | OT Available: hh:mm + Request OT |
| `REQUEST_PENDING` | the employee requested it; chain not finished | OT Request Pending: hh:mm |
| `APPROVED` | finally approved; `approved_ot_minutes` is paid | OT Approved: hh:mm |
| `REJECTED` | an approver rejected it | OT Rejected |
| `CLOSED_AT_PAYROLL_LOCK` | closed by the payroll lock; `ot_closure_reason` says why | OT Rejected + the closure wording |

`approved_ot_minutes` is 0 until final OT approval and is never more than the
eligible OT: at final approval it is the lower of the figure claimed and the
engine's current candidate for the date.

## The employee requests OT: `POST /attendance/me/ot-request`

Body `attendance_date`, `reason`. Nothing else is accepted — `employee_id`,
`requested_for_employee_id`, `candidate_ot_minutes` and `approved_ot_minutes`
are refused by the schema. The employee is `req.decoded.employee_id`. The
usecase (`raiseOtRequest`) recalculates the date on the server and stores that
candidate; refuses a day with no candidate OT, an incomplete day, a future
date, a date older than 45 days, and a date that already carries an OT claim
in any state (one claim per date — a fresh claim after rejection is not a
policy this invents). The request is `request_type = OT`, `auto_created = 0`,
with the employee's reason and the ordinary approval chain. Approvers decide
it through the existing decision endpoint; nobody approves their own.

## Missing punch is attendance only

`raiseRequest` creates `REGULARIZATION` only, with `candidate_ot_minutes = 0`.
Final approval recalculates the date and reports `ot_now_available`; the
employee then sees *OT Available* and requests it.

## Payroll lock

There is no payroll lock action in this codebase yet. The domain rule is
implemented and exposed as `closeOtForPayrollLock({ employee_id, year, month })`
on the calculation (payroll) usecase, for the future lock action to call
inside its workflow:

| At lock | Result |
|---|---|
| OT available, never requested | a REJECTED OT record for the date, `closure_reason = NOT_REQUESTED_BEFORE_PAYROLL_LOCK` ("Rejected – Not Requested Before Payroll Lock") |
| OT request pending | REJECTED, `closure_reason = NOT_APPROVED_BEFORE_PAYROLL_LOCK`, steps SKIPPED |
| already rejected | unchanged |
| finally approved | unchanged, paid |

Afterwards no open OT request exists for the period and a closed date cannot
be claimed. Idempotent. Nothing marks candidate OT payable. Migration
`20260921120000` adds the nullable `closure_reason` column.

---

# Raw punch controls: the ten-minute duplicate rule and Void Punch

Two controls sit between the immutable raw punch tables and the engine. Both
are decided in one place - `utils/attendance_effective_punches.js` (pure) -
and applied in one place - `usecase/attendance_calculation.js`
`groupRawPunchesByAttendanceDate`, which every calculating path goes
through: the preview, a single-date recalculation, the bulk run, the
approval's assumed day and the proposed-punch pricing. Raw rows are never
written by either.

## Where the raw punches are

Every raw punch, whichever way it arrived, is a row of `biomax_punch` with a
globally unique `biomax_punch_id`; `ingest_source` says how it got there
(`LIVE`, `HISTORICAL_PULL` = a Biomax device, `DIGISME_IMPORT` = the Excel
import) and `biomax_punch_derived.employee_id` says whom ingest matched it
to. The engine's `source` is `BIOMAX` for the two device values and `IMPORT`
for the import. A REGULARIZED punch is a row of a different table
(`attendance_regularized_punch`) and joins the effective list only through
its APPROVED + SETTLED request, exactly as before.

## The order of exclusion

```
raw BIOMAX + IMPORT punches of the employee, ONE stream by absolute instant
  -> manually VOIDED punches are removed (attendance_punch_void)
  -> a punch <= 10 minutes after the LAST KEPT punch is IGNORED as a duplicate
  -> the kept punches are re-dated by the historical cutoff and grouped
  -> the APPROVED regularized punches join per date, untouched by the above
  -> chronological positional pairing (1st IN, 2nd OUT, ...) and calculation
```

* The comparison is against the last **kept** punch: 09:00 / 09:04 / 09:09 /
  09:11 keeps 09:00 and 09:11. Exactly ten minutes is a duplicate.
* The stream is ordered by the absolute instant, so 23:58 and 00:04 are six
  minutes apart whatever attendance date each lands on. To see the last kept
  punch before a range, the raw fetch now starts **one day before `from`**
  (and still one day after `to` for dating); nothing from that extra day is
  calculated or stored - the grouping drops it as it always did.
* Two punches at the same instant are ordered by id; the lower id is kept.
* A voided punch is out before the rule looks, so it can neither be kept nor
  hide a genuine punch: voiding 09:00 promotes the 09:04 it was hiding.
* A REGULARIZED punch never enters the rule.

An excluded punch counts for nothing - not the punch count, the pairing, NRM,
Worked, Shortage, candidate OT, Missing Punch or the status - and is carried
on the calculated day as `excluded_punches`, each with `effective_status`
(`IGNORED_DUPLICATE` with `duplicate_of_punch_id`, or `VOIDED` with the
void), so the Day Detail and the Punch Audit can show it. Every effective
punch carries `effective_status: USED`. `raw_punch_ids` on the stored row
lists every raw punch the engine looked at, counted or not.

Nothing is stored for an automatic suppression: it is derived on every read
and every calculation from the raw rows and the void rows, so it is
deterministic and needs no audit row of its own.

`CALCULATION_VERSION` is **2**. Historical dates can come out differently,
and nothing recalculates them on deploy: Recalculate Attendance applies the
rule to a chosen range.

## Void Punch

`POST /attendance/raw/punches/:id/void`, key `void_attendance_punch`,
granted by migration `20260924120000` to **nobody**. Body: `reason`
(mandatory, five characters or more, trimmed) and optionally `source`
(`BIOMAX` / `IMPORT`; `REGULARIZED` is refused). Everything else is refused
by the schema: the employee, the original time and the source come from the
punch the server reads, the actor from the session.

`attendance_punch_void` is one additive row per raw punch - `biomax_punch_id`
(UNIQUE, FK to `biomax_punch`), a snapshot of `punch_source`, `employee_id`,
`punch_io_time` and the engine-derived `attendance_date`, the `reason`,
`voided_by_employee_id` / `voided_by_user_id`, `voided_at`. There is no
un-void. Refused: a nonexistent punch (404), an unmatched punch, an already
voided punch, a source that does not match the punch, and - so that an
approver never finds the day changed under a request they are deciding - a
punch whose attendance date carries a **PENDING** regularization or OT
request:

> This attendance date has a pending Attendance/OT request. Decide or cancel
> it before voiding a raw punch.

Approved and rejected history is not rewritten (`findOpenRequest` sees
PENDING rows only, and the void repository never touches the approval
tables).

After the void is stored the date is recalculated through the existing
`recalculateRange`. The two are deliberately not one transaction: the void
is the audit record and survives a calculation failure, and the answer says
what happened - `recalculated: true`, or `recalculated: false` with the
error and a `msg` naming the date, which Recalculate Attendance repairs.

## What the screens show

* **Employee Attendance day detail** lists every punch of the day: used ones
  with their position and IN/OUT, excluded ones unpositioned, dimmed, with
  *Ignored – Duplicate within 10 min* or *Voided* (struck through, with the
  reason). *Void Punch* appears beside a raw BIOMAX/IMPORT punch for a caller
  holding the key, never on a REGULARIZED or already VOIDED punch.
* **Punch Audit** carries `effective_status` (`USED` / `IGNORED_DUPLICATE` /
  `VOIDED`, null for an unmatched punch), `punch_source`, and for a void its
  reason, who and when; the CSV gains *Punch ID, Source, Effective Status,
  Effective Reason, Void Reason, Voided By, Voided At*. The duplicate status
  is derived for the page by reading the matched employees' raw stream from
  the day before the range (`listPunchStreamForEmployees`). A holder of the
  key gets the Void action; `view_attendance_punch_audit` alone sees the
  status.

The DigiSME import and the Biomax receiver are unchanged: a raw punch within
ten minutes of another is still committed and still received, and the
calculation layer ignores it.

---

# Employee Attendance Calculation Type (Shift Based / Present/Absent Only)

An employee-level, **effective-dated** attendance policy. It is configured per
employee - never by designation, department or employee id in code - on
Employee Master -> Employment Details.

| Type | A date is |
|---|---|
| `SHIFT_BASED` (default) | calculated exactly as everything above describes. Unchanged. |
| `PRESENT_ABSENT_ONLY` | **Present** (`FINAL`, `attendance_day_count = 1`) with any attendance, **Absent** (`ABSENT`, final, count 0) with none. |

## Where it lives

| Concern | File |
|---|---|
| The one resolver (`getEmployeeAttendanceCalculationType`) | `utils/attendance_calculation_mode.js` (pure) |
| The engine branch | `utils/attendance_engine.js#calculatePresentAbsentOnlyDay` |
| History read for the engine | `repository/attendance_calculation.js#getAttendanceCalculationModeHistory`, `repository/attendance_dashboard.js#getAttendanceCalculationModeHistoryForEmployees` |
| The Employee Master write | `repository/employee_attendance_mode.js`, `usecase/employee_attendance_mode.js`, `routes/employee_master.js` |

## Effective dating

`employee_attendance_calculation_mode` is append-only, exactly like
`employee_work_shift_assignment`: a date resolves to the row with the greatest
`effective_from <= date`, ties broken by the greatest id, and **no row at all
is `SHIFT_BASED`**. Nothing is backfilled, so every existing employee stays
Shift Based until somebody states otherwise from a date. A later change never
reinterprets an earlier date, and a recalculation of September resolves
September's mode - never the employee's current one.

Both calculating paths - `usecase/attendance_calculation.js#buildContext`
(preview, stored recalculation, bulk run, approvals, voids, device time
correction, the month) and the batched `usecase/attendance_dashboard.js`
(dashboard, staffing, missing attendance) - load the history and ask the same
`modeResolver` per date. `attendance_day_calculation.attendance_calculation_mode`
records which mode produced each stored row (existing rows: `SHIFT_BASED`, the
column default, which is what calculated them).

## What "attendance exists" means

At least one **effective** punch dated to the attendance date: a raw
`biomax_punch` (BIOMAX or IMPORT, matched to the employee through
`biomax_punch_derived.employee_id`) that survives the manual void and the
ten-minute duplicate rule, or an approved and settled regularized punch - the
same canonical stream the shift engine pairs. Punch count, order and duration
decide nothing: one punch, an odd count, ten minutes, a late arrival or an
early exit are all Present. No raw-punch integrity rule is relaxed.

A Present/Absent Only date has no shift, so it claims no punch of the
following morning: its punches are dated by the calendar. A Shift Based
previous night keeps its cutoff, so the 00:30 end of the last shift-based
night stays on that night.

## What a Present/Absent Only day does NOT produce

No shift is resolved or recorded (`work_shift_id`, `shift_snapshot` NULL), so
there is no `NO_SHIFT_FOR_DATE` / `NO_SCHEDULE_ROW`, no `MISSING_PUNCH`, no
break / Extra Break Hours / `BREAK_EXCEEDS_SHIFT`, no NRM (stored 0), no late
or early minutes, no shortage, no candidate OT and no shift-authorised OT.
Approved OT is 0. The day closes at midnight.

The attendance exemption (`attendance_required = 0`) still takes precedence,
and the employment window still bounds every date. There is no Holiday,
Leave or Weekly-Off day status anywhere in this system; the month's notional
offs are applied by `utils/attendance_payroll.js` to Present/Absent Only months
exactly as to any other.

A pending missing-punch correction holds a day only while it has no
attendance (`REGULARIZATION_PENDING`); a Present day stays Present. New
missing-punch and OT requests are refused on such dates with a message naming
the mode.

## Payroll

Nothing special: `utils/attendance_payroll.js` prices a day from
`attendance_day_count`, `is_final`, `shortage_minutes` and
`approved_ot_minutes`, so a Present day is one complete attendance day with no
deduction. With no shortage and no OT on the day its NRM of 0 is never divided
by, and `listEffectiveNrm` simply leaves it out of the OT pricing groups.

## Changing the setting

`GET  /hr/employee/:employee_id/attendance-calculation-mode` - `view_employees` + branch scope.
`POST /hr/employee/:employee_id/attendance-calculation-mode` - `employee_edit` + branch scope,
the Employment Details save's own guards; body `{ calculation_mode, effective_from, note? }`,
nothing else. No new permission key.

The write appends a row inside a transaction that locks the employee and the
history and takes `assertMonthsNotPayrollLocked` on every month the row
changes (effective date up to the next later row, or today) - so a change
that would reach a payroll-locked month is refused, and there is no bypass.
A future effective date is allowed. **Nothing is recalculated by saving**
(the Extra Break Hours precedent): the response names the already-stored
range that needs Recalculate Attendance, which then goes through the ordinary
write gate.

## Present/Absent Only across the other attendance views

* **One-Day Shift Change is refused** on a Present/Absent Only date, whatever
  shift assignment still exists: `SHIFT_CHANGE_REASON.PRESENT_ABSENT_ONLY`
  in `utils/shift_change_eligibility.js#decidePreconditions`, checked first.
  The request path, the options dropdown, the eligibility probe and the Shift
  Change Eligibility report all read it from the same dated resolver
  (`attendanceCalculationModeFor` / the dashboard `modeFor`), so they refuse
  with one sentence: *Shift Change is not applicable because this employee
  uses Present/Absent Only attendance.*
* **Raw punch views.** The receiver keeps storing `NO_SHIFT` for a punch it
  cannot date; nothing about ingest changes. `usecase/attendance_raw.js`
  resolves each punch's date's mode (the ingest date, or the calendar date
  for an undated punch) and, on a Present/Absent Only date, shows
  *Attendance Mode: Present/Absent Only* instead of the no-shift fault: the
  Attendance List banner counts and the Punch Audit review queue / `NO_SHIFT`
  and `UNDATED` issue lists leave such punches out (a device problem still
  keeps a punch in review), the Punch Audit and its CSV show the mode, and
  the Attendance List shows the punches on their calendar date.
* **Missing Attendance / the 07:00 reminder / staffing** - a one-punch
  Present/Absent Only day is Present: it is excluded by
  `utils/attendance_missing.js` (`EXCLUSION.PRESENT_ABSENT_ONLY`), so neither
  the report nor the reminder chases it, and staffing does not list the
  employee as "still recorded IN with no active shift".
* **Employee Report**: `attendance_calculation_mode` ("Attendance
  Calculation Type", *Shift Based* / *Present/Absent Only*) is the history
  row in effect on today's IST date - a scheduled future change is not shown
  as active. The report has no as-of date; the join mirrors
  `resolveModeRowForDate` statement for statement (as the salary join mirrors
  `getCurrentSalary`) and a MariaDB test holds the two to the same answers.
* **Attendance List date = the engine's date.** `presentedAttendanceDate`
  (`utils/attendance_calculation_mode.js`) presents each raw punch under the
  date the engine would give it, from what ingest stored: a punch ingest
  dated to a Present/Absent Only date is shown on its CALENDAR date (the
  02:00 punch ingest moved back onto 01/10 by a shift cutoff is 02/10's); a
  Shift Based ingest date is kept, including the last shift-based night's
  after-midnight OUT at a transition; an undated punch is shown only on a
  Present/Absent Only calendar date. Whether the employee has, had or will
  have a shift plays no part. `listCalendarCandidates` reads the calendar
  window as well, so a punch that belongs inside the range is found although
  ingest dated it outside. The Punch Audit's Attendance Date and its
  `attendance_date` filter use the same presented date. Raw rows are unchanged.
* **Dashboard Present/Absent Only row** is grouped by each day's own
  `attendance_calculation_mode` and carries `attendance_mode`; clicking it
  opens `drilldown?bucket=TOTAL&attendance_mode=PRESENT_ABSENT_ONLY`, which
  filters the SAME population by that mode - so the count and the list agree,
  a Shift Based employee with no shift stays in the No Shift gap, and a
  Present/Absent Only employee with a shift is in the Present/Absent Only row.

## The joining date is the hard lower boundary

A date before `new_employee.date_of_joining` (parsed by
`utils/joining_date.js#JOINED_ON`) is **not an attendance day**. Regression:
employee 2284 joined 09-09-2026 and Employee Attendance showed 01-09..08-09
as *No Shift Assigned*; Process Attendance stored those dates as
`NO_SHIFT_FOR_DATE` rows and left the monthly summary held (`is_final = 0`)
until somebody closed it by hand.

**Why they were materialised.** `calculateRange` - behind the screen's read,
the month read and the month persist - calculated every date of the range with
no employment bound. Recalculate clamped its window to the joining date, but
`calculateMonth({ persist: true })` did not, and the A0 backfill dates shift
history from 2026-09-01, so a pre-joining date could even resolve a shift.

**The rule now, everywhere:**

| Where | Behaviour before the joining date |
|---|---|
| Engine (`utils/attendance_engine.js`) | `CALC_STATUS.NOT_JOINED`: settled, every minute and the day count 0, no shift, no review reason. Answered before everything else. |
| Read path (`calculateRange` / `readRange`) | Returns `NOT_JOINED` and ignores any stored row for the date. |
| Month persist (`calculateMonth`) | Never stores the date; deletes a stale row for it inside the payroll-locked transaction, before the summary is fingerprinted. |
| Any storage path | `upsertCalculationRows` drops a `NOT_JOINED` row - it is never materialised. |
| Monthly payroll (`computeMonthlyAttendancePayroll`) | Pre-joining days add nothing and are never held; `available_dates` starts on the joining date, so a mid-month joiner's month becomes final on its own. |
| Payrun NRM evidence (`listEffectiveNrm`) | Rows before the joining date are not read. |
| Recalculate | Unchanged: clamps to the joining date and reconciles pre-joining rows away. |
| Dashboard | Unchanged: `employedOn` per date; `NOT_JOINED` is never an issue. |
| Shift assignment | Edit Shift Assignment and history corrections refuse an `effective_from` before the joining date; a bulk assignment made ahead of the first day applies from the joining date; single-date Edit Shift is refused. |
| Requests | Correction, OT and one-day shift change requests are refused (Permission already was). |
| Frontend | Badge *Not Joined*, a dash in every figure, no Edit Shift / Permission action, and not counted in any summary card (All included). |

Existing stale rows are removed by the ordinary Process Attendance or
Recalculate of the affected month once this is deployed (a payroll-locked month
is refused, as for any attendance change). `scripts/hr/pre-joining-attendance-audit.sql`
lists them read-only beforehand.

## The last working date is the hard upper boundary

The mirror of the joining-date rule. Regression: employee 2284 joined
09-09-2026 with last working date 13-09-2026; 14-09..30-09 were shown and
stored as `ABSENT`, so the cards read All 22 / Present 3 / Absent 19 while
payroll had already bounded the month to 09-09..13-09.

**The source of the bound** is the one payroll uses for `available_to`:
`new_employee.resignation_date`, set by the resign action as the employment
period's `ended_on` and read **inclusively** (`availableDates`,
`utils/attendance_eligibility.js#resignationDateOf` / `employedOn`). There is
no separate last-working-date column.

**Why the dates were materialised.** As with the lower bound, `calculateRange`
(the read path and the month persist) had no upper employment bound, so a
rostered post-exit date with no punch became an `ABSENT` day. Recalculate and
the dashboard already used `employedOn` (both bounds).

| Where | Behaviour after the last working date |
|---|---|
| Engine | `CALC_STATUS.EXITED` - distinct from `NOT_JOINED`; settled, all zero, no shift, no review reason. |
| Read path | Returns `EXITED`; any stored row for the date is ignored. |
| Month persist | Never stores the date; deletes a stale row inside the payroll-locked transaction (`outside_employment_dates`). |
| Any storage path | `upsertCalculationRows` drops `EXITED` as it drops `NOT_JOINED`. |
| Monthly payroll | Post-exit days add nothing and are never held. |
| Stored summaries | `utils/attendance_month_effective.js` reads a summary whose held dates all fall outside `available_from`..`available_to` as final - no re-process needed. |
| Payrun NRM evidence | Rows after `resignation_date` are not read. |
| Shifts | Change / correction with `effective_from` after the last working date refused; bulk assign (effective today) refused for anybody whose employment already ended, naming them; single-date Edit Shift refused. Historical rows untouched. |
| Requests | Correction, OT, one-day shift change and Permission requests refused: "Attendance is not applicable after the employee's last working date." Existing requests untouched. Permission requests now check the joining date too. |
| Frontend | Badge *Exited*, a dash in every figure, no Edit Shift / Permission action, excluded from every card (All included). |
