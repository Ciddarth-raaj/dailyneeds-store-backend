# Biomax devices: connection state and receiver health

## Two states, never merged

| | Where it comes from | Values |
|---|---|---|
| **Assignment** | an open `biomax_device_assignment` period | `ACTIVE`, `INACTIVE` |
| **Connection** | `biomax_device.last_seen_at` | `CONNECTED`, `STALE`, `OFFLINE`, `NEVER_SEEN` |

Assignment is paperwork: an administrator opened a location period and
nothing closes it by itself, so it says nothing about whether the terminal
is plugged in. Connection is the machine fact. `ACTIVE + OFFLINE` is a real
and important combination — it is the row somebody has to drive to an outlet
about — and so is `INACTIVE + CONNECTED`. The definition of ACTIVE is
unchanged.

## Why `last_seen_at`, never `last_punch_at`

`biomax/receiver.js` calls `store.touchDevice(dev_id, { punch: false })` on
**every** request, including the bare `receive_cmd` poll a terminal sends
when nobody is standing in front of it. `last_punch_at` only moves when an
employee puts a face to the terminal, so a healthy device in a quiet outlet
would look dead by that measure all night.

## Thresholds, and what they are not based on

The BM70W's poll interval is a setting on the terminal. **This repository
contains no evidence of what it is in production.** The only cadence
recorded anywhere is the ~3 minute retry of an *unacknowledged punch*
(`docs/biomax-attendance-part1.md` R1, `test_support/biomax/README.md`),
which is a retransmit timer, not a poll timer; `BIOMAX_COMMAND_LEASE_SECONDS`
(600) is a command-delivery lease, also not a poll timer.

So the rule is configuration, not a deduction:

| Env var | Default | Meaning |
|---|---|---|
| `BIOMAX_DEVICE_STALE_SECONDS` | `900` (15 min) | older than this → `STALE` |
| `BIOMAX_DEVICE_OFFLINE_SECONDS` | `3600` (60 min) | older than this → `OFFLINE` |

The defaults are deliberately **loose**. A loose threshold under-reports a
dead terminal for a while; a tight one cries wolf at every outlet every hour,
and only one of those gets ignored by the people who must act on it. Tighten
them once a week of production `last_seen_at` shows the real gap between
polls — that measurement is the follow-up this feature is waiting on.

The rule lives in `utils/biomax_connection.js` and is applied in
`usecase/biomax_device.js`. The frontend re-implements none of it: it
renders the word the API sends.

## Receiver health

`GET /attendance/devices/receiver-health` (permission
`view_biomax_devices`) probes the receiver's own `GET /healthz` on
`127.0.0.1:BIOMAX_PORT` with an `BIOMAX_HEALTH_TIMEOUT_MS` (800 ms) budget
and returns:

```json
{ "receiver": { "status": "ONLINE", "ok": true, "db": true, "last_punch_received": "…" },
  "devices": { "connected": 6, "stale": 0, "offline": 1, "never_seen": 0, "total": 7 },
  "thresholds": { "staleSeconds": 900, "offlineSeconds": 3600 } }
```

- **The browser never touches port 7005.** That port is for the terminals:
  unauthenticated and on the private host. The API is already on that host,
  so it probes and the screen asks the API.
- **Nothing internal is passed on.** No host, no port, no receiver Node
  version, and never a socket error string — an error message is exactly
  where a hostname leaks. A failure is reduced to `UNAVAILABLE` plus
  `timeout` / `unreachable`.
- **A failed probe is not a verdict on the terminals.** The endpoint is
  separate from `GET /attendance/devices` so the list renders regardless,
  and the counts come from our own `last_seen_at` either way. The receiver
  being unreachable from this process for 800 ms says nothing about whether
  DN1 was polling a minute ago.

## Timestamps

| Value | Stored as | Shown |
|---|---|---|
| `last_seen_at`, `last_punch_at`, `first_seen_at`, event `created_at`, `last_punch_received` | UTC (MySQL `NOW(3)` on a UTC server) | converted to IST |
| `biomax_punch.io_time` (unregistered first/last punch, Register prefill) | the terminal's own clock, already IST (R3) | **not** converted |
| `effective_from` / `effective_to` | administrator-typed wall clock | **not** converted |

Converting the second or third row would push a time somebody already read
correctly forward by another 5:30.
