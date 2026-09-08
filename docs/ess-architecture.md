# ESS — Employee Self Service: architecture and design plan

**Status:** planned. Nothing in this document is built. It exists so that HR,
Attendance and Payroll can be finished in a way that does not have to be
redone when ESS arrives.

**Module strategy (fixed):**

| Module | Audience | Contains |
| --- | --- | --- |
| **HR** | management | Employees, Department, Designation |
| **Attendance** | management | (next) |
| **Payroll** | management | (after Attendance) |
| **ESS** | employees | separate employee-facing experience, built last |

Recruitment, Resume Tracking and Self-Onboarding are deferred and are not
planned here.

Companion documents: `hr-schema.md` (as-is schema),
`payroll-target-architecture.md` (target design),
`authentication-decoupling-audit.md` (login flow and its coupling),
`auth-stage0a-implementation.md` (what Stage 0A actually shipped).

---

## 1. The one thing to get right

ESS is the first module where **the user is the subject of the data**. Every
other screen in dnds.co.in is a manager looking at other people; ESS is an
employee looking at themselves. That inverts the security question:

> Management modules ask *"may this user see employees?"*
> ESS asks *"which employee IS this user?"* — and then serves only that one.

The answer must come from the **session**, never from the request. If any ESS
endpoint accepts an `employee_id` and trusts it, ESS is broken no matter what
the menus show.

**The good news: this foundation already exists and is already enforced.**
Stage 0A's auth middleware resolves the acting employee server-side and
re-checks it against the database on every request:

```js
// middlewares/auth.js — already in production
if (Number(state.employee_id) !== employeeId) return deny(res, 403, "Access Denied");
if (config.login.employeeStatusCheck && !employeeActive(state)) {
  return deny(res, 403, "Access Denied", { error: "EMPLOYEE_INACTIVE" });
}
```

`req.auth.employeeId` is therefore already a trustworthy "who am I", derived
from `user.user_id` → `user.employee_id`, cross-checked against the token, and
refused if the employee is no longer active. **ESS should build directly on it
and add nothing of its own.**

---

## 2. Proposed ESS navigation

```
My Dashboard      today at a glance
My Profile        who HR has me as, and requests to correct it
My Attendance     my punches, my month
My Leave          balance, apply, history
My Payslips       finalized payroll results, read-only
My Documents      what I may see and what I have submitted
My Requests       everything I have asked for, in one list
```

Seven items, no management screens, no employee switcher, no branch picker.
An employee never chooses whose data they are looking at, because there is
only ever one answer.

**Mobile-first.** Most staff are cashiers, loaders and supervisors on phones.
ESS should be a card-and-list interface at 360 px first and a wider layout
second — the inverse of the management screens, which are desktop tables.
Keep the Daily Needs purple, drop the density.

Sketch of the dashboard, which sets the tone for the whole portal:

```
Good morning, Ravi

Cashier • Moolakulam
Employee ID #631

Today
Present · In 09:04 AM · Out —

[ My Attendance ]   [ Leave ]
[ Payslips ]        [ My Profile ]
[ Documents ]       [ Requests ]
```

---

## 3. Identity model

### 3.1 The rule

**ESS uses the permanent employee ID from the HR employee master and creates
no identity of its own.** `new_employee.employee_id` stays MySQL
`AUTO_INCREMENT`, is never renumbered, and survives every resignation and
rejoin — C1 made this the spine of the system, and ESS is a consumer of it,
not a second opinion.

The resolution chain is exactly one hop, and it already exists:

```
JWT.sub → user.user_id → user.employee_id → new_employee.employee_id
                                          → employee_employment_period (C1)
```

No ESS table may carry its own employee key. No ESS endpoint may accept one.

### 3.2 Gaps found in the existing linkage

I inspected `repository/user.js`, `middlewares/auth.js` and the migration
history. Three findings, in order of how much they matter to ESS.

**(a) `user.username` has no unique index — the real prerequisite.**

`findByUsername` returns *every* row matching a username and the usecase takes
the first:

```sql
WHERE u.username = ?
ORDER BY u.status DESC, u.user_id ASC
```

