# DigiSME Excel attendance import (Part 1, permanent fallback)

**Status: backend built, not deployed. Frontend not built.**

Architecture decision: Biomax live punches to dnds.co.in are the primary
path; the DigiSME "ATD Daily Attendance" Excel export is the permanent
fallback; the Biomax historical pull stays dormant and experimental. This
document is the design record for the fallback.

## 1. What it does

An administrator uploads `ATDDailyAttendance.xlsx`. The workbook is parsed,
every non-empty `Clock Time-N` cell becomes one punch candidate, each
candidate is resolved against **our** employee master and dated with the
**same** attendance-date rule as a live punch, and the result is staged and
shown as a preview. Only an explicit commit of that staged preview writes
punches, and they go into the same `biomax_punch` table as live punches, so
the Attendance List and Punch Audit read one table.

Nothing here computes IN/OUT, hours, breaks, overtime or pay.

## 2. Pieces

| piece | file |
|---|---|
| parser | `biomax/digismeImport.js` (exceljs, already a dependency) |
| write path | `biomax/store.js` `insertPunch(..., { source: 'DIGISME_IMPORT', importBatchId })` |
| identity | `biomax/employeeMatch.js` (unchanged) |
| attendance date | `biomax/attendanceDate.js` (unchanged, reused, not forked) |
| staging | `repository/attendance_import.js` |
| rules | `usecase/attendance_import.js` |
| API | `routes/attendance_import.js`, mounted at `/attendance/imports` |
| migration | `migrations/mysql/migrations/20260913120000-digisme-attendance-import.*` |
| read model | `repository/biomax_punch.js`, `usecase/attendance_raw.js` (device status `IMPORTED`) |

## 3. Parsing

- Sheet must be named `Attendance` (case-insensitive fallback). The header
  row is found within the first 10 rows as the row that carries both
  `Employee Code` and `Clock Date`.
- `Clock Time-N` columns are discovered by `/^Clock Time-(\d+)$/` and sorted
  by N. Nothing is hard-coded to 10. Column order is irrelevant.
- `Employee Name` and `Department Name` are never read.
- `Clock Date`: `DD-MM-YYYY` text (also `/` or `.`), ISO text, a real date
  cell, or an Excel serial. `Clock Time`: `HH:MM:SS` or `HH:MM` text, a real
  time cell, or a fraction-of-day number. Midnight is `00:00:00`. No
  working-hours assumption.
- Empty means empty: null, undefined, blank or whitespace strings, NaN,
  booleans, error cells and formulas with a null result produce nothing.
- `io_time_raw = YYYYMMDDHHMMSS` from Clock Date + Clock Time, the same
  14-digit form a terminal sends. Clock Date is the calendar date of the
  punch, never assumed to be the attendance date.
- A bad Employee Code or Clock Date rejects the **row** (one BAD_ROW item,
  noting how many time cells it carried). A bad Clock Time rejects only
  that **cell**. Parsing never aborts on data; only a structurally unusable
  workbook (not a zip, no such sheet, no header, no time column) is refused.

## 4. Imported punch model

For `DIGISME_IMPORT` rows in `biomax_punch`: `dev_id NULL`, `user_id` = the
canonical Employee Code string, `io_time_raw` and `io_time` from the
workbook, `ingest_source = 'DIGISME_IMPORT'`, `import_batch_id` = the batch,
and every device field NULL (`source_ip`, `source_port`, `verify_mode`,
`io_mode`, `fk_bin_data_lib`, `cmd_id`, `blk_no`, `blk_len`,
`content_length`, `body_len_prefix`, `raw_json`). No device, outlet, JSON or
punch location is invented; the Punch Audit shows the location blank and
the device status `IMPORTED`. Imported punches are not quarantined (that is
a device decision) and appear on the Attendance List like any other punch
once dated.

## 5. Schema change (migration 20260913120000)

All guarded through `information_schema` + `PREPARE`, re-runnable, no
existing row rewritten:

- `biomax_punch.dev_id` VARCHAR(32) **NULL** (was NOT NULL).
- `biomax_punch.raw_json` TEXT **NULL** (was NOT NULL).
- `biomax_punch.ingest_source` ENUM gains `DIGISME_IMPORT` at the end; LIVE
  and HISTORICAL_PULL keep their positions and values.
- `biomax_punch.import_dedup_key` VARCHAR(96) **STORED generated**:
  `CASE WHEN dev_id IS NULL THEN CONCAT(ingest_source,'|',user_id,'|',io_time_raw) ELSE NULL END`
  with `UNIQUE KEY uq_biomax_punch_import_dedup`.
- `biomax_punch.import_batch_id` BIGINT UNSIGNED NULL, indexed.
- New tables `biomax_attendance_import_batch` and
  `biomax_attendance_import_item`.
