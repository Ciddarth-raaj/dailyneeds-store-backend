# EPFO statutory wage ceiling: ₹15,000 → ₹25,000 from 17-09-2026

Status: **feature branch, not merged, not deployed.**

## What payroll does

**Effective-dated ceiling** (`config/statutory.js` → `pf.ceilingSchedule`):

| From | EPF / EPS / EDLI ceiling | Version stamped on every calculation |
|---|---|---|
| up to 16-09-2026 | ₹15,000 | `EPFO-CEILING-15000-2014-09-01` |
| from 17-09-2026 | ₹25,000 | `EPFO-CEILING-25000-2026-09-17` |

A future revision is a new schedule row, set in the file or via `PF_WAGE_CEILING_SCHEDULE`. The payroll logic does not change.

**PF wage** = earned Basic = Basic × Salary Days / 26. This is unchanged.

**A month with no ceiling change in it** (October onward, and every month before September 2026) is one period on the full monthly ceiling, exactly as before:

```
EPF wage = min(earned Basic, ceiling)
EE       = 12% x EPF wage
EPS      = 8.33% x min(EPF wage, EPS ceiling)   (when EPS applies)
ER EPF   = ER 12% - EPS
EDLI     = 0.5% x EDLI wage
Admin    = 0.5% x EPF wage
```

**September 2026** (`utils/pf_period.js`) is two periods:
- **01–16 Sep** on the old ceiling, ₹15,000 × 16/30 = ₹8,000.
- **17–30 Sep** on the new ceiling, ₹25,000 × 14/30 = ₹11,666.67.

Each period is calculated as follows:
1. **Share of the wage.** Earned Basic is apportioned by **paid days**. LOP is placed in the period it fell in, using the attendance day rows and scaled to the month's own LOP. Joining and leaving dates bound each period.
2. **Status in that period.** The employee is not employed, excluded, EPF only, or EPF + EPS.
3. **Contribution basis:** `CEILING`, or `ACTUAL_WAGE` for a recorded higher-wage contributor.
4. **EPS.** Tested against that period's monthly pension ceiling, using the contractual Basic, with age taken at the period's end.

Figures are exact to the paisa within each period, then summed. The month's totals are **rounded once** to the rupee, and employer EPF = rounded 12% − rounded EPS. The result is **one** monthly result and **one** ECR line. The stored audit trail per calculation is `pf_segments`, `pf_scenario`, `pf_exact`, `pf_ceiling_version` and `statutory_config_version`.

**Employees aged 58 or over** get no EPS from the period in which they are 58. The whole employer 12% goes to EPF. EPF continues as applicable.

**Official FAQ illustrations** (₹20,000 PF wage, asserted in `utils/epfo_faq_scenarios_2026.test.js`):

| | Period 1 EPF / EPS | Period 2 EPF / EPS | EE | EPS | ER EPF | EDLI | Admin | Total |
|---|---|---|---:|---:|---:|---:|---:|---:|
| A: excluded → member | 0 / 0 | 9,333.33 / 9,333.33 | 1,120 | 777.47 | 342.53 | 46.67 | 46.67 | 2,333.34 |
| B: higher-wage EPF, EPS from 17-09 | 10,666.67 / 0 | 9,333.33 / 9,333.33 | 2,400 | 777.47 | 1,622.53 | 100 | 100 | 5,000.00 |
| C: EPF + EPS capped | 8,000 / 8,000 | 9,333.33 / 9,333.33 | 2,080 | 1,443.87 | 636.13 | 86.67 | 86.67 | 4,333.34 |

Scenarios A and B need `pf_applicable_from` / `pf_contribution_basis` to be recorded. Both are read-only master fields until an edit path is approved. With nothing recorded, every member is on the ceiling basis.

## EPS eligibility correction (separate switch)

`PF_EPS_ELIGIBILITY_ON_UNCAPPED_WAGE`, default `true`.

- **Old behaviour:** EPS eligibility was tested on the already-capped PF wage. That wage can never exceed the ceiling, so `previous_eps_member` and the 01-09-2014 cutoff were never consulted.
- **Corrected behaviour:** the test uses the contractual Basic.
- **Who changes:** PF members under 58 on the ceiling basis, with Basic above the ceiling, who joined on or after 01-09-2014.
  - With Previous EPS Member = No, EPS becomes 0 and the employer's 12% goes wholly to EPF.
  - With Previous EPS Member not recorded, EPS becomes unresolved and approval is blocked until it is recorded.
- **Unchanged:** employee PF and the employer total; only the split moves. Approved or locked months are never rewritten.
- **Rollback:** set the variable to `false`, which reproduces the old behaviour exactly. Tests: `utils/eps_eligibility_correction.test.js`.

