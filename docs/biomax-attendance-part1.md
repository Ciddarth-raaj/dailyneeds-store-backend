# Biomax attendance - Part 1: the raw punch flow (as built)

Status: implemented on branch `claude/biomax-attendance-spec-uh6y3m` in both
repositories; **not deployed**. Deployment and any change to a real Biomax
terminal require separate approval (see §9).

This is the specification as approved (Revisions 1-5 plus the final
amendments) reconciled with what the code does. Where the two differed the
code was made to follow the approval; the few deliberate deviations are in
§8.

---

## 1. Scope

**Goal.** Biomax BM70W punch -> dnds.co.in raw storage -> employee-master
join -> Attendance List and Punch Audit. Nothing is interpreted.

**Built.** Device registry with effective-dated locations and an audited
history; append-only raw punch storage with transport dedup; IST-safe time
handling; the exact BM70W acknowledgement; attendance-date attribution from
the employee's assigned shift and the previous day's Attendance Day Cutoff;
a review queue for punches that cannot be dated; the Attendance List
(employee x date, cross-outlet merged) with a Home Outlet filter; the Punch
Audit (one row per punch) with device / location filters under its own
permission; server-side CSV exports audited by shape; a standalone pm2
receiver; the fixed fake-device fixture; Shift Management validation making
the cutoff mandatory.

**Not built, by decision.** IN/OUT pairing, near-duplicate collapse, breaks,
grace, late/early, Actual/NRM/Under/OT, Present/Absent/Half Day,
regularisation, payroll (all Part 2); proxy, historical pull, backfill,
device redirection, cutover (decided later); the re-derivation endpoint
(tables and key reserved only).

---

## 2. Protocol (verified on hardware; fixtures in `test_support/biomax/`)

Request `POST /hdata.aspx HTTP/1.0` with custom headers; `request_code`
alone decides: `realtime_glog` = punch, anything else = poll. Punch body
`<uint32 LE len><JSON><0x0A><0x00>`, JSON fields `fk_bin_data_lib`,
`io_mode`, `io_time` (14 digits, device-local IST), `log_image`, `user_id`
(string = employee code), `verify_mode`. No `log_id`.

Reply: the device reads the `response_code` header, not the status line.
Punch -> `response_code: OK`. Poll -> `response_code: ERROR_NO_CMD` plus
empty `cmd_id:` and `cmd_code:`. Body empty, `Content-Length: 0`,
`Connection: close`. A bare 200 without the header causes a retry storm.
An unacknowledged punch is retried every ~3 minutes and blocks newer punches
on that device, which is the property the receiver relies on for safety.

---

## 3. Rules (numbered; tests cite them)

- **R1** ACK only what is durable: `OK` after the punch row (new or
  duplicate) or a raw-request row is committed; otherwise close with no
  reply so the device retries.
- **R2** Dedup is the unique key `(dev_id, user_id, io_time_raw)` with a
  retransmit counter. Transport only.
- **R3** `io_time` never passes through a JS Date: `STR_TO_DATE` in the
  INSERT; date arithmetic on the digits with `Date.UTC`.
- **R4** Times leave the DB as strings (`DATE_FORMAT`).
- **R5** `user_id` stored verbatim (VARCHAR). Match = 1-9 ASCII digits with
  value > 0; `"0042"` -> 42; `"0"`, `"000"`, blank, letters, spaces,
  `1e3`, `-5`, `1.0`, full-width digits, 10+ digits -> unmatched. Never 0.
- **R6** Unmatched is a state, not a filter.
- **R7** Registry is a lookup, not a gate: an unregistered Cloud ID's punch
  is stored, ACKed, and quarantined (`UNREGISTERED_DEVICE`) until registered.
- **R8** `biomax_punch` is append-only; only the R2 counter is ever updated.
- **R9** Receiver writes; API reads.
- **R10** One header decides (see §2).
- **R11** Attendance row key = employee + attendance_date. Device and outlet
  are never part of it; a day across several outlets is one row.
- **R12** Home Outlet (employee master, snapshotted at ingest) and Punch
  Location (device registry, resolved by time) are separate and neither
  writes the other.
- **R13** Flood caps for unregistered devices: 30/min, 2000/day per Cloud
  ID, 20 distinct unknown Cloud IDs/day; capped frames are ACKed, not stored,
  one raw row per hour.
- **R14** The Attendance List has no device or punch-location filter and
  answers 400 to one; those live on the Punch Audit.
- **R16** Anything derived from current-state tables is computed once at
  ingest into `biomax_punch_derived`; edits to employees, shifts, schedules
  or devices affect later punches only. The only way a stored derived value
  changes is an audited re-derivation run (reserved).
- **R17** Punch location = the assignment period containing the punch's
  `io_time`. Moving a terminal closes one period and opens another.
