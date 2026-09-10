# HR schema and API — what exists today

Written as the ground truth for the payroll proposal in
[payroll-integration-proposal.md](payroll-integration-proposal.md). Nothing
here is a suggestion; it is what is in the database and the code right now.

The headline: **the employee, designation, department and branch masters are
not owned by this system.** They are a nightly mirror of Digisme, an external
HRMS. And **there is no attendance data in this database at all** — no table,
no column, no endpoint, no import.

---

## 1. Where the masters come from

`services/synker.js` runs a cron at **07:00 daily** (`CRON_SYNTAX_EMPLOYEE =
"0 7 * * *"`) calling `syncDigismeEmployees()`. The same routine is exposed
manually as `POST /employee/sync`. It talks to Digisme at
`https://indhrmsgateway.azurewebsites.net` — `GET /Authenticate` for a bearer
token, then `GET /api/GetEmployeeDetails` with an AES-encrypted
`{CompanyId, IsActive}` payload.

One Digisme response populates four tables:

| Digisme field | Lands in |
| --- | --- |
| `EmployeeCode` | `new_employee.employee_id` — **the PK is Digisme's code, not a local sequence** |
| `EmployeeName`, `Gender`, `MartialStatus`, `MobileNo` | `new_employee.*` |
| `IsTerminated` / `TerminateDate` | `new_employee.status` (1/0) and `resignation_date` |
| `DesignationCode` / `DesignationName` | `designation` (upsert on `designation_code`) |
| `DepartmentCode` / `DepartmentName` | `department` (upsert on `department_code`) |
| `CategoryCode` / `CategoryName` | `outlets` (upsert on `outlet_code`) — a Digisme "category" is a branch |
| `ShiftCode` | `new_employee.shift_code` |

Each master is written with a `bulkCreate` that builds
`INSERT ... ON DUPLICATE KEY UPDATE` from the keys present in the payload
(`repository/employee.js:552`, `repository/designation.js:291`). Two
consequences that matter for payroll:

- **Columns absent from the Digisme payload are never touched.** `salary`,
  `bank_name`, `ifsc`, `account_no`, `pf_number`, `uan`, `esi_number`,
  `aadhaar_*` and `date_of_joining` are all locally maintained and survive the
  sync. `employee_id` and `created_at` are explicitly excluded from the update.
- **Columns present in the payload are overwritten every night.**
  `employee_name`, `designation_id`, `department_id`, `store_id`, `shift_code`,
  `status` and `resignation_date` are Digisme's to change, silently, at 07:00.

`new_employee.shift_code` is stored but **never resolved** to a
`shift_master.shift_id`; the sync does not send `shift_id`, so an employee's
`shift_id` is whatever was last set by hand (often 0/NULL) while `shift_code`
carries the real Digisme value. The two disagree.

The Digisme API key and custom key are **hardcoded in `services/synker.js`**
(lines 15–18) and committed. Authentication is done by shelling out to `curl`
via `child_process.exec`. Flagged here because a payroll module will lean on
this integration.

---

## 2. Tables

### `new_employee` — the employee master

PK `employee_id INT` (Digisme `EmployeeCode`; `AUTO_INCREMENT` on the column
is vestigial — rows arrive with the id supplied).

| Group | Columns |
| --- | --- |
| Identity | `employee_name`, `father_name`, `spouse_name`, `dob`, `gender`, `marital_status`, `marriage_date`, `blood_group`, `employee_image` (LONGTEXT) |
| Contact | `permanent_address`, `residential_address` (both LONGTEXT), `primary_contact_number`, `alternate_contact_number`, `email_id`, `telegram_username` |
| Posting | `store_id` → `outlets.outlet_id`, `department_id`, `designation_id`, `shift_id`, `shift_code` |
| **Pay** | **`salary VARCHAR(45)`**, `payment_type VARCHAR(45)`, `bank_name`, `ifsc`, `account_no` |
| Statutory | `esi`, `esi_number`, `pf`, `pf_number`, `uan`, `pan_no`, `aadhaar_card_no`, `aadhaar_card_name`, `aadhaar_card_image` |
| Employment | `date_of_joining VARCHAR(45)`, `previous_experience`, `additional_course`, `qualification`, `introducer_name`, `introducer_details`, `uniform_qty` |
| Lifecycle | `status TINYINT DEFAULT 1`, `resignation_date DATE`, `online_portal`, `created_at`, `updated_at` |

