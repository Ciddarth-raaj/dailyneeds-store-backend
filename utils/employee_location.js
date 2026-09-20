/**
 * WHERE AN EMPLOYEE IS EXPECTED TO BE - the one rule, in one place.
 *
 * Until now this system had exactly one answer: `new_employee.store_id`, the
 * single outlet an employee belongs to. That column carries two different
 * facts at once and always has - WHICH BRANCH OWNS THIS RECORD (used for
 * authorization scope, reporting lines and the employee directory) and WHERE
 * THIS PERSON IS EXPECTED TO STAND DURING THEIR SHIFT (used by the staffing
 * snapshot to build Expected and Gap per outlet).
 *
 * For most people those are the same place. For an area or operations role
 * they are not: somebody who works ACROSS the outlets is owned by one of them
 * on paper - usually the warehouse - and is expected at none of them in
 * particular. Counting such a person into the warehouse's Expected Now
 * manufactures a permanent staffing gap at a branch nobody was ever rostered
 * to cover, and flags every ordinary visit to another outlet as
 * "recorded IN elsewhere - verification needed".
 *
 * SO THE TWO FACTS ARE SEPARATED, and only the second one is new:
 *
 *   `new_employee.store_id`            unchanged. Still the owning branch,
 *                                      still what every authorization scope
 *                                      and every directory filter reads. A
 *                                      roaming employee keeps theirs, so a
 *                                      branch manager still sees their own
 *                                      people and nobody becomes invisible.
 *   `new_employee.works_all_locations` NEW. 1 = this person's duty is not
 *                                      tied to one outlet.
 *
 * NO NAME AND NO DESIGNATION IS HARD-CODED ANYWHERE. This is a per-employee
 * flag set on the employee master, not a list of job titles: "Operations
 * Manager" is a designation that one day will have three holders, two of whom
 * sit at a desk in one building. Deciding it from the designation would be a
 * rule nobody can see and nobody can change without a deploy.
 *
 * WHAT THE FLAG DOES NOT MEAN. It is not an attendance exemption - that is
 * `attendance_required`, a different column with a different meaning, and a
 * roaming employee still punches, still has a shift, still appears in
 * attendance, in the missing-attendance report and in payroll exactly as
 * before. It is not a status, not a resignation and not a payroll switch. The
 * ONLY thing it changes is which outlet's EXPECTED and GAP they are counted
 * into: none of them, individually.
 *
 * PURE. No database, no clock, no I/O; every function takes a plain employee
 * row, in whichever shape the query that loaded it produced.
 */

/** How an employee's duty location is expressed. Two values, and no third. */
const LOCATION_SCOPE = Object.freeze({
  FIXED: "FIXED",
  ALL_LOCATIONS: "ALL_LOCATIONS",
});

/** The words staff see for a roaming employee, everywhere. One string. */
const ROAMING_LABEL = "All Locations / Roaming";

/** The group key the roaming employees are collected under. Never an outlet id. */
const ROAMING_GROUP_KEY = "roaming";

/**
 * Does this employee work across all locations?
 *
 * ABSENT MEANS FIXED. The column is `NOT NULL DEFAULT 0`, but a row loaded by
 * a query that did not select it must not silently become roaming - that
 * would empty an outlet's Expected Now because of a forgotten column in a
 * SELECT list. So anything that is not recognisably a truthy 1/true/"1"/"true"
 * reads as FIXED, which is the conservative answer: the employee keeps being
 * counted where they always were.
 */
function worksAllLocations(employee) {
  if (!employee) return false;
  const v = employee.works_all_locations;
  if (v === true) return true;
  if (v === 1) return true;
  if (typeof v === "string") {
    const t = v.trim().toLowerCase();
    return t === "1" || t === "true";
  }
  return false;
}

/** The scope as a named value, for anything that reports it rather than branches on it. */
function locationScopeOf(employee) {
  return worksAllLocations(employee) ? LOCATION_SCOPE.ALL_LOCATIONS : LOCATION_SCOPE.FIXED;
}

/**
 * The outlet this employee's SHIFT is expected to be covered at, or null.
 *
 * Null for a roaming employee - deliberately the same null a fixed employee
 * with no `store_id` produces, because the staffing classifier already has a
 * meaning for "no expected outlet" and does not need a second one. The
 * ROAMING flag travels beside it for anything that must tell the two aparts.
 */
function expectedOutletIdFor(employee) {
  if (worksAllLocations(employee)) return null;
  const id = employee ? employee.store_id : null;
  return id === null || id === undefined ? null : Number(id);
}

/**
 * The group an employee is DISPLAYED under, store-wise.
 *
 * EXACTLY ONE GROUP PER EMPLOYEE, which is the whole point: a grouped list
 * whose groups overlap is a list that double-counts people. Roaming wins over
 * the owning branch, because that is the fact the reader needs; everybody else
 * groups by `store_id`, and an employee with no outlet on record groups under
 * `none` rather than being dropped.
 */
function locationGroupKeyOf(row) {
  if (worksAllLocations(row)) return ROAMING_GROUP_KEY;
  const id = row ? row.store_id : null;
  return id === null || id === undefined ? "none" : String(id);
}

/** The heading that group is shown with. */
function locationGroupLabelOf(row) {
  if (worksAllLocations(row)) return ROAMING_LABEL;
  return (row && (row.outlet_name || row.outlet_nickname)) || "No outlet on record";
}

module.exports = {
  LOCATION_SCOPE,
  ROAMING_LABEL,
  ROAMING_GROUP_KEY,
  worksAllLocations,
  locationScopeOf,
  expectedOutletIdFor,
  locationGroupKeyOf,
  locationGroupLabelOf,
};