```js
const rows = await this.userRepo.findByUsername(username);
const row = rows && rows.length ? rows[0] : null;
```

With duplicate usernames this is deterministic but arbitrary. Today the
consequence is mild (one of the two accounts simply can never sign in). Under
ESS the consequence is that **"my payslip" means whichever row happened to
sort first** — and if those two rows point at different employees, a person
can be shown a colleague's pay. This is Stage 0.10 in the programme plan,
still open, and it is the one item that **must** be closed before ESS ships.

Recommendation: a reviewed de-duplication pass, then
`UNIQUE KEY (username)`. Not now — it is not a prerequisite for current HR
work — but it is a hard gate on ESS.

**(b) `user.employee_id` has no unique index and no foreign key.**

Two logins for one employee is not a data leak (both resolve to the same
person) but it defeats revocation: disabling one account leaves the other
working, and `token_valid_from` is per-user. For ESS, one employee should have
at most one ESS login.

Recommendation: after de-duplication,
`UNIQUE KEY (employee_id)` for non-system accounts plus the FK to
`new_employee`. Same gate as (a).

A dangling `user.employee_id` (pointing at no employee) is already **safe by
default**: the `LEFT JOIN` yields `employee_status = NULL`, `employeeActive()`
returns false, and the request is refused. That behaviour should be preserved
deliberately — it is a fail-closed default, not an accident.

**(c) System accounts have no employee and must be excluded from ESS.**

`employeeActive()` returns `true` for `is_system_account = 1` precisely because
such accounts have no employee. ESS must therefore refuse them explicitly —
`is_system_account = 1` or `employee_id IS NULL` gets a clean 403 from every
`/ess/*` route, rather than falling through to "employee null" and querying
with a null id.

---

## 4. Authorization model

### 4.1 Self-only, enforced in the repository

ESS must **not** reuse `view_employees`. That key means "may see the staff
list", which is the opposite of what ESS grants. Two separate ideas:

| | management | ESS |
| --- | --- | --- |
| question | may this user see employees? | which employee is this user? |
| key | `view_employees`, `view_employee_sensitive`, … | `ess_access` (one key, or none at all) |
| scope | many employees, filtered | exactly one, fixed |
| routes | `/hr/*`, `/employee/*` | `/ess/*` |

Recommendation: **a single `ess_access` permission**, granted broadly (every
designation whose staff should have the portal), doing one job — deciding
whether the portal exists for you at all. It must never be the thing that
decides *whose* data you get. That is decided by `req.auth.employeeId`.

Better still, and my actual recommendation: gate ESS on
**"has an active employee-linked, non-system login"** and skip the permission
key entirely for the read endpoints. Every employee with a login is entitled to
their own payslip; requiring HR to grant a key per designation just creates a
population of employees who silently cannot see their own data.

### 4.2 The enforcement rule

> The employee id is a **parameter of the query, supplied by the middleware**,
> and never a parameter of the request.

Concretely, every ESS repository method takes the employee id as its first
argument and every ESS route passes `req.auth.employeeId` — never
`req.query`, `req.params` or `req.body`. A route that needs an id in the path
does not exist; `/ess/payslips/:payroll_month` is fine because the month is not
an identity.

This is worth a test that reads the ESS route file and fails if any handler
mentions `req.params.employee_id`, `req.body.employee_id` or
`req.query.employee_id` — the same style of source-level guard already used
for the sensitive-field rules in C2/C3.

### 4.3 Defence in depth for second-level objects

Payslips, documents and requests have their own ids. `GET /ess/documents/88`
must not return document 88 if it belongs to someone else. The rule:

> Ownership is a **`WHERE` clause**, not an `if`.

```sql
SELECT ... FROM new_employee_documents
 WHERE document_id = ? AND employee_id = ?     -- both, always
```

Never fetch-then-compare: a fetch that succeeds has already read the row, and
the comparison is one forgotten line away from a leak. A miss returns 404, not
403 — a 403 confirms the object exists.

### 4.4 Admin impersonation