Every one of the posting columns is a **bare INT with no foreign key**. There
are no FK constraints from `new_employee` to `outlets`, `designation`,
`department` or `shift_master`; the joins are all `LEFT JOIN` by convention.
Twelve *other* tables do declare `FOREIGN KEY (created_by) REFERENCES
new_employee(employee_id)` (materials, EB consumption, stock checker, expiry
checker, purchase acknowledgement, stock holding, GST match, …), so
`employee_id` is already the established actor key across the app.

Notable weaknesses for payroll:

- `salary` is a **free-text VARCHAR** holding one number. No components, no
  effective dating, no history. Changing an employee's pay destroys the old
  figure.
- `date_of_joining` is a VARCHAR, not a DATE.
- Bank details are unvalidated free text and returned in the clear by
  `GET /employee/bank` and `GET /employee/employees`.

### `designation`

`designation_id` PK, `designation_code VARCHAR(20) UNIQUE`,
`designation_name`, `status`, `online_portal`, `login_access`.

Doubles as the **role** for authorisation — see §4. Also joined by *name*
(not id) to `budget.designation_name` in `repository/designation.js:30`.

### `department`

`department_id` PK, `department_code VARCHAR(20) UNIQUE`, `department_name`,
`status`. Distinct from `product_department`, which is the merchandise
hierarchy and unrelated to HR.

### `outlets` — the one location master

`outlet_id` PK, `outlet_code VARCHAR(20) UNIQUE`, `outlet_name`,
`outlet_nickname`, `outlet_address`, `outlet_phone`, `phone`,
`telegram_username`, `opening_cash FLOAT`, `gofrugal_id`, `allowed_ips`,
`ip_restriction_enabled`, `is_active`, `created_at`, `updated_at`.

Referenced as `store_id` almost everywhere in the codebase, including
`new_employee.store_id`. Codes in use: `DNHO`, `DN1`–`DN5`.

There is also a legacy `store` table (`store_id`, `store_name`, `short_name`,
`lock_status`, `ob1`, `ob2`, …) still mounted at `/store`. **`outlets` is the
live one** — it is what the Digisme sync writes, what `new_employee.store_id`
points at, and what the IP restriction reads. Do not add to `store`.

### `shift_master`

`shift_id` PK, `shift_name`, `shift_in_time TIME`, `shift_out_time TIME`,
`status`. Purely local; Digisme's shift is carried as a code on the employee
and never reconciled against this table.

### `payment_det` — the current "salary" module

```sql
payment_id INT PK, employee VARCHAR(45), loan_amount INT,
installment_duration VARCHAR(45), paid_status INT, status INT,
created_at, updated_at
```

Despite the `/salary` mount, this is a **staff loan/advance tracker**, not
payroll. It has no gross, no components, no period. `employee` is a **name
string** and `repository/salary.js` joins it as
`LEFT JOIN new_employee ON new_employee.employee_name = payment_det.employee`
— so two employees sharing a name collide, and a Digisme rename orphans the
row. There is no repayment schedule; `installment_duration` is a VARCHAR.

The module is effectively dormant: `view_salary_advance` / `add_salary_advance`
are **commented out** in `constants/permissions.js` and `constants/menus.js`,
so the pages at `pages/salary/` are unreachable from the navigation.

### `resignation`

