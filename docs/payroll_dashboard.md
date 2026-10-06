# Payroll Dashboard — design, data contract and review findings

A read-only dashboard over the payroll month that already exists. It calculates
nothing: every count, status and figure comes from the two usecases the Payrun
screens already use, so the dashboard and Calculation & Review cannot disagree.

## 1. Where every number comes from

| Dashboard item | Source (existing code, reused) |
|---|---|
| Payroll population, Ready / Blocked, blocking reasons, `exited_in_month` | `PayrunUsecase.getMonth` (`repository/payrun.js#listPopulation`, `utils/payrun_eligibility.js`) |
| Initialized | a `payrun_employee` snapshot exists |
| Calculation status, blockers, recalculation reasons, attendance-needs-action, statutory hold | `PayrunCalculationUsecase._assemble` + `_present` — the code `getMonth` (Calculation & Review) runs |
| Gross / deductions / net / PF / ESI / advance / other / rounding | the **stored** `payrun_employee_calculation` row, via `PayrunCalculationUsecase.getMonthFigures` |
| Month strip | one aggregate over `payrun_employee ⟕ payrun_employee_calculation` (stored state only) |
| Scope | `middlewares/employee_branch_scope.js#listFilters`, fail-closed |
| Permissions | `requireAll(view_employees, view_payroll, view_salary)` — the Payrun conjunction |

`getMonthFigures` = `getMonth`'s rows (same `_assemble`/`_present`) + the stored figures,
**null while `attendance_pending`** — the same `provisional` rule the employee detail's
`breakup.final` applies — and null while the stored net pay is unresolved. It reads only;
it writes nothing. An employee whose figures are null is *initialized but not costed*.

## 2. Money formulas (stored fields, `utils/payrun_calculation.js#computeCalculation`)

```
Payroll Cost (Gross) = total_earnings
                     = salary_earnings + extra_day_amount + ot_amount + incentive + bonus + arrears
Total Deductions     = total_employee_deductions
                     = missing_hours_deduction + employee_pf + employee_esi + advance_recovery + shortage_recovery
Net Payable          = net_pay = round_to_rupee(Gross − Deductions)
Gross − Deductions + net_pay_rounding = Net Payable        (exact, to the paisa)
```

`Gross − Deductions = Net` is **not** always exact: net pay is paid in whole rupees and the
stored `net_pay_rounding` (< ₹0.50 per employee) closes the gap. The dashboard returns and
shows the rounding total.

Deduction breakdown: PF = `employee_pf`, ESI = `employee_esi`, Advance = `advance_recovery`,
Other = `shortage_recovery + missing_hours_deduction`. The four add up to Total Deductions.
**Employer contributions** (`employer_pf_total`, `employer_epf/eps`, `edli`, `pf_admin_charge`,
`employer_esi`) and CTC are **not** included anywhere — the payrun does not put them in
employee deductions either. `balance_advance` is informational and never deducted.

**PT and Income Tax / TDS**: DnDS stores no monthly figure for either. They are returned with
`tracked: false` and `amount: null` and shown as *Not tracked* in the breakdown and the
comparison; drill-down rows have no such column. Never ₹0.

## 3. Historical correctness (effective dates)

| Dimension | Initialized employee | Not-initialized employee |
|---|---|---|
| Location / Department / Designation | **historical** — the month's snapshot, as at initialization | **current** Employee Master |
| Employee Type | **current** master (not snapshotted) | current master |
| Joined / Resigned / Rejoined | employment-period history + dated master facts (see §4) | same |

What cannot be reconstructed today:
- There is **no transfer history table**. A not-initialized employee in a past month is
  attributed to their *current* location/department/designation. (In a completed month
  everybody is initialized, so this affects open/partial months only.)
- A snapshot records the dimensions **as at initialization**, not as at month start; a
  mid-month transfer before initialization shows the new location.
- Employee Type is always current.
- The payrun's own population rule (`listPopulation`) reads the master's *current-spell*
  dates; an employee who left in a month and has since **rejoined** has a later joining date
  and drops out of that month's population if they were never initialized for it. This is
  existing payrun behaviour, not the dashboard's, and initialized months are unaffected.

## 4. People Movement

- **Rejoined**: an `employee_employment_period` with `period_no > 1` whose `joined_on` is in
  the month. Reliable for every rejoin done through DnDS: `employee_master.rejoin` opens the
  period in the same transaction (or rolls back). Rejoins before the lifecycle backfill were
  never recorded as such and read as *New Joined*.