- **R18 (A1/A2/A3)** Attendance date: read the employee's
  `default_work_shift_id`, then the schedule row for the **previous
  calendar day's** weekday, then `is_working_day` and
  `attendance_day_cutoff`. If working and `time_of_day < cutoff` ->
  previous date, else the punch's date. Nothing else is read. If the
  employee is unmatched, has no shift, the row is missing, or a working row
  has no cutoff, `attendance_date` is NULL with a status
  (`UNMATCHED` / `NO_SHIFT` / `NO_SCHEDULE_ROW` / `MISSING_CUTOFF`) and the
  punch sits in the review queue. Nothing falls back to the calendar date.

Shift Management enforces A1/A2: a working row cannot be saved without a
cutoff; a rest row's cutoff is cleared; the cutoff must be earlier than the
next working day's In time (`utils/workShift.js`, mirrored in the frontend).

---

## 4. Schema (migration `20260911120000-biomax-raw-attendance`)

| Table | Purpose |
|---|---|
| `biomax_device` | one row per terminal; `dev_id` verbatim, unique; label, notes, first/last seen |
| `biomax_device_assignment` | effective-dated location periods; several devices per outlet allowed |
| `biomax_device_event` | append-only admin history (created, label/notes changed, dev_id corrected, assignment opened/closed) |
| `biomax_punch` | RAW, append-only; unique `(dev_id, user_id, io_time_raw)`; `io_time DATETIME` IST; `punch_date` generated; protocol fields; `raw_json` |
| `biomax_punch_derived` | 1:1 sidecar: `attendance_date` (nullable), `derivation_status`, employee/home outlet/department snapshot, shift and schedule row consulted, `cutoff_applied` |
| `biomax_raw_request` | unparsed / unknown / oversized / first-seen / flood / config-error / store-error diagnostics with the verbatim frame |
| `biomax_derivation_run`, `biomax_derivation_change` | reserved for the audited re-derivation |

Permissions: `view_raw_attendance`, `export_raw_attendance`,
`view_attendance_punch_audit` granted to HR EXECUTIVE by name;
`view_biomax_devices`, `manage_biomax_devices` granted to nobody (admins
via bypass); `rederive_attendance` declared, granted to nobody, gates no
route.

Seed: the seven confirmed terminals, Cloud IDs verbatim (letter O and digit
0 both present, never normalised), initial assignments from
`2026-09-01 00:00:00` - DN1..DN5 by `outlet_code`, WH and G2 to `outlet_id
2` (Warehouse). A device whose outlet code is not found is reported by the
migration and assigned from the Devices screen. The migration also prints
any working schedule row lacking a cutoff; it backfills nothing.

**MySQL floor.** The migration uses features available from MySQL 5.7.8
(JSON, generated columns, `DATETIME(3)`, `JSON_OBJECT`). The `CHECK`
constraint on assignment periods is enforced on 8.0.16+ and parsed-and-
ignored on 5.7; the usecase enforces the same rule regardless. There is no
stored generated column for employee matching (it moved into the receiver
under D10), so the 5.7 concern raised for that column no longer applies.
The actual server version is still to be confirmed on the host (§9) before
the migration runs.

---

## 5. Receiver (`biomax/`, pm2 app `biomax-receiver`)

Files: `receiver.js` (HTTP server, request flow, `/healthz`),
`protocol.js` (pure parse/ack), `employeeMatch.js` (R5),
`attendanceDate.js` (R18), `flood.js` (R13), `store.js` (all writes, the
three minimal reads, schedule row cache 60 s), `log.js` (one JSON line per
request), `spool.js` (last-resort disk copy of frames refused for lack of a
database; never a recovery queue).

**Runtime (D1, amended).** Production is `ec2-user` on the host's existing
**Node 14.21.3**, the same unpinned `node` the API runs on. No second Node
is installed and the receiver is never run as root. `biomax/` uses no API
newer than Node 14 (no `fetch`, no `node:` prefixes, no `??=`/`||=`, no
`replaceAll`, no `Array.prototype.at`); `assertRuntime()` exits with code 78
and a clear message below Node 14. **No new npm dependency was added**; the
receiver uses `mysql@^2.17.1`, already in `package.json`, plus Node built-ins.
Node 14 reached end-of-life in April 2023. That is a pre-existing condition
of the host; upgrading the API runtime is out of scope for Part 1 and is
recorded as technical debt (§10).

Env: `BIOMAX_PORT` (7005), `BIOMAX_HOST`, `BIOMAX_MAX_BODY`,
`BIOMAX_SOCKET_TIMEOUT_MS`, `BIOMAX_SPOOL_DIR`, `BIOMAX_UNREG_PER_MINUTE`,
`BIOMAX_UNREG_PER_DAY`, `BIOMAX_UNREG_DEVICES_PER_DAY`. DB from the same
`config.json` `db.mysql[env]` section as `drivers/mysql.js` (the primary
application database; never the GoFrugal pool).

