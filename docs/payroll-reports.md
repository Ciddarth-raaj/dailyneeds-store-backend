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
| Migration | `migrations/mysql/migrations/20261123120000-payroll-reports.js` |

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

## Population: the report reconciles to the payrun

A report's rows are the month's **payrun employees** (`payrun_employee`, frozen at initialization), narrowed only by:

- the caller's branch scope, applied to the payrun's own outlet,
- the report type's population,
- the user's filters.

Nothing about the employee today can drop a row: a status change, a resignation, a transfer or a later lock change all leave the row in place.

- **Payroll figures are shown only where that employee's calculation is `APPROVED_LOCKED`.** Any other payrun row stays in the report with its figures blank. *Payrun Status* says why ("Not calculated" or "Not approved & locked"), the screen marks the row, and the Excel/PDF header line states how many such rows there are.
- **Totals are therefore finalized totals.** Every calculation figure goes through `finalizedOnly` (`utils/payroll_report_query.js`).
- **The Payroll Register always reconciles to the payrun for the same month and scope.** The report's employee count equals the number of payrun employees, its finalized count equals the number of approved employees, and its Gross, Total Deductions and Net Pay totals equal the payrun's finalized totals. `repository/payroll_report.js#payrunTotals` computes the payrun side with its own SQL, independent of the report query builder. Every Payroll Register preview returns `reconciliation: { payrun, report, reconciled }`, and the screen shows the result. A mismatch is shown, never hidden.

## Data integrity: what each column shows

Opening a report runs SELECTs only. It never calls the payroll or attendance calculation and never writes a payrun table. Approved figures change only through the payrun's own unlock → recalculate → approve process.

Each field declares its `source`, and the column picker shows it:

| Source | Meaning |
| --- | --- |
| Finalized payrun | Stored on the approved calculation row: earnings, deductions, net pay, PF/ESI wages and contributions, NCP days, paid days, OT. Blank for a row that is not approved & locked. |
| Payrun-time snapshot | Frozen on `payrun_employee` at initialization: name, outlet, designation, department ID, joining date, last working day, salary structure, PF/ESI applicability, UAN, PF number, ESI number, pay type. |
| Attendance month read by the payrun | `attendance_monthly_payroll` / `attendance_day_calculation`: present, weekly off, absent, late, early out. These are shown **only while that attendance month is still the exact one the payrun read**, meaning `calculated_at` equals the stored `attendance_calculated_at`. If attendance is recalculated after payroll, these cells are blank and *Attendance Snapshot Status* reads "Changed after payrun - not shown". Frozen figures such as paid days, LOP and net pay never change. |
| Current Employee Master | **Not snapshotted by the payrun, so these show today's value, labelled "Current master"**: bank name, account number, IFSC, mobile, email, PAN, gender, date of birth, employment type, and every other `em_` field. |

Specific notes:

- **UAN and ESI/IP number** use the payrun snapshot. When the snapshot is empty they fall back to the current master, the same rule the ECR already applies.
- **Department** is snapshotted as an ID and displayed under the department's current name.
- **Basic / HRA / Conveyance / Special Allowance (earned)** are the payslip's own whole-rupee split of the stored Salary Earnings. The *(structure)* columns are the monthly structure.
- **LOP Days** is the stored NCP days. **Payable Days** is Paid Days + LOP Days.
- **Not available**: DnDS stores no monthly figure for TDS, loan recovery, penalty, holidays, paid leave or permission counts, so these columns do not exist rather than showing invented zeros.

## Statutory files

Both files are generated on the server from the stored payrun rows. Each has a fixed layout that is independent of the visible report columns: neither endpoint accepts a column list.

### All or nothing

The statutory population is every payrun employee the month makes relevant:

- **EPF**: the stored PF status is not `NOT_APPLICABLE`, or the snapshot says PF applies when no calculation is stored.
- **ESI**: the same rule, using the ESI status and ESI applicability.

Every one of them is either **Ready** or **Blocked**, so `ready + blocked = considered`. Each blocked employee is listed with every reason.

**If even one employee is blocked, the file is refused** (HTTP 409 `BLOCKED_EMPLOYEES`, with the counts and the blocked list), and the download button stays disabled until the issues are resolved. **There is no "ready employees only" option.** The routes accept only the month (plus ESI zero-day reasons); a request carrying any other field, such as a partial-file flag or a column list, is rejected with 400.

The ordinary Excel/PDF EPF and ESI reports still download, with their validation-status columns.

### EPFO ECR - `Download ECR File` (`POST /reports/payroll/epf/ecr`)

**Format**: plain text, one line per member, no header line, fields separated by `#~#`, eleven fields in the order below. All amounts and counts are whole numbers.

