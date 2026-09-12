-- The Digisme employee sync is removed: retire its schedule row.
--
-- The route, the cron registration and the service code went with the
-- application change this migration accompanies
-- (docs/digisme-employee-sync-removal.md). What is left in the database is
-- the operator-facing SCHEDULE row seeded by 20260614120000-api-sync-log,
-- already `is_enabled = 0` since Stage 0C. With no job to schedule it is a
-- phantom entry on the API Sync Log screen, so it goes.
--
-- THE HISTORY STAYS. `api_sync_log` rows of log_type 'employee_sync' are the
-- record of what that sync did on every night it ran - including the wrong
-- `row_count` it reported - and nothing here touches them.
-- `constants/api_sync_types.js` keeps its `employee_sync` entry for the same
-- reason: the screen resolves those rows' label through it.
--
-- Guarded, so the file can be re-run, and reported so the deploy says what
-- it found. The DELETE is by log_type, which carries a unique key, so it can
-- affect at most one row.
SET @had_row = (SELECT COUNT(*) FROM `api_sync_cron_config` WHERE `log_type` = 'employee_sync');

DELETE FROM `api_sync_cron_config` WHERE `log_type` = 'employee_sync';

-- REPORT ONLY.
SELECT @had_row AS EMPLOYEE_SYNC_SCHEDULE_ROWS_REMOVED,
       (SELECT COUNT(*) FROM `api_sync_log` WHERE `log_type` = 'employee_sync')
         AS HISTORICAL_LOG_ROWS_KEPT;
