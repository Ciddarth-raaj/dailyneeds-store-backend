const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const build = require("./employee_bulk_update");
const { OUTCOME } = build;

/* ------------------------------------------------------------- the fakes -- */

const MASTERS = {
  // No `code` on any of them: `department_code` and `designation_code` are
  // nullable and nothing writes them since the Digisme sync was removed, so
  // the fakes must not grant the feature a column production will not have.
  outlet: [
    { id: 1, name: "ECR", active: 1 },
    { id: 2, name: "Muthialpet", active: 1 },
    { id: 3, name: "Muthialpet", active: 1 },
    { id: 4, name: "Old Branch", active: 0 },
  ],
  department: [
    { id: 10, name: "Operations", active: 1 },
    { id: 11, name: "Retired Dept", active: 0 },
  ],
  designation: [
    { id: 20, name: "Cashier", active: 1 },
    { id: 21, name: "Store Manager", active: 1 },
    { id: 22, name: "Abolished Role", active: 0 },
  ],
};

const EMPLOYEES = [
  {
    employee_id: 1865,
    employee_name: "Kumar",
    store_id: 1,
    department_id: 10,
    designation_id: 20,
    employment_type: "Permanent",
    grade: "B",
    status: 1,
    date_of_joining: "2024-06-01",
  },
  {
    employee_id: 1900,
    employee_name: "Latha",
    store_id: 2,
    department_id: 10,
    designation_id: 21,
    employment_type: null,
    grade: null,
    status: 1,
    date_of_joining: null,
  },
  {
    employee_id: 2000,
    employee_name: "Vikram",
    store_id: 3,
    department_id: 10,
    designation_id: 20,
    employment_type: "Contract",
    grade: "E",
    status: 0,
    date_of_joining: "2020-01-15",
  },
];

function fakeRepo(overrides = {}) {
  const calls = { exportFilters: [], audits: [] };
  return {
    calls,
    getMasters: async () => JSON.parse(JSON.stringify(MASTERS)),
    getEmployeesForExport: async (actor, filters) => {
      calls.exportFilters.push({ actor, filters });
      return (overrides.exportRows || EMPLOYEES).map((e) => ({ ...e }));
    },
    getCurrentValues: async (ids) =>
      EMPLOYEES.filter((e) => ids.includes(e.employee_id)).map((e) => ({ ...e })),
    recordBulkUpdate: async (entry) => {
      calls.audits.push(entry);
      return 1;
    },
    ...overrides.repo,
  };
}

/** A stand-in for the C2 employee master that records what it was asked to do. */
function fakeMaster(behaviour = {}) {
  const calls = { edit: [], joiningDate: [] };
  return {
    calls,
    editEmployee: async (id, patch, opts) => {
      calls.edit.push({ id, patch, opts });
      if (behaviour.editThrows) throw behaviour.editThrows;
      // The real usecase revokes sessions when a SECURITY_RELEVANT_FIELD moves.
      const securityRelevant = ["store_id", "designation_id"].filter((k) => k in patch);
      return {
        code: 200,
        employee_id: id,
        fields_changed: Object.keys(patch),
        security_relevant: securityRelevant,
        sessions_revoked: securityRelevant.length > 0,
      };
    },
    correctJoiningDate: async (id, input, opts) => {
      calls.joiningDate.push({ id, input, opts });
      if (behaviour.joiningThrows) throw behaviour.joiningThrows;
      return { code: 200, employee_id: id, period_no: 1, joined_on: input.date_of_joining };
    },
  };
}

const ALL_BRANCHES = { allBranches: true, inScope: () => true };
const ONLY_ECR = { allBranches: false, inScope: (storeId) => Number(storeId) === 1 };
const ACTOR = { userId: 7, employeeId: 99 };

const HEADERS = [
  "Employee ID",
  "Employee Name",
  "Location",
  "Department",
  "Designation",
  "Employment Type",
  "Grade",
  "Date of Joining",
];

const row = (over = {}) => ({
  "Employee ID": "",
  "Employee Name": "",
  Location: "",
  Department: "",
  Designation: "",
  "Employment Type": "",
  Grade: "",
  "Date of Joining": "",
  ...over,
});

