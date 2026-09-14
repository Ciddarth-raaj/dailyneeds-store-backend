# Employee branch scope

**What changed:** every employee read and every employee write on `dnds.co.in`
is now confined to the branches the caller is assigned to in Employee Master.
HR and administrators are company-wide, as they were.

## The defect

`view_employees` and `employee_edit` said WHETHER somebody could read or write
an employee. Nothing said WHERE. A Store Manager at Kathirkamam holding
`view_employees` could read every employee in the company, and holding
`employee_edit` could change any of them - by typing another branch's employee
id into `/employee/<id>`, by picking another outlet in the list filter, by
searching, or by calling the API directly.

This was known and recorded rather than hidden: `repository/employee_scope.js`
carried an `accessScope` unit that was deliberately EMPTY, with a comment
saying that emptiness was "a finding rather than an omission" and that the unit
existed so a restriction could be added in one place and apply to the directory
and to Reports at once. That is what has now happened.

## The rule

```
canViewEmployee = hasViewEmployeePermission
                  AND (isAdmin OR isHR OR employee.store_id IN caller.branches)

canEditEmployee = hasEditEmployeePermission
                  AND (isAdmin OR isHR OR employee.store_id IN caller.branches)
```

The permission keys are unchanged and are still checked first. The branch scope
NARROWS; it never widens, and holding a branch grants no key.

### Who is company-wide

| | how |
|---|---|
| Administrator | `user_type = 2`, the system's existing single administrator concept. Checked before any key is read, because the permission middleware gives an administrator every key. |
| HR | the `employee_scope_all_branches` permission key, granted by migration to the `HR EXECUTIVE` designation and to nobody else. |

There is no `is_hr` column on `designation` to read. The `permissions` table's
only shape of right is a boolean key per designation, so HR is expressed as one
key - the same way the Work Shift, Attendance and Dashboard features express
theirs, and grantable to a second HR designation on the rights screen without a
code change.

### Everybody else

Scoped to `new_employee.store_id` for their OWN employee record, read LIVE on
every request. Not `req.decoded.store_id`: that claim is a copy taken at login
and nothing refreshes it, so a transferred manager would keep authority over
the branch they left until they next signed in.

The scope is carried as a LIST throughout, because the approved rule is "the
user's assigned branch/branches". `new_employee.store_id` holds one branch per
employee, so the list has one element in production; a user -> branches mapping
would be read in `repository/employee_branch.js` and nowhere else.

### Fail closed

Refused, never widened to company-wide:

* no employee record (a system / break-glass account)
* an inactive employee record
* no branch assigned in Employee Master
* an employee whose branch cannot be determined
* an actor that reached a query WITHOUT a resolved scope - `accessScope`
  renders `1 = 0` for one, so a future query that forgets the resolver returns
  an empty screen rather than everybody

## Where it lives

| file | what |
|---|---|
| `utils/employee_branch_scope.js` | the rule, as pure functions. No database, no Express. |
| `repository/employee_branch.js` | two read-only lookups: the caller's branches, and one employee's branch. Nothing sensitive is selected. |
| `middlewares/employee_branch_scope.js` | the resolver, and the guards routes use: `requireEmployeeInScope`, `checkTargetBranch`, `listFilters`, `actorFor`. |
| `repository/employee_scope.js` | `accessScope` renders a resolved scope into the WHERE clause shared by the HR directory, Reports and the shift-assignment population. |

## What is protected

**Detail reads and every write that names an employee** carry
`requireEmployeeInScope`. A non-existent employee id gets the SAME refusal as a
foreign one, so ids cannot be enumerated by watching the answer change.

* `/employee/employee_id`, `/employee/update-status`, `/employee/updatedata`
* every `/hr/employee/:employee_id/*` route - edit, joining date, resign,
  rejoin, lifecycle, Aadhaar (status, attach, full) and bank (verify, status,
  confirm-name, name-review, override-duplicate), onboarding education,
  attendance-required
* `/hr/work-shift-assignments/employee/:employee_id`, `/correction`, and
  `/bulk` - where EVERY employee in the list must be in scope, because the
  assignment itself is all-or-nothing

**Lists, searches and counts** are narrowed in SQL, not trimmed afterwards:
`/employee/employees`, `/employee/filter` (search), `/employee/headcount`,
`/employee/store_id`, `/employee/familydet`, `/employee/bank`,
`/employee/birthday`, `/employee/anniversary`, `/employee/newjoinee`,
`/employee/newjoiner`, `/employee/resignedemp`,
`/hr/employees/status-summary`, `/hr/employee/check-duplicate`,
`/hr/lifecycle/review` (and its total), `/hr/work-shift-assignments`, and
Employee Reports including both exports.

A request that NAMES a branch outside the caller's scope is REFUSED rather than
silently narrowed - otherwise their own branch's figures would come back under
another branch's heading.

## Branch transfer

A scoped caller may only ever name a branch they are authorized for, on create
and on edit, so Employee Edit cannot move somebody out of - or into - their
scope. A write that does not name `store_id` is not a transfer and is
unaffected. HR and administrators keep the transfer capability they have today.

## Two pre-existing defects fixed in passing

Both were in `getEmployeeByFilter`, the employee search, and both had to be
fixed for the branch scope to hold there at all:

* **Precedence.** The clause read `status = 1 AND name LIKE x OR id LIKE x OR
  outlet LIKE x`. AND binds tighter than OR, so the last two arms stood alone -
  a branch predicate appended to that shape would have been bypassable by
  exactly those two arms. The search group is parenthesised now.
* **Interpolation.** The search term went from the query string straight into
  the SQL text. It is a bound parameter now, with `%` and `_` escaped.

## Rollback

`migrations/.../20261002120000-employee-branch-scope-down.sql` removes the key.
Rolling back the SQL alone fails CLOSED, not open: with the key gone and the
code still deployed, only administrators are company-wide and HR is confined to
its own branch. Restoring the previous behaviour means deploying the previous
code too.

## Known limits

* One branch per user, because `new_employee.store_id` holds one. The rule,
  the resolver and every predicate already handle a list.
* `/hr/employee/check-duplicate` is scoped, so a branch-scoped creator no
  longer sees a duplicate at another branch. It is an ADVISORY check that
  blocks nothing; the uniqueness guarantees that actually prevent a duplicate
  record are elsewhere and are unchanged, and HR - who complete onboarding -
  still see company-wide matches.
* The web app is unchanged. It sends an outlet filter only when a user picks
  one, so a scoped caller's screens narrow silently; picking another branch's
  outlet returns a clear 403 rather than that branch's data.
