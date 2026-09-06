# Payroll module — integration proposal

A proposal only. Nothing here is implemented.

Read [hr-schema.md](hr-schema.md) first — this document assumes it. The short
version of what it establishes:

- `new_employee` is the employee master, PK `employee_id` = Digisme's
  `EmployeeCode`, already the actor key on a dozen other tables.
- `outlets` is the one location master (`outlet_id`, referenced everywhere as
  `store_id`). `designation`, `department` and `shift_master` are the other
  masters.
- All four are **overwritten nightly at 07:00 from Digisme**.
- **There is no attendance data anywhere in the database.**
- `/salary` + `payment_det` is a name-keyed staff loan tracker, not payroll,
  and is unreachable from the navigation.

## Guiding constraints

1. **No new employee or location tables.** Payroll references
   `new_employee.employee_id` and `outlets.outlet_id` by foreign key and owns
   nothing about who a person is or where they work.
2. **The masters are a mirror, so payroll cannot depend on their current
   state.** A payslip must record what it was computed against.
3. **Attendance has to be imported before payroll can compute anything.**
4. **Money is `DECIMAL(12,2)`.** Never `FLOAT` — `outlets.opening_cash` is a
   `FLOAT` and that mistake should not spread.
5. **Follow the advance-request module.** `routes/advance_request.js`,
   `usecase/advance_request.js` and migration `20260903020000-lr-workflow-stage-4`
   are the current best pattern in this codebase: explicit status enum naming
   who the record is waiting on, permission middleware on every route, real
   HTTP status codes, and an activity table recording every transition.

---

## 1. The mirror problem

The 07:00 sync issues `INSERT … ON DUPLICATE KEY UPDATE` over
`new_employee`, rewriting `employee_name`, `designation_id`, `department_id`,
`store_id`, `shift_code`, `status` and `resignation_date` from Digisme. A
transfer between branches, a promotion or a termination lands silently
overnight.

Two rules follow.

**Payroll owns its own pay data.** `new_employee.salary` is a free-text
VARCHAR holding one figure with no history. It stays where it is for
backwards compatibility, but payroll must not compute from it. A new
effective-dated structure replaces it, and `new_employee.salary` becomes a
display-only legacy field (a later migration can backfill from it and stop
writing it). The same applies to `payment_det`.

**Every payslip snapshots its inputs.** `payroll_payslip` stores
`designation_id`, `department_id`, `store_id` *and* the three names as at the
moment of computation. A payslip reprinted a year later must show the branch
the person was actually paid against, not the branch they are in today. This
is the same reason `stock_holding_items_snapshot` denormalises the buyer name.

## 2. Attendance

Payroll cannot exist without it, and it is the piece with a real unknown in
it: **what Digisme exposes.** `services/synker.js` calls only
`GET /api/GetEmployeeDetails`. Digisme's gateway almost certainly offers an
attendance or muster endpoint, but that has to be confirmed against the vendor
before any of this is built. Everything below is designed so that the answer
changes the *importer*, not the schema.

Digisme stays the system of record for raw punches. This database holds a
**derived daily summary**, one row per employee per date — enough to compute a
payslip and to show a branch manager why someone was paid what, and no more.

New cron `payroll_attendance_sync`, registered through
`cronService.register` and wrapped in `apiSyncLogger.wrapCron` exactly as
`employee_sync` is, so failures surface in the existing API sync log. It runs
after the employee sync (say 07:15, so the master is current), pulls a rolling
window (the current period plus the previous one, to catch backdated
regularisations), and upserts on `(employee_id, attendance_date)`.

Rows for a **locked** period are never overwritten by the importer — once a
period is locked, a late Digisme correction is reported, not applied. That is
what `payroll_attendance_import_conflict` records.

If Digisme turns out to have no usable attendance API, the same table is fed
by a spreadsheet import — the frontend already has `util/parseSpreadsheetFile.js`
and `util/fileImport.js`, used by the price-checker and offers uploads. The
`source` column exists so both paths can coexist and be told apart.

## 3. Schema

All new tables prefixed `payroll_`. Every employee reference is
`INT` → `new_employee(employee_id)`; every branch reference is
`INT` → `outlets(outlet_id)`.

### Pay structure

```
payroll_component
  component_id PK, code UNIQUE, name,
  type ENUM('earning','deduction','employer_contribution'),
  calculation ENUM('fixed','percent_of_basic','per_day','formula'),
  is_taxable, affects_pf, affects_esi, sort_order, status
```

