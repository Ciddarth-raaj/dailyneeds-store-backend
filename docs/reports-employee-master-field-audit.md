# Reports → Employee Master: field audit and permission fix

Task `DN-REPORTS-EMPLOYEE-MASTER-SYNC-20260918-001`. Source of truth:
`main-autodeploy` on both repositories, as at the audit.

Two things were wrong, and they are unrelated to each other except that both
made Reports less useful than it looks.

1. **The three report rights could not be granted.** `view_reports`,
   `export_reports` and `manage_shared_report_templates` are declared by
   `20260909160000-reports-foundation`, granted to nobody by it, and required
   by `routes/employee_report.js`. They were never listed in the frontend's
   `constants/permissions.js`, which is what the Designation Permission Matrix
   renders — so there was no checkbox, and Reports worked for administrators
   (through the `user_type = 2` bypass) and for nobody else.

2. **The field catalogue had stopped tracking the Employee Master.** Eleven
   columns were added to `new_employee` after the catalogue was written and
   none of them was reportable; two more had been set aside for reasons that
   had since become wrong.

## A. The permission change

`constants/permissions.js` gains one group:

| Key | Label |
| --- | --- |
| `view_reports` | View Reports |
| `export_reports` | Export Reports |
| `manage_shared_report_templates` | Manage Shared Report Templates |

Nothing else changed. In particular:

* **No second permission system.** The keys are the backend's, spelled as
  `constants/hr_permissions.js` spells them. Nothing is renamed or aliased.
* **`hr_reports` and `process_payroll` stay off the screen.** Neither runs a
  payroll nor produces a report today.
* **Backend authorization is untouched and remains authoritative.** Every
  route still demands `view_reports` **and** `view_employees` through
  `permissions.requireAll`, and the service re-checks the dataset itself. The
  AND was not weakened.
* **Menu and page behaviour already used `view_reports`** and were verified
  rather than changed: both `REPORTS_MENU` entries name
  `["view_reports", "view_employees"]`, `util/menuPermissions.js` treats an
  array as AND, and all three report pages call
  `usePermissions([...], { all: true })`. Reports is therefore never shown or
  opened on the strength of `view_employees` alone, and `view_reports` alone
  opens nothing.
* **The administrator bypass is unchanged.** `user_type = 2` still bypasses the
  permission table in the middleware; no screen infers it.

`util/permissionCatalog.js` gains one icon entry so the module header matches
the rail.

## B. The field audit

Held against `EMPLOYEE_MASTER_COLUMNS` in `repository/employee.js` — the
Employee Master's own result contract, which
`repository/employee_detail_columns.test.js` already holds against the
migrations. All 58 columns are accounted for, plus the Employee Master fields
that live in other tables.

### Missing fields found, and now reportable

| Employee Master field | Storage / source | Was in report? | Permission required | Action |
| --- | --- | --- | --- | --- |
| Employment Type | `new_employee.employment_type` | no | none | added, ENUM filter (Permanent / Contract) |
| Grade | `new_employee.grade` | no | none | added, ENUM filter (A–E) |
| Work Shift | `work_shift.shift_name` via `new_employee.default_work_shift_id` | no | none | added as resolved label, TEXT filter. The existing `shift` key stays: it is the **legacy** `shift_master` roster and a seeded report names it |
| Attendance Required | `new_employee.attendance_required` | no | none | added, Yes/No, ENUM filter |
| PF Applicable | `new_employee.pf_applicable` | no | `view_employee_sensitive` | added, tri-state, Yes/No filter |
| Existing / Previous PF Member | `new_employee.previous_pf_member` | no | `view_employee_sensitive` | added, tri-state, Yes/No filter |
| Existing / Previous EPS Member | `new_employee.previous_eps_member` | no | `view_employee_sensitive` | added, tri-state, Yes/No filter |
| ESI Applicable | `new_employee.esi_applicable` | no | `view_employee_sensitive` | added, tri-state, Yes/No filter |
| Payment Type | `new_employee.payment_type` | no — it was a `FORBIDDEN_KEY` | `view_employee_sensitive` | added, Bank / Cash, ENUM filter |
| Marriage Date | `new_employee.marriage_date` | no | none | added, **no filter** (VARCHAR with no validated format) |
| Resignation Date | `new_employee.resignation_date` | no | none | added, DATE filter |
| Name as per Aadhaar | `employee_aadhaar_identity.name_as_per_aadhaar` | no | `view_employee_aadhaar` | added, TEXT filter |
| Salary Effective From | `employee_salary.effective_from` | no | `view_salary` | added, DATE filter |
| Monthly Gross, Daily Salary, Basic, HRA, Conveyance, Special Allowance, Employee PF, Employer PF (total), Employee ESI, Employer ESI, Monthly CTC | `employee_salary` (current APPROVED row) | no | `view_salary` | added, no filters |

The four statutory flags and `payment_type` are all in
`constants/sensitive_fields.js`, so they carry exactly the key B3 already
applies to them — no weaker, and no new right. The salary figures use M2's
existing `view_salary`, which already gates the Employee Master's Payroll
section and the Payroll screens: no generic reporting right was invented, and
granting the report keys confers no pay access at all.