`resignation_id` PK, `employee_name VARCHAR(45)`, `reason_type`,
`resignation_date VARCHAR(45)`, `reason LONGTEXT`. Also keyed by **name**, and
`usecase/employee.js#get()` uses it to filter the employee list by building a
`NOT IN (names…)` clause. `new_employee.status` / `new_employee.resignation_date`
(written by the sync) are the reliable signal; this table is not.

### `employee_family`, `new_employee_documents`

`employee_family` keyed by `employee_name` (again). `new_employee_documents`
is keyed properly by `employee_id`: `document_id`, `card_type`, `card_no`,
`card_name`, `file LONGTEXT`, `expiry_date`, `is_verified`, `status`.

### `budget`

`budget_id`, `store_id VARCHAR(45)`, `designation_name VARCHAR(45)`,
`budget BIGINT`, `status`. A headcount-cost budget per branch per designation,
joined by name.

### Unrelated, despite the name

`advance_requests` / `advance_request_documents` / `advance_request_activity`
(the "LR workflow", migrations `20251024053106` → `20260903020000`) are
**supplier** advances to distributors, paid through Tally. They share nothing
with employee pay. They are, however, **the best-built workflow in the
codebase** and the right template to copy — see the proposal.

`accounts` is the daily per-branch cash/sales sheet (denominations, card
sales, loyalty). It is not a general ledger and payroll should not post to it.

---

## 3. Attendance

**Part 1 of the Biomax integration is built** (branch
`claude/biomax-attendance-spec-uh6y3m`): raw punch storage, device registry,
attendance-date attribution, Attendance List and Punch Audit. See
[biomax-attendance-part1.md](biomax-attendance-part1.md). Nothing below this
line has changed: the Digisme sync still reads `GetEmployeeDetails` only,
and no attendance is *calculated* anywhere. The rest of this section is the
pre-Part-1 state, kept for the record.

**There was none.**

`grep -ril "attendance|biometric|punch|check_in|clock_in|muster|leave_|lop"`
across both repositories returns nothing. No table, no migration, no
repository, no route, no page. `shift_master` defines shift timings but
nothing records whether anybody worked them.

Attendance is captured in **Digisme** and has never been pulled across. The
existing sync reads `GetEmployeeDetails` only.

This is the single largest gap between the current schema and a payroll
module, and the first thing the proposal addresses.

---

## 4. API structure

### Layering

Three layers, wired by hand in `server.js`:

```
routes/<name>.js     Express Router, Joi validation, HTTP shape
   ↓
usecase/<name>.js    orchestration
   ↓
repository/<name>.js raw mysql callbacks wrapped in Promises, logger.Log on error
```

`server.js` does it in four passes: `initRepositories()` (~line 141),
`initUsecases()` (~line 357), `initRoutes()` (~line 638) and the `app.use()`
mount table (~line 834). A module is added by touching all four.

Every module exports a factory:

```js
class XRoutes { constructor(xUsecase) { this.xUsecase = xUsecase; this.init(); } … }
module.exports = (xUsecase) => new XRoutes(xUsecase);
```

Migrations are **db-migrate**: a boilerplate `.js` in
`migrations/mysql/migrations/` that reads a matching `-up.sql` / `-down.sql`
pair from `migrations/mysql/migrations/sqls/`. Filenames are
`YYYYMMDDHHMMSS-kebab-name`.

### HR endpoints

