# Telegram Attendance Mini App — regularising a missing punch from Telegram

The 06:00 Missing Attendance alert now carries a **Regularise Attendance**
button. Tapping it opens a Telegram Mini App in which the employee sees their
own missing-attendance dates, opens one, enters the missing punch time and a
reason, and submits. What that creates is the **ordinary Daily Needs
attendance regularisation request** — same engine, same rules, same
manager/HR approval chain. There is no Telegram approval system and no second
regularisation workflow.

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
   compared in constant time. `hash` and `signature` are excluded from the
   data-check-string; a duplicated key is refused outright.
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

## The API

| Method | Path | What it does |
| --- | --- | --- |
| POST | `/telegram/attendance/session` | exchange `init_data` for the scoped token |
| GET | `/telegram/attendance/missing-dates` | this employee's actionable dates |
| GET | `/telegram/attendance/date?attendance_date=` | one date, read-only |
| POST | `/telegram/attendance/regularization` | raise the ordinary request |

All four are listed in `middlewares/auth.js#unProtectedRoutes` for the same
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
* **what a date looks like** — `usecase/attendance_calculation.js#readRange`,
  the same read `/attendance/me` serves.
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

The Mini App URL must also be registered with BotFather (`/newapp` or the bot's
Menu Button / Web App domain) before Telegram will open it.

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
