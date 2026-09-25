/**
 * WHEN A SINGLE-DATE SHIFT OVERRIDE STILL APPLIES - one condition, shared by
 * every reader of `attendance_date_shift_override`.
 *
 * An override written by an approved SHIFT_CHANGE request carries that
 * request's id. When an administrator REVOKES the approval the request
 * becomes CANCELLED, and from that moment its override is history, not a
 * rule: the date resolves exactly as if the row had never been written - to
 * an earlier override for the date, or to the dated assignment history - and
 * the overtime the longer shift authorised goes with it.
 *
 * THE ROW IS NOT DELETED OR UPDATED. The override table is an audit trail
 * ("a later edit of the same date is a further row, never an update"), and
 * the request's own status is already the single source of truth the
 * resolver joins for `shift_change_approved`. So the override's authority is
 * read from the same place: a row whose authorising request is CANCELLED is
 * skipped. A DIRECT management edit (no request id) is never affected.
 *
 * NULL-SAFE BY CONSTRUCTION: `NOT EXISTS` over a NULL request id finds
 * nothing, so a direct edit always passes.
 *
 * Every query that reads the override table to decide which shift applied on
 * a date must include this condition. `repository/shift_override_readers.test.js`
 * holds the list and fails if a reader is added without it.
 */
const activeOverrideCondition = (alias = "o") =>
  `NOT EXISTS (SELECT 1 FROM attendance_approval_request revoked_req
                WHERE revoked_req.attendance_approval_request_id = ${alias}.attendance_approval_request_id
                  AND revoked_req.status = 'CANCELLED')`;

module.exports = { activeOverrideCondition };