| # | ECR field | DnDS source (stored, approved calculation) |
| --- | --- | --- |
| 1 | UAN | Payrun snapshot UAN; current UAN if the snapshot has none. Must be 12 digits. |
| 2 | MEMBER NAME | Payrun snapshot name, upper case. Letters, spaces and `.` only; other characters are replaced by a space. Must start with a letter and be at most 85 characters, or the member is blocked (never truncated). |
| 3 | GROSS WAGES | `total_earnings`, nearest rupee |
| 4 | EPF WAGES | `pf_wage`, nearest rupee |
| 5 | EPS WAGES | `eps_wage`, nearest rupee |
| 6 | EDLI WAGES | `edli_wage`, nearest rupee |
| 7 | EPF CONTRI REMITTED (EE) | `employee_pf` |
| 8 | EPS CONTRI REMITTED | `employer_eps` |
| 9 | EPF EPS DIFF REMITTED (ER) | `employer_epf` |
| 10 | NCP DAYS | `ncp_days`. Blocked if not stored, or outside the month. When EPF wages are 0 it must equal the days in the month. |
| 11 | REFUND OF ADVANCES | `0`. DnDS records no refund of EPF advances, so this is a stated value, not a guess. |

**Blocking reasons**: not calculated, not approved & locked, incomplete, PF/EPS unresolved, UAN missing, UAN invalid, member name invalid or too long, NCP days not stored, NCP days outside the month, NCP days not matching zero wages, negative wages, EPS/EDLI wages not stored, contribution mismatch (EE = 12% of EPF wages, EPS = 8.33% of EPS wages, EPS and EDLI wages ≤ EPF wages, ER difference = EE − EPS, each within ₹1).

### ESIC monthly contribution - `Download Contribution File` (`POST /reports/payroll/esi/contribution-file`)

**Format**: a real **Excel 97-2003 `.xls`** workbook (BIFF8 / OLE2), so it does not need converting before upload. It has one sheet, one header row and one row per IP:

| # | Column | DnDS source | Rule |
| --- | --- | --- | --- |
| 1 | IP Number (10 Digits) | Payrun snapshot ESI number; current one if the snapshot has none | Exactly 10 digits. Written as a text cell. |
| 2 | IP Name( Only alphabets and space ) | Payrun snapshot name | Letters and spaces only, upper case. Blocked if no letters remain. |
| 3 | No of Days for which wages paid/payable during the month | `salary_days` | Whole number, 0 to the days in the month |
| 4 | Total Monthly Wages | `esi_wage` (as stored) | Must be present and not negative |
| 5 | Reason Code for Zero workings days(...) | See mapping below | Numeric; 0 for all other reasons |
| 6 | Last Working Day( Format DD/MM/YYYY or DD-MM-YYYY) | Payrun snapshot last working day, or the date chosen on the ESI tab | `DD/MM/YYYY`, zero-padded, as a text cell. Given **only** for codes 2, 3, 4, 5, 6 and 10; blank for every other code. |

**Reason codes and their mapping to DnDS.** DnDS has no reason codes of its own:

- An employee whose payrun-snapshot last working day falls within or before the month gets **2 - Left Service**, with that date, automatically.
- Any other employee with zero days or zero wages is blocked (`ZERO_REASON_MISSING`) until a code is chosen on the ESI tab. The choice applies to that download only, is not stored, and is validated again on the server.
- Employees with days and wages get **0**.

| Code | ESIC reason | Last working day |
| --- | --- | --- |
| 0 | Without Reason | blank |
| 1 | On Leave | blank |
| 2 | Left Service | required |
| 3 | Retired | required |
| 4 | Out of Coverage | required |
| 5 | Expired | required |
| 6 | Non Implemented Area | required |
| 7 | Compliance by Immediate Employer | blank |
| 8 | Suspension of Work | blank |
| 9 | Strike / Lockout | blank |
| 10 | Retrenchment | required |
| 11 | No Work | blank |
| 12 | Does Not Belong To This Employer | blank |

**Blocking reasons**: not calculated, not approved & locked, incomplete, ESI unresolved, IP number missing or not 10 digits, IP name invalid, days outside the month, wages missing or negative, zero days/wages without a reason, invalid reason code, last working day missing or after the month, stored employer contribution missing. The contributions themselves are the engine's stored figures and are not recomputed here.

### Sources and verification status

The build environment's network policy blocks `epfindia.gov.in`, `esic.gov.in` and `esic.in`, so the official files could not be downloaded. Everything below marked confirmed was read from the official pages themselves (via search restricted to those domains).

**EPFO - confirmed**

