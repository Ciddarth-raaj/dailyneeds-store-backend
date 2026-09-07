# Payroll and HR — target architecture

A proposal. Nothing here is implemented.

**Target: dnds.co.in owns the complete employee lifecycle, attendance, shifts
and payroll. Digisme is discontinued.**

This supersedes [payroll-integration-proposal.md](payroll-integration-proposal.md),
which assumed Digisme stayed. [hr-schema.md](hr-schema.md) remains accurate as
the as-is record and is assumed throughout.

The as-is in one paragraph: `new_employee` is the employee master, PK
`employee_id` = Digisme's `EmployeeCode`, and it is overwritten nightly at
07:00 by `services/synker.js` along with `designation`, `department` and
`outlets`. There is no attendance data in the database at all. `shift_master`
exists but is never reconciled — the sync writes a `shift_code` string onto
the employee and leaves `shift_id` stale. `/salary` + `payment_det` is a
name-keyed staff loan tracker, not payroll. Every HR endpoint is listed in
`unProtectedRoutes` and served without authentication.

---

## 1. Employee master ownership

### 1.1 Recommendation: keep the existing `employee_id` values

**Yes — retain them. Do not renumber.** This is the single highest-leverage
decision in the migration, and the cost of getting it wrong is silent data
corruption rather than a visible failure.

`employee_id` is already the actor key across the whole application. Counting
the schema:

**Twelve tables declare a hard foreign key** to `new_employee(employee_id)`:

| Table | Column | On delete |
| --- | --- | --- |
| `material_request` | `created_by` | *(none — restrict)* |
| `eb_consumption` | `created_by` | *(none — restrict)* |
| `product_image_log` | `created_by` | RESTRICT |
| `purchase_return_extra` | `created_by` | SET NULL |
| `purchase_acknowledgement` | `created_by` | SET NULL |
| `stock_checker` | `created_by` | SET NULL |
| `stock_checker_items` | `created_by` | SET NULL |
| `products_expiry_checker_items` | `created_by` | SET NULL |
| `pick_pack_write_off` | `reason_employee_id` | SET NULL |
| `product_distributor` | `buyer_id` | SET NULL |
| `gst_purchase_match` | `matched_by` | *(none)* |
| `gst_purchase_no_2a_accept` | `accepted_by` | *(none)* |
| `stock_holding_report` | `created_by` | *(none)* |

**Roughly fifty actor columns exist in total** across the schema
(`created_by` ×18, `employee_id` ×9, `uploaded_by` ×6, `paid_by` ×3,
`buyer_id` ×3, `balance_checked_by` ×3, `approved_by` ×3, plus
`matched_by`, `accepted_by`, `assigned_to`, `changed_by`, `updated_by`,
`reason_employee_id`, `balance_action_by`, `cashier_id`). Most of them —
including every actor column on `advance_requests` — have **no FK
constraint at all**. A renumbering pass would have no referential safety net
on the majority of references: a column missed from the rewrite script would
not error, it would silently repoint years of history at a different person.

Three further dependencies make renumbering worse than it first looks:

- **`user.employee_id`** links a login to a person, and `usecase/user.js`
  puts `employee_id` **into the signed JWT**. Tokens last a day
  (`jwt.sign(info, "1d")`), so a renumber during business hours leaves every
  already-issued token pointing at the wrong employee until it expires.
- **Snapshot tables denormalise the resolved name**, not just the id —
  `stock_holding_items_snapshot`, `dead_stock_items_snapshot` and the
  price-checker buyer snapshot all carry `ne.employee_name` joined via
  `buyer_id`. Renumbering desynchronises snapshots from live rows.
- **Digisme's `EmployeeCode` is what staff and the branch managers already
  know people by.** Changing it changes the number on every existing record
  anyone might look up.

There is no upside to renumbering, and the decision is settled:

**`employee_id` is the permanent employee code and the primary employee
identity.** It is not a surrogate for something else and no second code is
introduced alongside it. Every existing value stays exactly as it is. Every
existing reference, every JWT claim and every historical record keeps using
it unchanged. It was Digisme's `EmployeeCode`; after migration it is simply
dnds.co.in's employee code, and the fact that Digisme once allocated it is
history rather than dependency.

**New employees continue the same convention.** The codes are plain
sequential integers, and new local hires take the next one. The column is
already `AUTO_INCREMENT`, and InnoDB advances the counter past any explicit
value inserted, so the sequence continues from the current maximum with no
gap and no reserved range. Two things must change for that to work cleanly:

- `POST /employee` currently requires the client to supply `employee_id`
  (`routes/employee.js`, Joi `employee_id: Joi.number().required()`), so
  today the person entering a joiner types the next code by hand. Allocation
  moves to the server: the create path omits `employee_id` from the
  `INSERT`, lets MySQL assign it, and returns `insertId`. A hand-typed code
  is how a collision happens.
- One marker column is added so the origin of a row is recorded:

```
origin   ENUM('digisme','local') NOT NULL DEFAULT 'local'
         backfilled to 'digisme' for every row that exists at migration time
```

`origin` replaces the idea of a separate Digisme reference column. A
`digisme_employee_code` would hold exactly the value already in
`employee_id` for every migrated row, so it records nothing. What is worth
recording is *which system created the row*, and `origin` does that.

**The overlap period needs one guard.** While the Digisme sync is still
writing `new_employee` (Sync Stages A and B in §2), a code allocated locally
could later be allocated by Digisme for a different person, and the sync's
`INSERT … ON DUPLICATE KEY UPDATE` would overwrite the local employee with
Digisme's. The guard is in the sync, not the schema: before upserting, the
sync checks incoming codes against rows where `origin = 'local'`, skips any
match, and records it in `digisme_sync_diff` as a conflict. In shadow mode
the sync writes nothing, so the conflict surfaces as a diff regardless. Once
the sync is off, the guard is dead code and goes with it.

**No new employee table.** `new_employee` is extended in place. The name is
poor — it has meant "the employee table" since 2021 — but renaming it would
churn every query in `repository/` for no functional gain. Leave it.

### 1.2 What stops being Digisme's

After cutover, every column on `new_employee` is locally owned and locally
edited. `origin` is the only trace of where a row came from, and it is inert.

---

## 2. Phasing out the nightly master sync

**Nothing is removed now.** The sync stays running through Stages 0 and 1 and
is switched off in three deliberate steps, each independently reversible.

### 2.1 How the sync actually writes, and why that makes this easy

`syncDigismeEmployees()` in `services/synker.js` maps the Digisme response
into a flat object per employee, then hands the array to
`repository/employee.js#bulkCreate` (line 552). That method builds its column
list **from the keys present on the first row**:

```js
const columns = Object.keys(rows[0]);
const doNotUpdate = new Set(["employee_id", "created_at"]);
const updateAssignments = columns.filter(c => !doNotUpdate.has(c))
  .map(c => `\`${c}\` = VALUES(\`${c}\`)`).join(", ");
