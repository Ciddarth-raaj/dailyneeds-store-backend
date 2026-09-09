/**
 * The Department / Designation / Shift picker lists.
 *
 *   node --test routes/master_directories.test.js
 *
 * ============================================ THE DEFECT THESE PIN =========
 *
 * The C3 employee profile lets HR change where somebody works: branch,
 * department, designation and shift. Branch worked. The other three did not,
 * and the reason was not in the edit path at all - `POST /hr/employee/:id/edit`
 * has always accepted `department_id`, `designation_id` and `shift_id`, and the
 * repository has always persisted them.
 *
 * The reason was the PICKER. Department, designation and shift were read from
 * `GET /department`, `GET /designation` and `GET /shift`, each gated on the
 * master's own `view_*` permission. An HR user holding `employee_edit` but not
 * `view_department` received `{ code: 403 }`, the frontend's `unwrapList` gave
 * the section an empty array, and the dropdown rendered with nothing in it. The
 * field could not be changed because there was nothing to choose - and nothing
 * on screen said why.
 *
 * Administering a master was never a prerequisite for being ASSIGNED one. This
 * is the same failure `GET /outlet/directory` was added to fix - which is why
 * branch alone kept working - and the fix is the same: return less rather than
 * hand back the permission.
 *
 * INACTIVE ROWS ARE INCLUDED, deliberately. An employee assigned to a
 * department that was later switched off must still see it and must still have
 * it preselected when editing. Filtering to active rows would silently blank a
 * real assignment the first time somebody retired a master row.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const read = (rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
/** Comments explain the rule; only code enforces it. */
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const MASTERS = [
  {
    noun: "department",
    route: "routes/department.js",
    repo: "repository/department.js",
    usecase: "usecase/department.js",
    table: "department",
    id: "department_id",
    label: "department_name",
    permission: "VIEW_DEPARTMENT",
  },
  {
    noun: "designation",
    route: "routes/designation.js",
    repo: "repository/designation.js",
    usecase: "usecase/designation.js",
    table: "designation",
    id: "designation_id",
    label: "designation_name",
    permission: "VIEW_DESIGNATION",
  },
  {
    noun: "shift",
    route: "routes/shift.js",
    repo: "repository/shift.js",
    usecase: "usecase/shift.js",
    table: "shift_master",
    id: "shift_id",
    label: "shift_name",
    permission: "VIEW_SHIFT",
  },
];

/* ===================================== the picker is not permission-gated */

