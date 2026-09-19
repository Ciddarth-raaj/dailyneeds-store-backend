# `purchase_api` TOKEN_REVOKED, 2026-09-17 14:04:26 UTC

Written up because the timestamp match is suggestive and suggestive is not
proven. The fix on this branch does not depend on which of the two callers
fired; the distinction is recorded so nobody later repeats the inference as
a fact.

## Proven

* `purchase_api` (user 198) has `token_valid_from = 2026-09-17 14:04:26`,
  `employee_id = 1`, `status = 1`, `last_login_at = NULL`.
* Employee 1 has a `period_corrected` / `date_corrected` lifecycle event at
  the same instant, actor employee 1, joining date moved to 2013-05-27.
* `purchase_api` has no logout, password-change or reset audit event near
  that time.
* The joining-date correction writes NO `token_valid_from`. `correctJoiningDate`
  (`usecase/employee_master.js`) calls `setJoiningDate`,
  `lifecycle.correctJoinedOn` and `_enqueueMembership`; `correctJoinedOn`
  (`usecase/employee_lifecycle.js`) writes the period row and the event and
  nothing else.
* **Writer class.** Only three statements write `user` keyed by
  `employee_id`, and only two of them write `token_valid_from`:
  * `repository/employee_master.js` `bumpTokenValidFrom(tx, employeeId)`
  * `repository/user.js` `bumpTokenValidFromByEmployeeId(employeeId)`
  Before this branch both excluded only `is_system_account = 0`, so both
  matched `purchase_api`. No DB trigger and no `ON UPDATE CURRENT_TIMESTAMP`
  exists: the column is plain `DATETIME NULL`
  (`20260906120000-auth-stage0a-user-columns-up.sql`).
* **Deployed revision.** `a945ec2` (committed and pushed 2026-09-17T14:02:05Z,
  deployed minutes later) was live at 14:04:26. Diffing `a945ec2` against
  `main-autodeploy@4243248` over `usecase/employee_master.js`,
  `usecase/employee_lifecycle.js`, `repository/user.js`,
  `repository/employee_master.js`, `routes/employee_master.js`,
  `middlewares/auth.js` and `utils/ip.js` shows additive changes only, none
  of them matching `token|revoke|bump`. The revocation code that ran then is
  the code on `main-autodeploy` today.
* `String(patch[k]) !== String(before[k])` in `editEmployee` classified an
  unchanged NULL vs `""` `designation_id` / `store_id` as a change, and a
  security-relevant change revokes. Fixed on this branch.

## Not proven

**Which caller fired.** Every caller of
`repository/employee_master.bumpTokenValidFrom()` is:

| Caller | Reaches it via | Leaves a lifecycle event? |
|---|---|---|
| `editEmployee` (`usecase/employee_master.js:557`) | `designation_id` / `store_id` judged changed | **No** — only the `EDIT-REVOKED` log line |
| `resignEmployee` (`:691`) | `_revokeIfOwed` | Yes, `period_closed` |
| `rejoinEmployee` (`:803`) | `_revokeIfOwed` | Yes, `period_opened` |
| `employee_bulk_update` | calls `editEmployee` / `correctJoiningDate` per row | as above |

plus `usecase/employee_lifecycle.js:414` via
`repository/user.js bumpTokenValidFromByEmployeeId`, on a standalone
reconcile.

The audit shows `period_corrected` only — no close, no open — so the
resign/rejoin callers are ruled out. That leaves `editEmployee`, which
writes no lifecycle event, which is consistent with what the audit shows but
is not the same as evidence. `editEmployee` and the joining-date correction
are issued from one Save on the Employment Details card
(`components/hr/profile/EmploymentSection.jsx` in the frontend), which makes
them plausible at one timestamp.

**Status: writer class proven; specific caller inferred.**

## The one command that would settle it

Read-only, on the application host, against retained logs:

```
grep -rF 'USECASE.EMPLOYEE_MASTER.EDIT-REVOKED' ~/.pm2/logs/ | grep '2026-09-17T14:0[3-5]'
```

(substitute the retained log location if PM2's logs have rotated elsewhere;
`journalctl` or the archived log for that day works the same way.)

* A hit naming employee 1 → the caller is `editEmployee`, i.e. the
  null-vs-blank misclassification, and both halves of this branch's fix are
  load-bearing.
* No hit, with logs known to be retained for that window → the caller is the
  lifecycle reconciler path, and the guard alone is the fix.
* No retained logs → it stays inferred. Say so.

Either way the statement that wrote the column is guarded on this branch.