- **Format.** [ECR File Format (for Employers)](https://www.epfindia.gov.in/site_docs/PDFs/OnlineECR_PDFs/ECR_ForEmployers_FileStructure.pdf) and [Introduction - ECR 2.0](https://www.epfindia.gov.in/site_docs/PDFs/EPFOUnifiedPortal/Introduction_ECR2.0.pdf):
  - `.txt` file, one line per member, `#~#` separator, eleven fields, no decimals;
  - member name: at most 85 characters, no special character other than `.`;
  - NCP days equal the days in the month when wages are 0;
  - EDLI wages equal EPF wages, capped at the EDLI ceiling (0 only for no wages or an EDLI exemption);
  - Refund of Advances: a whole number.
- **[Revamped ECR](https://www.epfindia.gov.in/site_en/revamped_ecr.php), from wage month September 2025** (also [PIB](https://www.pib.gov.in/PressReleasePage.aspx?PRID=2178587)). It **retains the existing ECR format**. The new items are portal-side: return and payment are separated, system validations are added, 14B damages and 7Q interest are calculated, and ECRs can be revised and must be filed in month order. Nothing in the file layout changes.
- **Upper case.** The official text sets no upper-case requirement. Names are written upper case, exactly as the payrun's own ECR (`utils/epfo_ecr.js#cleanName`) already writes them. That satisfies the character rule and keeps the two ECRs identical.
- **EDLI ceiling.** The ceiling rises from 15,000 to 25,000 with effect from 17 September 2026 ([PIB](https://www.pib.gov.in/PressReleasePage.aspx?PRID=2313829)). The ECR writes the payroll engine's **stored** `edli_wage`, which the engine computed from its effective-dated ceiling schedule in `config/statutory.js` (`pfCeilingSchedule`). The file generator holds no ceiling constant of its own.
- **Refund of Advances.** `0`: DnDS records no refund of EPF advances.

**ESIC - confirmed**

- **Format.** [MC template](http://www.esic.in/InsuranceGlobalWebV4/App_Themes/Help/MC_Template1.xls) and [multiple-sheet circular](https://esic.gov.in/attachments/circularfile/0d84038f847b3a37178d824ca3d5992b.pdf):
  - Excel 97-2003 `.xls`;
  - IP Name: alphabets and space only;
  - reason code: numeric, 0 for all other reasons;
  - the reason list (On Leave … Doesn't Belong To This Employer; no "Duplicate IP");
  - last working day only for Left Service, Retired, Out of Coverage, Expired, Non-Implemented Area and Retrenchment;
  - dates `DD/MM/YYYY` or `DD-MM-YYYY`, zero-padded.

**ESIC - PENDING DIRECT-TEMPLATE VERIFICATION**

These four values have not been checked against the official template itself. They are neither invented nor changed silently: each is a single, named constant in `utils/payroll_statutory_files.js`, and stays as it is until the template is checked.

| Item | Current value | Status |
| --- | --- | --- |
| Numeric code of each zero-wage reason | 0 Without Reason … 12 Does Not Belong To This Employer (`ESIC_REASON`) | **Pending.** The list of reasons is confirmed; the number for each is not. |
| Exact text of the six column headers | `ESIC_HEADERS` | **Pending** |
| Whether Total Monthly Wages may carry paise | The stored ESI wage is written as stored (paise appear when the stored wage has them) | **Pending** |
| Whether the worksheet name is significant | `Sheet1` | **Pending** |

> **Before Download Contribution File is used for an actual statutory filing**, save the official ESIC `MC_Template1.xls`, exactly as downloaded from the ESIC portal, at `test_support/statutory/MC_Template1.xls`, and run `node --test utils/payroll_statutory_official_template.test.js`. That test checks the headers and every reason-code number, and **must pass**. Confirm the paise and sheet-name points against the same template. The build environment cannot reach esic.gov.in / esic.in, so the suite is skipped until the file is supplied.

### No second payroll calculation

The file generator formats and validates the stored payrun. It never re-derives a statutory figure:

- **Wages and contributions** (EPF, EPS, EDLI, ESI) are the engine's stored values.
- **The ESI check** blocks only a *missing* stored contribution. An earlier check that recomputed ESI from the current config rates was removed.
- **The EPF arithmetic check** is the payrun's own shared `validateEcrMember`, called with the engine's configured rates (`config/statutory.js` `pf.employeeRatePercent` / `epsRatePercent`).

### `.xls` round trip

`utils/payroll_statutory_files.test.js` writes the contribution file and re-opens it with SheetJS. When available, it also uses `xlrd`, an independent reader that only opens genuine BIFF `.xls`. It asserts:

- BIFF8 (Excel 97-2003);
- IP number and last working day stored as **text**, so a leading zero is kept (for example `0012345678`);
- days, wages and reason code stored as **numbers**;
- an empty last working day stored as a **blank** cell;
- every value unchanged after re-opening.

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
ATTENDANCE_TEST_MYSQL=mysql://user:pass@localhost/scratch_db node --test repository/payroll_report.mysql.test.js repository/payroll_report_engine.mysql.test.js
node --test utils/payroll_statutory_official_template.test.js   # needs test_support/statutory/MC_Template1.xls
```
