# Telegram Attendance Mini App — regularising a missing punch from Telegram

The 06:00 Missing Attendance alert carries a **Regularise Attendance** button.
Tapping it opens a Telegram Mini App with two sections:

* **My Attendance** (the default) — the employee's own calculated month,
  read-only, with month navigation that stops at the current month. Tapping a
  day opens the existing Day Detail.
* **Corrections** — every date inside the regularisation window that needs a
  correction or already has one, with its state. An actionable date takes a
  missing punch time and a reason.

Submitting creates the **ordinary Daily Needs attendance regularisation
request** — same engine, same rules, same manager/HR approval chain. There is
no Telegram approval system and no second regularisation workflow, and no
second attendance calculation.

## Identity — the whole of it

A Mini App runs in a WebView the employee controls, so nothing it sends is
trusted:

* **not** an `employee_id` in the URL (there isn't one — the button's URL
  carries only `?date=`, a navigation hint)
* **not** an `employee_id` in a request body (Joi refuses unknown keys: a 422)
* **not** an employee name, code or Telegram username
* **not** group membership, a mobile number, or anything else

The one trusted input is Telegram's **`initData`**: a query string Telegram
signs with a key derived from the bot token.

1. `utils/telegram_init_data.js` verifies it — `secret = HMAC_SHA256("WebAppData",
   TELEGRAM_BOT_TOKEN)`, `expected = HMAC_SHA256(secret, data-check-string)`,
   compared in constant time. **Only `hash` is excluded** from the
   data-check-string. `signature` — the newer Ed25519 field for *third-party*
   validation, which we do not need and do not implement — is a received
   field and Telegram hashed it with everything else, so it **stays in**.
   Dropping it would refuse every payload from a current client. A duplicated
   key is refused outright.
2. `auth_date` must be within **5 minutes** (and not meaningfully in the
   future), so captured `initData` is not a permanent credential.
3. The signed Telegram `user.id` is looked up in `employee_telegram_identity`
   **where `disconnected_at IS NULL`**. That row is the employee. No mapping
   or a disconnected mapping is a refusal, never a fallback.

## The scoped session

`POST /telegram/attendance/session` spends the signature once and returns a
short-lived token (**15 minutes**) carrying `{ scope, emp, tgu, sid }`.

It **cannot become a dnds.co.in session.** `middlewares/auth.js#resolveIdentity`
accepts exactly two claim shapes: `auth_ver: 2` needs a string `sub`, and the
legacy shape needs a positive-integer `id` *and* `employee_id`. This token has
none of `sub`, `id`, `employee_id` or `auth_ver`, so it resolves to `null` — a
403 — on every ordinary route. It grants no permission key and names one
employee. The reverse also holds: an ordinary login token has no `scope` claim
and is refused by the Mini App.

The token travels in its own header, **`x-telegram-session`**, never
`x-access-token`.

## The bot's home menu

A plain `/start` in the private bot chat answers with **Daily Needs Employee
Services** and three inline `web_app` buttons — My Attendance, Corrections,
Help — for a Telegram account with an active `employee_telegram_identity`.
Anyone else gets one flat sentence telling them to complete Telegram setup
through Daily Needs, and nothing about any employee.

The same menu is attached to the **Telegram connected successfully ✅**
message the instant verification finishes, so an employee never has to
discover that typing `/start` produces buttons. The success text and every
check that leads to it are unchanged.

### Why plain `/start` is safe to claim

`usecase/passwordReset.js#parseStartPayload` is `/^\/start(?:@\w+)?\s+(\S+)$/`
— the `\s+(\S+)` makes a payload **mandatory**, so a bare `/start` has never
matched it and still does not. The menu's predicate is the exact complement
(`\s*$`), which makes the two mutually exclusive by construction:

