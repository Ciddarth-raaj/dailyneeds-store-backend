/**
 * The permission key each GRN endpoint requires.
 *
 * One key per decision, the same rule `constants/hr_permissions.js` states:
 * `permissions.require(a, b)` is OR, so two keys in one call would weaken the
 * check to either-of.
 *
 * VIEW_ALL_GRN is what the web app gates the All GRN screens on
 * (`GlobalWrapper permissionKey="view_all_grn"`); VERIFY_GRN is a SEPARATE
 * decision on purpose. Everybody who works a GRN can look at one; signing it
 * off as checked is an audit record naming the person who signed it, and
 * granting the first must not hand out the second.
 */
module.exports = {
  // MAY THIS USER OPEN THE GRN LIST / DETAIL SCREENS?
  VIEW_ALL_GRN: "view_all_grn",

  // MAY THIS USER MARK A GRN AS CHECKED AND VERIFIED?
  //
  // Write, not read, and the only key that lets `POST /grn/:refno/verify`
  // through. The verifier and the timestamp come from the authenticated
  // session and the database clock, never from the request body.
  VERIFY_GRN: "verify_grn",
};