**Recommendation: do not build it for v1.** HR already has a better tool — the
management employee profile at `/hr/employees/[id]` shows the same underlying
data with proper permissions and auditing. "View as employee" adds a second
path to the same data whose only purpose is to look like someone else, which
is exactly the thing an audit log is supposed to make impossible.

If a support need proves real later, the only acceptable shape is:

- an explicit, separately-permissioned action (`ess_impersonate`, granted to
  nobody by default, as `view_aadhaar_full` and
  `override_duplicate_bank_account` already are);
- a **distinct token** with an `impersonated_employee_id` claim and a short
  expiry — never a silent widening of an admin's normal session;
- **read-only**: an impersonated session may never submit a request, approve
  one, or change anything;
- a row in the audit log at issue time and on every request, naming both the
  administrator and the subject;
- a visible banner in the ESS UI for the whole session.

Anything less is a masquerade, and the C2 precedent (the person who typed the
value must not be the person who waves it through) applies here too.

---

## 5. My Profile

### 5.1 What an employee may see

Everything here is already computed for the HR profile; ESS needs a narrower
**projection**, not new queries.

| Shown | Source | Note |
| --- | --- | --- |
| Employee ID, name | `new_employee` | the permanent code |
| Branch, department, designation | joins | current values |
| Joining date | C1 `current` | read-only, lifecycle-owned |
| Mobile, alternate contact | `new_employee` | |
| Address (permanent, residential) | `new_employee` | |
| DOB, gender, blood group | `new_employee` | |
| Aadhaar **status** | C2 | `VERIFIED` / `PENDING` + last 4 only |
| Bank **status** | C2 | the six states + `bank_payroll_ready` |
| Masked account, IFSC | C2 `getStatus` | `**********6789`; see below |
| Statutory summary | `new_employee` | *presence* of PAN/UAN/PF/ESI, masked |

### 5.2 What an employee must never see

Aadhaar ciphertext, IV, auth tag or fingerprint; the full Aadhaar number; the
account fingerprint; provider payloads, transaction ids or raw responses;
`password_hash`, `token_valid_from`, `ip_policy`, `allowed_ips`,
`is_system_account`; another employee's duplicate-account clash details
(C2 currently names the clashing employee to HR — ESS must not).

A useful sanity rule: **ESS shows statuses and masks; HR shows values.**

### 5.3 Should an employee see their own salary and bank number?

An open question worth deciding before building, not during:

- **Masked bank (`**********6789`) — yes.** It lets an employee confirm the
  account their salary goes to without exposing anything useful to a shoulder
  surfer. C2 already produces exactly this string.
- **Full account number — no.** It adds nothing (they know their own account)
  and turns a phone screen into a disclosure surface.
- **PAN / UAN — masked, presence only.** "PAN on record: ABCDE••••F".
- **Salary — see §7.** My recommendation is that ESS shows *payslips*, not the
  salary master. A payslip is a fact about a closed month; the salary master is
  a forward-looking number HR is often mid-revision on.

### 5.4 Profile changes go through requests, never direct writes

**No ESS endpoint may write `new_employee`.** Not mobile, not address, not
bank. The flow is:

```
employee submits request
        ↓
HR reviews in the management module
        ↓
approve → HR applies the change through the existing approved path
          (POST /hr/employee/:id/edit, or /employee/updatedata for the
           B3-sensitive fields)
reject  → reason recorded, employee sees it
```

Two reasons this matters more than it looks. First, bank changes are the
classic payroll-fraud vector — an employee-writable bank field is a
salary-redirection attack, and C2's verification would be running against an
account nobody approved. Second, C2's fingerprint invalidation means a bank
change silently resets verification to `PENDING`; that is correct behaviour but
it must be triggered by an HR decision, not by an employee editing a form on a
bus.

The approved change must go through the **same** backend path HR uses, so the
lifecycle guards, the B3 sensitive-write gate and the audit trail all still
apply. The request table records *what was asked for*; it is never itself the
source of truth for employee data.

---

## 6. My Attendance, and what Attendance must preserve

ESS reads; the Attendance module owns. What ESS needs:

- today's status (present/absent, in, out)
- the month as a calendar: present, absent, late arrival, early out, missing
  punch, weekly off, holiday