Seeded with Basic, HRA, Conveyance, Special Allowance, PF (employee),
ESI (employee), Professional Tax, PF (employer), ESI (employer).

```
payroll_structure
  structure_id PK,
  employee_id FK new_employee, effective_from DATE, effective_to DATE NULL,
  gross_monthly DECIMAL(12,2), pay_basis ENUM('monthly','daily'),
  created_by FK new_employee, created_at, updated_at
  UNIQUE (employee_id, effective_from)

payroll_structure_line
  structure_line_id PK, structure_id FK, component_id FK,
  amount DECIMAL(12,2) NULL, percent DECIMAL(6,3) NULL
```

Effective dating gives arrears and increment history for free, and closes the
"changing pay destroys the old figure" hole. `effective_to IS NULL` is the
live row.

### Attendance

```
payroll_attendance_day
  attendance_id PK,
  employee_id FK new_employee, attendance_date DATE,
  status ENUM('present','absent','weekly_off','holiday','paid_leave',
              'unpaid_leave','half_day','on_duty'),
  payable_units DECIMAL(4,2) NOT NULL DEFAULT 0,   -- 1.00 / 0.50 / 0.00
  worked_minutes INT NULL, ot_minutes INT NULL, late_minutes INT NULL,
  shift_code VARCHAR(20) NULL,
  outlet_id FK outlets NULL,                        -- branch as at that date
  source ENUM('digisme','import','manual') NOT NULL,
  source_ref VARCHAR(100) NULL,
  remarks VARCHAR(255) NULL,
  created_by FK new_employee NULL, created_at, updated_at
  UNIQUE (employee_id, attendance_date)
  INDEX (attendance_date, outlet_id)

payroll_attendance_import_conflict
  conflict_id PK, employee_id, attendance_date,
  existing_status, incoming_status, period_id, detected_at, resolved_at NULL
```

`payable_units` is what the payslip actually multiplies. Keeping it as a
stored decimal rather than deriving it from `status` at run time means a
half-day rule change never silently restates a closed period.

`outlet_id` is captured per day so a mid-month transfer splits correctly for
branch-wise cost reporting.

### Period and payslip

```
payroll_period
  period_id PK, period_month DATE UNIQUE,        -- always the 1st
  status ENUM('open','locked','computed','pending_approval',
              'approved','paid','closed') NOT NULL DEFAULT 'open',
  locked_by, locked_at, approved_by, approved_at, closed_at
```

The statuses name who the period is waiting on, as the advance-request enum
does. `locked` freezes attendance; `computed` means payslips exist;
`approved` releases them for payout.

```
payroll_payslip
  payslip_id PK, period_id FK, employee_id FK new_employee,
  -- snapshot, because the masters move under us
  designation_id, department_id, store_id,
  designation_name, department_name, outlet_name,
  structure_id FK payroll_structure,
  payable_days DECIMAL(5,2), lop_days DECIMAL(5,2), paid_days DECIMAL(5,2),
  gross DECIMAL(12,2), total_deductions DECIMAL(12,2), net_payable DECIMAL(12,2),
  employer_cost DECIMAL(12,2),
  status ENUM('draft','on_hold','approved','paid'),
  computed_at, created_at, updated_at
  UNIQUE (period_id, employee_id)
  INDEX (period_id, store_id)

payroll_payslip_line
  payslip_line_id PK, payslip_id FK ON DELETE CASCADE,
  component_id FK, component_code, component_name,   -- snapshot too
  type, amount DECIMAL(12,2), note VARCHAR(255)
```

Recompute of an *open* period deletes and rewrites the payslip and its lines.
Recompute of a locked-or-later period is refused.

### Loans and advances — succeeding `payment_det`

```
payroll_loan
  loan_id PK, employee_id FK new_employee,
  loan_type ENUM('salary_advance','loan'),
  principal DECIMAL(12,2), installment_amount DECIMAL(12,2),
  installment_count INT, recovered_amount DECIMAL(12,2) DEFAULT 0,
  start_period_id FK payroll_period,
  status ENUM('requested','approved','rejected','active','closed','written_off'),
  reason VARCHAR(500),
  requested_by, approved_by, approved_at, created_at, updated_at

payroll_loan_installment
  installment_id PK, loan_id FK, period_id FK,
  amount DECIMAL(12,2), payslip_line_id FK NULL,
  status ENUM('scheduled','recovered','skipped')
  UNIQUE (loan_id, period_id)
```

