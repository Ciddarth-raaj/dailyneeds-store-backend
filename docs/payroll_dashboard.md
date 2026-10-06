# Payroll Dashboard — design and data contract

A read-only dashboard over the payroll month that already exists. It calculates
nothing: every count, status and figure comes from the two usecases the Payrun
screens already use, so the dashboard and Calculation & Review cannot disagree.

## 1. What already exists (inspection findings)

| Question | Answer in DnDS today |
|---|---|
| Payroll population of a month | `PayrunUsecase.getMonth` → `repository/payrun.js#listPopulation` (dated rule: joined ≤ month end, resignation ≥ month start; `status` deliberately not read) |
| Initialized | a `payrun_employee` row exists (the month's snapshot). Not initialized = population row with `status` READY or BLOCKED |
| Calculated / review status | `PayrunCalculationUsecase.getMonth` derives `CALC_STATUS` live (NOT_CALCULATED, ATTENDANCE_PENDING, CALCULATED, RECALCULATION_REQUIRED, READY_FOR_APPROVAL, APPROVED_LOCKED, PUBLISHED). Only CALCULATED / APPROVED_LOCKED are stored in `payrun_employee_calculation.status` |
| Money | `payrun_employee_calculation`: `total_earnings` (gross), `total_employee_deductions`, `net_pay`, `employee_pf`, `employee_esi`, `advance_recovery`, `shortage_recovery`, `missing_hours_deduction`. Deductions = missing hours + PF + ESI + advance + shortage |
| PT / Income tax (TDS) | **Not stored anywhere** (`constants/payroll_report_catalogue.js` says so). Shown as "Not tracked", never as ₹0 |
| Location / Department / Designation | initialized employees: the month's snapshot (`payrun_employee.store_id / department_id / designation_id`) — the same attribution Calculation & Review uses. Not initialized: the live Employee Master. There is no transfer history table |
| Employee type | `new_employee.employment_type` (Permanent / Contract), live master only (not snapshotted) |
| Joined / Resigned / Rejoined | joined: joining date inside the month; resigned: `exited_in_month` from `utils/payrun_eligibility.js#exitedByMonthEnd` (the Exited card's rule); rejoined: an `employee_employment_period` with `period_no > 1` whose `joined_on` is in the month |
| Held / Pre-joining | **Not modelled** in payroll (`constants/payrun.js`: "There is no HOLD"). Not shown |
| Permissions | `requireAll(view_employees, view_payroll, view_salary)` — the Payrun / Calculation & Review conjunction |
| Scope | `middlewares/employee_branch_scope.js#listFilters` — admin / `employee_scope_all_branches` see all, everybody else their own branch, fail-closed |
| Blocking validations | Initialization `BLOCK_REASON` (SALARY_NOT_APPROVED, STATUTORY_SETUP_INCOMPLETE, …); approval `READY_BLOCKER` (ATTENDANCE_INCOMPLETE, PENDING_* , ADJUSTMENT_PENDING_CONFIRMATION, STATUTORY_SETUP_INCOMPLETE, CALCULATION_INCOMPLETE, …); `RECALC_REASON` |
| Negative net pay | no validation exists; the dashboard flags `net_pay < 0` from the stored figure (a fact, not a new rule) |

## 2. Backend

All under `/payroll/dashboard`, `requireAll(view_employees, view_payroll, view_salary)`,
branch-scoped with `listFilters(req, store_id)`: a `store_id` outside the caller's
branches is refused 403, never widened. `Cache-Control: no-store`.

Common query: `year`, `month`, optional `store_id`, `department_id`, `designation_id` (single ids; absent = All).

### `GET /payroll/dashboard/months?fy=2026` (+ filters)
One cheap aggregate over `payrun_employee ⟕ payrun_employee_calculation` for April `fy` … March `fy+1`.
```json
{ "code": 200, "fy": 2026, "label": "FY 2026-27",
  "months": [ { "year": 2026, "month": 4, "label": "APR '26", "status": "PUBLISHED",
                "initialized": 240, "calculated": 240, "approved": 240, "published": 240,
                "gross": "2907375.00" } ] }
```
`status`: FUTURE · NOT_STARTED · INITIALIZED · CALCULATING · APPROVED · PUBLISHED (derived from stored state only).

### `GET /payroll/dashboard/summary` (+ `compare_year`, `compare_month`)
```json
{ "code": 200,
  "period": { "year": 2026, "month": 8, "label": "August 2026", "month_locked": false },
  "filters": { "applied": {...}, "options": {
      "locations":    [{ "id": 1, "name": "Moolakulam", "count": 120 }],
      "departments":  [{ "id": 3, "name": "Billing", "count": 40 }],      // within chosen location
      "designations": [{ "id": 9, "name": "Cashier", "count": 12 }] } },  // within chosen location + department
  "kpis": { "total_employees": 241, "initialized": 240, "not_initialized": 1,
            "payroll_cost": "2907375.00", "total_deductions": "153751.00", "net_payable": "2753624.00",
            "costed_employees": 238, "uncosted_initialized": 2 },
  "headcount": { "location": [...], "department": [...], "designation": [...], "employment_type": [...] },
  "earnings": { "gross": "…", "net": "…", "deductions": "…",
                "breakdown": [ { "key": "PF", "label": "PF", "amount": "53020.00", "tracked": true },
                               { "key": "PT", "label": "Professional Tax", "amount": null, "tracked": false }, … ] },
  "comparison": { "base": {...}, "compare": {...},
                  "metrics": [ { "key": "GROSS", "label": "Gross Wages", "base": "…", "compare": "…", "difference": "…", "tracked": true } ] },
  "movement": [ { "key": "JOINED", "label": "New Joined", "count": 16, "payroll_cost": "…", "deductions": "…", "net_wages": "…" }, … ],
  "actions":  [ { "key": "ATTENDANCE_NEEDS_ACTION", "label": "…", "description": "…", "count": 3,
                  "severity": "high", "target": { "stage": "CALCULATION", "card": "ATTENDANCE_NEEDS_ACTION" } } ] }
```
Money figures count only employees whose calculation the review screen presents as a result
(calculated, attendance settled, net pay resolved) — the `attendanceDependent` rule in
`usecase/payrun_calculation.js#_present`. `uncosted_initialized` says how many are left out.

### `GET /payroll/dashboard/employees` (+ `metric`, `group_by`, `group_id`, `page`, `page_size`)
The drill-down, fetched only when opened, paginated (max 200).
`metric`: ALL · INITIALIZED · NOT_INITIALIZED · COSTED · DED_PF · DED_ESI · DED_ADVANCE · DED_OTHER ·
MOVE_JOINED · MOVE_REJOINED · MOVE_RESIGNED · HEADCOUNT (+ `group_by` location|department|designation|employment_type, `group_id`) ·
ACTION_<key>.
```json
{ "code": 200, "total": 1, "page": 1, "page_size": 50,
  "totals": { "gross": "…", "deductions": "…", "net": "…" },
  "rows": [ { "employee_id": 77, "employee_name": "…", "location": "…", "department": "…", "designation": "…",
              "initialized": false, "status_label": "Blocked", "reasons": ["Salary not approved"],
              "gross": null, "deductions": null, "net": null, "pf": null, "esi": null, "advance": null, "other": null } ] }
```

### Code
- `usecase/payrun_calculation.js#getMonthFigures` — `_assemble` + `_present` (unchanged) plus the stored figures, under the same presentation rule.
- `repository/payroll_dashboard.js` — the FY month aggregate, live employee facts (department name, employment type), rejoin periods.
- `utils/payroll_dashboard.js` — pure: merge, filters + dependent options, KPIs, head count, breakdown, comparison, movement, action items, drill-down selection.
- `usecase/payroll_dashboard.js`, `routes/payroll_dashboard.js`, wired in `server.js`.

## 3. Frontend
- `pages/payroll/dashboard.jsx`, menu entry *Payroll → Payroll Dashboard* (same three keys as Payrun).
- `components/payroll/dashboard/`: `DashboardFilterBar`, `MonthStrip`, `KpiCards`, `HeadCountPanel` (recharts bar, group-by select), `EarningsDeductionsPanel` (donut + breakdown tiles), `ComparisonPanel`, `PeopleMovementPanel`, `ActionRequiredPanel`, `DrilldownDrawer`.
- `helper/payrollDashboard.js`, `util/payrollDashboard.js` (CommonJS: FY months, compact ₹ L/Cr, payrun deep link).
- `pages/payroll/payrun.jsx` accepts `?year&month&stage&card&store_id&department_id&designation_id&search` so an action item / drill-down row opens Calculation & Review on exactly those employees.
