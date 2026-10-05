# Payroll Reports

Payroll → Reports. Month-wise reports built from the **finalized payrun**, with reusable templates, optional Employee Master and attendance columns, and dedicated EPF (ECR) and ESI (ESIC contribution) file downloads.

## Where things are

| Piece | File |
| --- | --- |
| Field catalogue (every column, its SQL, source and permission) | `constants/payroll_report_catalogue.js` |
| Report types (population + default columns) | `constants/payroll_report_types.js` |
| The one query path (preview, count, totals, Excel, PDF) | `utils/payroll_report_query.js` |
| ECR / ESIC validation and file rows | `utils/payroll_statutory_files.js` |
| Service (layouts, templates, exports, statutory files) | `usecase/payroll_report_service.js` |
| Reads + layout/default tables | `repository/payroll_report.js` |
| HTTP, mounted at `/reports/payroll` | `routes/payroll_report.js` |
| Migration | `migrations/mysql/migrations/20261122120000-payroll-reports.js` |

## Reused infrastructure, not a parallel system

- **Templates** are rows in the existing `report_template` table, one `dataset_key` per report type (`PAYROLL_REGISTER`, `PAYROLL_EPF`, `PAYROLL_ESI`, `PAYROLL_BANK`, `PAYROLL_OT`, `PAYROLL_DEDUCTIONS`, `PAYROLL_ATTENDANCE`). They use the same ownership rules (`usecase/report_template_rules.js`): personal / shared / built-in, Duplicate (Save a Copy), and reconciliation on every run. A template stores only the column keys in order, the display preferences (`filters.display`) and reusable filters (outlets, departments, pay type). It never stores a payroll value.
- **Export audit** uses the existing `report_export_log`. It records the shape of each export, never the values. The `format` enum gains `pdf`, `ecr` and `esic`.
- **ECR lines** come from `utils/epfo_ecr.js#buildEcr`, the builder the payrun's own ECR uses.
- **Employee Master columns** are generated from `constants/employee_report_catalogue.js`, with the same SQL, joins, transforms and permissions, under an `em_` key. A field added there appears here automatically.
- **Branch scope** uses the shared `employee_branch_scope` resolver, applied to the payrun's `store_id` snapshot exactly as the payrun screens apply it. It fails closed.

## New tables (structure only)

- `payroll_report_layout`: unique per **user + report type + payroll month**. It holds the selected columns in order, the display preferences, the reusable filters, and the template the layout was applied from.
- `payroll_report_default_template`: unique per **user + report type**. It holds that user's "Set as Default" template.

A month with no layout of its own opens with the user's default template if they have one, and otherwise with the report type's built-in default columns. **Copy Columns from Previous Month** copies the user's most recent layout from an earlier month for that report type into the selected month. It does not create a template.

## Data integrity: what each column shows

Every query is pinned to `payrun_employee_calculation.status = 'APPROVED_LOCKED'` for the selected month. Opening a report runs SELECTs only. It never calls the payroll or attendance calculation and never writes a payrun table. Approved figures change only through the payrun's own unlock → recalculate → approve process.

Each field declares its `source`, and the column picker shows it:

| Source | Meaning |
| --- | --- |
| Finalized payrun | Stored on the approved calculation row: all earnings, deductions, net pay, PF/ESI wages and contributions, NCP days, paid days, OT. |
| Payrun-time snapshot | Frozen on `payrun_employee` at initialization: name, outlet, designation, department ID, joining date, last working day, salary structure, UAN, PF number, ESI number. |
| Attendance month read by the payrun | `attendance_monthly_payroll` / `attendance_day_calculation`: present, weekly off, absent, late, early out. These are shown **only while that attendance month is still the exact one the payrun read**, meaning `calculated_at` equals the stored `attendance_calculated_at`. If attendance is corrected after payroll, these cells are blank and *Attendance Snapshot Status* reads "Changed after payrun - not shown". A later correction never silently rewrites a finalized month. |
| Current Employee Master | **Not snapshotted by the payrun, so these show today's value**: bank name, account number, IFSC, mobile, email, PAN, gender, date of birth, employment type, and every other `em_` field. |

Specific notes:

- **UAN and ESI/IP number** use the payrun snapshot. When the snapshot is empty they fall back to the current master, the same rule the ECR already applies.
- **Department** is snapshotted as an ID and displayed under the department's current name.
- **Basic / HRA / Conveyance / Special Allowance (earned)** are the payslip's own whole-rupee split of the stored Salary Earnings (`utils/payslip_snapshot.js#balancedComponents`). The *(structure)* columns are the monthly structure.
- **LOP Days** is the stored NCP days, i.e. salary base days less paid days. **Payable Days** is Paid Days + LOP Days.
- **Not available**: DnDS stores no monthly figure for TDS, loan recovery, penalty, holidays, paid leave or permission counts, so these columns do not exist rather than showing invented zeros.

## Statutory files

The statutory files are independent of the visible report columns. Neither endpoint accepts a column list.

- **Download ECR File** (`POST /reports/payroll/epf/ecr`) produces the ECR 2.0 text (`#~#`, 11 fields) from the stored approved calculations.
- **Download Contribution File** (`POST /reports/payroll/esi/contribution-file`) produces the ESIC monthly contribution sheet. It has six fixed columns: IP number (as text), IP name (letters and spaces), days, total monthly wages, zero-day reason code and last working day (DD/MM/YYYY). The sheet is written as `.xlsx`. The ESIC portal template is the older `.xls` format, so open the file in Excel and use *Save As → Excel 97-2003 Workbook* before uploading if the portal rejects `.xlsx`.

**Validation.** Every relevant employee ends up either Ready or Blocked, so `ready + blocked = considered`. Each Blocked employee lists every reason.

- **EPF reasons**: not calculated, not approved, incomplete, PF/EPS unresolved, UAN missing, UAN invalid, NCP days not stored or outside the month, negative wages, EPS/EDLI wages not stored, contribution mismatch (the EPFO arithmetic checks).
- **ESI reasons**: not calculated, not approved, ESI unresolved, IP number missing or not 10 digits, days outside the month, wages missing, zero days or wages without a reason code, invalid reason code, last working day missing (required for reason codes 2, 3, 4, 5, 6 and 10), contribution mismatch.

**Zero-day reasons.** A last working day inside or before the month (`payrun_employee.resignation_date`) gives reason 2 automatically. Any other zero-day employee needs a reason chosen on the ESI tab. That choice is sent with the request and is not stored.

**Downloading with blocked employees.** If anybody is blocked, the download is refused with HTTP 409 and the blocked list. It only proceeds with `acknowledge_blocked: true`, and then the file contains the ready employees only. The counts are returned in `X-Statutory-Ready` / `X-Statutory-Blocked` and written to the audit row. Blocked employees are never left out silently.

## Permissions (no new keys)

| Action | Keys required (all of them) |
| --- | --- |
| Open reports, preview, layouts, templates, validation | `view_reports`, `view_employees`, `view_payroll`, `view_salary` |
| Excel / PDF | the above + `export_reports` |
| ECR / ESIC file | the above + `view_employee_sensitive` |
| Share a template | `manage_shared_report_templates` |

Column access is decided per field. UAN, PF member ID, ESI number, PF/ESI applicability and all bank fields need `view_employee_sensitive`. Employee Master fields keep the Employee Master's own permissions; for example, Aadhaar status, last 4 and verified name need `view_employee_aadhaar`. Fields a user may not use are missing from the picker, are refused if requested by key, and are dropped (with a warning) from any template or layout that names them. A full Aadhaar number has no field at all.

## Performance

A report is a fixed number of queries whatever the headcount: count, one page or all rows, totals, and two statutory reads when a validation-status column is selected. Joins are added only for the selected fields. The attendance aggregate is a single grouped derived table for the month. Excel exports the full eligible population, up to `PAYROLL_REPORT_MAX_ROWS` (default 20000); PDF is capped at `PAYROLL_REPORT_MAX_PDF_ROWS` (default 3000).

## Tests

```
node --test utils/payroll_report_query.test.js utils/payroll_statutory_files.test.js usecase/payroll_report_service.test.js
ATTENDANCE_TEST_MYSQL=mysql://user:pass@localhost/scratch_db node --test repository/payroll_report.mysql.test.js
```
