# Stock Audit (foundation)

RetailPilot runs the audit: article allotment, physical counting and recounts
all happen there. DNDS Connect reads what RetailPilot recorded (read-only,
over SPECTRA), maps it to branches and employees, and keeps its own records
of audit cycles, verification results, incentives, KPIs and approvals.
DNDS has no counting, allotment or recount entry screen, and will not get one.

Discovery report (live findings, 26-27 Nov 2026): the "Stock Audit API
Discovery Report" doc.

## What this branch adds (no API calls, nothing scheduled, no routes)

| File | What |
| --- | --- |
| `migrations/mysql/migrations/20270108120000-stock-audit-foundation.js` + `sqls/` | 14 `sa_*` tables and the `manage_stock_audit` / `approve_stock_audit_incentive` permissions. No existing table is changed |
| `services/retailpilot_spectra.js` | Opt-in retry (`config.retry`): 429 honours Retry-After (max 120 s), 5xx and timeouts back off 2 s / 8 s / 30 s, 4xx never retried; errors carry `status`, `spectraError`, `retryable`. `queryKeyset` for watermark reads. Without `config.retry` the client behaves exactly as before |
| `utils/stock_audit_queries.js` | Keyset SQL for the session, line and STK_ADJ ledger streams; microsecond-exact UTC timestamps; 30-minute overlap; every literal validated |
| `utils/stock_audit_incentive.js` | The confirmed incentive rules as data, and pure calculations |
| `utils/stock_audit_credit.js` | One credit per (cycle, store, article): first finalized count wins; duplicates, unmapped stores/users and unfinished counts are reported, never credited |

Run the tests: `node --test utils/stock_audit_*.test.js services/retailpilot_spectra.test.js`

## Confirmed incentive structure (27 Nov 2026)

Employee, per unique article audited, by counting accuracy from independent
recounts (at least 5% of the employee's audited articles):
99% and above Rs 1.10 · 97% to below 99% Rs 1.00 · 95% to below 97% Rs 0.50 · below 95% nil.

Management maximums: Supervisor Rs 1,000 per store, Store Manager Rs 1,500
per store, Operations Manager Rs 2,000 across the five stores.

The KPI split inside those maximums is a configurable default and needs
management approval: results are `final` only from an approved rule set.

Accuracy compares the recount with the ORIGINAL PHYSICAL COUNT, never with
book stock, so a genuine shortage or excess never lowers an incentive.
While an employee has no independent recount the result is
`PENDING_VERIFICATION` (amount not decided), not nil.

## Pending

- **Recount integration.** No recounts had been performed by 27 Nov 2026, so
  the empty `recount_slug` is expected. Once real recounts exist, the same
  three tables are re-read to establish where recount quantities live,
  whether the original count is kept, whether the original and recount users
  are separate, both timestamps, multiple recounts, new record vs update,
  stock movement between the two counts, and visibility in SPECTRA and
  MOSAIC report 6. `creditArticles({ isRecount })` is the hook.
- **Sync, cron, routes and screens**: after RetailPilot confirms the audit
  tables are a supported part of our SPECTRA access. The cron ships disabled.
- **Payroll posting**: separate approval; off by default.
