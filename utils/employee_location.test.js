/**
 * WHERE AN EMPLOYEE IS EXPECTED TO BE - the rule, on its own.
 *
 *   node --test utils/employee_location.test.js
 *
 * Pure arithmetic over plain rows. What is defended here is the part that a
 * screen test cannot reach: that an absent column reads as FIXED rather than
 * as roaming, that the flag is a per-employee fact and not a designation rule,
 * and that the grouping is a TOTAL function - every row lands in exactly one
 * group, so a grouped list cannot double-count anybody.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const loc = require("./employee_location");

describe("worksAllLocations reads the column and nothing else", () => {
  it("is true only for a recognisable 1 / true", () => {
    [1, true, "1", "true", " True "].forEach((v) => {
      assert.equal(loc.worksAllLocations({ works_all_locations: v }), true, String(v));
    });
  });

  it("is false for 0, false and the strings that mean them", () => {
    [0, false, "0", "false", ""].forEach((v) => {
      assert.equal(loc.worksAllLocations({ works_all_locations: v }), false, String(v));
    });
  });

  /**
   * THE IMPORTANT ONE. A query that forgot to select the column must not turn
   * everybody it loaded into a roaming employee - that would empty an outlet's
   * Expected Now for a reason nobody could see. Absent reads as FIXED, which
   * keeps the employee counted exactly where they were counted before.
   */
  it("absent, null and undefined all read as FIXED, never as roaming", () => {
    assert.equal(loc.worksAllLocations({}), false);
    assert.equal(loc.worksAllLocations({ works_all_locations: null }), false);
    assert.equal(loc.worksAllLocations({ works_all_locations: undefined }), false);
    assert.equal(loc.worksAllLocations(null), false);
    assert.equal(loc.worksAllLocations(undefined), false);
  });

  it("names the scope rather than a boolean, for anything that reports it", () => {
    assert.equal(loc.locationScopeOf({ works_all_locations: 1 }), loc.LOCATION_SCOPE.ALL_LOCATIONS);
    assert.equal(loc.locationScopeOf({ store_id: 3 }), loc.LOCATION_SCOPE.FIXED);
  });
});

describe("the expected outlet", () => {
  it("is the employee's store for a fixed employee", () => {
    assert.equal(loc.expectedOutletIdFor({ store_id: "7" }), 7);
  });

  it("is null for a roaming employee EVEN THOUGH they still have a store", () => {
    // `store_id` is the OWNING branch and is deliberately still set: every
    // authorization scope reads it, so clearing it would hide the person from
    // their own manager. It is simply not an expectation.
    assert.equal(loc.expectedOutletIdFor({ store_id: 7, works_all_locations: 1 }), null);
  });

  it("is null for a fixed employee with no outlet on record", () => {
    assert.equal(loc.expectedOutletIdFor({ store_id: null }), null);
  });
});

describe("the store-wise grouping is total and non-overlapping", () => {
  const rows = [
    { employee_id: 1, store_id: 1, outlet_name: "Vallalar Salai" },
    { employee_id: 2, store_id: 1, outlet_name: "Vallalar Salai" },
    { employee_id: 3, store_id: 2, outlet_name: "Kathirkamam" },
    { employee_id: 4, store_id: null, outlet_name: null },
    { employee_id: 5, store_id: 9, outlet_name: "Warehouse", works_all_locations: 1 },
  ];

  it("gives every row exactly one key", () => {
    const keys = rows.map(loc.locationGroupKeyOf);
    assert.deepEqual(keys, ["1", "1", "2", "none", loc.ROAMING_GROUP_KEY]);
    assert.equal(keys.filter((k) => k === undefined || k === null).length, 0);
  });

  it("files a roaming employee under roaming and NOT under the branch that owns them", () => {
    const roamer = rows[4];
    assert.equal(loc.locationGroupKeyOf(roamer), loc.ROAMING_GROUP_KEY);
    assert.notEqual(loc.locationGroupKeyOf(roamer), String(roamer.store_id));
    assert.equal(loc.locationGroupLabelOf(roamer), loc.ROAMING_LABEL);
  });

  it("names a missing outlet rather than dropping the row", () => {
    assert.equal(loc.locationGroupLabelOf(rows[3]), "No outlet on record");
  });

  it("falls back to the nickname when there is no outlet name", () => {
    assert.equal(loc.locationGroupLabelOf({ outlet_nickname: "MOOL" }), "MOOL");
  });
});

/**
 * THE RULE IS A COLUMN, NOT A LIST OF JOB TITLES.
 *
 * The request that produced this module named one person and one designation.
 * Encoding either would be a rule nobody can see and nobody can change without
 * a deploy - and a designation one person holds today three people hold next
 * year, two of whom sit in one building. So the source is read back and
 * checked: nothing in it decides anything from a name or a designation.
 */
describe("no employee and no designation is hard-coded", () => {
  const sources = [
    "utils/employee_location.js",
    "usecase/attendance_staffing.js",
    "repository/attendance_dashboard.js",
  ].map((rel) => ({ rel, text: fs.readFileSync(path.join(__dirname, "..", rel), "utf8") }));

  it("names no employee and no job title as a rule", () => {
    sources.forEach(({ rel, text }) => {
      // Comments explain the fault; code must not encode a person or a title.
      const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      assert.ok(!/kumaraguru/i.test(code), `${rel} names an employee`);
      assert.ok(!/operations\s*manager/i.test(code), `${rel} names a designation`);
    });
  });

  it("decides roaming from the column, and from nothing on the designation", () => {
    const text = fs.readFileSync(path.join(__dirname, "employee_location.js"), "utf8");
    const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.ok(code.includes("works_all_locations"));
    assert.ok(!code.includes("designation_id"), "the scope must not be read off a designation");
    assert.ok(!code.includes("designation_name"));
  });
});
