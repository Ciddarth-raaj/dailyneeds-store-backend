/**
 * The one rule for reading `new_employee.date_of_joining`.
 *
 * That column is a VARCHAR holding three shapes: an ISO prefix
 * ("2022-04-01", sometimes with a time after it), the Indian long form
 * ("05 September 2021"), and - for 425 of the 630 production rows - nothing
 * at all. C1b parsed it one way to create the backfilled periods; C1c must
 * parse it the same way or the two will disagree about when somebody joined.
 *
 * So the expression lives here, once, and `c1b_backfill.test.js`'s sibling
 * `employee_lifecycle.test.js` asserts it is character-identical to the one
 * frozen inside scripts/auth/c1b-backfill.js - the script that actually ran
 * against production. Editing either without the other fails a test.
 *
 * `%M` and not `%b`: `%b` parses "23 May 2024" but returns NULL for
 * "05 September 2021" and "05 Sept 2021". Both forms depend on
 * `lc_time_names`, which the reconciler asserts is en_US before it reads
 * anything.
 */

/** SQL that yields a DATE, or NULL when the text is absent or unreadable. */
const JOINED_ON = (t = "ne") => `
  CASE
    WHEN ${t}.date_of_joining IS NULL OR TRIM(${t}.date_of_joining) = '' THEN NULL
    WHEN ${t}.date_of_joining LIKE '____-__-__%'
         AND STR_TO_DATE(LEFT(${t}.date_of_joining, 10), '%Y-%m-%d') IS NOT NULL
      THEN STR_TO_DATE(LEFT(${t}.date_of_joining, 10), '%Y-%m-%d')
    ELSE STR_TO_DATE(TRIM(${t}.date_of_joining), '%d %M %Y')
  END`;

/** True where a value is present but the rule above cannot read it. */
const UNPARSEABLE = (t = "ne") => `
  ${t}.date_of_joining IS NOT NULL
  AND TRIM(${t}.date_of_joining) <> ''
  AND (${JOINED_ON(t)}) IS NULL`;

module.exports = { JOINED_ON, UNPARSEABLE };
