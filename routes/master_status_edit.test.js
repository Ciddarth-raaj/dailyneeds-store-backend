/**
 * Department and Designation master — renaming and retiring.
 *
 *   node --test routes/master_status_edit.test.js
 *
 * ===================================== WHAT WAS ACTUALLY BROKEN ===========
 *
 * The Designation master could already be renamed AND have its status changed:
 * `POST /designation/update-designation` has always accepted `status` inside
 * `designation_details`, and `UPDATE designation SET ?` has always written it.
 * That half of the defect was entirely in the frontend form.
 *
 * The Department master could not. Its route declared
 *
 *     department_details: Joi.object({
 *       department_name: Joi.string().required(),
 *       // status: Joi.number().required(),
 *     })
 *
 * with `status` COMMENTED OUT. Joi rejects unknown keys by default, so a body
 * carrying a status was refused outright - the one field the screen most needed
 * to change was the one the schema would not accept. Status could only be moved
 * through the separate `/update-status` endpoint, which the master screen never
 * called.
 *
 * The fix is that one line, made `.optional()` rather than `.required()` so a
 * caller sending only a name still validates.
 *
 * ============================================ WHAT IS DELIBERATELY UNCHANGED
 *
 * NO UNIQUENESS RULE IS ADDED. Neither `department` nor `designation` carries a
 * unique index on its name - both are plain `varchar(255) DEFAULT NULL` - so
 * the create path has always permitted two masters with the same name. Adding
 * uniqueness on the edit path would invent a policy the create path does not
 * have, and enforcing it in the database would need a migration that would fail
 * on any duplicate already in production. The rule is therefore unchanged:
 * names are free text, on create and on edit alike.
 *
 * NO STATUS CASCADE. Retiring a master writes one column on one row. It does
 * not touch `new_employee`, so an employee assigned to a department that has
 * just been made inactive stays assigned to it.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const read = (rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const deptRoute = strip(read("routes/department.js"));
const desigRoute = strip(read("routes/designation.js"));
const deptRepo = strip(read("repository/department.js"));
const desigRepo = strip(read("repository/designation.js"));

/* ================================= the schema accepts a status now ======= */

test("DEPARTMENT: the update schema accepts status", () => {
  // The one-line defect. Without this, a rename-and-retire body is a 422.
  const schema = deptRoute.slice(
    deptRoute.indexOf("update-department"),
    deptRoute.indexOf("updateDepartmentDetails")
  );
  assert.match(schema, /department_name: Joi\.string\(\)\.required\(\)/);
  assert.match(schema, /status: Joi\.number\(\)\.valid\(0, 1\)\.optional\(\)/);
});

test("DEPARTMENT: a name-only body still validates", () => {
  // `.optional()`, not `.required()`: any existing caller that sends only a
  // name must keep working, and `UPDATE department SET ?` just leaves the
  // column alone.
  const schema = deptRoute.slice(
    deptRoute.indexOf("update-department"),
    deptRoute.indexOf("updateDepartmentDetails")
  );
  assert.ok(
    !/status: Joi\.number\(\)\.valid\(0, 1\)\.required\(\)/.test(schema),
    "status must not become mandatory"
  );
});

test("DESIGNATION: the update schema already accepted status, and still does", () => {
  const schema = desigRoute.slice(
    desigRoute.indexOf("update-designation"),
    desigRoute.indexOf("updateDesignationDetails")
  );
  assert.match(schema, /designation_name: Joi\.string\(\)\.required\(\)/);
  assert.match(schema, /status: Joi\.number\(\)\.required\(\)/);
});

test("only 0 and 1 are accepted as a department status", () => {
  // The column is `int DEFAULT '1'` and the whole application reads
  // `status === 1` as Active. A third value would render as Inactive
  // everywhere while meaning something else to whoever wrote it.
  const schema = deptRoute.slice(deptRoute.indexOf("update-department"));
  assert.match(schema.slice(0, 600), /valid\(0, 1\)/);
});

/* ============== a name/status edit must not revoke permissions ========== */

test("DESIGNATION: `permissions` IS OPTIONAL, SO A NAME EDIT CANNOT WIPE THEM", () => {
  // `usecase.updateDesignationDetails` DELETES every permission row for the
  // designation and recreates it from this array - but only when the array is
  // present. Requiring it meant a caller changing just the name had to send
  // the full set back, and an empty array from a screen that never loaded them
  // silently revoked everything that designation could do.
  const schema = desigRoute.slice(
    desigRoute.indexOf("update-designation"),
    desigRoute.indexOf("updateDesignationDetails")
  );
  assert.match(schema, /permissions: Joi\.array\(\)\.items\(Joi\.string\(\)\)\.optional\(\)/);
  assert.ok(
    !/permissions: Joi\.array\(\)\.items\(Joi\.string\(\)\)\.required\(\)/.test(schema),
    "permissions must not be mandatory on an update"
  );
});