**Activation is separate from the backend deploy.** The receiver is declared
only in `ecosystem.biomax.config.js`; `ecosystem.config.js` deliberately
does not list it and `deploy-backend.yml` neither starts nor reloads it (it
only prints a notice if it happens to be running). A normal dnds.co.in
deploy therefore ships the API, migrations and any backend change without
touching the receiver. Activation is one explicit, approved operator action
as `ec2-user`: `pm2 start ecosystem.biomax.config.js && pm2 save`. From then
on pm2 supervises it (crash restart, resurrect on reboot via the existing
pm2 startup unit). New receiver code reaches a running receiver only when an
operator runs `pm2 reload biomax-receiver` deliberately; a reload is lossless
under R1.

---

## 6. API (`/attendance`, main API)

| Endpoint | Key | Notes |
|---|---|---|
| `GET /attendance/raw` | `view_raw_attendance` | `from`, `to` (≤ 92 days), `home_outlet_id`, `department_id`, `search`; **400 on `dev_id` / `punch_outlet_id`** |
| `GET /attendance/raw/summary` | `view_raw_attendance` | banner counts |
| `GET /attendance/raw/export.csv` | `export_raw_attendance` | same filters; `with_locations=1` renders `HH:MM:SS @DN2` |
| `GET /attendance/raw/punches` | `view_attendance_punch_audit` | ≤ 31 days, ≤ 1000 rows; `dev_id`, `punch_outlet_id`, `device_status`, `review=needs_review|ok`, `search`, `source_ip`, `employee_id`, `attendance_date` |
| `GET /attendance/raw/punches/export.csv` | `view_attendance_punch_audit` | |
| `GET /attendance/devices`, `/unregistered`, `/details` | `view_biomax_devices` | |
| `POST /attendance/devices/create`, `/update-details`, `/assign`, `/deactivate`, `/correct-cloud-id` | `manage_biomax_devices` | no delete exists |

Attendance List row: `employee_id`, `user_id`, `matched`, `employee_name`,
`department_name`, `home_outlet(_id/_code)`, `clock_date` (=
attendance_date), `punches[]` (time, io_time, calendar_date, dev_id,
device_label, punch_outlet(_id/_code), source_ip, cutoff_applied),
`punch_count`, `distinct_punch_outlets`, `quarantined_punch_count`.
`meta.max_punch_count` drives the column count. Punches from a device that
is `UNREGISTERED_DEVICE` or `INACTIVE_DEVICE` at their time are left out of
`punches[]` and counted (D6/D8).

Exports: streamed CSV, refusals before the first byte, `res.on("error")`
guard, `csvCell` formula neutralisation, `report_export_log` row with
`dataset_key` `RAW_ATTENDANCE` / `RAW_ATTENDANCE_PUNCHES`, shape only.

Device rules: Cloud ID immutable in normal editing; `correct-cloud-id`
needs a reason, is audited, and is refused once the device has punched.
Move = close the open period at `effective_from` and open the new one.
Deactivate = close with no successor. Replace = deactivate + add the new
Cloud ID as a new device. Closing a period before the device's latest punch
returns 409 `needs_confirmation`; the UI shows the question and sends
`confirm_before_last_punch=true` only on a deliberate second click.

---

## 7. UI (Attendance module)

Menu module **Attendance** (purple) with Attendance List
(`view_raw_attendance`), Punch Audit (`view_attendance_punch_audit`), Biomax
Devices (`view_biomax_devices`). Permission catalogue group `attendance`.

`/attendance/list`: two tabs. **Attendance List** - From/To, Home Outlet,
Department, Employee; columns Employee Code | Employee Name | Department |
Home Outlet | Clock Date (DD/MM/YYYY) | Clock Time-1..N | Punches; each time
cell shows the punch location underneath in one neutral style for every
punch, with a hover popover (device, Cloud ID, punched-at, source IP,
calendar date when it differs); `Punches` shows `4 (+1 quarantined)` linking
to the audit; banners count undatable/quarantined punches and link to the
existing screen that fixes each cause; two server CSV exports. **Punch
Audit** - Punch Location, Device, Device status, Review, Employee, Source
IP; one row per punch with status badges; "Open day" links back to the
employee's full day; server CSV.

`/attendance/devices`: Device Label | Cloud ID | Location | Effective From |
Effective To | Status | Last Punch | Punches Today | Actions; "Unregistered
devices seen" with Register (pre-fills Cloud ID and suggests the first punch
as Effective From). `/attendance/devices/new`: Cloud ID, label, Location,
Effective From (required, no default), notes. `/attendance/devices/[id]`:
details, label/notes edit, Move / Deactivate / Reactivate (effective-dated,
confirmation on closing before the last punch), Correct Cloud ID (reason
required), Location history, Device history.