- worked hours per day and the month total
- shift, where the employee has one
- **attendance correction request** (a request type, not a write)

`payroll_attendance_day` as designed in `payroll-target-architecture.md`
already fits: one row per employee per date, with `payable_units` **stored**
rather than derived. Storing it is what lets ESS show an employee the same
number payroll used, months later, after a threshold changed.

### Decisions Attendance must make now to keep ESS cheap

1. **`payroll_attendance_day` keyed by `(employee_id, date)`** — the natural
   key for "my month" as well as for payroll. Do not key it by a device or a
   punch id.
2. **Keep the derived day state as a column**, not a runtime computation.
   ESS, payroll and HR must all read the same `LATE` / `MISSING_PUNCH`, and a
   recomputation on read will drift from the payroll that already paid it.
3. **Store the shift that applied on that day**, not just a pointer to the
   employee's current `default_shift_id`. An employee moved to a different
   shift in March must still see March as it was.
4. **Never delete a punch.** `payroll_punch` is append-only in the target
   design; corrections are new rows plus a correction record. ESS will show
   employees their own punches, and a disappearing punch is a dispute.
5. **Model corrections as requests from the start** (§9), rather than a
   bespoke `attendance_correction` table that later has to be merged into the
   generic framework.
6. **Do not make the ADMS push endpoint employee-aware.** It maps a device
   serial + biometric enrolment id to an employee; that mapping is Attendance's
   business and must not leak into an employee-facing surface.

---

## 7. My Leave

Not designed here beyond what ESS needs, because leave policy is a business
decision that has not been made yet. What ESS requires of it:

- **balance** per leave type, as of a date
- **apply**: type, date or range, half-day flag, reason, optional attachment
- **status**: pending / approved / rejected / cancelled
- **history** with the approver and the decision note
- **cancellation** where policy allows, before the leave starts

Approval routing, conceptually:

```
employee → reporting manager → HR
```

`new_employee.reporting_manager_id` is already planned in Stage 1.1 of the
programme. **That field is the prerequisite for leave routing**, and it is
worth populating during HR rather than retro-fitting it: a leave request with
nowhere to go is a leave module that cannot ship. Where a manager is not set,
route to HR rather than blocking.

Leave must be **a request type in the generic framework** (§9), not its own
parallel workflow. The only leave-specific parts are the balance calculation
and the calendar overlap check.

Open policy questions to answer before building: is leave in scope at all
(programme open question 3); what types exist and how they accrue; whether
balances come from Digisme (they must be exported before cancellation
regardless — cutover gate 10); how leave interacts with `payable_units` in
payroll.

---

## 8. My Payslips

### The rule

> **Payroll calculates and finalizes. ESS only reads the employee's finalized
> result.** ESS contains no salary arithmetic of any kind.

If ESS ever computes a figure, that figure will eventually disagree with the
payslip the employee was paid on, and the employee will believe the one that
is wrong.

### What Payroll must preserve

`payroll-target-architecture.md` already gets most of this right; these are the
points ESS depends on, and they are cheap now and expensive later:

1. **Payslips are immutable once the period is locked.** ESS shows historical
   months; a payslip that changes after the fact is a payslip the employee has
   already screenshotted.
2. **Snapshot designation, department and branch onto the payslip.** An
   employee who transfers from Moolakulam to Villianur in August must still see
   their July payslip as *Moolakulam* — that is the whole point of the
   snapshot, and joining to the current employee row would silently rewrite
   history for every past month.
3. **Post-lock corrections are arrears, never edits** — `payroll_adjustment`
   as designed. ESS then shows the original month plus the adjustment, which is
   also what the employee's bank statement shows.
4. **Store the generated payslip document** rather than rendering it on demand
   from live data. `services/pdf.js` exists; the stored file is the artefact
   the employee downloads and the one that must not drift.
5. **A per-employee, per-month unique key** so ESS can fetch "my July" without
   scanning.