// INSERT ... ON DUPLICATE KEY UPDATE <updateAssignments>
```

So **the set of Digisme-owned columns is exactly the set of keys the mapper
emits.** Narrowing Digisme's ownership is a change to one object literal in
`synker.js` — not a schema change, not a repository change. The same holds
for `designation`, `department` and `outlets`, which go through the
equivalent `bulkCreate` in their own repositories.

This is what makes a staged withdrawal safe: each stage is a small,
revertible edit to the field map, guarded by config.

### 2.2 Configuration

Add `config/digisme.js` following the shape of `config/delium.js`, but with
**no hardcoded credential defaults** (see §11):

```js
{
  enabled:        process.env.DIGISME_SYNC_ENABLED === "true",
  mode:           process.env.DIGISME_SYNC_MODE || "write",  // write | shadow | off
  ownedTables:    (process.env.DIGISME_SYNC_TABLES || "employee,designation,department,outlet")
                    .split(","),
  apiKey:         process.env.DIGISME_API_KEY,      // required when enabled
  customKey:      process.env.DIGISME_CUSTOM_KEY,
  baseUrl:        process.env.DIGISME_BASE_URL,
}
```

`mode` is the important one. `shadow` runs the whole fetch and mapping but
writes divergences to a diff table instead of the masters — the mechanism
Stage B relies on.

### 2.3 Stage A — stop overwriting locally managed fields

Narrow the Digisme field map, per table, to identity only. Everything else
becomes locally owned immediately.

| Table | Digisme keeps writing | Becomes locally owned |
| --- | --- | --- |
| `new_employee` | `employee_id` (match key only) | `employee_name`, `designation_id`, `department_id`, `store_id`, `shift_code`, `status`, `resignation_date`, `gender`, `marital_status`, `primary_contact_number` |
| `designation` | nothing | all — new designations created in the app |
| `department` | nothing | all |
| `outlets` | nothing | all — branches change perhaps once a year |

`designation`, `department` and `outlets` can be released **first and
together**. They are small, slow-moving, already have unique `*_code`
columns, and the app already has full CRUD screens and endpoints for all
three. There is no meaningful risk in taking them local on day one; the only
thing the sync does for them today is auto-create a row when Digisme reports
a code we have never seen, which after cutover is a thing HR does
deliberately.

`new_employee` is the one with real content, so it stays partially synced
longer. Note that the fields payroll cares about most — `salary`, bank,
PF/ESI/UAN/PAN/Aadhaar, `date_of_joining` — are **already** locally owned
today, because the Digisme payload never contains them. Stage A only has to
release the posting and lifecycle fields.

Exit criterion for Stage A: joiners, leavers, transfers and promotions are
being entered in dnds.co.in by HR, and Digisme is no longer the place anyone
types them.

### 2.4 Stage B — shadow mode, validate local management

Flip `DIGISME_SYNC_MODE=shadow`. The cron still authenticates, fetches and
maps, but instead of writing it records every field where Digisme and
dnds.co.in disagree:

```
digisme_sync_diff
  diff_id PK, run_at TIMESTAMP, entity ENUM('employee','designation','department','outlet'),
  entity_key VARCHAR(20),          -- the Digisme code
  field VARCHAR(64),
  local_value VARCHAR(255), digisme_value VARCHAR(255),
  reviewed_at TIMESTAMP NULL, reviewed_by INT NULL,
  verdict ENUM('local_correct','digisme_correct','ignored') NULL
  INDEX (run_at), INDEX (entity, entity_key)
```

A small screen lists unreviewed diffs. Every `digisme_correct` verdict is a
gap in the local process — a joiner someone forgot to enter, a transfer
recorded in the wrong place — and is fixed in dnds.co.in, not in Digisme.

**Exit criterion: two full payroll months with zero `digisme_correct`
verdicts on `new_employee`.** Two months rather than one, because a monthly
process has monthly failure modes and one clean cycle proves nothing.
`designation` / `department` / `outlets` should reach zero within days.

Shadow mode is also what makes Stage C reversible in practice: if something
is wrong, the field map is widened again and the sync is put back into
`write` for that table alone.

### 2.5 Stage C — disable completely

1. `DIGISME_SYNC_ENABLED=false`. The cron is not registered; nothing calls
   Digisme. Leave it this way for one full payroll cycle.
2. Complete the **export** in §10 and verify the archive independently of
   Digisme (row counts, spot-checks against payslips).
3. Terminate the Digisme contract.
4. Delete `syncDigismeEmployees`, `_fetchDigismeEmployees`,
   `_authenticateDigisme`, `getDigismeToken`, the `employee_sync` cron
   registration and `POST /employee/sync` from `services/synker.js` and
   `routes/employee.js`. Keep `config/digisme.js` deleted too. Keep
   `origin` and `digisme_sync_diff` — they are history.

Order matters: **do not terminate the contract before the export is verified.**
Once the account is closed, anything not exported is gone.

---

## 3. Employee master fields

`E` = exists today and is adequate · `E*` = exists but needs a type or
semantic change · `A` = add.

| Field | Status | Column and note |
| --- | --- | --- |
| Employee code | E | `employee_id` **is** the code and the identity — permanent, never renumbered. New hires continue the integer sequence via server-side allocation (§1.1). Add `origin ENUM('digisme','local')`. |
| Employee name | E | `employee_name VARCHAR(45)` — widen to 100; Digisme truncates |
| Date of birth | E | `dob DATE` |
| Gender | E | `gender VARCHAR(45)` — normalise to `ENUM('M','F','O')` |
| Mobile | E | `primary_contact_number`, `alternate_contact_number` |
| Address | E | `permanent_address`, `residential_address` (LONGTEXT) |
| Date of joining | **E\*** | `date_of_joining VARCHAR(45)` → **`DATE`**. It is a string today and payroll cannot do date arithmetic on it. Requires a parse-and-backfill migration with a manual exception list for unparseable rows. |
| Designation | E | `designation_id` → `designation` — **add the missing FK** |
| Department | E | `department_id` → `department` — add FK |
| Outlet / location | E | `store_id` → `outlets.outlet_id` — add FK |
| Employment type | **A** | `employment_type ENUM('permanent','probation','contract','temporary','trainee','part_time')` |
| Probation status | **A** | `probation_status ENUM('not_applicable','on_probation','confirmed','extended')`, `probation_end_date DATE`, `confirmation_date DATE` |
| Reporting manager | **A** | `reporting_manager_id INT NULL` → `new_employee(employee_id)`, `ON DELETE SET NULL`. Self-referencing. Needed for OT approval routing (§7). Guard against cycles in the usecase. |
| Default shift | **E\*** | `shift_id` exists but is stale and unreconciled; `shift_code` is a Digisme string. Replace both with `default_shift_id INT` → `shift_master(shift_id)` with a real FK. Backfill by matching `shift_code` → `shift_master.shift_code` (§4), reporting unmatched rows for manual assignment. Drop `shift_code` after Stage C. |
| Weekly off rule | **A** | `weekly_off_rule_id INT NULL` → `payroll_weekly_off_rule` (§5.1) |
| PF applicability | **E\*** | `pf VARCHAR(45)` is free text → `pf_applicable TINYINT(1) NOT NULL DEFAULT 0`, plus `pf_joining_date DATE NULL` |
| ESI applicability | **E\*** | `esi VARCHAR(45)` free text → `esi_applicable TINYINT(1) NOT NULL DEFAULT 0` |
| UAN | E | `uan VARCHAR(45)` — add a 12-digit format check in the usecase |
| ESI number | E | `esi_number VARCHAR(45)` |
| PAN | E | `pan_no VARCHAR(45)` — validate `[A-Z]{5}[0-9]{4}[A-Z]` |
| Aadhaar | E | `aadhaar_card_no`, `aadhaar_card_name`, `aadhaar_card_image` |
| Bank account | **E\*** | `bank_name`, `ifsc`, `account_no` exist but are unvalidated free text. Add IFSC format validation and a confirm-account-number field in the UI; snapshot per payout (§9). |
| Status | E | `status TINYINT` — formalise as `ENUM`-like: 1 active, 0 inactive |
| Resignation date | E | `resignation_date DATE` — meaning: date the resignation was *tendered* |
| Last working date | **A** | `last_working_date DATE NULL` — **distinct from resignation date and the one payroll actually uses.** Notice periods mean the two differ by weeks; paying to the resignation date is a real and expensive error. |

Also add for lifecycle completeness: `exit_type ENUM('resignation','termination','retirement','abscond','contract_end')`,
`exit_reason VARCHAR(500)`, `rehire_eligible TINYINT(1)`.

The legacy `resignation` table (keyed by `employee_name`) is superseded by
these columns and should stop being written. `usecase/employee.js#get()`
currently filters the employee list with a `NOT IN (names…)` clause built
from it — that must move to `new_employee.status`.

### 3.1 Sensitive fields

**PAN, Aadhaar, bank account, salary and salary structure are the sensitive
set.** They need three things, none of which exist today.

**Never `SELECT *` on the employee master.** `repository/employee.js:507`
currently does exactly that on `GET /employee/employee_id`, returning the
Aadhaar number, Aadhaar image and bank account to anyone who asks — on an
endpoint that is in `unProtectedRoutes`. Replace with an explicit column
allowlist chosen by the caller's permissions.

**Mask by default.** The list and detail endpoints return
`account_no` as `••••1234`, `pan_no` as `••••••1234A`, `aadhaar_card_no` as
`••••••••9012`, and omit `salary` entirely. Full values come only from a
dedicated call:

