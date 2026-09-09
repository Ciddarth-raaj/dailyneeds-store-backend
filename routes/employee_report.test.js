/**
 * Reports — the HTTP surface.
 *
 *   node --test routes/employee_report.test.js
 *
 * Two kinds of test here.
 *
 * The first exercises `csvCell` directly, because it is the function standing
 * between an employee's name and a formula executing on the machine of
 * whoever opens the spreadsheet.
 *
 * The second reads the route file as text. That is unusual, and it is
 * deliberate: several of the guarantees this feature makes are about what is
 * ABSENT - no caller-supplied SQL, no row logged, no permission missing from a
 * route - and an absence is not something an HTTP call can demonstrate. A
 * request test proves one path behaves; these prove no path was added that
 * does not.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const routes = require("./employee_report");
const { csvCell, EmployeeReportRoutes } = routes;

const SRC = fs.readFileSync(path.join(__dirname, "employee_report.js"), "utf8");
/** The file with comments stripped, so prose about SQL is not read as SQL. */
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/* ============================================== CSV cell safety ========= */

test("RFC 4180: separators and newlines cannot break the grid", () => {
  assert.strictEqual(csvCell("plain"), "plain");
  assert.strictEqual(csvCell("12, Main Road"), '"12, Main Road"');
  assert.strictEqual(csvCell("line1\nline2"), '"line1\nline2"');
  assert.strictEqual(csvCell('He said "hi"'), '"He said ""hi"""');
  assert.strictEqual(csvCell(null), "");
  assert.strictEqual(csvCell(undefined), "");
  assert.strictEqual(csvCell(0), "0");
});

test("A CELL THAT WOULD EXECUTE IS NEUTRALISED", () => {
  // Excel runs a cell beginning with any of these when the file is opened. An
  // employee name stored as a formula would then run on the machine of
  // whoever opens the export.
  for (const dangerous of [
    "=HYPERLINK(\"http://x\")",
    "+1+1",
    "-1+1",
    "@SUM(A1)",
    "=cmd|'/c calc'!A1",
  ]) {
    const cell = csvCell(dangerous);
    assert.ok(
      cell.startsWith("'") || cell.startsWith("\"'"),
      `${dangerous} was not neutralised: ${cell}`
    );
  }
});

test("neutralising does not corrupt an ordinary value", () => {
  // The guard must not fire on things that merely contain these characters.
  assert.strictEqual(csvCell("A-1"), "A-1");
  assert.strictEqual(csvCell("name@example.com"), "name@example.com");
  assert.strictEqual(csvCell("Kumar S"), "Kumar S");
});

/* ====================================== no caller string becomes SQL ==== */

test("NO REQUEST SCHEMA ACCEPTS SQL STRUCTURE", () => {
  // The list from the spec, one assertion each so a failure names the term.
  for (const forbidden of [
    "order_by",
    "orderBy",
    "sort_expression",
    "sql",
    "raw_sql",
    "where",
    "having",
    "select_expression",
    "table_name",
    "column_name",
    "join",
    "operator",
  ]) {
    assert.ok(
      !new RegExp(`\\b${forbidden}\\s*:`, "i").test(CODE),
      `the request schema must not accept '${forbidden}'`
    );
  }
});

test("the route file builds no SQL of its own", () => {
  // The one query lives in usecase/employee_report.js. A SELECT appearing
  // here would be a second query path, and the second one always drifts.
  assert.ok(!/\bSELECT\b/i.test(CODE), "no SELECT in the route layer");
  assert.ok(!/\bFROM\s+new_employee\b/i.test(CODE));
  assert.ok(!/\bWHERE\b/i.test(CODE));
});

test("Joi runs without allowUnknown, so an invented field is refused", () => {
  assert.ok(!/allowUnknown/.test(CODE));
});

/* ============================================== permissions on routes === */

test("EVERY ROUTE CARRIES A PERMISSION GUARD", () => {
  // `router.get("/x", <guard>, handler)` - the middle argument must be one of
  // the two guards, never absent.
  const declarations = CODE.match(/router\.(get|post|put|delete)\([^)]*/g) || [];
  assert.ok(declarations.length >= 8, `expected the full route set, found ${declarations.length}`);

  for (const decl of declarations) {
    assert.match(
      decl,
      /,\s*(canView|canExport)\s*,/,
      `unguarded route: ${decl.slice(0, 80)}`
    );
  }
});

