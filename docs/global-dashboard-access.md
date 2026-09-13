# Global Dashboard access

One authorization layer for every dashboard on dnds.co.in. Attendance uses it
today; HR, Sales and My Dashboard are expected to use the same two calls rather
than growing copies of it.

## The two questions, kept apart

| Question | Answered by |
|---|---|
| May this person open this dashboard? | one **feature key** per dashboard |
| Which locations may they see? | the shared **store scope** |

A feature key permits a *screen*. It never widens a *location*. Conflating the
two is how a permission key silently became a company-wide grant in the first
Attendance implementation.

## Using it from a new dashboard

```js
const P = require("../constants/hr_permissions");

// `dashboardScope` is built once in server.js and handed to the router.
router.get(
  "/sales/dashboard/overview",
  this.dashboards.requireDashboardAccess(P.VIEW_SALES_DASHBOARD),
  async (req, res) => {
    // Reached only by a caller who may be here, with a scope already resolved.
    const store_ids = this.dashboards.storeIdsFor(req); // null | [id]
  }
);
```

`requireDashboardAccess` refuses, before the handler runs:

* no feature key -> 403 `NO_DASHBOARD_PERMISSION`
* no scope key -> 403 `NO_SCOPE_GRANTED`
* both scope keys -> 403 `CONFLICTING_SCOPE`
* Own Store but no employee row -> 403 `NO_EMPLOYEE_RECORD`
* Own Store but no branch on the employee -> 403 `NO_STORE_ASSIGNED`
* a request naming a branch outside the scope -> 403 `OUT_OF_SCOPE_LOCATION`

A handler that runs therefore has `req.dashboardScope` (never `NONE`) and
`req.dashboardStoreIds`, already narrowed.

A module that needs the scope without the middleware - a filters endpoint
building its own options, say - calls `resolveDashboardScope(req, key)` and
reads `.kind` itself.

## The three answers

| Kind | `store_ids` | Meaning |
|---|---|---|
| `ALL_STORES` | `null` | no restriction; a browser filter may narrow it |
| `OWN_STORE` | `[id]` | exactly the branch Employee Master assigns; nothing the caller sends changes it |
| `NONE` | `[]` | refused - never degrades to company-wide |

`[]` is a real answer meaning *no locations*, and is not the same as `null`.
The repository's `locationPredicate` renders it as `1 = 0`.

## Where Own Store comes from

`new_employee.store_id`, reached through `user.employee_id` =
`req.decoded.employee_id`, read **live on every request**.

Deliberately **not** `req.decoded.store_id`: that claim is copied into the JWT
at login (`usecase/user.js`) and never refreshed for the token's lifetime, and
`middlewares/auth.js` never validates it. An employee transferred in Employee
Master would keep a token naming the branch they no longer work at. An
authorization boundary cannot be a stale cache of a fact it does not own.

## The scope keys, and why there are two

The approved model is ONE value. The rights system has no enum: `permissions` is
(designation_id, permission_key, is_active) and every right in the application
is a boolean key. So the approved fallback applies - two keys,
`dashboard_scope_own_store` and `dashboard_scope_all_stores`, with exactly one
effective scope enforced on the server by `decideScope`.

* An **administrator** (`user_type` 2) is All Stores by user type, decided
  BEFORE the conflict rule - the permission middleware gives them every key, so
  applying the conflict rule to them would lock them out.
* A **non-administrator holding both** is a configuration fault and is refused.
  Guessing which was meant would turn a mis-click into company-wide access.

## Relationship with `all_stores`

`all_stores` ("Access All Stores") is an application-wide permission with its
own meaning outside dashboards - the web app's `UserContext` nulls the signed-in
user's store for holders, changing how operational screens behave. It is **not**
reused as a dashboard scope and **not** modified. Existing holders are not
migrated automatically.

## Telling the browser

`scopeForClient(scope)` returns only the kind, the pinned outlet and whether an
outlet picker should be offered. It carries no permission key, no reason code
and nothing about anybody else's branches. It is presentation input, never
authorization: every endpoint re-resolves the scope on the server regardless.

## What it does not do

It decides where a dashboard may look, not what it shows. It writes nothing and
grants nothing. Sales and HR data, routes and screens are not part of it.
