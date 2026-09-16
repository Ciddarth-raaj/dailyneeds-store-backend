/**
 * EMPLOYMENT TYPE AND GRADE on the Employee Master — create, edit, read, the
 * existing employees who have neither, and the values that cannot be stored.
 *
 *   node --test usecase/employee_employment_type_grade.test.js
 *
 * These are CLASSIFICATION fields. Half of this file pins what they do NOT
 * do: they are not a payroll input, not an attendance input, not a permission
 * and not a branch rule, and recording one must leave every other column on
 * the row exactly as it was.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const build = require("./employee_master");
const { EDITABLE_FIELDS, LIFECYCLE_CONTROLLED_FIELDS } = require("../repository/employee_master");
const { EMPLOYEE_MASTER_COLUMNS } = require("../repository/employee");
const {
  EMPLOYMENT_TYPES,
  GRADES,
  normaliseClassificationFields,
} = require("../utils/employment_classification");

/* ------------------------------------------------------------- the fakes */

function fakeRepo(store = {}) {
  store.row = store.row || {
    employee_id: 901,
    employee_name: "A",
    status: 1,
    resignation_date: null,
    date_of_joining: "2020-01-01",
    store_id: 1,
    designation_id: 1,
    department_id: 1,
    salary: "26000",
    employment_type: null,
    grade: null,
  };
  return {
    withTransaction: async (fn) => fn({ query: async () => [] }),
    createEmployee: async (tx, fields) => {
      store.inserted = fields;
      return 901;
    },
    updateEmployee: async (tx, id, patch) => {
      store.patched = { id, patch };
      Object.assign(store.row, patch);
      return Object.keys(patch).length;
    },
    lockEmployee: async () => store.row,
    appendShiftAssignment: async () => 1,
    bumpTokenValidFrom: async () => {
      store.tokensBumped = true;
    },
  };
}

const usecaseWith = (store) =>
  build(
    fakeRepo(store),
    { reconcileEmployee: async () => ({ action: "open_initial" }) },
    { getLatestPeriod: async () => [], recordEvent: async () => {}, insertEvent: async () => {} },
    null,
    { getActiveWorkShift: async (id) => ({ work_shift_id: id, active: 1 }) }
  );

/** A create that satisfies the Personal Details rules. */
const base = {
  employee_name: "A",
  date_of_joining: "2026-01-05",
  store_id: 1,
  designation_id: 1,
  department_id: 1,
  father_name: "B",
  dob: "1992-07-19",
  gender: "M",
  marital_status: "Single",
  primary_contact_number: "9876543210",
  alternate_contact_number: "9876500000",
  permanent_address: "1 Street",
  residential_address: "1 Street",
};

/* ------------------------------------------------------------- the lists */

test("the two sets are exactly what the business named, and nothing else", () => {
  assert.deepEqual(EMPLOYMENT_TYPES, ["Permanent", "Contract"]);
  assert.deepEqual(GRADES, ["A", "B", "C", "D", "E"]);
});

test("the migration's ENUMs carry the same members as the code", () => {
  const sql = fs.readFileSync(
    path.join(
      __dirname,
      "../migrations/mysql/migrations/sqls/20261017120000-employee-employment-type-and-grade-up.sql"
    ),
    "utf8"
  );
  assert.match(sql, /`employment_type`\s+ENUM\('Permanent','Contract'\)\s+NULL/);
  assert.match(sql, /`grade`\s+ENUM\('A','B','C','D','E'\)\s+NULL/);
  // BACKWARD COMPATIBILITY IS IN THE SCHEMA, not in a convention: nothing is
  // NOT NULL, nothing has a default, and nothing backfills an existing row.
  assert.ok(!/NOT NULL/.test(sql), "a NOT NULL column would invalidate every existing employee");
  assert.ok(!/UPDATE\s+`?new_employee`?/i.test(sql), "existing employees are not given a value");
});

/* ----------------------------------------------------------------- create */

test("create stores both values", async () => {
  const store = {};
  await usecaseWith(store).createEmployee({ ...base, employment_type: "Contract", grade: "C" });
  assert.equal(store.inserted.employment_type, "Contract");
  assert.equal(store.inserted.grade, "C");
});

test("create without them is a valid create and records neither", async () => {
  const store = {};
  const created = await usecaseWith(store).createEmployee({ ...base });
  assert.equal(created.code, 200);
  assert.ok(!("employment_type" in store.inserted));
  assert.ok(!("grade" in store.inserted));
});

test("a blank dropdown is 'not recorded', never an empty string in an ENUM", async () => {
  const store = {};
  await usecaseWith(store).createEmployee({ ...base, employment_type: "", grade: null });
  assert.equal(store.inserted.employment_type, null);
  assert.equal(store.inserted.grade, null);
});