| Permission | Grants |
| --- | --- |
| `view_employees` | the non-sensitive master |
| `view_employee_sensitive` | full PAN, Aadhaar, bank |
| `edit_employee_sensitive` | writing them |
| `view_payroll_salary` | salary structures and payslip amounts |
| `view_own_payslip` | the signed-in user's own payslip only, via `user.employee_id` |

**Log every unmasked read.** `payroll_activity` (§9.4) takes rows with
`field = 'sensitive_read'` recording who read whose PAN/Aadhaar/bank and
when. This is the part people skip, and it is the part that matters when
something leaks.

---

## 4. Shift master

`shift_master` exists (`shift_id`, `shift_name`, `shift_in_time TIME`,
`shift_out_time TIME`, `status`). **Extend it in place** — the `shift_id` PK
is already referenced from `new_employee` and there is no reason to create a
second shift table.

```
shift_master  (extended)
  shift_id                    INT PK                    existing
  shift_code                  VARCHAR(20) UNIQUE        ADD - matches the
                                                        Digisme ShiftCode
                                                        values already sitting
                                                        in new_employee.shift_code,
                                                        so the backfill can join
  shift_name                  VARCHAR(150)              existing
  start_time                  TIME                      existing shift_in_time
  end_time                    TIME                      existing shift_out_time
  crosses_midnight            TINYINT(1) DEFAULT 0      ADD
  break_minutes               INT DEFAULT 0             ADD
  paid_hours                  DECIMAL(4,2)              ADD
  late_grace_minutes          INT DEFAULT 0             ADD
  early_exit_grace_minutes    INT DEFAULT 0             ADD
  minimum_full_day_minutes    INT                       ADD
  minimum_half_day_minutes    INT                       ADD
  overtime_allowed            TINYINT(1) DEFAULT 0      ADD
  overtime_start_after_minutes INT NULL                 ADD
  maximum_ot_minutes_per_day  INT NULL                  ADD
  active                      TINYINT(1) DEFAULT 1      existing `status`
  created_at, updated_at                                ADD
```

Rename `shift_in_time`/`shift_out_time` → `start_time`/`end_time` and
`status` → `active` in the same migration; only `repository/shift.js` and
`repository/employee.js` reference them.

`crosses_midnight` is what makes night-shift attendance correct: a punch-out
at 02:10 belongs to the previous day's shift. The attendance processor
(§6.3) reads this flag to decide which work date a punch is attributed to —
without it, every night-shift worker looks absent one day and doubly present
the next.

**Existing rows are suspect.** `shift_master` has never been maintained
against Digisme and `new_employee.shift_id` is largely stale. Treat the
existing rows as untrusted: define the real shift set from scratch with
operations, backfill `shift_code` from the Digisme values, then map every
active employee to a `default_shift_id`, listing the unmatched for manual
assignment. This is a data exercise, not a code one, and it should happen in
Stage 1 while Digisme is still available to answer questions.

**Default shift, roster overrides.** `new_employee.default_shift_id` is the
fallback. The roster (§5) overrides it for a given date. Attendance
processing resolves the shift for a day as: roster row → employee default →
unresolved (flagged, not guessed).

---

## 5. Shift roster

### 5.1 Weekly off rules

Weekly offs are a rule, not a per-day fact, so they are defined once and
expanded into the roster:

```
payroll_weekly_off_rule
  weekly_off_rule_id PK, name VARCHAR(100),
  pattern ENUM('fixed_day','rotating','alternate_week','none'),
  fixed_day TINYINT NULL,            -- 0=Sun … 6=Sat, for 'fixed_day'
  config JSON NULL,                  -- rotation definition for the others
  active TINYINT(1) DEFAULT 1
```

