# Attendance → Device Time Correction

For when an attendance terminal's clock was wrong for a period. Employees
punched at the right moment and the device stamped the wrong time.
**Administrators only** (`user_type = 2`); no permission key exists or is
granted.

## Model

| Table | What it holds |
|---|---|
| `biomax_punch` | Raw device punch. **Never written.** `io_time` stays what the device sent. |
| `attendance_device_time_correction` | One row per batch: date, device, optional outlet, device-clock window, offset, reason, remarks, the preview fingerprint, `APPLIED`/`REVERTED`, who applied/reverted it, when, and why. Never deleted. |
| `attendance_device_time_correction_punch` | One row per corrected punch: `original_io_time`, `corrected_io_time`, offset, `is_active`. The generated `active_biomax_punch_id` has a UNIQUE key, so a punch can have **at most one active correction**. |

**Effective time** = `COALESCE(active correction.corrected_io_time, biomax_punch.io_time)`.
Every read that calculates or shows attendance uses it
(`repository/lib/effective_punch_time.js`). These include the calculation engine, the dashboard's live read,
Attendance & Staffing, the Punch Audit, the Attendance List, and Void Punch.
Punch *location* still uses the device time. That is the clock the device
assignment period was compared against.

## Flow

1. **Preview** (`POST /attendance/device-time-corrections/preview`). This step writes nothing.
   It selects punches where **all** of these match: device (registry id → exact
   Cloud ID), calendar date, device-clock window (both ends inclusive, to the
   second), and the outlet the device was assigned to at that time (if one is given). It returns
   counts, the earliest and latest original and corrected times, a row per punch, a `batch_ref`, and a
   `preview_fingerprint`.
2. **Apply** (`POST /attendance/device-time-corrections`). Send the same criteria plus
   `batch_ref` and `preview_fingerprint`. The server re-selects the punches before the
   transaction and again inside it. If anything changed, it refuses with 409
   `PREVIEW_STALE`. It then does the following in one transaction: insert the batch and its punch rows, take the payroll lock
   (`FOR UPDATE`) for every affected employee and date, and write the
   recalculated days. Any failure rolls everything back.
3. **Revert** (`POST /attendance/device-time-corrections/:id/revert`, `{reason}`).
   This sets the batch's punch rows inactive (the rows are kept), marks the batch `REVERTED` with who, when and why,
   and writes the days recalculated on the original times. It runs in one transaction and is refused in a locked month.

It refuses the whole batch (it never partially applies) when:

- no punch matches
- a corrected time would leave the selected date
- a punch already has an active correction (revert that correction first)
- any affected employee's month is payroll-locked (`payrun_employee_calculation.status = 'APPROVED_LOCKED'`)
- the batch was already applied

Recalculation goes through `calculateRange` with the new times assumed in
memory, the same pattern as `setDateShift`. So first IN, last OUT, worked time, late arrival, early exit,
shortage, missing punch, OT, authorised OT, status and review reasons all
come from the one engine. Two rules apply, the same as for Recalculate:

- Only closed days are stored. An open day, such as today, reads live with the correction. It is stored
  by the first recalculation after it closes (the daily 06:55 job).
- Ineligible dates (outside employment, or `attendance_required = 0`) are not calculated.

## Applying the 25-09-2026 incident

1. Confirm the offset: **real time minus what the device showed**, at one
   observed moment. For example, the device showed 06:30 when it was really 08:47, so the offset is `+137`.
   Do not guess it.
2. Find when the clock was fixed. The window's **To** must be *before* the device time at which it was
   fixed. Punches after the fix already carry the right time.
3. Attendance → Device Time Correction. Enter: Date 25-09-2026, the affected device,
   outlet (optional), From / To in **device** time, the offset, reason
   *Biomax Device Time Error*, and remarks that say how the offset was established.
4. Preview. Check the count, the employees, and the "Received By Server" column. A punch
   received much later than its device time plus the offset may be one that arrived after the fix.
5. Apply.