const make = (repoOverrides, masterBehaviour) => {
  const repo = fakeRepo(repoOverrides);
  const master = fakeMaster(masterBehaviour);
  return { repo, master, usecase: build(repo, master) };
};

/** The confirm envelope a browser builds from a preview it displayed. */
const echo = (preview) =>
  preview.rows.map((r) => ({ row_number: r.row_number, expected_before: r.expected_before }));

/* ================================================================ export == */

describe("bulk export", () => {
  it("passes the caller's scoped actor and filters straight to the scoped query", async () => {
    const { repo, usecase } = make();
    const actor = { branch_scope: { kind: "OWN_BRANCHES", store_ids: [1] } };
    await usecase.buildExport(["store_id"], { status: 1, store_ids: [1] }, actor);

    assert.equal(repo.calls.exportFilters.length, 1);
    assert.equal(repo.calls.exportFilters[0].actor, actor);
    assert.deepEqual(repo.calls.exportFilters[0].filters, { status: 1, store_ids: [1] });
  });

  it("always carries Employee ID and Employee Name, and only the selected update columns", async () => {
    const { usecase } = make();
    const sheet = await usecase.buildExport(["grade", "store_id"], {}, {});
    assert.deepEqual(sheet.columns.map((c) => c.label), [
      "Employee ID",
      "Employee Name",
      "Location",
      "Grade",
    ]);
    assert.deepEqual(Object.keys(sheet.rows[0]).sort(), [
      "employee_id",
      "employee_name",
      "grade",
      "store_id",
    ]);
  });

  it("exports human-readable values, never internal ids", async () => {
    const { usecase } = make();
    const sheet = await usecase.buildExport(
      ["store_id", "department_id", "designation_id", "date_of_joining"],
      {},
      {}
    );
    const kumar = sheet.rows.find((r) => r.employee_id === 1865);
    assert.equal(kumar.store_id, "ECR [1]");
    assert.equal(kumar.department_id, "Operations [10]");
    assert.equal(kumar.designation_id, "Cashier [20]");
    assert.equal(kumar.date_of_joining, "01/06/2024");

    // A duplicated master name is disambiguated by the primary key, which
    // every master row has - unlike the nullable code columns.
    const vikram = sheet.rows.find((r) => r.employee_id === 2000);
    assert.equal(vikram.store_id, "Muthialpet [3]");
  });

  it("offers ACTIVE master rows only as the sheet's dropdown values", async () => {
    const { usecase } = make();
    const sheet = await usecase.buildExport(["store_id", "designation_id", "grade"], {}, {});
    assert.deepEqual(sheet.validation.store_id, ["ECR [1]", "Muthialpet [2]", "Muthialpet [3]"]);
    assert.deepEqual(sheet.validation.designation_id, ["Cashier [20]", "Store Manager [21]"]);
    assert.deepEqual(sheet.validation.grade, ["A", "B", "C", "D", "E"]);
  });

  it("refuses an export field that is not in the catalogue", async () => {
    const { usecase } = make();
    await assert.rejects(() => usecase.buildExport(["salary"], {}, {}), /not an exportable field/);
  });
});

/* =============================================================== preview == */

