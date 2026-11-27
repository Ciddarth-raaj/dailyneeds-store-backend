# Stock Audit & Premier League (SAPL)

RetailPilot does allotment, counting, recounts and stock adjustments. DNDS
imports, mirrors, measures and reports. **Not enabled in this phase:**
incentive approval, revocation and payroll posting (the endpoints answer 501),
any scheduled sync (manual runs only), Telegram.

## Code map

| Part | File |
| --- | --- |
| Migrations (new tables only, nothing altered) | `migrations/mysql/migrations/20270108120000-stock-audit-foundation` (15 tables, 20 permissions), `20270108120100-stock-audit-allotment-sapl` (8 tables), `20270108120200-stock-audit-participation-roles` (6 tables, 2 permissions) |
| Activation | `STOCK_AUDIT_ENABLED=true` (whole module) and `STOCK_AUDIT_SYNC_ENABLED=true` (RetailPilot sync button); both OFF by default: every endpoint answers 503 |
| Read-only production checks | `scripts/stock_audit/phase2_readiness.js` (bundled and run by the agent branch's workflow) |
| Permission keys (one per decision) | `constants/stock_audit_permissions.js` |
| Rules (pure) | `utils/stock_audit_policy.js` (confirmed amounts), `_eligibility`, `_verification`, `_incentive`, `_progress`, `_sapl`, `_allotment`, `_mirror`, `_queries`, `_status` |
| SQL | `repository/stock_audit.js` |
| Screens' API | `usecase/stock_audit.js`, `routes/stock_audit.js` (mounted at `/stock-audit` in `server.js`) |
| RetailPilot sync | `usecase/stock_audit_sync.js` (SPECTRA, read-only) |

## Data flow

1. **Audit period** (`POST /stock-audit/cycles`): one cycle per programme store
   (outlets 3-7; the warehouse, outlet 2, is refused) with a common deadline.
2. **Allotment**: HR uploads every auditor's RetailPilot
   `assortment-effective` CSV, unmodified (`POST /allotment/validate`), reviews
   the validation, then confirms (`POST /allotment/uploads/:id/confirm`).
   - store and auditor come from the file's contents; `Effective = Y` is
     allotted, `N` is not auditable
   - rejected: not a RetailPilot file, several stores / auditors in one file,
     store outside the cycle or Branch Master, same content twice, two files
     for one auditor
   - an auditable article allotted to two auditors in one store blocks the
     confirm (validation, then the unique key `uq_sa_allotment_auditable`)
   - a file identical to the auditor's current revision is "already
     imported"; a changed one becomes the next revision (old ones kept)
   - confirm is one transaction; it is refused if the allotment changed since
     validation (two people confirming at once)
3. **Sync** (`POST /stock-audit/sync` `{kind}`): HISTORICAL from 25 Nov 2026
   00:00 IST, INCREMENTAL from the watermark minus 30 min, or DRY_RUN.
   Streams: `stock_audit_count_session`, `stock_audit_count_line`,
   `stock_ledgers` (STK_ADJ). Keyset paging, microsecond timestamps, upserts by
   RetailPilot slug + row hash. Watermarks move only when the whole run
   succeeds; Retry-After above the limit records a DEFERRED run. The booked
   difference of a count is read from its finalize marker's traceability.
4. **Figures** (`utils/stock_audit_progress.js`, recomputed on read, cached
   60 s and cleared after every write): per employee and store - allotted,
   audited (original count, Store + Auditor + Article), today, pending,
   completion, within deadline, recount sample (5% of unique articles,
   rounded up), accuracy (independent recounts only), calculated and estimated
   incentive; Supervisor / Store Manager / Operations Manager KPIs; SAPL KPIs.
   No allotment -> Unavailable; no recounts -> Pending; never 0 or 100%.
5. **HR PDFs**: `GET /stock-audit/hr/report?date=` returns team figures only
   (individual incentive fields are removed server-side); the browser draws
   the PDF. A past date is rebuilt from audits and recounts up to the end of
   that day (allotment = current revision).

## Participation and responsible persons

- **Participation** = eligible staff who counted at least one article in the
  store cycle / ALL eligible active staff of the store x 100; Premier League
  points = participation % x 5 / 100. Eligible = `new_employee.status = 1`,
  `store_id` = the store, `designation_id` in the setting
  `eligible_designation_ids` (default 2 Customer Service Associate,
  4 Cashier). An employee counts as participating through any RetailPilot
  user mapped to them.
- **Snapshot** (`POST /eligibility/:outlet/snapshot`): freezes the headcount
  for the store cycle (`sa_cycle_employee`). Until taken, the live headcount
  is used and participation is marked provisional. Later additions are
  explicit, with a note (`POST /eligibility/:outlet/employees`).
- **Exclusions**: request with a mandatory reason; approved or rejected by
  someone else (never the requester, never the employee); one open or
  approved request per employee per cycle (database key); all history kept.
- **Responsible persons** (`GET/PUT /roles`): per audit period, from
  `role_designation_ids` (default Supervisor 9, Store Manager 3, Operations
  Manager 27), the employee's Branch Master store and active status. Where
  several qualify, a person with `manage_stock_audit_roles` chooses. No
  assignment -> that incentive is Pending. Database keys: one active holder
  per role per store per period; one active management role per person per
  period (no double management incentive). Replacements kept as history.

## Confirmed amounts (27 Nov 2026)

- Employee: ₹1.10 / ₹1.00 / ₹0.50 per eligible unique article at 99 / 97 / 95%
  accuracy, nil below; exact slab, never rounded up.
- Supervisor ₹200 / ₹300 / ₹500 (max ₹1,000). Store Manager ₹600 completion
  within deadline / ₹500 counting accuracy / ₹400 verification quality
  (max ₹1,500). Operations Manager ₹400 a store, max ₹2,000, on the Store
  Manager score; nil without independent verification.
- SAPL: completion 35 + accuracy 40 + recount 20 + participation 5 = 100.
  Shortage / excess never score. Prize ₹10,000. One season = one audit period.

## Configurable until management decides

Per season (`PUT /stock-audit/sapl/seasons/:id`, `rules_json`, each marked
`confirmed: false`): qualification, tie-breaker order, prize distribution
method (equal / by articles audited / manual). The weights cannot be changed.
Management KPI thresholds are in the policy's draft scoring layer.

## Safety

- Every route: permission key first, then the caller's branch scope;
  `view_stock_audit_all_stores` for company-wide. A request naming another
  store is refused.
- Nobody maps a RetailPilot user to themself; independent store verification
  cannot come from that store; the season verifier cannot also finalise it.
- Nothing writes to RetailPilot or payroll.

## Tests

- `node --test utils/stock_audit_*.test.js routes/stock_audit.test.js`
- `SA_TEST_MYSQL=mysql://user:pass@host:port/SCRATCH_DB node --test repository/stock_audit.mysql.test.js`
  (drops and creates its tables: scratch databases only) - import, revisions,
  conflicts, concurrent confirms, sync (idempotent, failure, deferral), figures,
  HR data, SAPL, 75,000-article run.
- `SA_REAL_CSV=<path>` additionally checks a real RetailPilot export (not kept
  in the repository).

## Still open

- How RetailPilot records recounts: none existed on 27 Nov 2026
  (`recount_slug` empty on every session). `sa_verification` is filled once
  real recounts are inspected; until then accuracy stays Pending.
- RetailPilot to confirm the audit tables are officially supported before any
  scheduled sync.
- Confirm the default designation ids with HR (`GET/PUT /settings`).
