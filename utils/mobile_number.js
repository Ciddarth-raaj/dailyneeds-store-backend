/**
 * INDIAN MOBILE NUMBERS, normalised so two spellings of one number compare
 * equal.
 *
 * WHY THIS EXISTS. Telegram hands us a phone number the employee's own device
 * reported - usually `+919876543210`. `new_employee.primary_contact_number` is
 * a free-text VARCHAR(45) typed by whoever created the record, and holds every
 * spelling a person might use: `9876543210`, `+91 98765 43210`,
 * `091-98765-43210`. Comparing those as text answers "no" to numbers that are
 * plainly the same, so the comparison has to happen on a canonical form.
 *
 * THE CANONICAL FORM IS THE TEN-DIGIT NATIONAL NUMBER. Not E.164: the stored
 * column is overwhelmingly ten digits, and normalising TOWARDS the shape the
 * data already has means nothing has to be migrated for a comparison to work.
 *
 * IT NEVER REWRITES ANYBODY'S RECORD. This module answers questions; it does
 * not touch `new_employee`. A record with a malformed number stays exactly as
 * it is and the verification simply cannot succeed against it - which is the
 * honest outcome, and a prompt to correct the record rather than a silent
 * "fix" that makes an employee's stored contact number disagree with what
 * anybody typed.
 *
 * WHAT IS ACCEPTED, and why each rule is there:
 *
 *   spaces, hyphens, brackets, dots   presentation, everywhere in real data
 *   a leading +                       E.164 as Telegram reports it
 *   a leading 00                      the international prefix, dialled
 *   a leading 91 before ten digits    the country code
 *   a leading 0 before ten digits     the national trunk prefix
 *
 * WHAT IS REFUSED, and this is the important half:
 *
 *   anything that does not end as EXACTLY ten digits
 *   a first digit that is not 6, 7, 8 or 9 - India's mobile series. A landline
 *     or a service number is not a mobile and cannot receive a Telegram
 *     account, so accepting one could only ever produce a false match.
 *   `91` stripped from a number that is not then ten digits long - `919876`
 *     is not a mobile with a country code, it is a malformed value, and
 *     stripping regardless would invent a number nobody has.
 *   empty, null, undefined, and any value with a letter in it
 *
 * THE COMPARISON IS EXACT once both sides are canonical. No last-four
 * matching, no fuzzy distance: a near-miss between two staff mobiles is
 * exactly the case that must NOT verify.
 */

/** India's mobile series. A number outside it is not a mobile. */
const INDIAN_MOBILE_RE = /^[6-9]\d{9}$/;

/** Characters people put in phone numbers that carry no information. */
const PRESENTATION_RE = /[\s\-().]/g;

/**
 * The ten-digit national number, or null when the value is not one.
 *
 * null is the ONLY failure signal, and every caller must treat it as "these
 * do not match" rather than as an empty string that might equal another empty
 * string - see `mobilesMatch`.
 */
function normalizeIndianMobile(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" && typeof value !== "number") return null;

  let digits = String(value).replace(PRESENTATION_RE, "");
  if (digits === "") return null;

  // A single leading + is E.164 punctuation; a + anywhere else is malformed.
  if (digits.startsWith("+")) digits = digits.slice(1);
  if (!/^\d+$/.test(digits)) return null;

  // Longest prefix first: `0091…` is the international prefix AND the country
  // code, and stripping only one of them would leave a value that is not ten
  // digits and would then be refused - correct, but for the wrong reason.
  if (digits.length === 14 && digits.startsWith("0091")) digits = digits.slice(4);
  else if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
  else if (digits.length === 13 && digits.startsWith("091")) digits = digits.slice(3);
  else if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);

  return INDIAN_MOBILE_RE.test(digits) ? digits : null;
}

/** True when the value is a mobile this module can compare at all. */
const isValidIndianMobile = (value) => normalizeIndianMobile(value) !== null;

/**
 * Do these two values denote the same mobile?
 *
 * FALSE WHENEVER EITHER SIDE IS UNUSABLE. That is the whole reason this is a
 * function rather than `normalize(a) === normalize(b)` written at each call
 * site: two nulls are equal in JavaScript, so an employee with no recorded
 * mobile would "match" a Telegram account that shared nothing.
 */
function mobilesMatch(a, b) {
  const left = normalizeIndianMobile(a);
  if (left === null) return false;
  const right = normalizeIndianMobile(b);
  if (right === null) return false;
  return left === right;
}

module.exports = {
  normalizeIndianMobile,
  isValidIndianMobile,
  mobilesMatch,
  INDIAN_MOBILE_RE,
};
