/**
 * Credit Purchase - the bill reference rules, free of SQL.
 *
 * The same supplier bill must never be entered twice, and people type the
 * same reference several ways: "KF/2026/101", "kf-2026-101", "KF 2026 101".
 * The duplicate key is the reference upper-cased with whitespace and the
 * separators people use inconsistently removed. It is stored beside the
 * reference and is unique per supplier in the database; the reference itself
 * is kept as entered (trimmed, inner whitespace collapsed) for display.
 */

/** Spaces and the separators that do not distinguish one bill from another. */
const IGNORED_RE = /[\s\-\/._\\#]/g;

/** The reference as stored and shown. */
function cleanBillReference(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim().replace(/\s+/g, " ");
}

/** The duplicate-protection key, or "" when nothing meaningful is left. */
function billReferenceKey(value) {
  return cleanBillReference(value).toUpperCase().replace(IGNORED_RE, "");
}

module.exports = { cleanBillReference, billReferenceKey };