## Statutory setup hold (`STATUTORY_SETUP_INCOMPLETE`)

Checked on every read of Calculation & Review (`utils/payrun_eligibility.js#statutorySetupGaps`):

| Who | Must be recorded |
|---|---|
| Everybody (the existing rule) | PF Applicable and ESI Applicable answered; UAN or PF Number where PF applies; ESI Number where ESI applies |
| A PF member who **joined in the payroll month**, or has no DOJ at all | DOJ, DOB, Previous PF Member, Previous EPS Member. A previous PF member also needs their existing 12-digit UAN. A first-time member may use the PF number while the UAN is generated. |

What a hold does:
- **Calculation:** a held employee is **not calculable**. Calculate and Calculate All Eligible refuse them by name (`BLOCKED`), **store nothing**, and calculate everybody else normally.
- **Approval:** approval is blocked.
- **On screen:** the row shows an **On hold** banner naming the missing fields.
- **No guessing:** nothing is inferred. A missing Previous EPS Member is never derived from Basic or gross.

**Release:** HR completes the named fields in Employee Master → Statutory details. The identifiers and Form 11 facts are read **live**, so the hold lifts on the next refresh, and the employee can then be calculated and approved. A change to **PF / ESI Applicable** itself is frozen in the month's snapshot, so it needs **Reset → re-initialise** for that employee.

**Existing members** are not newly held by the Form 11 facts. Their statutory questions are the engine's, reported as unresolved exactly where they change the money. An existing member whose UAN is missing in DNDS is calculated on the existing rule (UAN or PF number). The ECR refuses them (`UAN_MISSING`) until HR records the UAN; the ECR then uses that UAN without re-initialisation.

## Safeguards

- **Approved / locked months are never rewritten.** `saveCalculations` keeps every column of an `APPROVED_LOCKED` row (`IF(status='APPROVED_LOCKED', keep, new)`), and the usecase refuses with `LOCKED`.
- **Statutory master changes after calculation** (UAN, Previous PF/EPS Member, DOB, DOJ, PF coverage start, contribution basis, PF/ESI applicability) make that calculation `RECALCULATION_REQUIRED`, "Statutory setup changed". A locked month is never marked. One-time effect on deploy: any month already calculated but **not approved** will show `RECALCULATION_REQUIRED` once, because the source marker is new.
- **Unresolved statutory questions block approval** (`CALCULATION_INCOMPLETE`) and never become a zero.
- **The payslip** is built from the stored approved calculation and shows each PF period of a split month.
- **The ECR** (`GET /payrun/calculation/ecr`) is built from **approved** stored calculations only; there is no unapproved preview. It writes one line per member per month and refuses pending, incomplete, unapproved and UAN-missing members. It needs `view_employee_sensitive`.

## Migration `20261120120000-epfo-wage-ceiling-2026`

Additive and idempotent. Each `ADD COLUMN` is guarded by `information_schema`. **No index. No row is inserted, updated or deleted. No historical payroll is recalculated. Nobody is enrolled.**

| Table | Column | Type |
|---|---|---|
| `payrun_employee_calculation` | `eps_wage`, `edli_wage`, `edli`, `pf_admin_charge` | DECIMAL(12,2) NULL DEFAULT NULL |
| | `ncp_days` | INT NULL DEFAULT NULL |
| | `pf_ceiling_version`, `statutory_config_version`, `pf_scenario` | VARCHAR(96) NULL DEFAULT NULL |
| | `pf_segments`, `pf_exact` | JSON NULL |
| | `statutory_setup_marker` | CHAR(32) NULL DEFAULT NULL |
| `new_employee` | `pf_applicable_from` | DATE NULL DEFAULT NULL |
| | `pf_contribution_basis` | ENUM('CEILING','ACTUAL_WAGE') NULL DEFAULT NULL |

The down-migration drops exactly these 13 columns, each guarded.

## Rollback

| What | How |
|---|---|
| Application code | Revert the merge commit(s) on `main-autodeploy` and redeploy. The added columns are NULLable and unread by the old code. |
| Migration | Leave it in place (harmless to the old code). Only if no month was calculated on engine v3 should you run `db-migrate down -c 1`; it discards the stored PF audit trail of anything calculated since. |
| EPS eligibility correction | `PF_EPS_ELIGIBILITY_ON_UNCAPPED_WAGE=false`, restart the API, recalculate any open (unapproved) month. |
| Statutory holds | Complete the master data (the intended release). As an emergency only, revert the hold commit; held employees then calculate on the pre-existing rule. |
