/**
 * M1 - the section keys a sensitive write demands.
 *
 *   node --test constants/employee_master_sections.test.js
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const P = require("./hr_permissions");
const { SENSITIVE_EMPLOYEE_FIELDS } = require("./sensitive_fields");
const {
  PAYMENT_DETAIL_FIELDS,
  STATUTORY_DETAIL_FIELDS,
  PAYMENT_TYPE,
  sectionKeysRequired,
  isSectionOnlyWrite,
} = require("./employee_master_sections");

test("the two keys are declared in the catalogue", () => {
  assert.equal(P.EDIT_PAYMENT_DETAILS, "edit_payment_details");
  assert.equal(P.EDIT_STATUTORY_DETAILS, "edit_statutory_details");
});

test("every section column is ALSO a B3 sensitive column - the section keys narrow, never replace", () => {
  for (const f of [...PAYMENT_DETAIL_FIELDS, ...STATUTORY_DETAIL_FIELDS]) {
    assert.ok(SENSITIVE_EMPLOYEE_FIELDS.includes(f), `${f} must stay sensitive`);
  }
});

test("the two sections do not overlap", () => {
  for (const f of PAYMENT_DETAIL_FIELDS) assert.ok(!STATUTORY_DETAIL_FIELDS.includes(f));
});

test("a payment body demands edit_payment_details; a statutory body edit_statutory_details; both, both", () => {
  assert.deepEqual(sectionKeysRequired({ payment_type: 2 }), [P.EDIT_PAYMENT_DETAILS]);
  assert.deepEqual(sectionKeysRequired({ account_no: "1", ifsc: "X", bank_name: "B" }), [P.EDIT_PAYMENT_DETAILS]);
  assert.deepEqual(sectionKeysRequired({ pan_no: "A" }), [P.EDIT_STATUTORY_DETAILS]);
  assert.deepEqual(sectionKeysRequired({ pf_applicable: 1, esi_number: "" }), [P.EDIT_STATUTORY_DETAILS]);
  assert.deepEqual(sectionKeysRequired({ UAN: "1", account_no: "2" }).sort(), [
    P.EDIT_PAYMENT_DETAILS,
    P.EDIT_STATUTORY_DETAILS,
  ]);
});

test("the route's capitalised UAN is recognised", () => {
  assert.deepEqual(sectionKeysRequired({ UAN: "100" }), [P.EDIT_STATUTORY_DETAILS]);
});

test("an ordinary field demands no section key, and a missing body none", () => {
  assert.deepEqual(sectionKeysRequired({ employee_name: "x", qualification: "y" }), []);
  assert.deepEqual(sectionKeysRequired(undefined), []);
  assert.deepEqual(sectionKeysRequired(null), []);
});

test("payment type values are the ones the legacy screens always stored", () => {
  assert.deepEqual(PAYMENT_TYPE, { BANK: 1, CASH: 2 });
});

test("the updatedata route applies the guard after validation and refuses as a whole", () => {
  const fs = require("fs");
  const src = fs.readFileSync(require.resolve("../routes/employee"), "utf8");
  const route = src.slice(src.indexOf('router.post("/updatedata"'), src.indexOf('router.post("/sync"'));
  const guardAt = route.indexOf("sectionKeysRequired(employee.employee_details)");
  const validateAt = route.indexOf("Joi.validate(employee, schema)");
  const writeAt = route.indexOf("updateEmployeeDetails(employee)");
  assert.ok(validateAt < guardAt && guardAt < writeAt, "validate, then guard, then write");
  assert.match(route, /permissions\.hasAll\(req, \.\.\.sectionKeys\)/, "AND, not OR");
  assert.match(route, /status\(403\)/);
});

/* ------------------------------------------------------ M1 review fix (2) */

test("a body of ONLY section columns is a section-only write", () => {
  assert.equal(isSectionOnlyWrite({ payment_type: 1, account_no: "1" }), true);
  assert.equal(isSectionOnlyWrite({ pan_no: "A", pf_applicable: 0 }), true);
  // Both sections at once is still only sections.
  assert.equal(isSectionOnlyWrite({ account_no: "1", esi_number: "E" }), true);
  // The route spells UAN in capitals; the decision is case-insensitive.
  assert.equal(isSectionOnlyWrite({ UAN: "100" }), true);
});

test("ONE ordinary column is enough to make it an ordinary write", () => {
  // This is what keeps the legacy route compatible, and what stops a name
  // change being smuggled through a Payment Details save.
  assert.equal(isSectionOnlyWrite({ payment_type: 1, employee_name: "x" }), false);
  assert.equal(isSectionOnlyWrite({ pan_no: "A", qualification: "y" }), false);
  assert.equal(isSectionOnlyWrite({ account_no: "1", docupdate: [] }), false);
  assert.equal(isSectionOnlyWrite({ account_no: "1", files: [] }), false);
});

test("anything unrecognised is NOT a section-only write, so add_employees stays required", () => {
  // The failure mode of an odd body must be "still gated", never "waved
  // through": these all fall back to the requirement the route always had.
  for (const value of [undefined, null, {}, [], "", 0, "payment_type", [{ payment_type: 1 }]]) {
    assert.equal(isSectionOnlyWrite(value), false, `${JSON.stringify(value)} is not section-only`);
  }
});

test("section-only never decides that a write is ALLOWED, only whether add_employees is also needed", () => {
  // Every field it accepts still demands its own section key, and every one
  // of them is sensitive under B3 - so nothing it returns true for is
  // reachable without `edit_employee_sensitive` plus the section key.
  for (const field of [...PAYMENT_DETAIL_FIELDS, ...STATUTORY_DETAIL_FIELDS]) {
    const body = { [field]: "x" };
    assert.equal(isSectionOnlyWrite(body), true, `${field} is a section column`);
    assert.equal(sectionKeysRequired(body).length, 1, `${field} still demands its section key`);
    assert.ok(SENSITIVE_EMPLOYEE_FIELDS.includes(field), `${field} is still sensitive`);
  }
});

test("the route demands add_employees for everything that is not a section-only write", () => {
  const fs = require("fs");
  const src = fs.readFileSync(require.resolve("../routes/employee"), "utf8");
  const guard = src.slice(src.indexOf("updateDataGuard()"), src.indexOf("getRouter()"));
  assert.match(guard, /isSectionOnlyWrite\(details\)/, "the body decides");
  assert.match(guard, /permissions\.require\(P\.ADD_EMPLOYEES\)/, "otherwise the old gate applies");
  // The route mounts the dynamic guard, not the flat one it used to.
  const route = src.slice(src.indexOf('router.post("/updatedata"'), src.indexOf('router.post("/sync"'));
  assert.match(route, /this\.updateDataGuard\(\)/);
});

test("salary is not a section column, so it cannot reach the route through one", () => {
  assert.ok(!PAYMENT_DETAIL_FIELDS.includes("salary"));
  assert.ok(!STATUTORY_DETAIL_FIELDS.includes("salary"));
  assert.equal(isSectionOnlyWrite({ salary: 1 }), false);
});