for (const m of MASTERS) {
  test(`${m.noun}: THE PICKER IS NOT GATED ON ${m.permission}`, () => {
    const code = strip(read(m.route));
    const decl = code.match(/router\.get\("\/directory",[^;]*/);
    assert.ok(decl, `${m.noun} must expose GET /directory`);
    // The middle argument of a guarded route is the guard. There must be none.
    assert.ok(
      !/require\(/.test(decl[0]),
      `${m.noun}/directory must not carry a permission guard: ${decl[0].slice(0, 90)}`
    );
    assert.match(decl[0], /async \(req, res\)/);
  });

  test(`${m.noun}: the administrative routes KEEP their permission`, () => {
    // The point is to add a narrow read, not to open the master.
    const code = strip(read(m.route));
    const listRoute = code.match(/router\.get\("\/",[^;]*/);
    assert.ok(listRoute, `${m.noun} must still expose GET /`);
    assert.match(
      listRoute[0],
      new RegExp(`require\\(P\\.${m.permission}\\)`),
      `${m.noun} GET / must remain gated`
    );

    // And nothing was quietly un-gated: every write still requires something.
    const writes = code.match(/router\.post\("[^"]*",[^;]{0,120}/g) || [];
    for (const w of writes) {
      assert.match(w, /require(All)?\(/, `${m.noun}: unguarded write ${w.slice(0, 70)}`);
    }
  });
}

/* ============================================ what the picker returns ==== */

for (const m of MASTERS) {
  test(`${m.noun}: the query selects id, label and status - and nothing else`, () => {
    const repo = strip(read(m.repo));
    const sql = repo.match(/getDirectory\(\)[\s\S]*?"(SELECT[^"]+)"/);
    assert.ok(sql, `${m.noun} repository must have getDirectory`);
    const query = sql[1];

    assert.match(query, new RegExp(`\\b${m.id}\\b`));
    assert.match(query, new RegExp(`\\b${m.label}\\b`));
    assert.match(query, /`status`/);
    assert.match(query, new RegExp(`FROM ${m.table}\\b`));
    // Not SELECT * - the whole point is to return less than the gated route.
    assert.ok(!/SELECT \*/.test(query), `${m.noun}: the picker must not select *`);
  });

  test(`${m.noun}: INACTIVE ROWS ARE NOT FILTERED OUT`, () => {
    // The behaviour the profile depends on: an employee assigned to a master
    // row that was later switched off must still see and preselect it.
    const repo = strip(read(m.repo));
    const sql = repo.match(/getDirectory\(\)[\s\S]*?"(SELECT[^"]+)"/)[1];
    assert.ok(!/WHERE/i.test(sql), `${m.noun}: the picker must not filter: ${sql}`);
    assert.ok(!/status\s*=\s*1/.test(sql), `${m.noun}: the picker must not require active`);
  });

  test(`${m.noun}: the usecase just passes it through`, () => {
    const usecase = strip(read(m.usecase));
    assert.match(usecase, /getDirectory\(\)/);
    assert.match(usecase, /Repo\.getDirectory\(\)/);
  });
}

/* ============================== the edit path was already correct ======== */

test("THE EDIT PATH ALREADY ACCEPTED ALL FOUR PLACEMENT FIELDS", () => {
  // Establishes that this defect was never in the backend's write path, which
  // is why the fix adds a read rather than touching the employee master.
  const repo = strip(read("repository/employee_master.js"));
  const editable = repo.slice(repo.indexOf("const EDITABLE_FIELDS"), repo.indexOf("];", repo.indexOf("const EDITABLE_FIELDS")));
  for (const field of ["store_id", "department_id", "designation_id", "shift_id"]) {
    assert.ok(editable.includes(field), `${field} must be editable`);
  }
});

test("JOINING DATE REMAINS LIFECYCLE-CONTROLLED, NOT EDITABLE", () => {
  const repo = strip(read("repository/employee_master.js"));
  const editable = repo.slice(repo.indexOf("const EDITABLE_FIELDS"), repo.indexOf("];", repo.indexOf("const EDITABLE_FIELDS")));
  assert.ok(!editable.includes("date_of_joining"), "date_of_joining must not be editable");

  const lifecycle = repo.slice(repo.indexOf("const LIFECYCLE_CONTROLLED_FIELDS"));
  assert.match(lifecycle.slice(0, 300), /date_of_joining/);
  assert.match(lifecycle.slice(0, 300), /status/);
  assert.match(lifecycle.slice(0, 300), /employee_id/);
});

test("changing designation or store still re-issues authorization", () => {
  // Unchanged by this fix, and worth pinning: these two columns decide what a
  // token may do, so an existing session must not keep the old authority.
  const repo = strip(read("repository/employee_master.js"));
  assert.match(repo, /SECURITY_RELEVANT_FIELDS = \["designation_id", "store_id"\]/);
});

/* ============================== nothing else moved ======================= */

test("THE FIX ADDS A READ AND CHANGES NO WRITE", () => {
  // A guard against scope creep: the employee master, its migrations and the
  // Reports feature are untouched by this hotfix.
  const employeeMaster = read("repository/employee_master.js");
  assert.ok(!/getDirectory/.test(employeeMaster), "the employee master is not part of this fix");
});

test("no new permission key was invented", () => {
  const perms = read("constants/hr_permissions.js");
  for (const invented of ["view_master_directory", "employee_placement", "edit_placement"]) {
    assert.ok(!perms.includes(invented), `${invented} must not exist`);
  }
  // The three the picker replaces are still declared for the routes that keep
  // using them.
  for (const kept of ["VIEW_DEPARTMENT", "VIEW_DESIGNATION", "VIEW_SHIFT"]) {
    assert.match(perms, new RegExp(kept));
  }
});
