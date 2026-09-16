/*
 * EMPLOYEE MASTER BULK EXPORT / IMPORT — the bulk-operation audit trail.
 *
 * WHAT THIS IS NOT. It is not the audit of an employee change. Every row a
 * bulk update writes still goes through `usecase/employee_master.js`, which
 * produces exactly the history an ordinary Employee Master edit produces: the
 * `USECASE.EMPLOYEE_MASTER.EDIT-REVOKED` log line and Stage 0A session cutoff
 * for a store or designation change, and a C1c `period_corrected` lifecycle
 * event carrying the old and new date for a joining-date correction. Removing
 * this table would lose none of that.
 *
 * WHAT IT ADDS is the thing those cannot say: that eighty of those changes came
 * from ONE file, uploaded by ONE person, at ONE moment, and what came of the
 * operation as a whole - including the rows that were REFUSED, which leave no
 * trace anywhere else precisely because nothing was written for them.
 *
 * Shaped after `report_export_log`, which already records the export half of
 * the employee master, rather than inventing a second audit framework.
 */
CREATE TABLE IF NOT EXISTS employee_bulk_update_log (
  bulk_log_id      INT NOT NULL AUTO_INCREMENT PRIMARY KEY,

  /* EXPORT, PREVIEW or CONFIRM. A preview is recorded too: it reads the whole
     employee population in one request, which is worth knowing happened even
     though it changes nothing. */
  operation        VARCHAR(16) NOT NULL,

  /* WHO. Both, as every other audit table here does: `user_id` is the login
     and `employee_id` the person, and the two are not always resolvable from
     each other. Nullable because a break-glass system account has no employee
     record (Stage 0A / A3). */
  user_id          INT NULL,
  employee_id      INT NULL,

  /* WHICH FILE. Free text from the browser and treated as a label, never as a
     path and never opened by anything. */
  source_filename  VARCHAR(255) NULL,

  /* WHICH FIELDS the operation covered, as the catalogue's field KEYS. */
  selected_fields  JSON NOT NULL,
  /* The export's filters. Ids and the status flag only - never a search term,
     for the same reason `report_export_log` omits one: a search string over
     an employee master is usually somebody's name. */
  filters          JSON NOT NULL,

  rows_uploaded    INT NOT NULL DEFAULT 0,
  rows_valid       INT NOT NULL DEFAULT 0,
  rows_error       INT NOT NULL DEFAULT 0,
  rows_warning     INT NOT NULL DEFAULT 0,
  rows_changed     INT NOT NULL DEFAULT 0,
  rows_applied     INT NOT NULL DEFAULT 0,
  rows_failed      INT NOT NULL DEFAULT 0,

  /* EXPORTED / PREVIEWED / APPLIED / APPLIED_PARTIAL / REFUSED_REVALIDATION /
     FAILED. Success and failure are both recorded; an operation that refused
     to run is the one most worth being able to find later. */
  outcome          VARCHAR(32) NOT NULL,

  /* Per row: the row number, the employee, which fields changed, the old and
     new values of THOSE fields, and the row's outcome. Nothing else off the
     employee record is recorded - the change IS the audit, and a change log
     that does not say what changed is decoration. */
  detail           JSON NOT NULL,

  created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

  /* WHEN, for the usual "what happened last Tuesday" read. */
  KEY idx_employee_bulk_update_log_created (created_at),
  /* WHO, for "everything this person did". */
  KEY idx_employee_bulk_update_log_actor (employee_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