test("an unsupported value is refused BEFORE anything is written", async () => {
  for (const bad of [
    { employment_type: "Temporary" },
    { employment_type: "permanent" },
    { employment_type: 1 },
    { grade: "F" },
    { grade: "a" },
    { grade: 3 },
  ]) {
    const store = {};
    await assert.rejects(
      usecaseWith(store).createEmployee({ ...base, ...bad }),
      /must be one of/,
      `${JSON.stringify(bad)} must be refused`
    );
    assert.equal(store.inserted, undefined, "nothing reached the insert");
  }
});

/* ------------------------------------------------------------------- edit */

test("edit changes both fields through the ordinary employee_edit path", async () => {
  const store = {};
  const res = await usecaseWith(store).editEmployee(901, {
    employment_type: "Permanent",
    grade: "B",
  });
  assert.equal(res.code, 200);
  assert.deepEqual(store.patched.patch, { employment_type: "Permanent", grade: "B" });
});

test("edit can clear them back to not recorded", async () => {
  const store = {};
  store.row = undefined;
  const uc = usecaseWith(store);
  await uc.editEmployee(901, { employment_type: "Permanent", grade: "B" });
  await uc.editEmployee(901, { employment_type: "", grade: "" });
  assert.deepEqual(store.patched.patch, { employment_type: null, grade: null });
});

test("edit refuses an unsupported value and writes nothing", async () => {
  const store = {};
  await assert.rejects(
    usecaseWith(store).editEmployee(901, { employment_type: "Intern" }),
    /must be one of/
  );
  await assert.rejects(usecaseWith(store).editEmployee(901, { grade: "Z" }), /must be one of/);
  assert.equal(store.patched, undefined);
});

test("recording a classification touches nothing else on the row", async () => {
  const store = {};
  await usecaseWith(store).editEmployee(901, { grade: "D" });
  assert.equal(store.row.status, 1, "not a lifecycle change");
  assert.equal(store.row.resignation_date, null);
  assert.equal(store.row.salary, "26000", "not a payroll input");
  assert.equal(store.row.store_id, 1, "not a transfer");
  assert.equal(store.row.designation_id, 1);
});

/* ------------------------------------------------- permissions and scope */

test("neither field is security-relevant, so no session is revoked", async () => {
  const store = {};
  const res = await usecaseWith(store).editEmployee(901, {
    employment_type: "Contract",
    grade: "E",
  });
  assert.deepEqual(res.security_relevant, []);
  assert.equal(res.sessions_revoked, false);
  assert.ok(!store.tokensBumped, "only branch and designation re-issue authorisation");
});

test("they ride the EXISTING employee_edit key and branch scope - no new permission", () => {
  for (const field of ["employment_type", "grade"]) {
    assert.ok(EDITABLE_FIELDS.includes(field), `${field} is an ordinary editable column`);
    assert.ok(!LIFECYCLE_CONTROLLED_FIELDS.includes(field));
  }
  const route = fs.readFileSync(path.join(__dirname, "../routes/employee_master.js"), "utf8");
  // The edit route derives its schema from EDITABLE_FIELDS and is guarded by
  // `EMPLOYEE_EDIT` plus `requireEmployeeInScope()`. Adding a column must not
  // have added a second door with rules of its own.
  assert.ok(
    !/employment_type|grade/.test(route.split("/* ------------------------------------------------------------ create */")[0]),
    "no classification-specific route or guard was introduced"
  );
  assert.equal(
    (route.match(/employment_type/g) || []).length,
    1,
    "employment_type appears once - in the create schema, beside every other column"
  );
});

/* ------------------------------------------------------------------- read */

test("both columns are returned by the employee detail read", () => {
  assert.ok(EMPLOYEE_MASTER_COLUMNS.includes("new_employee.employment_type"));
  assert.ok(EMPLOYEE_MASTER_COLUMNS.includes("new_employee.grade"));
});

test("an existing employee with neither reads back as null, not as a default", () => {
  const legacy = { employee_id: 12, employment_type: null, grade: null };
  const unchanged = normaliseClassificationFields(legacy);
  assert.equal(unchanged.employment_type, null);
  assert.equal(unchanged.grade, null);
  // A body that does not MENTION a field must leave it alone entirely, which
  // is what keeps a Personal Details save from rewriting a classification.
  assert.deepEqual(normaliseClassificationFields({ employee_name: "X" }), { employee_name: "X" });
});

/* ------------------------------------------ nothing else reads these two */

test("no business rule anywhere branches on employment type or grade", () => {
  const roots = ["usecase", "repository", "services", "middlewares", "utils", "drivers"];
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".js") && !entry.name.endsWith(".test.js")) {
        const text = fs.readFileSync(full, "utf8");
        // A comparison against a classification value is what a business rule
        // looks like. Listing the column, or normalising it, is not.
        if (/(employment_type|\bgrade\b)\s*(===|==|!==|!=)/.test(text)) offenders.push(full);
      }
    }
  };
  for (const r of roots) {
    const dir = path.join(__dirname, "..", r);
    if (fs.existsSync(dir)) walk(dir);
  }
  assert.deepEqual(offenders, [], "these fields classify; they must not decide anything");
});
