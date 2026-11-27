# Stock Audit - Stage 1 deployment record (27 Nov 2026)

## Database backup waiver
The mandatory pre-deployment database snapshot was NOT taken and NOT verified
(the server's AWS role is denied the Lightsail/RDS describe calls). Management
explicitly waived the backup requirement for THIS deployment only and accepted
the associated risk. The waiver does not extend to Stage 2 or any later deployment.

## Commits
| Repo | main-autodeploy before | after (fast-forward) | Deploy run |
| --- | --- | --- | --- |
| dailyneeds-store-backend | 108ef49 | b6bb022 | Deploy Backend #432 (45945929083) - success, 05:27:37-05:28:11 UTC |
| dailyneeds-store | 6f68a20 | c0e236e | Deploy #436 (45946115678) - success, 05:29:34-05:32:27 UTC |

## Migrations (05:28:02 UTC)
379 -> 382 applied: 20270108120000-stock-audit-foundation,
20270108120100-stock-audit-allotment-sapl, 20270108120200-stock-audit-participation-roles.
No other migration ran. 29 sa_ tables, 22 permission keys, 0 keys granted, 0 rows.

## Switches (effective, server)
STOCK_AUDIT_* absent from .env -> enabled=false, syncEnabled=false, access=restricted.
No cron; approvals / revoke / payroll answer 501; no Telegram.

## Health (check runs 45945821655 before, 45946543004 after)
pm2 server, fe, biomax-receiver online (reloaded 05:28 / 05:32). DB ping OK (8.4.9).
No new error lines in the API error log. Existing endpoints answer as before
(no 5xx). RetailPilot GRN sync at 05:30 UTC succeeded after the deploy.

# Stage 2 - restricted activation (27 Nov 2026, 06:13 UTC / 11:43 IST)
Management-approved. Run: "Stock Audit Stage 2 activate" 45950419837 (agent branch, one-time).
- `.env` copied to `~/env-backups/.env.stage2-20261127T061301Z` (mode 600, identical to the original) before any change.
- `.env`: 6 lines appended, 0 removed - `STOCK_AUDIT_ENABLED=true`, `STOCK_AUDIT_SYNC_ENABLED=false`,
  `STOCK_AUDIT_ACCESS=restricted`, `STOCK_AUDIT_ACCESS_DESIGNATIONS=11` (plus a blank and a comment line).
- Permissions: 11 rows inserted for designation 11 (Hr Executive), 437 -> 448 rows; no other row touched:
  view_stock_audit, view_stock_audit_all_stores, manage_stock_audit_cycles, manage_stock_audit_employee_mapping,
  import_stock_audit_allotment, manage_stock_audit_roles, manage_stock_audit_policy, view_sapl_leaderboard,
  manage_sapl_competition, view_stock_audit_hr_reports, download_stock_audit_hr_pdf.
  Withheld: approve / revoke / calculate incentives, payroll, sync, prize distribution, exclusion approval,
  recount verification, self-service, approve_stock_audit_allotment_import, review_stock_audit_eligibility.
- API reloaded with scripts/deploy/pm2-reload.js; effective switches enabled=true, syncEnabled=false, restricted [11].
- Check run 45950585692: pm2 online, DB OK, no new errors, all 29 sa_ tables empty, unauthenticated / bad-token
  requests refused (Access Denied) on every Stock Audit endpoint. No tokens were generated for any user.
- Undo (only on approval): restore the .env backup (or delete the 6 lines) and reload; delete the 11 designation-11 rows.

# Stage 4 - controlled RetailPilot sync (27 Nov 2026, management-approved)
Official RetailPilot confirmation of the audit tables waived temporarily by management. Read-only SPECTRA access.
- No audit cycle is needed for the sync (it mirrors RetailPilot; figures attach to cycles when read). None was created.
- Run 1 DRY_RUN (08:55 UTC): 11,459 sessions / 6,871 lines / 16,584 ledger rows read, nothing written to the mirror;
  matched RetailPilot's own totals; schema of all three streams as expected.
- Run 2 HISTORICAL (09:01:22-09:02:31 UTC) from 25 Nov 2026 00:00 IST: mirror 11,461 sessions, 6,872 lines,
  16,587 ledger rows, 50 RetailPilot users; 0 duplicates (primary keys on RetailPilot slugs).
- Validation vs RetailPilot at the run's start: all five stores identical (finalized sessions, unique articles,
  counters), 47/47 auditors identical, every IST day identical. No recounts exist in RetailPilot.
- Warehouse: 9 in-progress sessions mirrored with outlet 2; excluded from every figure, screen and PDF.
- `.env`: STOCK_AUDIT_SYNC_ENABLED false -> true (backup ~/env-backups/.env.stage4-20261127T090235Z); API reloaded.
  Manual runs by administrators only (no key granted to HR); no schedule registered.

# Stage 5 preparation - read-only review (27 Nov 2026, 14:42-14:45 IST)
Runs 45971714666 (REVIEW) and 45972169620 (VARIANCE). Nothing written.
- Shortage / excess quantity: screen = each article's ORIGINAL count exactly; plain sum = original + 159 repeat
  finalizations (59 reverse the first count, 84 book nothing, 6 same direction, 10 after a nil first count).
  Net per article (all counts netted) equals the matched RetailPilot STK_ADJ ledger quantity; every one of the
  5,607 non-marker ledger rows lines up with a finalized count. Screen VALUE is filed by the quantity's sign:
  zero-quantity counts with a value change and opposite-sign counts are dropped or misfiled (code fix proposed,
  not made).
- Warehouse: absent from store, employee, HR PDF and standings outputs.
- Retrospective mapping (in memory): store total unchanged, one row per employee, two ids of one employee = one
  row with the union of articles, no duplicate credit; estimate stays Pending.
- HR setup not started (0 cycles). No recounts. Account 197: no dependency found (details in the chat report).

# Audit-cycle discovery and Season 1 (27 Nov 2026)
- Read-only discovery (runs 45972954942, 45973674546): RetailPilot exposes NO audit cycle - not in the published
  schema of runway / masterhub / Mandapam, not as a column of stock_audit_count_session or _line, not in the
  MOSAIC Stock Audit reports (6, 13: from/to date window only), not in the allotment CSV; 128 likely table names
  all refused ("not available for querying"; SPECTRA does not distinguish missing from not whitelisted).
- Season 1 created at 09:29:47 UTC with the application's own functions (run 45974132648; data only, no code):
  period SEASON-1 = cycles 1-5 (outlets 3-7), 25 Nov - 31 Dec 2026, deadline 31 Dec 2026, OPEN;
  SAPL season 1 "Season 1", prize Rs 10,000, weights completion 35 / accuracy 40 / recount 20 / participation 5 (locked).
