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
