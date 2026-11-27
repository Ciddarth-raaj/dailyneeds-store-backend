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
