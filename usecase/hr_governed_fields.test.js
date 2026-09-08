/**
 * Stage 0C / C3 — governed projection fields and the cutover modes.
 *
 *   node --test usecase/hr_governed_fields.test.js
 *
 * The failure this file exists to prevent: legacy callers echo the whole
 * employee record back on every save. If an unchanged echo is read as a
 * change, every existing screen breaks the day history is activated. If a
 * real change is read as an echo, history silently stops being the truth.
 *
 * So the order is VALIDATE -> CANONICALIZE -> COMPARE, and the tests below
 * are mostly about the cases where those three disagree.
 */
const test = require("node:test");
const assert = require("node:assert");

const {
  GOVERNED_FIELDS,
  STATE,
  canonicalize,
  classifyGoverned,
  evaluateOrdinaryEdit,
  withoutGovernedFields,
  projectionOf,
} = require("./hr_governed_fields");

/* ============================================================ the fields */
test("all six projections are governed, and nothing else is", () => {
  assert.deepStrictEqual([...GOVERNED_FIELDS].sort(), [
    "department_id",
    "designation_id",
    "payment_type",
    "salary",
    "shift_id",
    "store_id",
  ]);
});

/* ====================================================== canonicalization */
test("an id compares equal whether it arrives as a number or a string", () => {
  assert.deepStrictEqual(canonicalize("store_id", 12), { ok: true, value: "12" });
  assert.deepStrictEqual(canonicalize("store_id", "12"), { ok: true, value: "12" });
  assert.deepStrictEqual(canonicalize("store_id", " 12 "), { ok: true, value: "12" });
  assert.deepStrictEqual(canonicalize("store_id", "012"), { ok: true, value: "12" });
});

test("NORMALIZATION CANNOT TURN INVALID INPUT INTO A HARMLESS NO-OP", () => {
  // The whole reason validation comes first. A guard that coerced "abc" to
  // NaN and compared NaN to NaN would wave through a bad request.
  for (const bad of ["abc", "12abc", "12.0", "-3", "0", "1e3", {}, []]) {
    const r = canonicalize("store_id", bad);
    assert.strictEqual(r.ok, false, `${JSON.stringify(bad)} must not canonicalize`);
    assert.strictEqual(r.code, "NOT_AN_ID");
  }
});

test("empty representations all mean 'not set'", () => {
  for (const empty of [null, undefined, "", "   "]) {
    assert.deepStrictEqual(canonicalize("shift_id", empty), { ok: true, value: null });
    assert.deepStrictEqual(canonicalize("salary", empty), { ok: true, value: null });
  }
});

test("SALARY COMPARES AT THE PRECISION THE COLUMN STORES", () => {
  // The projection is VARCHAR(45), the history is DECIMAL(12,2). All of these
  // are one value, and float arithmetic has no part in deciding that.
  const expected = { ok: true, value: "20000.00" };
  for (const same of ["20000", 20000, "20000.0", "20000.00", " 20000 ", "20,000"]) {
    assert.deepStrictEqual(canonicalize("salary", same), expected, String(same));
  }
  assert.deepStrictEqual(canonicalize("salary", "20000.50"), { ok: true, value: "20000.50" });
  // A genuinely different figure stays different.
  assert.notDeepStrictEqual(canonicalize("salary", "20001"), expected);
});

test("a salary that is not a number, or too precise for the column, is refused", () => {
  assert.strictEqual(canonicalize("salary", "twenty thousand").ok, false);
  assert.strictEqual(canonicalize("salary", "-500").ok, false);
  assert.strictEqual(canonicalize("salary", "20000.004").code, "SALARY_TOO_PRECISE");
  assert.strictEqual(canonicalize("salary", "99999999999999").code, "SALARY_TOO_LARGE");
  // Trailing zeros beyond the scale are not a loss of precision.
  assert.deepStrictEqual(canonicalize("salary", "20000.000"), { ok: true, value: "20000.00" });
});

test("payment_type is trimmed, not forced into an enum nobody has audited", () => {
  assert.deepStrictEqual(canonicalize("payment_type", " 1 "), { ok: true, value: "1" });
  assert.deepStrictEqual(canonicalize("payment_type", 1), { ok: true, value: "1" });
  assert.deepStrictEqual(canonicalize("payment_type", "Cash"), { ok: true, value: "Cash" });
});

/* ============================================================= classify */
const employee = {
  store_id: 2,
  department_id: 1,
  designation_id: 7,
  shift_id: null,
  salary: "20000",
  payment_type: "1",
};

test("an echo of the stored record changes nothing", () => {
  // What a legacy screen actually sends: everything it was given, unchanged.
  const body = { ...employee, employee_name: "Ramesh Kumar" };
  const r = classifyGoverned(body, employee);
  assert.deepStrictEqual(r.changed, []);
  assert.strictEqual(r.unchanged.length, 6);
});

test("an echo in the OTHER type still changes nothing", () => {
  const body = { store_id: "2", designation_id: "7", salary: "20000.00", payment_type: 1 };
  assert.deepStrictEqual(classifyGoverned(body, employee).changed, []);
});

test("a real change is detected, and only that field", () => {
  const r = classifyGoverned({ ...employee, designation_id: 2 }, employee);
  assert.deepStrictEqual(r.changed, ["designation_id"]);
});

test("setting a field that was empty, or clearing one that was set, is a change", () => {
  assert.deepStrictEqual(classifyGoverned({ shift_id: 3 }, employee).changed, ["shift_id"]);
  assert.deepStrictEqual(classifyGoverned({ salary: "" }, employee).changed, ["salary"]);
  // But an empty echo of an already-empty field is not.
  assert.deepStrictEqual(classifyGoverned({ shift_id: null }, employee).changed, []);
});

