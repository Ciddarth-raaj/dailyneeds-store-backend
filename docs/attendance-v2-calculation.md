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

## 6. Routine OT queues itself

A recalculation that finds candidate OT on a complete, valid day with no request
against it now raises the OT request automatically, on the same role/outlet
chain. Nobody has to know to ask for overtime they have already worked.

* **Idempotent.** A date is checked against every existing PENDING, APPROVED or
  REJECTED request for it, so a retried recalculation creates nothing.
* **Safe when the overtime goes away.** If a later recalculation finds no
  candidate OT, an open request *the queue itself raised* is CANCELLED with its
  steps stamped SKIPPED — superseded auditably, never left as stale payable OT.
  A request a person raised, or one already decided, is never touched.
* A date with a **missing punch** is left to its single combined
  `REGULARIZATION_WITH_OT` request, which carries the OT the proposed punch
  creates.
* The queue runs **after** the calculation is stored and outside the approval
  transaction: creating an approval request makes nothing payable.

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
same calculation. Routine OT on the recalculated day queues itself afterwards,
as after any recalculation.

## Status mapping the screens use

| Backend | Screen |
|---|---|
| `REVIEW_REQUIRED` with `MISSING_PUNCH` | Missing Punch (with Regularize) |
| `REGULARIZATION_PENDING` | Regularization Pending |
| `OT_PENDING` | OT Approval Pending |
| `NO_SHIFT_FOR_DATE` | No Shift Assigned |
| `NO_SCHEDULE_ROW` | Shift Setup Issue |
| `ABSENT` | Absent |
| `FINAL` | no badge |

"Review Required" is never shown to staff. A punch whose `source` is
`REGULARIZED` is shown as *Missed Punch – Regularized*.
