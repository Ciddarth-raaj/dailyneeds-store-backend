/**
 * Employee Master Bulk Export / Import — the HTTP surface.
 *
 *   node --test routes/employee_bulk_update.test.js
 *
 * Two kinds of test, for the same reason `routes/employee_report.test.js`
 * gives: several of the guarantees here are about what is ABSENT - no route
 * without a permission, no employee UPDATE anywhere in the feature outside the
 * C2 usecase, no new permission key - and an absence cannot be demonstrated by
 * exercising one path. The rest drives the router with fakes.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { PassThrough } = require("stream");
const ExcelJS = require("exceljs");

const buildRoutes = require("./employee_bulk_update");
const P = require("../constants/hr_permissions");

const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const ROUTE = read("routes/employee_bulk_update.js");
const ROUTE_CODE = strip(ROUTE);
const USECASE_CODE = strip(read("usecase/employee_bulk_update.js"));
const REPO_CODE = strip(read("repository/employee_bulk_update.js"));

/* ============================================ the shape of the feature == */

test("NO layer of this feature writes an employee except through the C2 usecase", () => {
  for (const [name, code] of [
    ["repository", REPO_CODE],
    ["usecase", USECASE_CODE],
    ["route", ROUTE_CODE],
  ]) {
    assert.ok(
      !/\bUPDATE\s+new_employee\b/i.test(code),
      `${name} contains an UPDATE of new_employee; every change must go through employee_master`
    );
    assert.ok(
      !/\bINSERT\s+INTO\s+new_employee\b/i.test(code),
      `${name} inserts into new_employee`
    );
  }
  // And the writes it DOES make are the two audited employee-master actions.
  assert.match(USECASE_CODE, /this\.master\.editEmployee\(/);
  assert.match(USECASE_CODE, /this\.master\.correctJoiningDate\(/);
});

test("Date of Joining is NEVER put in the generic edit patch", () => {
  assert.match(
    USECASE_CODE,
    /if \(change\.field === "date_of_joining"\) joiningDate = change\.to;\s*\n\s*else patch\[change\.field\] = change\.to;/,
    "the joining date must be routed to correctJoiningDate, not into the patch"
  );
});

test("every route carries a permission, and the write pair uses requireAll (AND, not OR)", () => {
  const routes = [...ROUTE_CODE.matchAll(/router\.(get|post)\(\s*\n?\s*"([^"]+)"([\s\S]{0,200}?)(?:async \(req, res\)|\(req, res\))/g)];
  assert.equal(routes.length, 4, "expected exactly four endpoints");

  for (const [, , url, between] of routes) {
    assert.ok(
      /this\.permissions\.(require|requireAll)\(/.test(between),
      `${url} has no permission check`
    );
  }

  const byUrl = Object.fromEntries(routes.map(([, , url, between]) => [url, between]));
  assert.match(byUrl["/employees/bulk/fields"], /require\(P\.VIEW_EMPLOYEES\)/);
  assert.match(byUrl["/employees/bulk/preview"], /requireAll\(P\.VIEW_EMPLOYEES, P\.EMPLOYEE_EDIT\)/);
  assert.match(byUrl["/employees/bulk/confirm"], /requireAll\(P\.VIEW_EMPLOYEES, P\.EMPLOYEE_EDIT\)/);
  // The export is registered with its permission on the same line.
  assert.match(ROUTE_CODE, /"\/employees\/bulk\/export",\s*\n\s*this\.permissions\.require\(P\.VIEW_EMPLOYEES\)/);
});

test("it introduces NO new permission key: every key used is an established one", () => {
  const used = [...ROUTE_CODE.matchAll(/P\.([A-Z_]+)/g)].map((m) => m[1]);
  assert.ok(used.length > 0);
  for (const key of new Set(used)) {
    assert.ok(P[key], `P.${key} is not a declared HR permission`);
  }
  /*
   * And no key was ADDED for this feature. The repo does have one bulk key
   * already - `bulk_assign_employee_shift` - so the bar is not "never add
   * one"; it is that this feature did not, because `employee_edit` already
   * answers "may this person change an employee's branch, department,
   * designation, classification or joining date" and a second key would be a
   * quieter second answer to the same question. Nothing here is a bypass
   * either: a caller who cannot edit one employee cannot edit eighty.
   */
  for (const key of Object.values(P)) {
    assert.ok(
      !/employee_bulk|bulk_update|bulk_export|bulk_import/.test(key),
      `${key} looks like a bulk-update-specific permission; this feature must reuse employee_edit`
    );
  }
});

test("B3's response filter and write guard are mounted on this router", () => {
  assert.match(ROUTE_CODE, /router\.use\(this\.sensitive\.filterResponse\)/);
  assert.match(ROUTE_CODE, /router\.use\(this\.sensitive\.guardWrite\)/);
});

test("the branch scope is required, not optional", () => {
  assert.throws(
    () => buildRoutes({}, fakePermissions(), fakeSensitive(), null),
    /branch scope is required/
  );
});

test("the export refuses a request naming a branch outside the caller's scope", () => {
  assert.match(ROUTE_CODE, /listFilters\(req, filters\.store_ids\)/);
  assert.match(ROUTE_CODE, /if \(!scoped\.ok\)[\s\S]{0,120}refuse\(res, scoped\)/);
});

test("the export population is read with the SCOPED actor, never permissions.actorFor", () => {
  assert.match(ROUTE_CODE, /this\.branchScope\.actorFor\(req\)/);
  assert.ok(
    !/this\.permissions\.actorFor\(req\)[\s\S]{0,200}buildExport/.test(ROUTE_CODE),
    "buildExport must be given the branch-scoped actor"
  );
});

test("the repository's export query composes the shared, fail-closed accessScope", () => {
  assert.match(REPO_CODE, /require\("\.\/employee_scope"\)/);
  assert.match(REPO_CODE, /accessScope\(actor\)/);
});

test("the active-flag column differs per master and each is spelled correctly", () => {
  assert.match(REPO_CODE, /is_active AS active\s*\n?\s*FROM outlets/);
  assert.match(REPO_CODE, /status AS active\s*\n?\s*FROM department/);
  assert.match(REPO_CODE, /status AS active\s*\n?\s*FROM designation/);
});

/* ================================================= driving the router == */

const fakePermissions = () => ({
  require: () => (req, res, next) => next(),
  requireAll: () => (req, res, next) => next(),
  actorFor: async () => ({ userId: 1, employeeId: 2 }),
});
const fakeSensitive = () => ({
  filterResponse: (req, res, next) => next(),
  guardWrite: (req, res, next) => next(),
});

test("the caller's scope is resolved ONCE per request and applied as a pure predicate", async () => {
  let resolveCalls = 0;
  const branchScope = {
    resolve: async () => {
      resolveCalls += 1;
      return { kind: "OWN_BRANCHES", store_ids: [1] };
    },
    refuse: () => {},
    listFilters: async () => ({ ok: true, store_ids: [1] }),
    actorFor: async () => ({}),
  };
  const routes = buildRoutes({}, fakePermissions(), fakeSensitive(), branchScope);
  const scope = await routes._scope({}, {});

  assert.equal(resolveCalls, 1);
  assert.equal(scope.allBranches, false);
  assert.equal(scope.inScope(1), true);
  assert.equal(scope.inScope(2), false, "a branch outside the scope must be refused");
});

test("a caller with NO resolvable branch is refused, and gets no scope object at all", async () => {
  let refused = null;
  const branchScope = {
    resolve: async () => ({ kind: "NONE", reason: "NO_BRANCH_ASSIGNED", store_ids: [] }),
    refuse: (res, outcome) => {
      refused = outcome;
    },
  };
  const routes = buildRoutes({}, fakePermissions(), fakeSensitive(), branchScope);
  assert.equal(await routes._scope({}, {}), null);
  assert.equal(refused.reason, "NO_BRANCH_ASSIGNED");
});

/* ===================================================== the workbook == */

async function writeAndRead(sheet) {
  const routes = buildRoutes({}, fakePermissions(), fakeSensitive(), { resolve: async () => ({}) });
  const stream = new PassThrough();
  const chunks = [];
  stream.on("data", (c) => chunks.push(c));
  const done = new Promise((resolve) => stream.on("end", resolve));
  await routes.writeWorkbook(stream, sheet);
  await done;

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.concat(chunks));
  return workbook;
}

const SHEET = {
  columns: [
    { key: "employee_id", label: "Employee ID", kind: "identity" },
    { key: "employee_name", label: "Employee Name", kind: "identity" },
    { key: "store_id", label: "Location", kind: "master" },
    { key: "grade", label: "Grade", kind: "choice" },
    { key: "date_of_joining", label: "Date of Joining", kind: "date" },
  ],
  rows: [
    { employee_id: 1865, employee_name: "Kumar", store_id: "ECR", grade: "B", date_of_joining: "01/06/2024" },
    { employee_id: 1900, employee_name: "Latha", store_id: "Muthialpet [DN2]", grade: "", date_of_joining: "" },
  ],
  validation: { store_id: ["ECR", "Muthialpet [DN2]"], grade: ["A", "B", "C", "D", "E"] },
  selected_fields: ["store_id", "grade", "date_of_joining"],
  date_format: "dd/mm/yyyy",
};

test("the workbook has the header, the rows, and the identity columns first", async () => {
  const workbook = await writeAndRead(SHEET);
  const ws = workbook.getWorksheet("Employees");
  assert.deepEqual(ws.getRow(1).values.slice(1), [
    "Employee ID",
    "Employee Name",
    "Location",
    "Grade",
    "Date of Joining",
  ]);
  assert.equal(ws.getCell("A2").value, 1865);
  assert.equal(ws.getCell("C2").value, "ECR");
  assert.equal(ws.rowCount, 3);
});

test("Date of Joining is a REAL date cell formatted dd/mm/yyyy, and a blank stays blank", async () => {
  const workbook = await writeAndRead(SHEET);
  const ws = workbook.getWorksheet("Employees");
  const cell = ws.getCell("E2");
  assert.ok(cell.value instanceof Date, "the joining date must be a date cell, not text");
  assert.equal(cell.value.toISOString().slice(0, 10), "2024-06-01");
  assert.equal(cell.numFmt, "dd/mm/yyyy");
  assert.ok(!ws.getCell("E3").value, "an employee with no joining date exports blank");
});

test("list columns carry data validation that ALLOWS BLANK, because blank means unchanged", async () => {
  const workbook = await writeAndRead(SHEET);
  const ws = workbook.getWorksheet("Employees");
  for (const ref of ["C2", "D2", "C3", "D3"]) {
    const dv = ws.getCell(ref).dataValidation;
    assert.equal(dv.type, "list", `${ref} has no list validation`);
    assert.equal(dv.allowBlank, true, `${ref} must accept a blank cell`);
    assert.match(dv.formulae[0], /^Lists!\$[A-Z]+\$2:\$[A-Z]+\$\d+$/);
  }
  // The identity columns are not dropdowns.
  assert.ok(!ws.getCell("A2").dataValidation);
});

test("the validation lists live on a hidden sheet, so the template reads as one grid", async () => {
  const workbook = await writeAndRead(SHEET);
  const lists = workbook.getWorksheet("Lists");
  assert.ok(lists, "the Lists sheet must exist");
  assert.equal(lists.state, "veryHidden");
  assert.deepEqual(lists.getColumn(1).values.slice(1), ["Location", "ECR", "Muthialpet [DN2]"]);
  assert.deepEqual(lists.getColumn(2).values.slice(1), ["Grade", "A", "B", "C", "D", "E"]);
});