test("a field the body does not mention is not considered at all", () => {
  const r = classifyGoverned({ employee_name: "X" }, employee);
  assert.deepStrictEqual(r.present, []);
  assert.deepStrictEqual(r.changed, []);
});

test("unparseable legacy stored data is treated as a change, which is the safe answer", () => {
  const messy = { ...employee, salary: "20,000/- per month" };
  assert.deepStrictEqual(classifyGoverned({ salary: "20000" }, messy).changed, ["salary"]);
});

/* ======================================================== the three modes */
const evaluate = (state, body, current = employee) =>
  evaluateOrdinaryEdit({ state, body, current });

test("PREPARING_BASELINE preserves today's behaviour exactly", () => {
  // Breaking legacy edits before the history is even populated would take the
  // employee master offline for the period HR needs it most.
  const r = evaluate(STATE.PREPARING_BASELINE, { ...employee, store_id: 5 });
  assert.strictEqual(r.action, "allow");
});

test("BASELINE_VALIDATED allows the change but records it", () => {
  // Shadow mode exists so the remaining legacy callers can be found and fixed
  // BEFORE enforcement, not discovered as errors an hour after activation.
  const r = evaluate(STATE.BASELINE_VALIDATED, { ...employee, salary: "25000" });
  assert.strictEqual(r.action, "shadow");
  assert.deepStrictEqual(r.fields, ["salary"]);
});

test("HISTORY_ACTIVE REJECTS A CHANGED GOVERNED FIELD, and says what to use", () => {
  const r = evaluate(STATE.HISTORY_ACTIVE, { ...employee, store_id: 5 });
  assert.strictEqual(r.action, "reject");
  assert.strictEqual(r.code, "GOVERNED_FIELD_IS_HISTORY_OWNED");
  assert.strictEqual(r.httpCode, 409);
  assert.match(r.msg, /Change Assignment/);
  assert.deepStrictEqual(r.fields, ["store_id"]);
});

test("HISTORY_ACTIVE still accepts an unchanged echo, in every state", () => {
  // This is what keeps every legacy screen working after activation.
  for (const state of Object.values(STATE)) {
    assert.strictEqual(evaluate(state, { ...employee }).action, "allow", state);
    assert.strictEqual(
      evaluate(state, { store_id: "2", salary: "20000.00" }).action,
      "allow",
      `${state} with type-shifted echo`
    );
  }
});

test("the rejection names every owning action, not just the first", () => {
  const r = evaluate(STATE.HISTORY_ACTIVE, { store_id: 5, shift_id: 3, salary: "25000" });
  assert.strictEqual(r.action, "reject");
  for (const action of ["Change Assignment", "Change Default Shift", "Revise Salary"]) {
    assert.match(r.msg, new RegExp(action));
  }
});

test("INVALID INPUT IS REJECTED IN EVERY STATE, including PREPARING", () => {
  // Not a cutover rule - ordinary validation. Relaxing it during preparation
  // would let bad data into the very rows the baseline is about to freeze.
  for (const state of Object.values(STATE)) {
    const r = evaluate(state, { store_id: "not-an-id" });
    assert.strictEqual(r.action, "reject", state);
    assert.strictEqual(r.code, "INVALID_GOVERNED_VALUE");
    assert.strictEqual(r.httpCode, 422);
  }
});

test("a changed field is never silently dropped - the caller is told", () => {
  const r = evaluate(STATE.HISTORY_ACTIVE, { salary: "25000" });
  assert.strictEqual(r.action, "reject");
  assert.ok(r.msg.length > 20, "the refusal explains itself");
});

/* =================================================== mass assignment ==== */
test("MASS ASSIGNMENT CANNOT CARRY A GOVERNED FIELD THROUGH", () => {
  // The real risk: a legacy path doing `employee.update(req.body)` names no
  // governed field anywhere near the code, so no reviewer or grep finds it -
  // but req.body still carries salary, and the update still writes it.
  const body = {
    employee_name: "Ramesh",
    primary_contact_number: "9999999999",
    store_id: 5,
    salary: "999999",
    payment_type: "2",
    shift_id: 3,
    department_id: 4,
    designation_id: 9,
  };
  const clean = withoutGovernedFields(body);
  assert.deepStrictEqual(Object.keys(clean).sort(), ["employee_name", "primary_contact_number"]);
  for (const governed of GOVERNED_FIELDS) {
    assert.ok(!(governed in clean), `${governed} must not reach a generic update`);
  }
});

test("stripping governed fields leaves an ordinary body untouched", () => {
  const body = { employee_name: "A", dob: "1990-01-01" };
  assert.deepStrictEqual(withoutGovernedFields(body), body);
  assert.deepStrictEqual(withoutGovernedFields({}), {});
  assert.deepStrictEqual(withoutGovernedFields(null), {});
});

/* ======================================================== the projection */
test("the projection is canonical, so it can be compared and fingerprinted", () => {
  assert.deepStrictEqual(projectionOf(employee), {
    store_id: "2",
    department_id: "1",
    designation_id: "7",
    shift_id: null,
    salary: "20000.00",
    payment_type: "1",
  });
});

test("two records that differ only in representation project identically", () => {
  const a = projectionOf({ store_id: 2, salary: "20000" });
  const b = projectionOf({ store_id: "2", salary: 20000.0 });
  assert.deepStrictEqual(a, b);
});