test("THE EXPORT ROUTES USE THE EXPORT PERMISSION, AND ONLY THEY DO", () => {
  const exportRoutes = (CODE.match(/router\.post\("\/export\/[a-z]+",[^,]+,/g) || []);
  assert.strictEqual(exportRoutes.length, 2, "xlsx and csv");
  for (const decl of exportRoutes) {
    assert.match(decl, /canExport/);
  }
  // And nothing else is behind canExport, so preview cannot become an export.
  const canExportUses = (CODE.match(/canExport/g) || []).length;
  assert.strictEqual(canExportUses, 3, "the definition plus the two export routes");
});

test("the guards are the declared permission constants, not typed strings", () => {
  assert.match(CODE, /needs\(P\.VIEW_REPORTS\)/);
  assert.match(CODE, /needs\(P\.EXPORT_REPORTS\)/);
  // A typo in a string literal is a silently open route; a typo in a constant
  // is a crash on boot.
  assert.ok(!/needs\("/.test(CODE), "no route guard names a permission as a literal");
});

/* ================================================== nothing logs a row == */

test("NO EXPORTED VALUE IS EVER LOGGED", () => {
  // Only one console call, and it takes the error rather than the payload.
  const logs = CODE.match(/console\.\w+\([^)]*\)/g) || [];
  assert.deepStrictEqual(logs, ["console.log(err)"]);

  for (const forbidden of [/console\.\w+\([^)]*\brow\b/, /console\.\w+\([^)]*prepared/, /console\.\w+\([^)]*body/]) {
    assert.ok(!forbidden.test(CODE), `a log statement carries report data: ${forbidden}`);
  }
});

/* ================================================== streaming discipline */

test("A FAILURE MID-STREAM DESTROYS THE RESPONSE RATHER THAN COMPLETING IT", () => {
  // A truncated file that downloads cleanly is worse than a broken download,
  // because somebody opens it and believes it.
  assert.match(CODE, /if \(res\.headersSent\)[\s\S]{0,120}res\.destroy\(\)/);
});

test("every refusal is decided before a byte is written", () => {
  // `_prepare` - which runs the permission check, the widened-filter gate and
  // the row cap - is called before `_sendHeaders` in both exports.
  for (const method of ["exportXlsx", "exportCsv"]) {
    const body = CODE.slice(CODE.indexOf(`async ${method}(`));
    const prepareAt = body.indexOf("this._prepare(");
    const headersAt = body.indexOf("this._sendHeaders(");
    assert.ok(prepareAt > -1 && headersAt > -1, method);
    assert.ok(prepareAt < headersAt, `${method}: headers are sent before the gates run`);
  }
});

test("an export is audited AFTER the rows are written, with the written count", () => {
  // Auditing an export that then failed would record one that never happened.
  for (const method of ["exportXlsx", "exportCsv"]) {
    const body = CODE.slice(CODE.indexOf(`async ${method}(`));
    assert.match(
      body.slice(0, body.indexOf("} catch")),
      /recordExport\(\{ \.\.\.prepared, row_count: written \}/,
      method
    );
  }
});

test("the response is not cacheable", () => {
  // A report is a point-in-time answer about people, and must not sit in an
  // intermediary or a browser cache.
  assert.match(CODE, /Cache-Control["']?,\s*["']no-store/);
});

/* ================================================== the router shape ==== */

test("the module exposes a router per instance", () => {
  const permissions = {
    require: () => (req, res, next) => next(),
    actorFor: async () => ({ userId: 1, isAdmin: true, permissions: [] }),
  };
  const a = routes({}, permissions);
  const b = routes({}, permissions);

  assert.ok(a instanceof EmployeeReportRoutes);
  assert.notStrictEqual(a.getRouter(), b.getRouter(), "two instances must not share one router");
  assert.strictEqual(typeof a.getRouter(), "function", "an express router is a function");
});

test("the server mounts it, once, under /reports", () => {
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const mounts = server.match(/app\.use\("\/reports\/employee-master"/g) || [];
  assert.strictEqual(mounts.length, 1);
  assert.match(server, /require\("\.\/routes\/employee_report"\)/);
  assert.match(server, /require\("\.\/usecase\/employee_report_service"\)/);
  assert.match(server, /require\("\.\/repository\/report_template"\)/);
});

test("the reports routes are NOT in the unauthenticated map", () => {
  const auth = fs.readFileSync(path.join(__dirname, "..", "middlewares", "auth.js"), "utf8");
  assert.ok(!/\/reports/.test(auth), "a report route must never skip authentication");
});
