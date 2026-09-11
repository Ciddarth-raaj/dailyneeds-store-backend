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