Retail rarely gives everyone Sunday off, so `rotating` and `alternate_week`
matter here. The rule generates candidate weekly-off dates; the roster is
what actually holds them, so an exception ("she took Tuesday off this week
instead") is a roster edit and does not fight the rule.

### 5.2 Roster

```
payroll_shift_roster
  roster_id        BIGINT PK
  employee_id      INT NOT NULL   FK new_employee(employee_id)
  work_date        DATE NOT NULL
  shift_id         INT NULL       FK shift_master(shift_id)   -- NULL when weekly off
  outlet_id        INT NULL       FK outlets(outlet_id)       -- assigned location that day
  is_weekly_off    TINYINT(1) NOT NULL DEFAULT 0
  is_holiday       TINYINT(1) NOT NULL DEFAULT 0
  status           ENUM('draft','published','locked') NOT NULL DEFAULT 'draft'
  source           ENUM('bulk','rule','manual') NOT NULL
  remarks          VARCHAR(255) NULL
  changed_by       INT NULL       FK new_employee(employee_id)
  changed_at       TIMESTAMP
  created_at       TIMESTAMP
  UNIQUE (employee_id, work_date)
  INDEX (work_date, outlet_id)
  INDEX (outlet_id, work_date, shift_id)
```

`outlet_id` on the roster is what makes a mid-month branch transfer, or a
day covering another branch, come out right in branch-wise payroll cost —
`new_employee.store_id` only knows where someone is *now*.

**Status.** `draft` is editable and invisible to staff; `published` is the
committed roster; `locked` is set when the attendance period closes and the
roster becomes historical. A locked roster row is never edited — a
correction after lock is an attendance correction (§6.5), not a roster edit.

**Bulk assignment.** `POST /payroll/roster/bulk` takes
`{ from_date, to_date, outlet_id?, employee_ids[], shift_id, weekly_off_rule_id? }`,
expands the date range, applies the weekly-off rule, and upserts on
`(employee_id, work_date)` — skipping locked rows and reporting them. That
covers "this branch, this shift, next month" and "copy last week onto this
week" in one endpoint. The frontend already has spreadsheet import helpers
(`util/parseSpreadsheetFile.js`, `util/fileImport.js`, used by the price
checker) if roster upload from Excel is wanted too.

A nightly job materialises roster rows for a rolling horizon from each
employee's default shift and weekly-off rule, so an unrostered employee is
never silently absent.

---

## 6. Attendance

**Digisme is not the attendance source. Biomax is.** Raw punches are kept
separate from processed payroll attendance, as two distinct tables with a
one-way processing step between them.

### 6.1 Biomax integration routes

Biomax has sold biometric and face terminals in India since 2014 and states
that its devices integrate with third-party software through REST API and
SDK, and export CSV/XML/Excel. The current range (SpeedFace-series face
terminals, N-BM30W fingerprint units) is ZKTeco-derived hardware, which means
the well-documented ZKTeco integration paths apply. Four routes, in the order
I would evaluate them:

**(a) ADMS / PUSH protocol — recommended.** The device initiates an outbound
HTTP(S) connection to a server URL configured on the terminal and posts
punches as they happen. Endpoints are `/iclock/cdata` (registration and data),
`/iclock/getrequest` (device polls for commands) and `/iclock/devicecmd`
(command acknowledgement); the payload is plain-text `key=value`, not JSON,
and the device identifies itself by serial number.

Why it fits here: the branches have no static IPs and sit behind consumer
NAT, and outbound-only means no VPN, no port forwarding, and no per-branch
network work. It is real-time, and the same channel can push employee
enrolment *to* the devices later.

The cost is an **unauthenticated public endpoint**, which given §11 needs
handling with care: mount it outside the JWT middleware but behind (i) a
long random secret path segment, (ii) a device serial allowlist in
`payroll_device`, (iii) an IP allowlist of the branch WAN addresses, and
(iv) HTTPS only. It accepts punches and nothing else — no reads, no employee
data. Rate-limit per serial.

**(b) Pull SDK over TCP 4370.** We poll each terminal. More control and no
inbound endpoint, but it needs each device reachable from the server — a
per-branch VPN or static IP across six locations — and the vendor SDK is
Windows-DLL-oriented, so a Node implementation means a third-party
reimplementation of the protocol. Reasonable fallback if ADMS turns out to
be unavailable on the installed firmware.

**(c) Read the BioMax attendance software's database directly.** Fastest to
build and the least work, but it couples payroll to an undocumented vendor
schema and keeps a Windows box in the critical path of payroll — which is
precisely the class of dependency this whole programme is removing. Not
recommended as the permanent route.

**(d) Scheduled CSV/XML export import.** Bootstrap and permanent fallback.
Worth building regardless of which live route is chosen, because it is what
gets used the week a device or a link is down, and because it is how
historical punch data is loaded during migration.

**Recommendation: (a) as the live route, (d) as the standing fallback.**
Before committing, one thing must be confirmed with the vendor or the
installed units: **which protocol the deployed firmware actually speaks**,
and whether the terminals can be pointed at a self-hosted ADMS server
without voiding support. That is a half-day of investigation and it gates
the whole attendance stage. Build the ingestion behind a `source` column so
the answer changes the adapter, not the schema.

### 6.2 Devices and enrolment

The device's internal user id is not `employee_id` and must be mapped
explicitly. Guessing this is how attendance ends up on the wrong person.

```
payroll_device
  device_id PK, serial_no VARCHAR(64) UNIQUE, name VARCHAR(100),
  outlet_id INT FK outlets(outlet_id),
  vendor ENUM('biomax','other') DEFAULT 'biomax',
  protocol ENUM('adms','pull','file'),
  last_seen_at TIMESTAMP NULL, last_punch_at TIMESTAMP NULL,
  active TINYINT(1) DEFAULT 1

payroll_device_enrollment
  enrollment_id PK, device_id FK, device_user_id VARCHAR(32),
  employee_id INT FK new_employee(employee_id),
  enrolled_at, active TINYINT(1) DEFAULT 1
  UNIQUE (device_id, device_user_id)
```

`last_seen_at` drives a **device-silent alert** — a terminal that has not
checked in for some hours is the most common cause of an entire branch
showing as absent, and it must be noticed on the day, not at period close.
Route it through the existing Telegram service, as other alerts already are.

### 6.3 Raw punches, kept separate

```
payroll_punch
  punch_id      BIGINT PK
  device_id     INT NULL  FK payroll_device(device_id)
  device_user_id VARCHAR(32) NULL      -- as reported, before mapping
  employee_id   INT NULL  FK new_employee(employee_id)  -- resolved; NULL = unmatched
  punch_at      DATETIME NOT NULL      -- exactly as reported by the device
  direction     ENUM('in','out','unknown') NOT NULL DEFAULT 'unknown'
  verify_mode   VARCHAR(20) NULL       -- finger / face / card / password
  source        ENUM('adms','pull','file','manual') NOT NULL
  raw_payload   VARCHAR(500) NULL
  received_at   TIMESTAMP
  processed_at  TIMESTAMP NULL
  UNIQUE (device_id, device_user_id, punch_at)   -- idempotent re-delivery
  INDEX (employee_id, punch_at)
  INDEX (processed_at)
```

**This table is append-only and is never edited.** Devices re-send on
reconnect, so the unique key makes ingestion idempotent. Unmatched punches
(`employee_id IS NULL`) go to an exceptions queue rather than being dropped.

Many terminals report every punch as the same type, so `direction` is often
`unknown` — the processor derives in/out by ordering, and the shift's
`crosses_midnight` flag decides which work date a punch belongs to.

### 6.4 Processed attendance

One row per employee per date. This is what payroll reads; it never reads
punches.

```
payroll_attendance_day
  attendance_id     BIGINT PK
  employee_id       INT NOT NULL FK new_employee(employee_id)
  work_date         DATE NOT NULL
  roster_id         BIGINT NULL FK payroll_shift_roster(roster_id)
  shift_id          INT NULL FK shift_master(shift_id)     -- shift as applied
  outlet_id         INT NULL FK outlets(outlet_id)         -- location as worked

  first_in          DATETIME NULL
  last_out          DATETIME NULL
  punch_count       INT NOT NULL DEFAULT 0
  worked_minutes    INT NOT NULL DEFAULT 0
  late_minutes      INT NOT NULL DEFAULT 0
  early_out_minutes INT NOT NULL DEFAULT 0

  status            ENUM('present','half_day','absent','weekly_off','holiday',
                         'leave','on_duty','not_processed') NOT NULL
  leave_type_id     INT NULL
  payable_units     DECIMAL(4,2) NOT NULL DEFAULT 0     -- 1.00 / 0.50 / 0.00

  detected_ot_minutes INT NOT NULL DEFAULT 0            -- see §7

  source            ENUM('device','manual','import') NOT NULL
  is_corrected      TINYINT(1) NOT NULL DEFAULT 0
  locked            TINYINT(1) NOT NULL DEFAULT 0
  processed_at      TIMESTAMP NULL
  created_at, updated_at
  UNIQUE (employee_id, work_date)
  INDEX (work_date, outlet_id)
  INDEX (work_date, status)
```

`payable_units` is **stored, not derived at payroll time**. If the half-day
threshold changes next year, a closed period must not silently restate
itself.

The processor runs nightly for the previous day and on demand for a range:
resolve shift from roster → default; gather punches for the shift window
(extended past midnight when `crosses_midnight`); derive `first_in`,
`last_out`, `worked_minutes`; apply `late_grace_minutes` and
`early_exit_grace_minutes`; classify against `minimum_full_day_minutes` and
`minimum_half_day_minutes`; compute `detected_ot_minutes` against
`overtime_start_after_minutes`, capped at `maximum_ot_minutes_per_day`.
**It never writes a row whose period is locked**, and never touches a row
where `is_corrected = 1` unless explicitly asked to reprocess.

### 6.5 Corrections and manual attendance

Both go through approval; neither edits `payroll_punch`.

```
payroll_attendance_correction
  correction_id PK, attendance_id BIGINT NULL, employee_id INT NOT NULL,
  work_date DATE NOT NULL,
  correction_type ENUM('missing_punch','wrong_status','manual_attendance',
                       'on_duty','regularisation'),
  proposed_first_in DATETIME NULL, proposed_last_out DATETIME NULL,
  proposed_status VARCHAR(20) NULL, proposed_payable_units DECIMAL(4,2) NULL,
  reason VARCHAR(500) NOT NULL,
  document_url VARCHAR(500) NULL,
  status ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  requested_by INT NOT NULL FK new_employee(employee_id),
  approved_by  INT NULL     FK new_employee(employee_id),
  approved_at TIMESTAMP NULL, approver_note VARCHAR(500) NULL,
  created_at, updated_at
  INDEX (status, work_date), INDEX (employee_id, work_date)
```

An approved correction writes through to `payroll_attendance_day`, sets
`is_corrected = 1` and `source = 'manual'`, and logs to `payroll_activity`.
Corrections are only accepted while the period is open; after close they are
arrears (§9.3).

Manual attendance — someone who worked at a branch with no device, or a
field visit — is the same table with `correction_type = 'manual_attendance'`
and no underlying punch. Keeping it here rather than allowing direct edits to
`payroll_attendance_day` means every non-device day carries a reason, a
requester and an approver.

---

## 7. Overtime

**A late punch-out is not overtime.** Four separate quantities are stored,
and payroll reads only the last one.

Columns on `payroll_attendance_day` plus an approval table:

| Quantity | Where | Written by |
| --- | --- | --- |
| **Detected OT** | `payroll_attendance_day.detected_ot_minutes` | the attendance processor, from punches and shift rules. Never paid. |
| **Requested / eligible OT** | `payroll_ot_request.requested_minutes` | the employee or the branch manager raising it, or auto-raised from detected OT for review |
| **Manager-approved OT** | `payroll_ot_request.manager_approved_minutes` | the reporting manager (§3, `reporting_manager_id`) |
| **HR-approved / payable OT** | `payroll_ot_request.hr_approved_minutes` | HR — **the only figure payroll uses** |

```
payroll_ot_request
  ot_request_id BIGINT PK,
  employee_id INT NOT NULL FK new_employee(employee_id),
  work_date DATE NOT NULL,
  attendance_id BIGINT NULL FK payroll_attendance_day(attendance_id),
  detected_minutes         INT NOT NULL DEFAULT 0,
  requested_minutes        INT NOT NULL DEFAULT 0,
  manager_approved_minutes INT NULL,
  hr_approved_minutes      INT NULL,
  ot_rule_id INT NULL FK payroll_ot_rule(ot_rule_id),
  reason VARCHAR(500) NULL,
  status ENUM('detected','requested','manager_approved','manager_rejected',
              'hr_approved','hr_rejected','paid') NOT NULL DEFAULT 'detected',
  requested_by INT NULL, manager_id INT NULL, manager_acted_at TIMESTAMP NULL,
  hr_id INT NULL, hr_acted_at TIMESTAMP NULL,
  period_id INT NULL FK payroll_period(period_id),
  created_at, updated_at
  UNIQUE (employee_id, work_date)
  INDEX (status, work_date)
```

The statuses name who the request is waiting on, following the
`advance_requests` convention. Each approval may only *reduce* the minutes
below the previous stage — HR cannot approve more than the manager did, and
the manager cannot approve more than was detected unless the request carries
an explicit override reason. Enforce that in the usecase, not the UI.

Rules and multipliers are configurable, never hardcoded:

```
payroll_ot_rule
  ot_rule_id PK, name VARCHAR(100), code VARCHAR(20) UNIQUE,
  applies_to ENUM('all','designation','department','outlet','employment_type'),
  applies_to_id INT NULL,
  day_type ENUM('working_day','weekly_off','holiday','any') DEFAULT 'any',
  multiplier DECIMAL(4,2) NOT NULL DEFAULT 1.00,     -- 1.0 / 1.5 / 2.0
  rate_basis ENUM('basic','gross','fixed_hourly') NOT NULL,
  fixed_hourly_rate DECIMAL(10,2) NULL,
  rounding ENUM('none','nearest_15','nearest_30','down_30') DEFAULT 'none',
  min_minutes_to_qualify INT DEFAULT 0,
  max_minutes_per_month INT NULL,
  effective_from DATE NOT NULL, effective_to DATE NULL,
  active TINYINT(1) DEFAULT 1
```

Effective-dated like the salary structure, so a rate change next year does
not restate last year. OT reaches the payslip as a single **OT earning
component** line computed as
`hr_approved_minutes / 60 × hourly_rate(rate_basis) × multiplier`, with the
rule id and the minutes recorded on the line for traceability.

---

## 8. Salary structure

`new_employee.salary` — a free-text `VARCHAR(45)` holding one number with no
history — stops being the payroll source. It stays readable for reference
during migration and is dropped after Stage 2.

**No formulas on employee records.** The employee is attached to a
*structure*; the structure carries amounts; the *component* carries the rule.

```
payroll_component
  component_id PK, code VARCHAR(20) UNIQUE, name VARCHAR(100),
  type ENUM('earning','deduction','employer_contribution') NOT NULL,
  calculation ENUM('fixed','percent_of_basic','percent_of_gross',
                   'per_day','per_hour','computed') NOT NULL,
  default_percent DECIMAL(6,3) NULL,
  is_taxable TINYINT(1) DEFAULT 1,
  affects_pf TINYINT(1) DEFAULT 0,
  affects_esi TINYINT(1) DEFAULT 0,
  prorate_on_lop TINYINT(1) DEFAULT 1,
  show_on_payslip TINYINT(1) DEFAULT 1,
  sort_order INT, active TINYINT(1) DEFAULT 1
```

Seeded to exactly the required set:

| Earnings | `calculation` | Notes |
| --- | --- | --- |
| Basic | fixed | prorated on LOP |
| HRA | percent_of_basic | prorated |
| Special Allowance | fixed | prorated |
| Other Allowance | fixed | prorated |
| OT | computed | from `hr_approved_minutes` (§7); not prorated |
| Incentive | fixed | per-period input, not prorated |
| Arrears | computed | from `payroll_adjustment` (§9.3) |
| Bonus | fixed | per-period input |

| Deductions | `calculation` | Notes |
| --- | --- | --- |
| PF | percent_of_basic | on `pf_applicable`; statutory ceiling in the rule |
| ESI | percent_of_gross | on `esi_applicable`; wage-ceiling test |
| LOP | computed | from `payable_units` — the shortfall against the period's payable days |
| Employee Loan | computed | from `payroll_loan_installment` |
| Salary Advance | computed | from `payroll_loan_installment`, `loan_type='salary_advance'` |
| Other deductions | fixed | per-period input |

Employer contributions (PF employer, ESI employer) are modelled as
`employer_contribution` so employer cost is reportable without inflating the
employee's gross or net.

```
payroll_structure
  structure_id PK,
  employee_id INT NOT NULL FK new_employee(employee_id),
  effective_from DATE NOT NULL, effective_to DATE NULL,   -- NULL = current
  gross_monthly DECIMAL(12,2) NOT NULL,
  pay_basis ENUM('monthly','daily') NOT NULL DEFAULT 'monthly',
  revision_reason ENUM('initial','increment','promotion','correction','other'),
  revision_note VARCHAR(500) NULL,
  created_by INT FK new_employee(employee_id), approved_by INT NULL,
  created_at, updated_at
  UNIQUE (employee_id, effective_from)
  INDEX (employee_id, effective_from, effective_to)

payroll_structure_line
  structure_line_id PK, structure_id FK ON DELETE CASCADE,
  component_id INT NOT NULL FK payroll_component(component_id),
  amount DECIMAL(12,2) NULL, percent DECIMAL(6,3) NULL,
  UNIQUE (structure_id, component_id)
```

Effective dating gives increment history, mid-month revisions (the period
splits across two structures, prorated by days) and arrears for free.
Creating a new structure closes the previous row's `effective_to`; structures
are never edited after a period that used them is locked.

---

## 9. Payroll workflow

```
Attendance Period Close
   → Attendance Approval
      → Payroll Generation
         → HR Review
            → Admin Approval
               → Payroll Lock
                  → Payslip
                     → Bank Transfer
                        → Statutory / Accounts Export
```

### 9.1 Period state

```
payroll_period
  period_id PK, period_month DATE UNIQUE,      -- always the 1st
  attendance_from DATE, attendance_to DATE,    -- cycle need not be calendar month
  status ENUM('open','attendance_closed','attendance_approved','generated',
              'hr_reviewed','admin_approved','locked','paid','closed')
         NOT NULL DEFAULT 'open',
  total_gross DECIMAL(14,2) NULL, total_net DECIMAL(14,2) NULL,
  total_employer_cost DECIMAL(14,2) NULL, employee_count INT NULL,
  attendance_closed_by, attendance_closed_at,
  attendance_approved_by, attendance_approved_at,
  generated_by, generated_at,
  hr_reviewed_by, hr_reviewed_at,
  admin_approved_by, admin_approved_at,
  locked_by, locked_at, closed_at,
  created_at, updated_at
```

Each status names the step the period has completed and therefore who it is
waiting on — the `advance_requests` convention. Transitions are one-way
except `attendance_closed → open` and `generated → attendance_approved`
(regeneration), both of which require a permission and log to
`payroll_activity`. **Nothing reopens past `locked`.**

`attendance_from` / `attendance_to` exist because retail attendance cycles
are often 26th–25th rather than calendar months.

What each gate does:

- **Attendance Period Close** — sets `locked = 1` on every
  `payroll_attendance_day` in the window and `status='locked'` on the roster
  rows. The nightly processor and the device importer stop writing to the
  window; late punches still land in `payroll_punch` and are reported, not
  applied.
- **Attendance Approval** — an exception report must be clear: unprocessed
  days, unmatched punches, employees with no roster, pending corrections,
  pending OT requests. Approval is blocked while any remain open.
- **Payroll Generation** — computes payslips. Idempotent: regenerating
  deletes and rewrites payslips and lines for the period. Refused once
  `locked`.
- **HR Review** — variance report against the previous period per employee;
  anything beyond a threshold needs an explicit acknowledgement.
- **Admin Approval** — the single sign-off on totals.
- **Payroll Lock** — payslips become immutable, as below.
- **Payslip / Bank Transfer / Export** — §9.5–9.6.

### 9.2 Payslips

```
payroll_payslip
  payslip_id BIGINT PK, period_id INT FK, employee_id INT FK new_employee,
  -- snapshot: the masters move, the payslip must not
  employee_name VARCHAR(100),
  designation_id INT, designation_name VARCHAR(255),
  department_id INT, department_name VARCHAR(255),
  store_id INT, outlet_name VARCHAR(255),
  structure_id INT FK payroll_structure(structure_id),
  period_days DECIMAL(5,2), payable_days DECIMAL(5,2),
  present_days DECIMAL(5,2), weekly_off_days DECIMAL(5,2),
  holiday_days DECIMAL(5,2), leave_days DECIMAL(5,2), lop_days DECIMAL(5,2),
  ot_minutes INT DEFAULT 0,
  gross DECIMAL(12,2), total_deductions DECIMAL(12,2),
  net_payable DECIMAL(12,2), employer_cost DECIMAL(12,2),
  status ENUM('draft','on_hold','approved','paid') NOT NULL DEFAULT 'draft',
  hold_reason VARCHAR(500) NULL,
  computed_at TIMESTAMP, created_at, updated_at
  UNIQUE (period_id, employee_id)
  INDEX (period_id, store_id), INDEX (employee_id, period_id)

payroll_payslip_line
  payslip_line_id BIGINT PK, payslip_id FK ON DELETE CASCADE,
  component_id INT, component_code VARCHAR(20), component_name VARCHAR(100),
  type ENUM('earning','deduction','employer_contribution'),
  amount DECIMAL(12,2) NOT NULL,
  basis_note VARCHAR(255) NULL,     -- "1.5 × 320 min @ ₹— /hr, rule OT_HOL"
  sort_order INT
```

The snapshot columns are not redundancy for its own sake. Designation,
department and branch all change; a payslip reprinted in two years must show
what the person was actually paid as, and `basis_note` is what lets anyone
answer "why is this figure what it is" without re-running the calculation.

Payslip PDFs use the existing `services/pdf.js`.

### 9.3 Immutability after lock, and arrears

**Once `payroll_period.status = 'locked'`, no row belonging to that period is
ever updated** — not payslips, not lines, not attendance days, not roster
rows. This is enforced in the usecase layer on every write path, and it is
the property the whole design exists to protect.

Corrections that surface afterwards flow forward:

```
payroll_adjustment
  adjustment_id BIGINT PK,
  employee_id INT NOT NULL FK new_employee(employee_id),
  origin_period_id INT NOT NULL FK payroll_period,   -- the period being corrected
  target_period_id INT NULL FK payroll_period,       -- where it is paid; NULL = next open
  component_id INT NOT NULL FK payroll_component,    -- Arrears / Other deductions
  amount DECIMAL(12,2) NOT NULL,                     -- signed
  reason VARCHAR(500) NOT NULL,
  status ENUM('pending','applied','cancelled') NOT NULL DEFAULT 'pending',
  raised_by INT, approved_by INT NULL, approved_at TIMESTAMP NULL,
  payslip_line_id BIGINT NULL,     -- set when it lands
  created_at, updated_at
  INDEX (employee_id, status), INDEX (target_period_id, status)
```

A backdated increment, a late attendance regularisation, an OT approval that
missed the cut-off: all become an arrears line on the next open period,
carrying the period they relate to. Nothing rewrites history.

### 9.4 Loans, advances and audit

`payroll_loan` / `payroll_loan_installment` replace `payment_det`, keyed by
`employee_id` instead of a name string, with a real schedule whose recovery
lands as a deduction line on the payslip. `payment_det` is left read-only;
carrying its open balances forward requires a hand-reviewed name match,
because the join it was built on is unreliable by construction.

`payroll_activity` (`entity`, `entity_id`, `employee_id`, `field`,
`old_value`, `new_value`, `created_at`) records every transition across
periods, payslips, structures, attendance, corrections, OT, loans, payouts
and sensitive-field reads — the shape and reasoning of
`advance_request_activity`.

### 9.5 Bank transfer

`payroll_payout_batch` / `payroll_payout_item`, following the
advance-request pattern where the money moves in Tally and this system
records the instruction and the advice. Each item snapshots
`account_no`, `ifsc` and `bank_name` at instruction time and captures a UTR,
because the employee master's bank fields are hand-edited and a later
correction must not rewrite what was actually instructed.

### 9.6 Statutory and accounts export

Export files, not postings: PF ECR text, ESI return, professional tax
statement, a bank advice CSV in the bank's format, and a payroll journal
summary for Tally (branch-wise, by component). `accounts` is the daily branch
cash sheet and payroll does not post to it.

Statutory *filing* stays a business process. Whether these are generated here
or by a consultant is an open question, but the export must exist regardless —
after Digisme is gone, nothing else can produce it.

---

## 10. Migration out of Digisme

Three categories, and the distinction is the point: what is already ours,
what must be pulled out before the account closes, and what nobody can
retrieve and so must be rebuilt by hand.

### A. Already held locally — verify, do not re-import

| Data | Where | Verification |
| --- | --- | --- |
| Employee IDs | `new_employee.employee_id` | retained as-is, permanently, as the employee code (§1.1); no migration |
| Employee master (name, DOB, gender, mobile, address, posting) | `new_employee` | reconcile row count and spot-check against a final Digisme export |
| Current salary | `new_employee.salary` | free text — parse into `payroll_structure`, **review every row by hand**; this is the field that will be wrong |
| Statutory identifiers (PAN, Aadhaar, UAN, ESI no., PF no.) | `new_employee` | present but never validated — run format checks, list failures for HR |
| Bank details | `new_employee.bank_name/ifsc/account_no` | validate IFSC format; confirm against a bank statement or cancelled cheque before the first local payroll run |
| Designations, departments, branches | `designation`, `department`, `outlets` | already complete with `*_code` |
| Employee documents | `new_employee_documents` | keyed correctly by `employee_id` |
| Family details | `employee_family` | keyed by name — needs an `employee_id` backfill |
| Loans / advances | `payment_det` | name-keyed, unreliable; open balances need hand review |

### B. Must be exported from Digisme before termination

**This is the irreversible list.** Once the contract ends, none of it can be
retrieved. Export as raw files (CSV/Excel) *and* keep them; import what fits
the new schema, archive the rest.

| Data | Why it matters | Import target |
| --- | --- | --- |
| **Attendance history** — daily summary per employee per date, as far back as available | the only record of what people were paid for; needed for any dispute, and for statutory inspection | `payroll_attendance_day` with `source='import'`, `locked=1` |
| **Raw punch logs**, if retrievable | the evidence behind the summary | `payroll_punch` with `source='file'` |
| **Leave balances** — current balance per employee per leave type | cannot be reconstructed from anything; staff will know their own balance and will be right | opening balances in the leave module (or a spreadsheet if leave is deferred) |
| **Leave transaction history** — applications, approvals, accruals | how balances were arrived at | archive; import if a leave module exists by then |
| **Payroll history** — monthly payslips, component breakdowns, gross/net per employee | statutory retention, Form 16 support, and any wage dispute | `payroll_payslip` / `payroll_payslip_line` as read-only historical rows, or archived PDFs |
| **Salary revision history** — effective dates and amounts | `new_employee.salary` holds only the current figure; the history exists only in Digisme | `payroll_structure` rows with historical `effective_from` |
| **Statutory filing history** — PF ECR files, ESI returns, PT challans, Form 16 / TDS | required to be retained; regenerating them is not possible | archive as files |
| **Shift master and shift assignment history** | `new_employee.shift_code` gives today's code, nothing historical | `shift_master`; assignments to `payroll_shift_roster` if daily detail exists |
| **Employee master history** — transfers, promotions, designation changes with dates | the local master holds only the current state | archive; `payroll_activity` if dated |
| **Probation / confirmation dates, employment type** | new fields (§3) with no local source | direct into `new_employee` |
| **Reporting manager mapping**, if Digisme holds it | new field | `new_employee.reporting_manager_id` |
| **Loan / advance balances**, if Digisme holds them | more reliable than `payment_det` | `payroll_loan` |
| **Documents and photographs** held only in Digisme | | `new_employee_documents` via `POST /asset` |

Two practical notes. Ask for **a full data export in writing, early** — some
vendors take weeks, and some charge for it or provide only what the UI can
download. And **verify the export against something independent** (payslip
totals, bank statements, PF challans) before terminating: an export that is
present but truncated is the failure mode that matters.

Retention: Indian payroll and statutory records are generally kept 7–8 years.
Archive the raw export accordingly, outside this database.

### C. To be recreated manually

Things that either do not exist in Digisme or will not survive extraction:

- **Weekly off rules** (§5.1) — encode the actual practice per branch with
  operations; almost certainly not modelled anywhere today.
- **Shift definitions in full** — `crosses_midnight`, `break_minutes`,
  grace periods, full/half-day thresholds, OT thresholds. Digisme holds *its*
  configuration of these, which will not map cleanly. Define them with
  operations against real practice.
- **OT rules and multipliers** (§7) — what is actually paid for OT on a
  working day, a weekly off and a holiday. Currently custom and informal.
- **Reporting manager mapping** if Digisme does not hold it — needed for OT
  approval routing.
- **Employment type and probation status** for existing staff if not
  exportable — an HR pass over the active roster.
- **Salary component breakdown** — `new_employee.salary` is a single figure,
  and Digisme's split may not match what the new components should be. HR
  must set Basic / HRA / Special / Other per employee at least once.
- **Biomax device inventory and enrolment mapping** (§6.2) — device serials,
  branch assignment, and the device-user-id → `employee_id` map. Build it
  fresh from the devices; do not assume Digisme's mapping is right.
- **Permission grants** for the new HR/payroll permission keys, per
  designation.

---

## 11. Security — Stage 0

This is a prerequisite, not a parallel workstream. Standing up payroll on top
of an unauthenticated employee master would leave the back door wider than
the front, and payroll multiplies what is behind the door.

### 11.1 Protect the HR endpoints

`middlewares/auth.js` opens with an `unProtectedRoutes` map that skips
authentication entirely, and it currently lists **every** `/employee`,
`/salary`, `/designation`, `/department`, `/shift`, `/outlet`,
`/resignation`, `/family` and `/document` endpoint. Salary figures, bank
accounts, PAN and Aadhaar are served to unauthenticated callers today.

The fix is small — the routes already work with a token, and
`helper/employee.js` already sends one. Remove those entries, then apply
`permissions.require(...)` per route. Doing so also brings
`middlewares/ip_restriction.js` into effect for them, since it depends on
`req.decoded`, which these routes never populate.

Sequence it as: remove from `unProtectedRoutes` → verify the frontend still
works end to end → add permission middleware. Two deploys, not one, so an
authentication regression and an authorisation regression cannot be confused.

The Biomax ADMS endpoint (§6.1) is the **one** deliberate exception, and it
is scoped as described there: write-only, secret path, serial allowlist, IP
allowlist, rate limited.

### 11.2 Permission keys

New keys, inserted into `all_permissions` by migration and added to the
frontend's `constants/permissions.js` under new `hr` and `payroll` groups:

```
HR         view_employee_sensitive, edit_employee_sensitive,
           manage_employee_lifecycle, view_shift_master, edit_shift_master,
           view_roster, edit_roster, publish_roster

Attendance view_attendance, edit_attendance, approve_attendance,
           sync_attendance, manage_attendance_device

Overtime   view_ot, request_ot, approve_ot_manager, approve_ot_hr

Payroll    view_payroll, view_payroll_salary, edit_payroll_structure,
           generate_payroll, review_payroll_hr, approve_payroll_admin,
           lock_payroll, view_own_payslip,
           view_payroll_loan, add_payroll_loan, approve_payroll_loan,
           view_payroll_payout, manage_payroll_payout,
           view_payroll_report, export_statutory
```

Branch scoping uses what already exists: `req.decoded.store_id` plus the
`all_stores` permission key. A branch manager sees their own branch;
only `all_stores` holders see every branch. `view_own_payslip` resolves
through `user.employee_id` and is self-only regardless of any other grant.

### 11.3 Secrets out of source

Four separate exposures are committed to this repository today. All four
should be treated as compromised and **rotated**, not merely moved:

1. **`keys/jwt/private.key` is tracked in git.** Anyone with repository
   access can mint valid tokens for any user, including admins. This is the
   most serious of the four. Generate a new RS256 keypair, load it from a
   path or secret given by environment, add `keys/` to `.gitignore`, and
   purge the key from history.
2. **AWS access key id and secret are hardcoded** in `services/s3.js`.
   Rotate the IAM credential and move to environment variables or an
   instance role.
3. **Digisme API key and custom key are hardcoded** in `services/synker.js`.
   Move to `config/digisme.js` reading environment only. These stop
   mattering after Stage C, but they are live until then.
4. **GST portal username and GSTIN are hardcoded** in
   `services/gst_authentication.js` (the `.env-sample` comment even
   documents this as intentional).

Follow the `config/delium.js` structure, but **without its pattern of a
committed default value** — a secret with a fallback baked into the source is
the same exposure with an extra step. Required secrets should make the
process fail to start when absent.

Also replace the `child_process.exec("curl …")` call in
`_authenticateDigisme` with `axios` while it still exists: shelling out with
interpolated values is a command-injection surface and it puts the
credentials into the process table.

### 11.4 Field-level protection and audit

Per §3.1: no `SELECT *` on the employee master, masked by default, full
values behind `view_employee_sensitive`, and a `payroll_activity` row for
every unmasked read. Payslip amounts are behind `view_payroll_salary` or
`view_own_payslip`.

Audit rows are written by the usecase layer, never by the frontend, and are
never deleted.

---

# Summary

## Recommended database changes

**Extend in place (no new master tables):**

| Table | Change |
| --- | --- |
| `new_employee` | `origin`, `employment_type`, `probation_status`, `probation_end_date`, `confirmation_date`, `reporting_manager_id` (self-FK), `default_shift_id` (FK), `weekly_off_rule_id`, `last_working_date`, `exit_type`, `exit_reason`, `rehire_eligible`, `pf_applicable`, `esi_applicable`, `pf_joining_date`. Type changes: `date_of_joining` → `DATE`, `gender` → ENUM, `employee_name` → `VARCHAR(100)`. Add the missing FKs to `designation`, `department`, `outlets`. **`employee_id` unchanged** — server-side allocation continues the existing sequence. Drop `shift_code` and `salary` after Stage 2. |
| `shift_master` | `shift_code` UNIQUE, `crosses_midnight`, `break_minutes`, `paid_hours`, `late_grace_minutes`, `early_exit_grace_minutes`, `minimum_full_day_minutes`, `minimum_half_day_minutes`, `overtime_allowed`, `overtime_start_after_minutes`, `maximum_ot_minutes_per_day`, timestamps; rename `shift_in_time`/`shift_out_time`/`status` → `start_time`/`end_time`/`active` |
| `all_permissions` | the ~30 new keys in §11.2 |

**New tables** (all money `DECIMAL(12,2)`; all employee references FK to
`new_employee(employee_id)`; all location references FK to
`outlets(outlet_id)`):

```
payroll_weekly_off_rule        payroll_shift_roster
payroll_device                 payroll_device_enrollment
payroll_punch                  payroll_attendance_day
payroll_attendance_correction  payroll_ot_request            payroll_ot_rule
payroll_component              payroll_structure             payroll_structure_line
payroll_period                 payroll_payslip               payroll_payslip_line
payroll_adjustment             payroll_loan                  payroll_loan_installment
payroll_payout_batch           payroll_payout_item
payroll_activity               digisme_sync_diff
```

**Left alone:** `payment_det` (read-only, superseded), `resignation` (stop
writing), `store` (legacy — `outlets` is live), `accounts` (branch cash sheet;
payroll does not post to it), `advance_requests` (supplier advances,
unrelated).

## Modules to build

Backend, each as `routes/` + `usecase/` + `repository/` wired through the
four passes in `server.js`, following the `routes/advance_request.js`
conventions — Joi per action, `permissions.require(...)` on every route, real
HTTP status codes, `409` on concurrent change, activity log on every
transition:

| Mount | Module |
| --- | --- |
| `/shift` (extend) | shift master |
| `/payroll/roster` | roster, bulk assignment, weekly-off rules |
| `/attendance/device` | Biomax ADMS receiver (public, scoped) + device registry |
| `/payroll/attendance` | punches, processed days, corrections, manual attendance |
| `/payroll/ot` | OT requests, manager and HR approval, rules |
| `/payroll/structures` | components, effective-dated structures |
| `/payroll/periods` | the nine-state workflow |
| `/payroll/payslips` | payslips, lines, PDF, `/me` |
| `/payroll/adjustments` | arrears and post-lock corrections |
| `/payroll/loans` | loans and advances (replaces `/salary`) |
| `/payroll/payouts` | batches, bank advice, UTR capture |
| `/payroll/reports` | register, variance, statutory and Tally exports |

Services: attendance processor (nightly + on demand), roster materialiser,
device-silence alerting via the existing Telegram service, all registered
through `cron_service` and wrapped in `apiSyncLogger.wrapCron` so failures
appear in the existing API sync log.

Frontend: `pages/payroll/*`, `pages/roster/*`, `pages/attendance/*`,
`helper/payroll.js` and friends, `customHooks/use*`, new `payroll` and `hr`
groups in `constants/permissions.js` and `constants/menus.js`.
`pages/salary` retires with `payment_det`.

## Migration risks

| Risk | Severity | Mitigation |
| --- | --- | --- |
| **Digisme terminated before the export is verified** | critical | export and verify first, terminate last (§2.5, §10.B). Leave balances and attendance history are unrecoverable. |
| **Biomax firmware does not support ADMS** | high | confirm with the vendor *before* Stage 2 begins; §6.1 keeps routes (b)–(d) open and the schema unchanged either way |
| **`new_employee.salary` parses wrong** | high | free text, one figure, no components. Every row is reviewed by hand and reconciled against the last Digisme payslip before the first local run. |
| **`date_of_joining` VARCHAR → DATE loses rows** | medium | parse in a reversible migration, keep the original in a shadow column, list unparseable rows for HR |
| **Employee id renumbering** | critical if attempted | never — `employee_id` is the permanent code (§1.1). ~50 actor columns, only 12 constrained; a missed column silently repoints history. |
| **Local/Digisme code collision during overlap** | high | sync guard on `origin = 'local'` (§1.1); shadow mode surfaces it as a diff |
| **Device-user-id → employee mapping wrong** | high | attendance lands on the wrong person and is paid. Verify enrolment per branch against a known punch before go-live. |
| **Night shifts misclassified** | medium | `crosses_midnight` must be set correctly per shift; test explicitly with real night-shift data |
| **Stale `shift_master` rows and unmapped `shift_code`** | medium | rebuild the shift set from scratch with operations; report unmatched employees rather than defaulting them |
| **Parallel-run divergence** | medium | run Digisme and dnds.co.in payroll side by side for at least two months and reconcile per employee before cutover |
| **Committed JWT private key** | critical | rotate in Stage 0; anyone with repo access can currently mint admin tokens |
| **Post-lock edits** | high | enforce immutability in the usecase layer on every write path, not by convention; arrears are the only route (§9.3) |
| **`payment_det` balances lost or misassigned** | medium | name-keyed and unreliable; carry forward only after hand review |

## Stage 0 — Security and foundations

*Before any payroll code. No dependency on Digisme's status.*

1. Rotate the JWT keypair, remove `keys/` from git and purge from history.
2. Rotate the AWS credential; move it, the Digisme keys and the GST portal
   values to environment-only config. Replace the `curl` shell-out with axios.
3. Remove the HR endpoints from `unProtectedRoutes`; verify; then add
   permission middleware (two deploys).
4. Replace `SELECT *` on the employee master with permission-driven column
   allowlists; mask PAN, Aadhaar and bank by default.
5. Add the new permission keys and the `payroll_activity` audit table;
   start logging sensitive reads.
6. Add `config/digisme.js` with `enabled` / `mode` / `ownedTables`, sync
   still in `write` mode and behaving exactly as today.

## Stage 1 — Own the masters

*Digisme still running. Nothing removed.*

7. Extend `new_employee` with the fields in §3; migrate `date_of_joining`
   to `DATE`; add the missing FKs; add `origin` and backfill it to
   `'digisme'`; move `employee_id` allocation from the client to the server
   in `POST /employee`.
8. Extend `shift_master` (§4); rebuild the shift set with operations;
   backfill `default_shift_id`; report unmatched.
9. Build the HR lifecycle screens — joiner, transfer, promotion, probation,
   confirmation, exit — and move HR's daily work into dnds.co.in.
10. **Sync Stage A**: narrow the Digisme field map. Release `designation`,
    `department` and `outlets` entirely; reduce `new_employee` to identity.
11. Build the roster (§5) and weekly-off rules; publish rosters for real.
12. **Sync Stage B**: `mode=shadow`, `digisme_sync_diff` plus a review
    screen. Exit when two payroll months pass with no `digisme_correct`
    verdicts on `new_employee`.
13. In parallel: confirm the Biomax protocol with the vendor; inventory
    devices; build the enrolment map.

## Stage 2 — Own attendance and payroll

14. Attendance ingestion: `payroll_device`, `payroll_punch`, the ADMS
    receiver, the file-import fallback, device-silence alerting.
15. Attendance processing: `payroll_attendance_day`, the nightly processor,
    the day grid, corrections and manual attendance with approval.
16. Overtime: detection, request, manager and HR approval, configurable
    rules and multipliers.
17. Salary structures: `payroll_component`, `payroll_structure`, hand-reviewed
    migration from `new_employee.salary`.
18. Payroll generation and the nine-state workflow, payslips, lock
    immutability, adjustments and arrears.
19. Loans and advances; retire `/salary` and `payment_det`.
20. Payouts, bank advice, statutory and Tally exports.
21. **Parallel run: at least two full months**, Digisme and dnds.co.in side
    by side, reconciled per employee. This is the real gate on cutover.
22. Complete the §10.B export and **verify it independently**.
23. **Sync Stage C**: disable, hold one cycle, then terminate the Digisme
    contract and delete the sync code.

## What must be exported from Digisme before discontinuing

The irreversible list, restated from §10.B. Request it in writing early;
verify it against payslips, bank statements and PF challans before the
contract ends.

1. **Attendance history** — daily summary per employee per date, full depth
2. **Raw punch logs** — if retrievable
3. **Leave balances** — current, per employee per leave type *(unrecoverable
   by any other means)*
4. **Leave transaction history** — applications, approvals, accruals
5. **Payroll history** — monthly payslips with component breakdowns
6. **Salary revision history** — effective dates and amounts
7. **Statutory filings** — PF ECR files, ESI returns, PT challans,
   Form 16 / TDS
8. **Shift master and shift assignment history**
9. **Employee master change history** — transfers, promotions, designation
   changes, with dates
10. **Probation, confirmation dates and employment type**
11. **Reporting manager mapping**
12. **Loan and advance balances**
13. **Documents and photographs** held only in Digisme

Archive all of it as raw files for the statutory retention period (7–8 years),
independently of this database, and only then close the account.

---

## Open questions

Answers change the plan; they are not blockers to starting Stage 0.

1. **Which protocol does the installed Biomax firmware speak**, and can the
   terminals be pointed at a self-hosted ADMS server without voiding support?
   Gates Stage 2. (§6.1)
2. **What attendance and leave history can Digisme actually export, and in
   what format?** Ask now — the answer sets the size of §10.B and vendors are
   slow. (§10)
3. **Is leave management in scope?** This proposal models leave as an
   *outcome* on the attendance day. Applications, accruals and balances are a
   separate module — but leave *balances* must be exported from Digisme
   regardless, because they cannot be reconstructed.
4. **Who runs statutory filing today** — Digisme, a consultant or Tally?
   Decides whether PF/ESI/PT are computed here or only exported. (§9.6)
5. **What is the attendance cycle** — calendar month, or 26th–25th? Sets
   `attendance_from`/`attendance_to`. (§9.1)
6. **What is actually paid for overtime** on a working day, a weekly off and
   a holiday? Needed to seed `payroll_ot_rule`. (§7)
7. **Should employees see their own payslip** through the existing login?
   `user.employee_id` makes it trivial but changes who uses the app. (§11.2)
8. **Are there workers paid outside `new_employee`** — contract, temporary,
   third-party? They need to exist in the master; no second employee table
   will be added.
9. **What happens to the open balances in `payment_det`** — hand-reviewed
   carry-forward, or start clean? (§9.4)