ESS shows: latest payslip, a month list, gross earnings, deductions, net pay,
PF/ESI and other statutory amounts, and a download. Nothing else, and nothing
about anyone else — payslip endpoints are the highest-value target in ESS and
should carry the `(payslip_id, employee_id)` double-`WHERE` of §4.3 without
exception.

---

## 9. Documents and My Requests

### 9.1 Document visibility is a gap today

`new_employee_documents` has `employee_id`, `card_type`, `card_name`,
`card_no`, `file`, `expiry_date` and a status — but **no visibility metadata**.
Nothing distinguishes:

- a document the employee submitted (their own Aadhaar scan);
- a document HR issued to them (appointment letter, warning letter);
- a document *about* them that they must not see (an investigation note, a
  performance record).

> **Being linked to an employee is not the same as being visible to them.**

So ESS must not simply list `new_employee_documents WHERE employee_id = ?`.
Required later (not now):

- `visibility ENUM('employee','hr_only')` — defaulting to **`hr_only`**, so
  every existing row and every future one is private until somebody decides
  otherwise. Fail closed.
- `source ENUM('employee','hr')` — who put it there.
- optionally `issued_at`, for letters.

C2's `SENSITIVE_CARD_TYPES` (types 1 and 4) already treats Aadhaar and PAN
scans as sensitive under B3; ESS should respect that too — an employee may see
*that* their Aadhaar document is on file, and need not be served the image.

### 9.2 Can an existing request model be reused?

I looked at the two candidates.

**`advance_requests`** (`20260903020000-lr-workflow-stage-4-up.sql`) is the
strongest workflow in the codebase and the programme plan already names it as
the template. But its columns are domain-specific — `distributor_code`,
`invoice_number`, `previous_advance_balance`, `utr`, `bank_id` — and it is
keyed to purchasing, not to an employee. **Reuse the shape, not the table.**

What to copy, because it is already right:

- a request table + a **documents** table + an **activity** table;
- status as an `ENUM` naming *who the record is waiting on*;
- per-stage actor, timestamp and note columns
  (`approved_by` / `approved_at` / `approval_note`);
- every transition written to the activity log, not just the latest state;
- `409` on concurrent change.

**`tickets`** is closer to generic — it has `ticket_comments` and
`ticket_activity`, and even a `view_my_tickets` permission — but it is a task
manager: assignment, checklists, recurrence, priorities, due dates. Bending it
into an HR approval workflow would mean every HR request carries a checklist
and a recurrence rule it does not want, and every ticket query would have to
learn to exclude HR requests. **Do not reuse; do steal `view_my_tickets` as
precedent** that a self-scoped permission already exists in this codebase.

**Recommendation: one new `employee_request` family**, in the
`advance_requests` shape:

```
employee_request            the request: type, employee, status, note, dates
employee_request_document   attachments, via the existing POST /asset + S3
employee_request_activity   every transition, with actor and timestamp
```

Lifecycle: `DRAFT → SUBMITTED → UNDER_REVIEW → APPROVED | REJECTED | CANCELLED`.

Types: attendance correction, leave, bank-detail change, personal-detail
correction, document request, salary advance, resignation request, and whatever
comes later — **one framework, many types**, because seven ad-hoc flows is
seven audit trails to get right and six of them will not be.

Type-specific fields belong in a `payload JSON` column rather than in seventy
nullable columns. The one thing that must **not** be generic is the *effect* of
approval: each type maps to a specific, existing, permissioned backend action,
and that mapping lives in code, not data.

No schema is proposed here, per scope. Two design notes for when it is:
the request table records what was **asked**, never what is **true** (the
employee master stays the source of truth); and an approved request must record
*which* backend action applied it, so an approval that failed halfway is
visible rather than silently lost.

---

## 10. Resign, rejoin, and sessions

This is already solved by Stage 0A and C1, and ESS should inherit it rather
than restate it. Expected behaviour:

| Situation | What happens today | Correct for ESS? |
| --- | --- | --- |
| Employee resigns; HR records it | `new_employee.status → 0`; C1 closes the open period | — |
| Their old token is still valid | **every request is refused** — `employeeActive()` reads `new_employee.status` on each request (cached ~briefly), returning `EMPLOYEE_INACTIVE` | **Yes.** ESS needs nothing extra |
| Terminated employee opens an old ESS URL | same refusal; the frontend maps `EMPLOYEE_INACTIVE` through the existing `handle403` conventions | **Yes** |
| Employee rejoins later | C1 opens a **new period** under the **same** `employee_id`; `status → 1` | **Yes** — and ESS history is automatically continuous, which is the point of the permanent id |
| Their old login row is reused | works immediately, same `user_id`, same `employee_id` | Acceptable, **with the caveat below** |
| An administrator forces a logout | `token_valid_from` invalidates every earlier token for that user | **Yes** |

**The one thing to decide deliberately:** on rejoin, the old login becomes live
again the moment `status → 1`, still carrying its old password. Recommendation:
**rejoin should force a password reset** (`must_change_password = 1`) and bump
`token_valid_from`, reusing the Stage 0A machinery that already exists. A
dormant account with a password last set years ago, reactivated automatically,
is exactly the account that gets phished. This is a small addition to the C1
rejoin path and is worth doing when ESS is built, not before.

**Also worth deciding:** whether ESS should show a resigned employee their
*final* payslip and documents after they leave. Legally and practically they
often need to. The current answer is no — all access stops at `status = 0`. If
that changes, it must be a **separate, narrow, read-only, time-boxed** mode,
not a relaxation of `employeeActive()`, which is load-bearing for the whole
application.

---

## 11. APIs to expose eventually

All under `/ess`, all deriving the employee from the session, none accepting an
employee id.

```
GET  /ess/me                          profile projection + today's attendance summary
GET  /ess/dashboard                   the dashboard tiles in one call

GET  /ess/attendance?month=YYYY-MM    my month
GET  /ess/attendance/today            today's punches and status

GET  /ess/leave/balance               by leave type
GET  /ess/leave                       my leave history
POST /ess/leave                       apply  → creates an employee_request

GET  /ess/payslips                    month list (finalized only)
GET  /ess/payslips/:payroll_month     one month's payslip
GET  /ess/payslips/:payroll_month/pdf the stored document

GET  /ess/documents                   visibility = 'employee' only
GET  /ess/documents/:id               WHERE document_id = ? AND employee_id = ?
POST /ess/documents                   submit → employee_request, not a direct write

GET  /ess/requests                    all my requests, any type
GET  /ess/requests/:id                WHERE request_id = ? AND employee_id = ?
POST /ess/requests                    submit any type
POST /ess/requests/:id/cancel         only my own, only while cancellable
```

Notes: `/ess/me` deliberately has no `/ess/employees/:id` sibling — the
absence is the security property. Management continues to use `/hr/*` and
`/employee/*` unchanged; the two surfaces never share a route.

---

## 12. Data-model additions likely required later

None of these should be built now.

| Area | Addition | Why |
| --- | --- | --- |
| Auth | `UNIQUE (user.username)`; `UNIQUE (user.employee_id)` for non-system rows; FK to `new_employee` | **hard prerequisite** — §3.2 |
| Auth | force reset + `token_valid_from` bump on C1 rejoin | §10 |
| Documents | `visibility ENUM('employee','hr_only') DEFAULT 'hr_only'`, `source ENUM('employee','hr')` | §9.1 — fail closed |
| Requests | `employee_request`, `employee_request_document`, `employee_request_activity` | §9.2 |
| Leave | leave types, balances, transactions | after policy is decided |
| HR | `reporting_manager_id` populated (already planned, Stage 1.1) | leave routing, §7 |
| Attendance | day state and applied shift stored, not derived | §6 |
| Payroll | payslip document storage; branch/designation snapshot; per-employee-month unique key | §8 |
| ESS | a `notification` / notice table, if HR notices are wanted | lowest priority |

---

## 13. Security risks to avoid

1. **Trusting an `employee_id` from the request.** The single failure that
   makes everything else irrelevant. Enforce structurally (§4.2), not by
   review.
2. **Menus as security.** Hiding "My Payslips" hides nothing; the endpoint is
   one `curl` away. Frontend guards are UX.
