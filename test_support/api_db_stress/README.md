# API DB-outage stress harness

Drives the **real `server.js`** (real middleware, routes, crons and mysqljs
pools) through database faults and measures what the process does. Test
environment only: it writes `config.json` values that point at a local
MariaDB and never at a production database.

| file | what it is |
|---|---|
| `faultProxy.js` | TCP proxy between the API pools and MariaDB; the fault is switched at runtime over a control port (`pass`, `slow?ms=`, `handshake_hang`, `refuse`, `freeze`, `/kill`) |
| `probe.js` | preload (`node -r probe.js server.js`): one JSON line a second from inside the server - mysqljs pool internals (`_connectionQueue`, all/free/acquiring), the admission layer's lanes and circuit when present, heap/RSS, event-loop delay, handles, HTTP in flight / aborted |
| `run.js` | one scenario: warm -> fault -> recovery -> drain, with open-loop load (`/telegram/attendance/month` + `/designation/permissions`), clients that give up after 30 s, and a JSON summary |
| `recalcOutage.js` | the attendance recalculation worker across an outage, on the real per-minute cron |
| `poolMechanics.js` | the pool alone (real `drivers/mysql.js`) under each fault |
| `mintToken.js` | Mini App session and login tokens, minted with the server's own `services/jwt` |
| `seed.sql` | 300 employees on one shift, two punches a day for Aug-Sep 2026, 50 login users |

## Setup (root, once)

```sh
# MariaDB, a database with every migration applied (the ones that need
# production data fail and are skipped), then the seed
mysql -ubm -pbm dnds_api_test < test_support/api_db_stress/seed.sql
# the DB address the API uses; the unreachable scenario removes it and
# installs `ip route add unreachable` - a real EHOSTUNREACH
ip addr add 198.51.100.7/32 dev lo
node test_support/api_db_stress/faultProxy.js 13306 127.0.0.1 3306 13399 &
```

`config.json` (gitignored) names both pools as `198.51.100.7:13306`.

## Run

```sh
NODE_BIN=/path/to/node-v14.21.3/bin/node SCENARIO=handshake_hang OUTAGE_S=480 \
  node test_support/api_db_stress/run.js
```

Scenarios: `pass`, `slow` (`SLOW_MS`), `handshake_hang` (TCP accepted, no
MySQL greeting - production's "Handshake inactivity timeout"), `refuse`
(`ECONNREFUSED`), `unreachable` (`EHOSTUNREACH`), `freeze` (a silent peer:
open connections stop passing bytes). Results and their interpretation:
`docs/api-db-backpressure.md`.