- **New Joined**: the first period opened in the month, or (no period history) the joining
  date is in the month; never also a rejoin.
- **Resigned / Exited**: the payrun's own `exited_in_month` OR any period that ended in the
  month — so an August exit stays an August exit after a later rejoin clears the master's
  `resignation_date`.
- Boundaries (tested): joined on the 1st ✓, resigned on the last day ✓, joined and resigned in
  the same month → both ✓, rejoined twice in a month → one rejoin ✓, a later (future-dated)
  join or exit is not this month's ✓.
- **Hold / Pre-joining**: not payroll statuses in DnDS (`constants/payrun.js`: "There is no
  HOLD"); not shown.

## 5. Action Required — each item is an existing rule

| Item | Rule (existing) | Opens |
|---|---|---|
| Not initialized | population row, not `INITIALIZED` (READY or BLOCKED) | Initialization · Ready (else Blocked) |
| Salary configuration issues | init blocker `SALARY_NOT_APPROVED` | Initialization · Blocked |
| PF / ESI configuration issues | init blocker `STATUTORY_SETUP_INCOMPLETE`, or calc `statutory_hold` / blocker `STATUTORY_SETUP_INCOMPLETE` | Calculation · All (Initialization · Blocked if none initialized) |
| Payroll attendance pending | calc row `attendance_needs_action` (the *Attendance Needs Action* card) | Calculation · Attendance Needs Action |
| Adjustments not confirmed | blocker `ADJUSTMENT_PENDING_CONFIRMATION` | Adjustments · Pending confirmation |
| Not calculated | status `NOT_CALCULATED` | Calculation · Not Calculated |
| Recalculation required | status `RECALCULATION_REQUIRED` | Calculation · Recalculation Required |
| Payroll calculation errors | blocker `CALCULATION_INCOMPLETE` or recalc reason `CALCULATION_FAILED` | Calculation · All |
| Negative net pay | stored `net_pay < 0` (direct check; no existing validation) | Calculation · All |
| Pending payroll verification | status `READY_FOR_APPROVAL` | Calculation · Ready for Approval |

No "unusual salary" item: there is no system-defined threshold. Every count equals its
drill-down (tested in the pure suite and on real MySQL).

## 6. Endpoints

All under `/payroll/dashboard`, `requireAll(view_employees, view_payroll, view_salary)`,
`Cache-Control: no-store`. The usecases always get the caller's **whole** scope; a
`store_id` filter must be inside it (else 403); a malformed id is 400 before anything is read.

- `GET /months?fy=2026[&store_id&department_id&designation_id]` — 12 months, stored progress, gross.
- `GET /summary?year&month[&filters][&compare_year&compare_month]` — KPIs (incl.
  `costed_employees`, `uncosted_initialized`, `net_pay_rounding`), headcount, earnings,
  comparison (default: previous month), movement, actions, dependent filter options.
- `GET /employees?year&month&metric[&group_by&group_id][&filters][&page&page_size≤200]` —
  metrics: `ALL INITIALIZED NOT_INITIALIZED COSTED UNCOSTED DED_PF DED_ESI DED_ADVANCE
  DED_OTHER MOVE_JOINED MOVE_REJOINED MOVE_RESIGNED HEADCOUNT ACTION_<key>`.

## 7. Validation on real MySQL

`repository/payroll_dashboard.mysql.test.js` (skipped unless `PAYROLL_DASHBOARD_TEST_MYSQL`
names a scratch DB on which **every** migration has been run). Run on MySQL 8.0.46 with all
328 migrations; utf8mb4_general_ci server default (the migrations mix `general_ci` /
`unicode_ci`; on MySQL 8's default `0900_ai_ci` some historical purchase migrations fail).
The production usecases initialize, calculate and approve the months; the dashboard is then
reconciled with independent SQL: completed month, partial month, not-started month,
joiner/leaver/rejoin, each filter and all three combined, comparison, month strip, empty scope,
branch scope, per-employee agreement with Calculation & Review's detail, every action count =
its drill-down.

Volume run (650 employees, 12 months of payrun rows): summary ≈ 0.5–0.7 s / 42 statements
(two months assembled: selected + comparison), month strip ≈ 15 ms / 1 statement, drill-down
page ≈ 0.3 s / 21 statements (re-assembles the month; no N+1). For comparison, Calculation &
Review's own month read ≈ 0.25–0.35 s / 13 statements. The month-strip query uses a range scan
on `idx_payrun_employee_month`; the calculation join uses `idx_payrun_calculation_payrun`;
the employment-period read uses `idx_period_joined`/`idx_period_ended`.