describe("bulk preview: file structure", () => {
  it("refuses a file carrying a column this feature does not own", async () => {
    const { usecase } = make();
    await assert.rejects(
      () =>
        usecase.preview(
          { headers: [...HEADERS, "Salary"], rows: [row({ "Employee ID": "1865" })] },
          ALL_BRANCHES,
          ACTOR
        ),
      /does not handle: Salary/
    );
  });

  it("refuses a file with no Employee ID column", async () => {
    const { usecase } = make();
    await assert.rejects(
      () => usecase.preview({ headers: ["Employee Name", "Grade"], rows: [row()] }, ALL_BRANCHES, ACTOR),
      /no 'Employee ID' column/
    );
  });

  it("refuses a file with no header row, and one with no data rows", async () => {
    const { usecase } = make();
    await assert.rejects(
      () => usecase.preview({ headers: ["", "  "], rows: [row()] }, ALL_BRANCHES, ACTOR),
      /no header row/
    );
    await assert.rejects(
      () => usecase.preview({ headers: HEADERS, rows: [] }, ALL_BRANCHES, ACTOR),
      /no data rows/
    );
  });

  it("refuses a file that carries no updatable column at all", async () => {
    const { usecase } = make();
    await assert.rejects(
      () =>
        usecase.preview(
          { headers: ["Employee ID", "Employee Name"], rows: [row({ "Employee ID": "1865" })] },
          ALL_BRANCHES,
          ACTOR
        ),
      /no updatable column/
    );
  });

  it("only considers fields the FILE carries, whatever else exists", async () => {
    const { usecase } = make();
    const preview = await usecase.preview(
      {
        headers: ["Employee ID", "Grade"],
        rows: [{ "Employee ID": "1865", Grade: "A" }],
      },
      ALL_BRANCHES,
      ACTOR
    );
    assert.deepEqual(preview.fields_in_file.map((f) => f.key), ["grade"]);
    assert.deepEqual(preview.rows[0].changes.map((c) => c.field), ["grade"]);
  });
});