| Message | Owner |
| --- | --- |
| `/start` | `telegram_employee_menu` |
| `/start e_<token>` | `employee_telegram_link` |
| `/start <48-hex>` | password reset (the poller's own branch) |
| `/setup` in a group | group detection (observer, claims nothing) |

`usecase/telegram_update_ownership.test.js` runs the **real** predicates over
a corpus of updates and fails if any update is ever claimed twice — replacing
an older "one claimer per update type" count, which would have been satisfied
by two overlapping claimers on different types and broken by two safe ones on
the same type. There is still exactly one `getUpdates` owner, no webhook, and
`ALLOWED_UPDATES` is unchanged (`message`, `chat_join_request`).

## The API

### Mini App deep links

| URL | Opens |
| --- | --- |
| `<base>` | My Attendance |
| `<base>?section=attendance` | My Attendance |
| `<base>?section=corrections` | Corrections |
| `<base>?section=help` | Help |
| `<base>?section=corrections&date=YYYY-MM-DD` | Corrections, that date highlighted (the 06:00 alert) |

`section` and `date` are **navigation only and carry zero authority**. An
unknown, empty, absent or hostile `section` falls back to My Attendance; a
`date` the employee is not entitled to is simply not in the list the server
returns, so it highlights nothing. Neither is ever sent to the API.

| Method | Path | What it does |
| --- | --- | --- |
| POST | `/telegram/attendance/session` | exchange `init_data` for the scoped token |
| GET | `/telegram/attendance/month?month=YYYY-MM` | My Attendance: one month of own days |
| GET | `/telegram/attendance/missing-dates` | Corrections: own correction dates |
| GET | `/telegram/attendance/date?attendance_date=` | one date, read-only |
| POST | `/telegram/attendance/regularization` | raise the ordinary request |

All five are listed in `middlewares/auth.js#unProtectedRoutes` for the same
reason `/user/login` is: the caller has no session and cannot get one (most
employees have no dnds.co.in login at all). They are not unauthenticated —
each applies the stricter gate above. The paths are **static** because that map
is an exact `req.path` lookup, which is why the date is a query parameter.

## What is reused, and what is not rebuilt

* **who is missing** — `usecase/attendance_missing.js#findMissingAttendance`,
  the same builder the Missing Attendance report and the 06:00 job use. The
  odd-punch test, the zero-punch exclusion, the eligibility test and the
  "today is never reportable" clamp are `utils/attendance_missing.js`.
  Nothing in the Mini App counts punches.
* **what a date looks like, and My Attendance entire** —
  `usecase/attendance_calculation.js#readRange`, the same read
  `/attendance/me` serves. `getMonth` is that call over one month, clamped to
  today. Every attendance state the screen shows — Final, Missing Punch,
  Regularization Pending, Review Required, No Shift, Absent, Shift Setup
  Issue — is the engine's, rendered by `util/attendanceV2.js#dayIssue` in the
  same `AttendanceDayList` / `AttendanceDayDetail` components the web screen
  uses.
* **what was filed and what came of it** —
  `usecase/attendance_regularization.js#listForEmployee`, so PENDING /
  APPROVED / REJECTED are `attendance_approval_request.status` and not a
  second reading of the day.
* **whether it may be submitted** —
  `usecase/attendance_regularization.js#raiseRequest`, called with actor and
  `requested_for_employee_id` both set to the authenticated employee.
* **how far back** — `attendanceRegularizationUsecase.MAX_BACKDATE_DAYS`, read
  from the usecase that owns it rather than restated.

## No punch count reaches the employee

The daily message is now:

```
Good morning.
Your attendance for 19 Sep 2026 has a missing punch.
Please submit the required attendance correction.
```

The count is still calculated, still stored on the
`attendance_missing_notification` row, and still on the Missing Attendance
report. It is absent only from what the employee reads, and from the Mini
App's list and detail payloads.

## Configuration

| Variable | Required | Notes |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | yes (already set in production) | the same bot credential; also what validates `initData`. Never leaves the server. |
| `ATTENDANCE_CORRECTION_MINI_APP_URL` | yes, to show the button | the Mini App page, e.g. `https://dnds.co.in/telegram/attendance`. **Unset = no button, and the alert still sends.** |

The bot token is **never** put in frontend code or a `NEXT_PUBLIC_*` variable.
No migration is required: `employee_telegram_identity` and
`attendance_missing_notification` already exist.

An inline `web_app` button needs **no `/newapp` or Main Mini App
registration**. What it needs operationally is:

* an HTTPS Mini App URL
* `ATTENDANCE_CORRECTION_MINI_APP_URL` set to it
* the private employee↔bot chat (which the alert already uses)
* an active `employee_telegram_identity` for the employee

`ATTENDANCE_CORRECTION_MINI_APP_URL` is the **only** place the Mini App's
address is configured. No hostname is hard-coded in application logic; every
URL is built by `utils/telegram_mini_app_url.js` from that value, and a test
greps that file for `dnds.co.in` to keep it that way.

### The permanent Telegram menu button — set by hand, once

This is a **BotFather / global bot setting**, not something the application
touches. No deploy reads it, writes it or depends on it, and nothing in this
codebase calls the Bot API to change it.

Set it manually in BotFather:

| Setting | Value |
| --- | --- |
| Menu button text | `My Attendance` |
| Web App URL | `https://dnds.co.in/telegram/attendance` |

It is a convenience — the bot's `/start` menu and the alert button both work
without it.

## The frontend shell

`/telegram/attendance` is listed in `pages/_app.js#STANDALONE_PATHS` and
renders inside `ChakraProvider` **only**. The ordinary shell is not passive:
`UserProvider` calls `GET /employee/get-details` and
`GET /designation/permissions` from a mount effect, and with no dnds.co.in
session `util/handle403.js` correctly reads their 403 as a dead session and
redirects to `/login` — which, inside Telegram's WebView, means the employee
never sees the page. `UserProvider`, `ProductsProvider`,
`ModuleTableThemeBridge`, `StockHoldingBackgroundLoadToast` and the toast
surfaces are therefore not mounted for this route, and `initUser` returns
early so no session header is attached on its behalf.

The route is read from `this.props.router`, not the `next/router` singleton:
during `next build`'s static prerender there is no router instance, and
touching the singleton there fails the build for every static page.

## The employee-identity guarantee

The guarantee is: **the browser never chooses, supplies or controls the
employee identity.** It is not that the id is a secret — the scoped session
token carries a signed `emp` claim the server reads and the client cannot
alter, and the employee plainly knows who they are.

What that means concretely:

* no `employee_id`, `requested_for_employee_id`, store, outlet, designation
  or approval-role field exists in any query or body schema on this
  namespace, and Joi refuses unknown keys — sending one is a 422
* every read and write is pinned to `req.miniApp.employee_id`
* the button URL carries only `?date=`, a navigation hint
* response bodies carry no `employee_id`, because the frontend has no use for
  one and a field a client is handed is a field it starts sending back

## Audit

* session issue and a verified-but-unmapped Telegram user are logged with the
  Telegram user id, the employee id and a session id
  (`USECASE.TELEGRAM-ATTENDANCE-SESSION`)
* a submission is logged with employee, date, request id and session id
  (`USECASE.TELEGRAM-ATTENDANCE-MINIAPP`)
* the regularisation request's own audit trail remains the source of truth
* the bot token, raw `initData` and the Telegram hash are never logged — the
  validator does not even return them

## Tests

```
node --test utils/telegram_init_data.test.js
node --test usecase/telegram_attendance_session.test.js
node --test usecase/telegram_attendance_miniapp.test.js
node --test routes/telegram_attendance.test.js
node --test usecase/attendance_missing_telegram.test.js
```