This is `payment_det` done properly: keyed by `employee_id` instead of a name
string, with a real schedule and a recovery that lands as a deduction line on
the payslip. `payment_det` is left in place and read-only; if the team wants
the open balances carried over, a one-off migration can match on
`employee_name` — but that match is unreliable by construction, so it should
be reviewed by hand rather than run blind.

### Payout

The advance-request module already establishes the house pattern: the money
moves in Tally, and this system records the instruction and the advice.
Payroll follows it.

```
payroll_payout_batch
  batch_id PK, period_id FK, store_id FK outlets NULL,
  payment_mode ENUM('bank_transfer','cash','cheque'),
  bank_id FK people_list(person_id) NULL,
  value_date DATE, total_amount DECIMAL(12,2),
  status ENUM('draft','released','paid'),
  released_by, released_at, created_by, created_at

payroll_payout_item
  payout_item_id PK, batch_id FK, payslip_id FK,
  amount DECIMAL(12,2),
  account_no_snapshot VARCHAR(45), ifsc_snapshot VARCHAR(20),
  bank_name_snapshot VARCHAR(100),
  utr VARCHAR(100) NULL, paid_at NULL,
  status ENUM('pending','paid','failed'), failure_reason VARCHAR(255)
  UNIQUE (batch_id, payslip_id)
```

Bank details are snapshotted per payout because `new_employee.bank_name`,
`ifsc` and `account_no` are hand-edited free text with no validation — a
subsequent correction must not rewrite the history of what was actually
instructed.

`payroll_payout_batch.bank_id` points at `people_list` because that is what
`advance_requests.bank_id` already does.

### Audit

```
payroll_activity
  activity_id PK,
  entity ENUM('period','payslip','structure','loan','payout','attendance'),
  entity_id BIGINT, employee_id FK new_employee NULL,
  field VARCHAR(64), old_value VARCHAR(255), new_value VARCHAR(255),
  created_at
  INDEX (entity, entity_id, created_at)
```

Same shape and same reasoning as `advance_request_activity`: this is money, so
every transition is kept, not just the latest state.

## 4. What the module does *not* add

- No employee table. No location table. No second designation or department
  list. Payroll joins `new_employee`, `outlets`, `designation`, `department`
  and reads `shift_master` for shift timings.
- No general ledger. Payouts are recorded here; the accounting entry is made
  in Tally, as with supplier advances. `accounts` is the daily branch cash
  sheet and is left alone.
- No leave management, initially. `payroll_attendance_day` carries
  `paid_leave` / `unpaid_leave` as *outcomes* imported from Digisme. If leave
  application and balances are wanted in this system later, that is a separate
  module writing into the same day table.

## 5. API surface

