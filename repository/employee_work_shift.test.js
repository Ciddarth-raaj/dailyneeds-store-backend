/**
 * Employee Shift Assignment — the SQL layer.
 *
 *   node --test repository/employee_work_shift.test.js
 *
 * Two things are proven here, and the second is the important one.
 *
 *   1. `buildFilters` produces the clause and the bound parameters the screen's
 *      filters mean — including the ASSIGNED / UNASSIGNED test, which is what
 *      makes "show me who still needs a shift" work at all.
 *
 *   2. THE LEGACY SHIFT MAPPING IS NEVER TOUCHED. `shift_id`, `shift_code` and
 *      `shift_master` appear nowhere in this module, in a read or a write, and
 *      the only column the UPDATE names is `default_work_shift_id`. That is a
 *      promise about production data, so it is checked against the source
 *      rather than trusted to a code review.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const buildRepo = require("./employee_work_shift");

const source = fs.readFileSync(path.join(__dirname, "employee_work_shift.js"), "utf8");
/** Comments explain the decisions; only code makes them. */
const code = source
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

const repo = buildRepo({ query: () => {} });
const norm = (s) => s.replace(/\s+/g, " ").trim();

/* ========================================================== the filters == */

describe("buildFilters", () => {
  it("defaults to active employees, with no other condition", () => {
    const { where, params } = repo.buildFilters({});
    assert.equal(norm(where), "WHERE ne.status = 1");
    assert.deepEqual(params, []);
  });

  it("ALL employment statuses adds no status condition at all", () => {
    const { where, params } = repo.buildFilters({ employment_status: "ALL" });
    assert.equal(where, "");
    assert.deepEqual(params, []);
  });

  it("INACTIVE catches both 0 and NULL, the way the employee list does", () => {
    const { where } = repo.buildFilters({ employment_status: "INACTIVE" });
    assert.match(where, /\(ne\.status IS NULL OR ne\.status <> 1\)/);
  });

  it("binds outlet, department and designation as IN lists, in that order", () => {
    const { where, params } = repo.buildFilters({
      employment_status: "ALL",
      store_ids: [2, 3],
      department_ids: [4],
      designation_ids: [5],
    });
    assert.equal(
      norm(where),
      "WHERE ne.store_id IN (?) AND ne.department_id IN (?) AND ne.designation_id IN (?)"
    );
    // Swapping these would filter outlets by department ids and vice versa —
    // a wrong population rather than an error, so the order is pinned.
    assert.deepEqual(params, [[2, 3], [4], [5]]);
  });

  it("UNASSIGNED is the NULL test, ASSIGNED its opposite, ALL neither", () => {
    assert.match(
      repo.buildFilters({ employment_status: "ALL", assignment_status: "UNASSIGNED" }).where,
      /ne\.default_work_shift_id IS NULL/
    );
    assert.match(
      repo.buildFilters({ employment_status: "ALL", assignment_status: "ASSIGNED" }).where,
      /ne\.default_work_shift_id IS NOT NULL/
    );
    assert.equal(
      repo.buildFilters({ employment_status: "ALL", assignment_status: "ALL" }).where,
      ""
    );
  });

  it("searches employee name and id, and binds the term rather than interpolating it", () => {
    const { where, params } = repo.buildFilters({ employment_status: "ALL", search: " Ada " });
    assert.equal(
      norm(where),
      "WHERE (ne.employee_name LIKE ? OR CAST(ne.employee_id AS CHAR) LIKE ?)"
    );
    assert.deepEqual(params, ["%Ada%", "%Ada%"]);
  });

  it("escapes LIKE wildcards, so a name containing % is not a match-everything", () => {
    const { params } = repo.buildFilters({ employment_status: "ALL", search: "50%_x" });
    assert.deepEqual(params, ["%50\\%\\_x%", "%50\\%\\_x%"]);
  });

  it("a blank search adds no condition", () => {
    assert.equal(repo.buildFilters({ employment_status: "ALL", search: "   " }).where, "");
  });
});

/* =============================================== what it must never do == */

describe("the legacy shift mapping", () => {
  it("never names the legacy table or the legacy employee columns", () => {
    assert.ok(!/shift_master/.test(code), "shift_master must not appear");
    // `\b` does not match inside `work_shift_id` or `default_work_shift_id`,
    // so this catches the legacy column and only it.
    assert.ok(!/\bshift_id\b/.test(code), "the legacy shift_id must not appear");
    assert.ok(!/\bne\.shift_code\b/.test(code), "new_employee.shift_code must not appear");
    assert.ok(!/\bne\.shift_id\b/.test(code), "new_employee.shift_id must not appear");
  });

  it("reads shift_code only from the work_shift master", () => {
    // Two places, both on `work_shift`: the joined display column on the list
    // and the shift the assignment names back to the user.
    const occurrences = code.match(/[A-Za-z_.]*shift_code/g) || [];
    assert.deepEqual(occurrences.sort(), ["shift_code", "work_shift_code", "ws.shift_code"]);
  });

  it("writes exactly one column on new_employee, and it is the new one", () => {
    const updates = code.match(/UPDATE new_employee SET [^"`]*/g) || [];
    assert.equal(updates.length, 1);
    assert.match(updates[0], /^UPDATE new_employee SET default_work_shift_id = \? WHERE employee_id IN \(\?\)/);
  });

  it("never SELECTs * from an employee table", () => {
    assert.ok(!/SELECT\s+\*/i.test(code), "every column is named");
  });

  it("selects no sensitive employee column", () => {
    const { isSensitiveField } = require("../constants/sensitive_fields");
    const selected = (code.match(/\bne\.([a-z_]+)/g) || []).map((m) => m.slice(3));
    for (const field of selected) {
      assert.ok(!isSensitiveField(field), `${field} must not be selected here`);
    }
  });
});