Mounted at `/employee`, `/designation`, `/department`, `/shift`, `/outlet`,
`/store`, `/salary`, `/resignation`, `/family`, `/document`.

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/employee` | create |
| GET | `/employee/employees` | full list; accepts `store_ids[]`, `designation_ids[]`; joins designation, department, outlet, shift, resignation |
| GET | `/employee/employee_id`, `/get-details`, `/filter`, `/store_id` | single / current user / search / per-branch count |
| GET | `/employee/headcount`, `/resignedemp`, `/newjoinee`, `/newjoiner`, `/birthday`, `/anniversary`, `/bank`, `/familydet` | dashboard cuts |
| POST | `/employee/updatedata`, `/employee/update-status` | update |
| POST | `/employee/sync` | manual Digisme pull |
| GET | `/designation`, `/designation/designation_id`, `/count`, `/budget`, `/permissions` | `/permissions` returns the permission set for a designation |
| POST | `/designation/create`, `/update-designation`, `/update-status` | |
| GET | `/outlet`, `/outlet/outlet_id`, `/outlet/id` | |
| POST | `/outlet/create`, `/update-outlet`, `/update-status` | |
| GET/POST | `/shift`, `/department`, `/resignation`, `/family` | same create / update-x / update-status shape |
| GET | `/salary`, `/salary/payment_id` | the loan tracker |
| POST | `/salary/create`, `/update-payment`, `/update-status`, `/update-paidstatus` | |

Older routes answer `200` with `{code: 500, msg}` in the body on failure.
`routes/advance_request.js` is the newer convention and sets real HTTP status
codes (400/404/409/500) — copy that one.

### Authentication

`middlewares/auth.js` reads a JWT from the **`x-access-token`** header and
populates `req.decoded` with `{ id, store_id, user_type, designation_id,
employee_id }`. `user` table: `user_id`, `username`, `user_type`,
`employee_id`, `password`, `status`, `allowed_ips`, `ip_policy`.
`user_type = 2` is admin.

> **This matters for payroll.** `middlewares/auth.js` opens with an
> `unProtectedRoutes` map that skips authentication entirely, and it currently
> lists **every** `/employee`, `/designation`, `/shift`, `/department`,
> `/outlet`, `/resignation`, `/family`, `/document` and `/salary` endpoint
> above. Salary figures, bank accounts, PAN and Aadhaar numbers are served to
> unauthenticated callers today. `middlewares/ip_restriction.js` cannot cover
> them either, since it depends on `req.decoded`, which these routes never
> populate.

### Authorisation

`middlewares/permissions.js`, built once from the designation usecase:

- `permissions(designation_id, permission_key, is_active)` is the grant table;
  `all_permissions(permission_id, permission_key, status)` is the catalogue.
- `require("key_a", "key_b")` is route middleware, 403 unless the caller holds
  one of the keys; `has(req, key)` for checks inside a handler.
- `user_type = 2` bypasses everything. Sets are cached per designation for 60s;
  `invalidate(id)` after an edit.

A new permission key is added by a migration
(`INSERT INTO all_permissions (permission_key) VALUES ('…')`) plus an entry in
the frontend's `constants/permissions.js`. `routes/advance_request.js:118-127`
is the reference for applying them.

### Cron and sync logging

`services/cron_service.js` registers jobs; `api_sync_log` records each run via
`apiSyncLogger.wrapCron(logType, path, fn)`. Current jobs: `product_sync`
(04:00), `employee_sync` (07:00), `stock_holding_report_sync` (07:30),
cleaning/packing (09:00). Visible in the app under `/uploads` / API sync log.

---

## 5. Frontend structure

Next.js pages router, Chakra UI.

```
pages/<module>/index.jsx , [id].jsx     screens
helper/<module>.js                      one object of Promise-returning API calls
customHooks/use<Module>.js              data fetching for the screens
util/api.js                             axios instance; NEXT_PUBLIC_API_URL,
                                        x-access-token, 403 → /login redirect
constants/permissions.js                permission key → human label, grouped
constants/menus.js                      navigation tree, each leaf gated by a permission
customHooks/usePermissions.js           client-side gate (presentation only)
contexts/UserContext.js                 userConfig.permissions
components/table/table.js               the shared grid
```

Existing HR screens: `pages/employee`, `/designation`, `/department`,
`/shift`, `/family`, `/resignation`, `/salary`, `/document`, `/newjoiner`,
`/adhaar`, `/without-adhaar`, `/store-budget`. The `employee` menu group in
`constants/menus.js` currently exposes only Employee, Department and
Designation; the rest are commented out.