One router mounted at `/payroll` in `server.js`, following the existing four
passes (`initRepositories` → `initUsecases` → `initRoutes` → `app.use`), and
built to the `routes/advance_request.js` conventions: Joi schemas per action,
`permissions.require(...)` on **every** route, real HTTP status codes, and a
`409` when a record has moved on between read and write.

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/payroll/periods` · `/periods/:id` | `view_payroll` |
| POST | `/payroll/periods` | `manage_payroll_period` |
| PATCH | `/payroll/periods/:id/lock` · `/compute` · `/approve` · `/close` | `manage_payroll_period` / `approve_payroll` |
| GET | `/payroll/attendance` (period, outlet, employee filters) | `view_payroll_attendance` |
| PATCH | `/payroll/attendance/:id` | `edit_payroll_attendance` |
| POST | `/payroll/attendance/sync` · `/import` | `sync_payroll_attendance` |
| GET | `/payroll/structures?employee_id=` · `/structures/:id` | `view_payroll_structure` |
| POST | `/payroll/structures` | `edit_payroll_structure` |
| GET | `/payroll/payslips` · `/payslips/:id` | `view_payroll` |
| GET | `/payroll/payslips/me` | authenticated, self only |
| PATCH | `/payroll/payslips/:id/hold` | `approve_payroll` |
| GET/POST | `/payroll/loans` · `/loans/:id` | `view_payroll_loan` / `add_payroll_loan` |
| PATCH | `/payroll/loans/:id/decision` | `approve_payroll_loan` |
| GET/POST | `/payroll/payouts` | `view_payroll_payout` / `manage_payroll_payout` |
| PATCH | `/payroll/payouts/:id/release` · `/items/:id/paid` | `manage_payroll_payout` |
| GET | `/payroll/reports/register` · `/reports/bank-advice` · `/reports/statutory` | `view_payroll_report` |
| GET | `/payroll/components` | `view_payroll` |

New keys go into `all_permissions` by migration and into
`constants/permissions.js` on the frontend under a new `payroll` group.

### Two things must change outside the module

**Nothing payroll adds may go in `unProtectedRoutes`.** That map in
`middlewares/auth.js` skips authentication entirely and currently lists every
`/employee`, `/salary`, `/designation`, `/outlet` and `/document` endpoint,
which is why salary figures, bank accounts, PAN and Aadhaar are served to
unauthenticated callers today. Payroll routes stay out of it, which also means
`middlewares/ip_restriction.js` actually applies to them.

**The existing HR routes should be removed from that map too.** Standing up a
payroll module on top of an unauthenticated employee master would leave the
back door wider than the front. This is a prerequisite, not a nice-to-have,
and it is a small change: the routes already work with a token, and
`helper/employee.js` already sends one.

**Branch scoping.** `req.decoded.store_id` is available and the app already
has an `all_stores` permission key. A branch manager should see their own
branch's payslips; only `all_stores` holders see every branch. The employee
list endpoint already accepts `store_ids[]` filters — the same convention
applies.

## 6. Frontend

Following the existing layout:

```
pages/payroll/index.jsx              periods list, status pipeline
pages/payroll/[period]/index.jsx     register for a period, branch-wise
pages/payroll/[period]/[id].jsx      one payslip
pages/payroll/attendance/index.jsx   day grid, editable while period is open
pages/payroll/structures/index.jsx   pay structure per employee
pages/payroll/loans/index.jsx        replaces pages/salary
pages/payroll/payouts/index.jsx      batches and bank advice
helper/payroll.js
customHooks/usePayrollPeriods.js , usePayslip.js , usePayrollAttendance.js
constants/permissions.js             new `payroll` group
constants/menus.js                   new top-level "Payroll" group
```

`pages/salary` and `helper/salary.js` stay until the loan data is dealt with,
then go. They are already invisible in the navigation.

## 7. Sequencing

Each stage is independently useful and independently shippable.

1. **Attendance import.** `payroll_attendance_day` + the Digisme importer +
   a read-only day grid. Confirms the Digisme attendance contract, which is
   the single biggest unknown, and gives operations something usable
   (a muster view) before payroll exists.
2. **Pay structures.** `payroll_component`, `payroll_structure`,
   `payroll_structure_line`, backfilled from `new_employee.salary`. Gives
   increment history immediately.
3. **Compute.** `payroll_period`, `payroll_payslip`, `payroll_payslip_line`,
   the register screen, the payslip PDF (`services/pdf.js` already exists).
4. **Loans.** `payroll_loan` + recovery as a deduction line; retire `/salary`.
5. **Payout.** Batches, bank advice export, UTR capture.
6. **Auth hardening** — pull the HR routes out of `unProtectedRoutes`. Listed
   last only because it is independent; it should be done first if it can be.

Statutory reporting (PF ECR, ESI, PT, Form 16) is deliberately out of scope
here. If Digisme already files these, this module should not duplicate them —
which is a question for the business before stage 3 is designed.

## 8. Open questions

These need answers from the business or from Digisme before implementation
starts. The first three change the design; the rest change the scope.

1. **Does Digisme expose an attendance API on the same gateway?** If not,
   payroll is fed by spreadsheet import and stage 1 changes shape.
2. **Is Digisme already running payroll?** If it is, this module is a
   *reporting and reconciliation* layer over Digisme's output, not a
   calculation engine, and stages 2–3 shrink to an import. If it is only
   attendance and employee master, this module computes.
3. **Where does statutory filing happen today** — Digisme, a consultant, or
   Tally? That decides whether PF/ESI/PT are computed here or only displayed.
4. **Should employees see their own payslip** through the existing login?
   `user.employee_id` makes `/payroll/payslips/me` trivial, but it changes who
   uses the app.
5. **How is pay actually approved today** — one admin, or branch manager then
   admin? The `payroll_period` status enum should name the real steps, the way
   the advance-request rework did.
6. **What happens to the open balances in `payment_det`?** Carry forward with
   a hand-reviewed name match, or start clean.
7. **Are there non-`new_employee` workers on the payroll** — contract,
   temporary, third-party? If so they need to exist in Digisme, because this
   module will not add a second employee table.