- Permission `manage_attendance_import` declared, granted to nobody.

The device dedup key `(dev_id, user_id, io_time_raw)` is untouched. Down
drops the two tables and the two added columns only; it does not re-impose
NOT NULL or shrink the ENUM, and deletes no punch.

## 6. Dedup mechanism

MySQL treats every NULL as distinct in a UNIQUE key, so the device key
cannot protect `dev_id NULL` rows. The stored generated column carries
`DIGISME_IMPORT|<code>|<time>` for terminal-less rows and NULL for device
rows; its UNIQUE index makes a repeated or concurrent import of the same
DigiSME punch an `ER_DUP_ENTRY`, which `insertImportedPunch` reports as
`duplicate` with the existing row id. The insert is a plain INSERT inside a
transaction, not SELECT-then-INSERT, so two commits racing on the same
punch cannot both succeed. Preview additionally pre-classifies re-import
duplicates (from the table and within the file) so the administrator sees
them before commit.

## 7. Cross-source collision

A LIVE (or HISTORICAL_PULL) punch and a DigiSME punch for the **same
resolved employee** at the **same io_time** have different dedup keys, so
both are preservable. Preview looks up existing non-import punches by
`biomax_punch_derived.employee_id` + `io_time_raw` (identity, not raw code
or device) and classifies the candidate `CROSS_SOURCE_COLLISION` with
`collided_punch_id`. Commit still imports it (`IMPORTED_WITH_COLLISION`);
the live punch is never touched. A live punch is never a re-import
duplicate, and an import is never a collision with another import.

## 8. Employee matching and attendance date

Identity is the Employee Code alone, through `parseEmployeeCode` (1 to 9
digits, integer > 0, never 0), then `new_employee` via `store.findEmployee`.
For a match the derived row snapshots `employee_id`, `home_outlet_id`
(store_id), `department_id`, `work_shift_id` and the schedule row consulted.
An unmatched code is still imported with `employee_id NULL` and
`derivation_status UNMATCHED`, exactly like a live unmatched punch; the
preview lists the unmatched codes with punch counts.

The attendance date comes from `deriveAttendanceDate` in
`biomax/attendanceDate.js`, unmodified: assigned shift + previous day's
cutoff, else NO_SHIFT / NO_SCHEDULE_ROW / MISSING_CUTOFF / UNMATCHED. Preview
derives for display; commit re-derives at insert, because commit is the
ingest and the derived row is the snapshot at ingest (R16).

## 9. Preview and commit flow

```
POST /attendance/imports/digisme/preview  (multipart, one .xlsx)
  -> parse -> resolve -> classify -> INSERT batch (PREVIEWED) + items
  -> returns batch summary, classification counts, unmatched codes
GET  /attendance/imports/items?import_batch_id=&classification=&limit=&offset=
POST /attendance/imports/commit { import_batch_id }
  -> UPDATE status PREVIEWED->COMMITTING WHERE status='PREVIEWED' (one winner)
  -> for each staged item, in Excel order: insert via biomax/store.js
     VALID -> IMPORTED, UNMATCHED_EMPLOYEE -> IMPORTED_UNMATCHED,
     CROSS_SOURCE_COLLISION -> IMPORTED_WITH_COLLISION,
     REIMPORT_DUPLICATE -> SKIPPED_REIMPORT_DUPLICATE, BAD_ROW -> SKIPPED_BAD_ROW,
     ER_DUP_ENTRY at insert -> SKIPPED_REIMPORT_DUPLICATE, any other error -> FAILED
  -> batch COMMITTED, or COMMITTED_WITH_ERRORS if any item FAILED, or FAILED
     if the database connection was lost (the only thing that stops a batch)
```

Preview writes nothing to `biomax_punch`. Commit never re-reads the file. A
second commit of the same batch is refused with 409.

## 10. Audit

`biomax_attendance_import_batch` keeps, forever: filename, SHA-256, size,
sheet, the time columns found, who uploaded and committed, previewed_at and
committed_at, date range, and every count (rows, codes, candidates, valid,
bad, unmatched, re-import duplicates, collisions, imported, skipped,
failed). Each item keeps Excel row, column, raw cells, canonical code,
io_time_raw, resolved employee, classification, derivation at preview,
collided punch, message, outcome and the created `biomax_punch_id`. There is
no delete endpoint or repository method. Existing LIVE punches are never
updated or deleted.

## 11. Security

Permission `manage_attendance_import` on every endpoint; administrators pass
through the existing user_type 2 bypass; nobody else is granted. Upload:
one file, `.xlsx` extension, zip signature checked, at most 15 MB,
formidable temp file in the OS temp dir deleted after parsing, no server
path in any response.

## 12. Not done here

Frontend screens, deployment, importing the real file, historical-pull
decoding, any receiver change.