The shared grid gained a `hideExport` prop so these screens have exactly one
export path.

---

## 8. Deviations from the approved text

1. **No stored generated matching column.** Revisions 1-3 put
   `employee_id_num` on the raw table; D10 ("all derived information in the
   sidecar") made that inconsistent, so the match is computed in the
   receiver (`employeeMatch.js`) and the matched `employee_id` is
   snapshotted in `biomax_punch_derived`. Same rule, one place, no generated
   column, and rule R15 (generated-column freeze) is therefore moot.
2. **Punch Audit CSV under the audit key**, not a separate export key
   (Revision 3 §7 said the same; recorded here because D5 mentions only the
   list export).
3. **`hideExport` prop added to `components/AgGrid`** - a small shared
   change not listed in the file plan, needed to keep one export path.
4. **Nothing in the spec's Revision 4 fallback survives**; Revision 5
   replaced it and the code follows Revision 5.

---

## 9. Deployment-only actions (each requires its own approval; none done)

Resolved and no longer open: warehouse = `outlet_id 2` (WH and G2 both map
to it, seeded); all seven terminals point directly at DigiSME
(`4.247.27.112:82`) and stay there; the runtime is the host's Node 14.21.3
under `ec2-user` (`pm2 describe 0` verified), nothing to install or change.

1. **Pre-migration check (required):** `SELECT VERSION();` on the primary
   application database (the `db.mysql` section of `config.json`, i.e. the
   `drivers/mysql.js` connection; never the GoFrugal pool). The migration
   requires **MySQL 5.7.8 or later**; on 8.0.16 or later the `CHECK` on
   assignment periods is also enforced by the server. Do not assume.
2. Ordinary backend deploy (push to `main-autodeploy`): API + migration.
   After `db-migrate up`, read the two report SELECTs it prints (seeded
   devices whose outlet code was not found; working schedule rows without a
   cutoff). This deploy does **not** start the receiver.
3. **Receiver activation (separate approval):** as `ec2-user`, `pm2 start
   ecosystem.biomax.config.js && pm2 save`; confirm `systemctl status
   pm2-ec2-user`; `sudo ss -ltnp | grep -E ':82 |:7005 '` should then show
   no listener on 82 and the receiver on 7005; local smoke test
   `HOST=127.0.0.1 PORT=7005 RAW=1 node test_support/biomax/fake-device-http.js`
   -> `PASS: response_code: OK`, `MODE=poll` -> `PASS: response_code:
   ERROR_NO_CMD`; then delete the test rows (`biomax_punch_derived` first,
   then `biomax_punch`) - the only time those tables are ever deleted from.
4. **Lightsail IPv4 Firewall (separate approval, not touched by this
   project's code):** leftover rules for 82 and 7005 are left as they are
   until that operation is approved. When parallel testing is approved,
   allow TCP 7005 from the outlets' static IPs only.
5. **Static IP source of truth for that allowlist:** the repositories hold
   no outlet IP values. They live in the production table
   `outlets.allowed_ips` (with `outlets.ip_restriction_enabled`), maintained
   through the IP Restrictions screen (`docs/ip-restrictions.md`,
   `repository/outlet.js#updateIpRestriction`). Read them at operation time
   with `SELECT outlet_id, outlet_code, allowed_ips, ip_restriction_enabled
   FROM outlets;` and use exactly those values; do not copy IPs from
   captures, screenshots or notes. Both feature branches are based on the
   current `main-autodeploy` head with nothing to reconcile.
6. Do **not** change DigiSME or any terminal's Server IP until cutover is
   decided.
7. HR: create the real work shifts with cutoffs and assign employees before
   parallel-run acceptance (A3); until then every punch is `NO_SHIFT` and sits
   in the review queue.

---

## 10. Technical debt recorded

- Host runtime Node 14.21.3 (EOL April 2023) for both the API and the
  receiver. Pre-existing; out of Part 1 scope.
- No employee posting history: home outlet/department are snapshotted at
  ingest because `new_employee` overwrites them in place.
- No dated roster: `default_work_shift_id` is the only employee -> shift
  link; a future roster replaces one read in `attendanceDate.js`.
- `utils/logger.js` maps WARN to a non-standard level; the receiver logs at
  info/error only.

---

## 11. Part 2 - NOT FOR IMPLEMENTATION

Raw punches -> punch processing -> the employee's assigned shift for that
date (never the outlet/device) -> break rules -> grace -> late/early ->
Actual -> NRM -> Under -> OT -> status -> payroll. Reads `biomax_punch` and
`biomax_punch_derived` as input, writes its own tables, never mutates
either. Cross-outlet punches remain one workday. All parameters come from
`work_shift` / `work_shift_weekly_schedule`, not hard-coded.