describe("bulk preview: rows", () => {
  const preview = (rows, scope = ALL_BRANCHES, headers = HEADERS) => {
    const { usecase, master } = make();
    return usecase
      .preview({ headers, rows, filename: "bulk.xlsx" }, scope, ACTOR)
      .then((p) => ({ preview: p, master }));
  };

  it("shows a change as before -> after, in human-readable terms", async () => {
    const { preview: p } = await preview([
      row({
        "Employee ID": "1865",
        "Employee Name": "Kumar",
        Location: "Muthialpet [2]",
        Grade: "A",
        "Date of Joining": "15/06/2024",
      }),
    ]);
    const r = p.rows[0];
    assert.equal(r.valid, true);
    assert.equal(r.has_changes, true);
    assert.deepEqual(
      r.changes.map((c) => `${c.label}: ${c.from_display} -> ${c.to_display}`),
      [
        "Location: ECR [1] -> Muthialpet [2]",
        "Grade: B -> A",
        "Date of Joining: 01/06/2024 -> 15/06/2024",
      ]
    );
    assert.deepEqual(p.rows_with_changes, 1);
    assert.equal(p.can_confirm, true);
  });

  it("writes NOTHING: preview never reaches the employee master", async () => {
    const { master } = await preview([
      row({ "Employee ID": "1865", Grade: "A", "Date of Joining": "15/06/2024" }),
    ]);
    assert.deepEqual(master.calls.edit, []);
    assert.deepEqual(master.calls.joiningDate, []);
  });

  it("treats a blank update cell as LEAVE UNCHANGED, never as clear", async () => {
    const { preview: p } = await preview([
      row({ "Employee ID": "1865", "Employee Name": "Kumar", Grade: "A" }),
    ]);
    // Only Grade was filled in; the five blank columns produce no change and
    // no error, and nothing proposes to null them out.
    assert.deepEqual(p.rows[0].changes.map((c) => c.field), ["grade"]);
    assert.deepEqual(p.rows[0].errors, []);
  });

  it("counts a row whose values all match as valid with no changes", async () => {
    const { preview: p } = await preview([
      row({
        "Employee ID": "1865",
        "Employee Name": "Kumar",
        Location: "ECR [1]",
        Department: "Operations [10]",
        Designation: "Cashier [20]",
        "Employment Type": "Permanent",
        Grade: "B",
        "Date of Joining": "01/06/2024",
      }),
    ]);
    assert.equal(p.rows[0].valid, true);
    assert.equal(p.rows[0].has_changes, false);
    assert.equal(p.rows_without_changes, 1);
    assert.equal(p.can_confirm, false, "nothing to confirm when nothing changes");
  });

  it("reports a missing and a non-numeric Employee ID against the row number", async () => {
    const { preview: p } = await preview([
      row({ Grade: "A" }),
      row({ "Employee ID": "18-65", Grade: "A" }),
    ]);
    assert.equal(p.rows[0].row_number, 1);
    assert.match(p.rows[0].errors[0], /Employee ID is required/);
    assert.equal(p.rows[1].row_number, 2);
    assert.match(p.rows[1].errors[0], /whole number/);
    assert.equal(p.can_confirm, false);
  });

  it("reports an unknown Employee ID", async () => {
    const { preview: p } = await preview([row({ "Employee ID": "999999", Grade: "A" })]);
    assert.match(p.rows[0].errors[0], /999999 was not found/);
  });

  it("refuses ALL rows of a duplicated Employee ID, not all but the first", async () => {
    const { preview: p } = await preview([
      row({ "Employee ID": "1865", Grade: "A" }),
      row({ "Employee ID": "1865", Grade: "C" }),
    ]);
    assert.equal(p.error_rows, 2);
    for (const r of p.rows) assert.match(r.errors[0], /appears on more than one row/);
  });

  it("refuses an employee outside the caller's branch scope, with no hint that they exist", async () => {
    const { preview: p } = await preview(
      [row({ "Employee ID": "1900", Grade: "A" })],
      ONLY_ECR
    );
    assert.match(p.rows[0].errors[0], /not an employee you are authorized for/);
    assert.doesNotMatch(p.rows[0].errors[0], /Latha/);
  });

  it("gives an unknown id and an out-of-scope id the SAME refusal for a scoped caller", async () => {
    const { preview: p } = await preview(
      [row({ "Employee ID": "1900", Grade: "A" }), row({ "Employee ID": "999999", Grade: "A" })],
      ONLY_ECR
    );
    // Identical but for the id the CALLER supplied, which is not a
    // disclosure. What must not differ is the reason: a scoped caller cannot
    // tell "exists elsewhere" from "does not exist" by reading the answer.
    const reason = (r) => r.errors[0].replace(/\d+/, "<id>");
    assert.equal(reason(p.rows[0]), reason(p.rows[1]));
    assert.match(reason(p.rows[0]), /not an employee you are authorized for/);
  });

  it("refuses a branch transfer OUT of a scoped caller's own branches", async () => {
    const { preview: p } = await preview(
      [row({ "Employee ID": "1865", Location: "Muthialpet [2]" })],
      ONLY_ECR
    );
    assert.match(p.rows[0].errors[0], /not authorized to move an employee to/);
  });

  it("refuses an unknown Location, Department and Designation", async () => {
    const { preview: p } = await preview([
      row({ "Employee ID": "1865", Location: "Nowhere" }),
      row({ "Employee ID": "1900", Department: "Imaginary" }),
      row({ "Employee ID": "2000", Designation: "Overlord" }),
    ]);
    assert.match(p.rows[0].errors[0], /Location 'Nowhere' is not in the Location master/);
    assert.match(p.rows[1].errors[0], /Department 'Imaginary' is not in the Department master/);
    assert.match(p.rows[2].errors[0], /Designation 'Overlord' is not in the Designation master/);
  });

  it("refuses an INACTIVE Location, Department and Designation", async () => {
    const { preview: p } = await preview([
      row({ "Employee ID": "1865", Location: "Old Branch [4]" }),
      row({ "Employee ID": "1900", Department: "Retired Dept [11]" }),
      row({ "Employee ID": "2000", Designation: "Abolished Role [22]" }),
    ]);
    assert.match(p.rows[0].errors[0], /Old Branch' is inactive/);
    assert.match(p.rows[1].errors[0], /Retired Dept' is inactive/);
    assert.match(p.rows[2].errors[0], /Abolished Role' is inactive/);
  });

  it("NEVER TRUSTS A BRACKETED ID ALONE: a stale name beside it is refused", async () => {
    // The file says id 2, but calls it something the master no longer calls
    // it. Assigning id 2 would honour a pointer whose label the author was
    // actually reading.
    const { preview: p } = await preview([
      row({ "Employee ID": "1865", Location: "Old Name For Branch Two [2]" }),
    ]);
    assert.equal(p.rows[0].valid, false);
    assert.match(p.rows[0].errors[0], /does not match the current master/);
    assert.match(p.rows[0].errors[0], /Muthialpet \[2\]/);
  });

  it("refuses a bracketed id that does not exist at all", async () => {
    const { preview: p } = await preview([
      row({ "Employee ID": "1865", Location: "Anything [4242]" }),
    ]);
    assert.match(p.rows[0].errors[0], /is not in the Location master/);
  });

  it("round-trips an untouched export: every exported label re-imports as no change", async () => {
    /*
     * THE REGRESSION THIS REPRESENTATION EXISTS FOR. Under the previous
     * `Name [CODE]` labelling, two same-named masters with NULL codes - the
     * normal case for department and designation now that the Digisme sync is
     * gone - exported as identical bare labels, so re-uploading an UNEDITED
     * export was refused as ambiguous and blocked the whole file.
     */
    const { usecase } = make();
    const sheet = await usecase.buildExport(
      ["store_id", "department_id", "designation_id", "employment_type", "grade", "date_of_joining"],
      {},
      {}
    );
    const headers = sheet.columns.map((c) => c.label);
    const rows = sheet.rows.map((r) =>
      Object.fromEntries(sheet.columns.map((c) => [c.label, r[c.key]]))
    );

    const p = await usecase.preview({ headers, rows }, ALL_BRANCHES, ACTOR);
    assert.equal(p.error_rows, 0, JSON.stringify(p.rows.filter((r) => !r.valid), null, 2));
    assert.equal(p.rows_with_changes, 0, "an untouched export must propose no change");
    assert.equal(p.rows_without_changes, sheet.rows.length);
  });

  it("refuses an ambiguous master name rather than guessing which record was meant", async () => {
    const { preview: p } = await preview([row({ "Employee ID": "1865", Location: "Muthialpet" })]);
    assert.match(p.rows[0].errors[0], /matches more than one record/);
    assert.match(p.rows[0].errors[0], /Muthialpet \[2\], Muthialpet \[3\]/);
    assert.match(p.rows[0].errors[0], /Name \[ID\]/);
  });

  it("refuses an Employment Type outside Permanent/Contract and a Grade outside A-E", async () => {
    const { preview: p } = await preview([
      row({ "Employee ID": "1865", "Employment Type": "Intern" }),
      row({ "Employee ID": "1900", Grade: "F" }),
    ]);
    assert.match(p.rows[0].errors[0], /Employment Type must be one of Permanent, Contract/);
    assert.match(p.rows[1].errors[0], /Grade must be one of A, B, C, D, E/);
  });

  it("accepts a case-different classification value and stores the master's exact spelling", async () => {
    const { preview: p } = await preview([
      row({ "Employee ID": "1900", "Employment Type": "permanent", Grade: "a" }),
    ]);
    assert.deepEqual(
      p.rows[0].changes.map((c) => c.to),
      ["Permanent", "A"]
    );
  });

  it("reads a Date of Joining as a real Excel date and as dd/mm/yyyy", async () => {
    const { preview: p } = await preview([
      row({ "Employee ID": "1865", "Date of Joining": new Date("2024-06-15T00:00:00Z") }),
      row({ "Employee ID": "1900", "Date of Joining": "15/06/2024" }),
    ]);
    assert.equal(p.rows[0].changes[0].to, "2024-06-15");
    assert.equal(p.rows[1].changes[0].to, "2024-06-15");
  });

  it("refuses an invalid and a FUTURE Date of Joining", async () => {
    const future = new Date(Date.now() + 40 * 86400000).toISOString().slice(0, 10);
    const [, mm, dd] = future.split("-");
    const { preview: p } = await preview([
      row({ "Employee ID": "1865", "Date of Joining": "31/02/2024" }),
      row({ "Employee ID": "1900", "Date of Joining": `${dd}/${mm}/${future.slice(0, 4)}` }),
    ]);
    assert.match(p.rows[0].errors[0], /is not a date this can read/);
    assert.match(p.rows[1].errors[0], /is in the future/);
  });

  it("raises a WARNING for a name mismatch, never an error and never a rename", async () => {
    const { preview: p, master } = await preview([
      row({ "Employee ID": "1865", "Employee Name": "Someone Else", Grade: "A" }),
    ]);
    assert.equal(p.rows[0].valid, true, "a name mismatch never blocks");
    assert.equal(p.warning_rows, 1);
    assert.match(p.rows[0].warnings[0], /will NOT be changed/);
    // And the name is not among the proposed changes.
    assert.deepEqual(p.rows[0].changes.map((c) => c.field), ["grade"]);
    assert.deepEqual(master.calls.edit, []);
  });

  it("identifies the employee by ID alone even when the name names somebody else", async () => {
    const { preview: p } = await preview([
      row({ "Employee ID": "1865", "Employee Name": "Latha", Grade: "A" }),
    ]);
    assert.equal(p.rows[0].employee_id, 1865);
    assert.equal(p.rows[0].employee_name, "Kumar");
  });

  it("validates EVERY row, including ones after a failure", async () => {
    const { preview: p } = await preview([
      row({ "Employee ID": "", Grade: "A" }),
      row({ "Employee ID": "1865", Grade: "Z" }),
      row({ "Employee ID": "1900", Grade: "A" }),
    ]);
    assert.equal(p.rows.length, 3);
    assert.equal(p.error_rows, 2);
    assert.equal(p.valid_rows, 1);
  });

  it("refuses a file larger than the cap, whole", async () => {
    const { usecase } = make();
    const rows = Array.from({ length: build.MAX_ROWS + 1 }, () => row({ "Employee ID": "1865" }));
    await assert.rejects(
      () => usecase.preview({ headers: HEADERS, rows }, ALL_BRANCHES, ACTOR),
      /the most that can be processed at once/
    );
  });
});

/* =============================================================== confirm == */

describe("bulk confirm", () => {
  const run = async (rows, { scope = ALL_BRANCHES, behaviour, mutate } = {}) => {
    const repo = fakeRepo();
    const master = fakeMaster(behaviour);
    const usecase = build(repo, master);
    const preview = await usecase.preview({ headers: HEADERS, rows, filename: "bulk.xlsx" }, scope, ACTOR);
    const expected = echo(preview);
    if (mutate) mutate(preview, expected);
    const result = await usecase.confirm(
      { headers: HEADERS, rows, filename: "bulk.xlsx", expected_before: expected },
      scope,
      ACTOR
    );
    return { preview, result, master, repo };
  };

  it("applies the ordinary fields through ONE editEmployee call per employee", async () => {
    const { result, master } = await run([
      row({ "Employee ID": "1865", Location: "Muthialpet [2]", Grade: "A", "Employment Type": "Contract" }),
    ]);
    assert.equal(result.rows_applied, 1);
    assert.equal(master.calls.edit.length, 1);
    assert.deepEqual(master.calls.edit[0].patch, {
      store_id: 2,
      employment_type: "Contract",
      grade: "A",
    });
    assert.equal(master.calls.edit[0].opts.actorEmployeeId, 99);
  });

  it("applies Date of Joining through correctJoiningDate, NEVER as an ordinary column", async () => {
    const { master } = await run([row({ "Employee ID": "1865", "Date of Joining": "15/06/2024" })]);
    assert.deepEqual(master.calls.edit, [], "DOJ must never reach the generic edit path");
    assert.equal(master.calls.joiningDate.length, 1);
    assert.deepEqual(master.calls.joiningDate[0].input, { date_of_joining: "2024-06-15" });
    assert.equal(master.calls.joiningDate[0].opts.actorEmployeeId, 99);
  });

  it("normalises a dd/mm/yyyy date to the YYYY-MM-DD the lifecycle path expects", async () => {
    const { master } = await run([row({ "Employee ID": "1865", "Date of Joining": "15/06/2024" })]);
    assert.match(master.calls.joiningDate[0].input.date_of_joining, /^\d{4}-\d{2}-\d{2}$/);
  });

  it("splits a row that changes both: one edit AND one joining-date correction", async () => {
    const { master } = await run([
      row({ "Employee ID": "1865", Grade: "A", "Date of Joining": "15/06/2024" }),
    ]);
    assert.deepEqual(master.calls.edit[0].patch, { grade: "A" });
    assert.equal(master.calls.joiningDate.length, 1);
  });

  it("performs NO operation at all for an unchanged row", async () => {
    const { result, master } = await run([
      row({ "Employee ID": "1865", Location: "ECR [1]", Grade: "B" }),
    ]);
    assert.equal(result.rows_unchanged, 1);
    assert.equal(result.rows_applied, 0);
    assert.deepEqual(master.calls.edit, []);
    assert.deepEqual(master.calls.joiningDate, []);
  });

  it("reports the session revocation a Location or Designation change causes", async () => {
    const { result } = await run([row({ "Employee ID": "1865", Location: "Muthialpet [2]" })]);
    assert.equal(result.rows[0].sessions_revoked, true);
  });

  it("leaves Employment Type and Grade classification-only: no revocation", async () => {
    const { result, master } = await run([
      row({ "Employee ID": "1865", "Employment Type": "Contract", Grade: "A" }),
    ]);
    assert.equal(result.rows[0].sessions_revoked, false);
    assert.deepEqual(master.calls.edit[0].patch, { employment_type: "Contract", grade: "A" });
    // And nothing else - no salary, no PF, no attendance field - is touched.
    assert.deepEqual(Object.keys(master.calls.edit[0].patch).sort(), ["employment_type", "grade"]);
  });

  it("REVALIDATES and applies nothing when the file no longer validates cleanly", async () => {
    const repo = fakeRepo();
    const master = fakeMaster();
    const usecase = build(repo, master);
    const rows = [row({ "Employee ID": "1865", Grade: "A" })];
    const preview = await usecase.preview({ headers: HEADERS, rows }, ALL_BRANCHES, ACTOR);
    assert.equal(preview.can_confirm, true);

    // The caller's scope narrows between the preview and the click.
    const result = await usecase.confirm(
      { headers: HEADERS, rows, expected_before: echo(preview) },
      { allBranches: false, inScope: () => false },
      ACTOR
    );
    assert.equal(result.code, 409);
    assert.equal(result.applied, false);
    assert.deepEqual(master.calls.edit, []);
  });

  it("refuses to trust the browser: confirm re-resolves every cell itself", async () => {
    const repo = fakeRepo();
    const master = fakeMaster();
    const usecase = build(repo, master);
    const rows = [row({ "Employee ID": "1865", Grade: "A" })];
    const preview = await usecase.preview({ headers: HEADERS, rows }, ALL_BRANCHES, ACTOR);

    // A hand-rolled client claims the row will do something else entirely.
    const tampered = echo(preview);
    const result = await usecase.confirm(
      { headers: HEADERS, rows, expected_before: tampered },
      ALL_BRANCHES,
      ACTOR
    );
    assert.deepEqual(master.calls.edit[0].patch, { grade: "A" }, "the FILE decides, not the echo");
  });

  it("detects stale data: a value changed since the preview is a conflict, not an overwrite", async () => {
    const { result, master } = await run([row({ "Employee ID": "1865", Grade: "A" })], {
      // Somebody else set the grade to C in between, so what the approver saw
      // ("B") is no longer true.
      mutate: (preview, expected) => {
        expected[0].expected_before.grade = "C";
      },
    });
    assert.equal(result.rows_conflicted, 1);
    assert.equal(result.rows_applied, 0);
    assert.equal(result.rows[0].outcome, OUTCOME.CONFLICT);
    assert.match(result.rows[0].failure_reason, /changed by someone else after the preview/);
    assert.deepEqual(master.calls.edit, [], "nothing is written for a conflicted row");
  });

  it("refuses a row whose preview values were not supplied at all", async () => {
    const repo = fakeRepo();
    const master = fakeMaster();
    const usecase = build(repo, master);
    const rows = [row({ "Employee ID": "1865", Grade: "A" })];
    const result = await usecase.confirm(
      { headers: HEADERS, rows, expected_before: [] },
      ALL_BRANCHES,
      ACTOR
    );
    assert.equal(result.rows_conflicted, 1);
    assert.deepEqual(master.calls.edit, []);
  });

  it("reports a per-row failure without abandoning the rest of the file", async () => {
    const repo = fakeRepo();
    const master = fakeMaster();
    const usecase = build(repo, master);
    const rows = [
      row({ "Employee ID": "1865", Grade: "A" }),
      row({ "Employee ID": "1900", Grade: "C" }),
    ];
    const preview = await usecase.preview({ headers: HEADERS, rows }, ALL_BRANCHES, ACTOR);

    let seen = 0;
    const original = master.editEmployee;
    master.editEmployee = async (...args) => {
      seen += 1;
      if (seen === 1) throw new Error("employee 1865 does not exist");
      return original(...args);
    };

    const result = await usecase.confirm(
      { headers: HEADERS, rows, expected_before: echo(preview) },
      ALL_BRANCHES,
      ACTOR
    );
    assert.equal(result.rows_failed, 1);
    assert.equal(result.rows_applied, 1);
    assert.equal(result.rows[0].outcome, OUTCOME.FAILED);
    assert.match(result.rows[0].failure_reason, /does not exist/);
    assert.equal(result.rows[1].outcome, OUTCOME.APPLIED);
  });

  it("never lets a crafted spreadsheet reach a field outside the catalogue", async () => {
    const repo = fakeRepo();
    const master = fakeMaster();
    const usecase = build(repo, master);
    // A row object carrying extra keys, as a tampered client could send.
    const rows = [
      {
        "Employee ID": "1865",
        Grade: "A",
        salary: "999999",
        status: "0",
        employee_name: "Renamed",
        pf_number: "X",
      },
    ];
    const preview = await usecase.preview({ headers: ["Employee ID", "Grade"], rows }, ALL_BRANCHES, ACTOR);
    await usecase.confirm(
      { headers: ["Employee ID", "Grade"], rows, expected_before: echo(preview) },
      ALL_BRANCHES,
      ACTOR
    );
    assert.deepEqual(master.calls.edit[0].patch, { grade: "A" });
  });
});

/* ================================================================= audit == */

describe("bulk audit", () => {
  it("records who, when, the filename, the fields, the counts and the outcome", async () => {
    const repo = fakeRepo();
    const master = fakeMaster();
    const usecase = build(repo, master);
    const rows = [row({ "Employee ID": "1865", Grade: "A" })];
    const preview = await usecase.preview(
      { headers: HEADERS, rows, filename: "june.xlsx" },
      ALL_BRANCHES,
      ACTOR
    );
    await usecase.confirm(
      { headers: HEADERS, rows, filename: "june.xlsx", expected_before: echo(preview) },
      ALL_BRANCHES,
      ACTOR
    );

    const confirm = repo.calls.audits.find((a) => a.operation === "CONFIRM");
    assert.equal(confirm.source_filename, "june.xlsx");
    assert.equal(confirm.user_id, 7);
    assert.equal(confirm.employee_id, 99);
    assert.equal(confirm.rows_uploaded, 1);
    assert.equal(confirm.rows_applied, 1);
    assert.equal(confirm.outcome, "APPLIED");
    assert.deepEqual(confirm.detail[0].changes, [{ field: "grade", from: "B", to: "A" }]);
  });

  it("records an export as shape only, never a value", async () => {
    const repo = fakeRepo();
    const usecase = build(repo, fakeMaster());
    await usecase.recordExport(
      { filename: "e.xlsx", selected_fields: ["grade"], filters: { status: 1 }, row_count: 3 },
      ACTOR
    );
    const entry = repo.calls.audits[0];
    assert.equal(entry.operation, "EXPORT");
    assert.equal(entry.rows_uploaded, 3);
    assert.deepEqual(entry.detail, []);
  });

  it("never fails the operation it is recording", async () => {
    const repo = fakeRepo();
    repo.recordBulkUpdate = async () => {
      throw new Error("the audit table is gone");
    };
    const master = fakeMaster();
    const usecase = build(repo, master);
    const rows = [row({ "Employee ID": "1865", Grade: "A" })];
    const preview = await usecase.preview({ headers: HEADERS, rows }, ALL_BRANCHES, ACTOR);
    const result = await usecase.confirm(
      { headers: HEADERS, rows, expected_before: echo(preview) },
      ALL_BRANCHES,
      ACTOR
    );
    assert.equal(result.rows_applied, 1);
  });
});