`payment_type` was removed from `FORBIDDEN_KEYS`, because a forbidden key that
now exists as a gated field is a contradiction rather than a second defence.
`salary` — the legacy column — stays forbidden.

### The Aadhaar fields carry one key, not one of three

Review correction `DN-REPORTS-EMPLOYEE-MASTER-SYNC-REVIEW1-20260918-002`.

The first pass gated only `aadhaar_name` on `view_employee_aadhaar` and left
`aadhaar_status` and `aadhaar_last4` open to any caller holding `view_reports`
+ `view_employees`. That contradicted the authorization contract the key is
declared with in `constants/hr_permissions.js`, which governs one question —
verification **status**, the **last four** digits and the **verified name** —
and which the employee profile applies to all three together. A report that
showed two of the three without the key would have been a way around it.

All three now carry `permission: view_employee_aadhaar` and `sensitive: true`:

| Field | Permission | Note |
| --- | --- | --- |
| Aadhaar Status | `view_employee_aadhaar` | ENUM filter, gated with the column |
| Aadhaar Last 4 | `view_employee_aadhaar` | no filter — partial column, see below |
| Name as per Aadhaar | `view_employee_aadhaar` | TEXT filter |

`sensitive: true` is the existing mechanism, not a new one: the resolver copies
it into discovery, and `usecase/employee_report_service.js` derives the export
audit's `sensitive_fields_included` from it, so an export carrying an Aadhaar
column is recorded as having carried one.

It is deliberately **not** `view_employee_sensitive`. That key is far broader —
salary, bank, PAN — and a store manager does not hold it, which is the whole
reason `view_employee_aadhaar` exists as its own narrow decision.

Nothing was widened. The full Aadhaar still has no catalogue entry at all,
gated or otherwise; `aadhaar_last4` is still unfilterable; the report dataset
rights and the branch scope are untouched; and no seeded system template names
an Aadhaar field, so all five still reconcile unchanged.

### The salary join

`employee_salary` holds one row per revision, so a plain join on `employee_id`
would turn one employee into one row per revision and break the invariant that
`preview.matching_count` equals the exported row count. The join therefore
pins the primary key chosen by a correlated subquery: the latest APPROVED
revision effective on or before today, ordered by effective date then id —
statement for statement the rule
`repository/employee_salary.js#getCurrentSalary` applies. Fixed text, no
placeholder, no caller value. An employee with no approved salary joins to
nothing and every figure exports blank, never zero.

### Intentionally excluded, and why

| Column | Reason |
| --- | --- |
| `employee_image`, `aadhaar_card_image` | image / document blobs |
| `aadhaar_card_no`, `aadhaar_card_name` | a full Aadhaar must never be exportable; there is no entry at all, not a gated one. The **verified** name is reported instead, behind `view_employee_aadhaar` |
| `salary` | legacy undated free-text VARCHAR that M2 neither reads nor copies from, and the Employee Master does not show. Exporting it beside the real structure would put two answers to one question in one row |
| `pf`, `esi` | deprecated, superseded by the numbers and the applicability flags |
| `uniform_qty`, `introducer_name`, `introducer_details`, `online_portal`, `telegram_username` | operational / internal |
| `shift_code`, `source_system`, `source_employee_code` | sync artefacts and provenance |
| `special_break_override_minutes` | attendance-engine configuration, set on the attendance screens behind `manage_employee_break_override`; it appears nowhere on the Employee Master |
| `created_at`, `updated_at` | row metadata |

### Filters deliberately withheld

* `account_no` and `aadhaar_last4` — exported masked/partial; a filter would
  compare the stored value and become an oracle for the hidden one. Unchanged.
* `marriage_date` — VARCHAR with no validated format, so a from/to range would
  be a lexical comparison over free text and would silently drop rows.
* Every money column — the catalogue has no numeric control, and adding one
  would be a query-builder feature rather than a form. The effective date is a
  real DATE and is filterable.
* The tri-state flags offer Yes and No only: an ENUM filter compiles to
  `expr = ?`, and nothing equals NULL, so a "Not recorded" option would look
  like a working filter that always returns nothing. The column still exports
  "Not recorded".

### The sweep is machine-checked now

`constants/employee_report_catalogue.test.js` holds the catalogue against
`EMPLOYEE_MASTER_COLUMNS`: every column is either read by a field or named in
the test's refusal list with its reason. A column added to the employee master
now fails a test until somebody has decided, in writing, whether it is
reportable — which is the failure mode this audit existed to fix.

## Compatibility

* No migration, no schema change, no data change.
* Every seeded system report (`Active Employee List`, `Contact List`,
  `PF List`, `ESI List`, `Bank/KYC Status List`) names field keys that still
  exist and are still enabled; a test parses the keys out of the migration and
  asserts it.
* No existing field key was renamed or removed, so saved custom reports
  reconcile exactly as before. The only label change is `shift` →
  "Shift (legacy)", to tell it apart from the work shift now beside it.