test("the usecase only rewrites permissions when it is given some", () => {
  // The guard this change relies on. If it ever became unconditional, an
  // absent list would wipe the set instead of leaving it alone.
  const usecase = strip(read("usecase/designation.js"));
  const body = usecase.slice(usecase.indexOf("updateDesignationDetails"));
  assert.match(body.slice(0, 700), /if \(designation\.permissions\) \{[\s\S]{0,200}deletePermissions/);
});

/* ============================================ permissions are unchanged == */

test("BOTH UPDATES KEEP THE EXISTING MANAGE PERMISSION", () => {
  // No new permission key: renaming or retiring a master is the same authority
  // as creating one, which is what `add_*` has always meant here.
  const dept = deptRoute.match(/router\.post\("\/update-department",[^,]+,/);
  assert.ok(dept);
  assert.match(dept[0], /require\(P\.ADD_DEPARTMENT\)/);

  const desig = desigRoute.match(/router\.post\("\/update-designation",[^,]+,/);
  assert.ok(desig);
  assert.match(desig[0], /require\(P\.ADD_DESIGNATION\)/);

  // The separate status endpoints keep theirs too.
  const deptStatus = deptRoute.match(/router\.post\("\/update-status",[^,]+,/);
  assert.match(deptStatus[0], /require\(P\.ADD_DEPARTMENT\)/);
  const desigStatus = desigRoute.match(/router\.post\("\/update-status",[^,]+,/);
  assert.match(desigStatus[0], /require\(P\.ADD_DESIGNATION\)/);
});

test("no new permission key was invented", () => {
  const perms = read("constants/hr_permissions.js");
  for (const invented of ["edit_department", "edit_designation", "manage_masters"]) {
    assert.ok(!perms.includes(invented), `${invented} must not exist`);
  }
  assert.match(perms, /ADD_DEPARTMENT: "add_department"/);
  assert.match(perms, /ADD_DESIGNATION: "add_designation"/);
});

/* ======================================== the write touches one row ====== */

test("RETIRING A MASTER DOES NOT TOUCH EMPLOYEES", () => {
  // The behaviour the whole feature depends on: inactive means "not offered
  // for new use", never "unassign everyone who has it".
  for (const [name, repo] of [["department", deptRepo], ["designation", desigRepo]]) {
    const update = repo.slice(repo.indexOf(`update${name[0].toUpperCase()}${name.slice(1)}Details`));
    const body = update.slice(0, update.indexOf("create("));
    assert.ok(!/new_employee/i.test(body), `${name} update must not touch new_employee`);
    assert.ok(!/DELETE/i.test(body), `${name} update must not delete`);
  }
});

test("the update is keyed by the permanent master id", () => {
  // Editing renames a row; it never creates a second one.
  assert.match(deptRepo, /UPDATE department SET \? WHERE department_id = \?/);
  assert.match(desigRepo, /UPDATE designation SET \? WHERE designation_id = \?/);
  // And neither update path inserts.
  const deptUpdate = deptRepo.slice(
    deptRepo.indexOf("updateDepartmentDetails"),
    deptRepo.indexOf("create(")
  );
  assert.ok(!/INSERT/i.test(deptUpdate), "the department edit path must not insert");
});

test("the status endpoints still write only the status column", () => {
  assert.match(deptRepo, /UPDATE department SET status = \? WHERE department_id = \?/);
  assert.match(desigRepo, /UPDATE designation SET status = \? WHERE designation_id = \?/);
});

/* ============================== the duplicate-name rule is unchanged ===== */

test("NO UNIQUENESS RULE WAS ADDED TO EITHER MASTER", () => {
  // Neither table has a unique index on its name, so create has always allowed
  // duplicates. Enforcing it on edit alone would be a policy the rest of the
  // application does not have - and a database-level rule would need a
  // migration that could not apply over existing duplicates.
  const deptTable = read("migrations/mysql/migrations/sqls/20211006085335-adds-department-up.sql");
  const desigTable = read("migrations/mysql/migrations/sqls/20211006085243-adds-designation-up.sql");
  assert.ok(!/UNIQUE/i.test(deptTable), "department name is not unique in the schema");
  assert.ok(!/UNIQUE/i.test(desigTable), "designation name is not unique in the schema");

  // And this change adds no application-level check either.
  const deptUpdate = deptRoute.slice(deptRoute.indexOf("update-department"));
  assert.ok(!/duplicate/i.test(deptUpdate.slice(0, 800)));
});

/* ============================== nothing outside the two masters moved ==== */

test("THIS FIX TOUCHES NEITHER THE EMPLOYEE MASTER NOR REPORTS", () => {
  // Scope guard. The employee profile, its lifecycle and the Reports feature
  // are all deployed and are not part of this change.
  const changed = ["routes/department.js"];
  for (const f of changed) {
    const src = read(f);
    assert.ok(!/new_employee/i.test(src), `${f} must not reference the employee master`);
    assert.ok(!/report_template|employee_report/i.test(src), `${f} must not reference Reports`);
  }
});

test("no migration was added for this change", () => {
  // The schema already supports both edits: `department_name varchar(255)` and
  // `status int DEFAULT '1'` are both writable columns.
  const migrations = fs.readdirSync(
    path.join(__dirname, "..", "migrations", "mysql", "migrations")
  );
  for (const m of migrations) {
    assert.ok(
      !/master-(status|edit)|department-history|designation-history/i.test(m),
      `unexpected migration: ${m}`
    );
  }
});