3. **Fetch-then-compare on second-level objects.** Ownership belongs in the
   `WHERE` clause (§4.3).
4. **Reusing `view_employees` for ESS.** It would either grant employees the
   staff list or deny the portal to everyone who should have it.
5. **Employee-writable master data**, especially bank details — a
   salary-redirection vector (§5.4).
6. **Documents visible by linkage.** Default `hr_only` (§9.1).
7. **Recomputing pay in ESS.** Read finalized results only (§8).
8. **Silent admin impersonation.** Explicit, audited, read-only, or not at all
   (§4.4).
9. **Enumeration through error codes.** A request for someone else's object
   returns 404, not 403.
10. **Leaking a colleague through a duplicate.** C2's duplicate-bank status
    names the clashing employee to HR; ESS must show only "this needs HR
    attention".
11. **Verbose errors on a phone.** ESS errors are for employees: "HR is
    reviewing this", not a stack trace or a provider status code.
12. **Rate limits.** ESS is internet-facing for staff on mobile data; the
    per-account lockout from Stage 0.4 covers login, but ESS reads should be
    throttled too.

---

## 14. What each module must preserve, starting now

The point of this document. None of these require work today; all of them are
expensive to retro-fit.

**HR (finishing now)**
- the permanent `employee_id`, never renumbered — already true (C1)
- `user.employee_id` as the single login→employee mapping; close the
  uniqueness gap before ESS (§3.2)
- a **self-safe projection** of the profile: statuses and masks, not values —
  C2 already produces `aadhaar_last4`, `masked_account` and the bank status,
  which is exactly what ESS needs, so keep them as the display contract
- populate `reporting_manager_id` when Stage 1.1 lands (§7)
- keep every employee write behind a permissioned, audited backend path — so
  that an approved ESS request has somewhere legitimate to apply itself

**Attendance (next)**
- `(employee_id, date)` day rows, state and shift **stored**, punches
  append-only (§6)
- corrections as requests, not as a bespoke table

**Payroll (after)**
- finalized results immutable; branch/designation snapshotted; arrears not
  edits; payslip documents stored (§8)

**Documents**
- ownership *and* visibility metadata, defaulting to `hr_only` (§9.1)

**Requests**
- one framework, one audit trail, many types (§9.2)

---

## 15. Recommended build order

```
1. Finish HR                    Employee Master (C3) → deploy
2. Close the auth prerequisite  de-duplicate usernames, add the unique keys
                                (Stage 0.10 — independent of ESS, do it anyway)
3. Attendance                   with the six ESS-ready decisions of §6
4. Payroll                      with the five of §8
5. Requests framework           built once, used by ESS and by HR
6. ESS phase 1                  My Dashboard, My Profile, My Payslips
                                — read-only, highest value, lowest risk
7. ESS phase 2                  My Attendance, My Documents, My Requests
                                — introduces employee-submitted data
8. ESS phase 3                  My Leave
                                — needs policy decided first
```

**Phase 1 is deliberately read-only.** It ships the whole security model — the
session-derived identity, the `/ess` surface, the self-only repository
discipline, the mobile shell — against data that already exists and cannot be
corrupted by a bug. Every later phase then adds features to a boundary that has
been in production and exercised, rather than shipping a new boundary and new
write paths on the same day.

---

## 16. Open questions

1. Is leave in scope, and what are the types and accrual rules? (blocks §7)
2. Should ESS require a permission key, or is "has an active employee login"
   the right gate? (§4.1 — I recommend the latter)
3. Does a resigned employee retain read-only access to final payslips and
   documents, and for how long? (§10)
4. Is admin impersonation genuinely needed, given HR already has the
   management profile? (§4.4 — I recommend not building it)
5. Should employees see their salary *master*, or only payslips? (§5.3 — I
   recommend payslips only)
6. Do all ~630 employees get a login, or only some grades? This decides
   whether ESS provisioning is a bulk exercise and how large the
   password-reset population is.
7. Is ESS on the same domain and login as the management app, or separate?
   Same login is simpler and reuses everything above; a separate subdomain
   makes the "no management screens" boundary more obvious.
