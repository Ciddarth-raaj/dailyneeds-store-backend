/**
 * M5 — Bulk Salary Upload: the rules the batch adds, and the ones it must
 * leave exactly as they were.
 *
 *   node --test usecase/m5_bulk_salary_upload.test.js
 *
 * M5 adds no salary rule at all. It classifies each row by the lifecycle's own
 * rule, prices it with the lifecycle's own engine, and creates it through the
 * lifecycle's own `createInitialSalary`. So what is proved here is the delta -
 * the classification, the opening-date CHECK, the duplicate rule, the automatic
 * reason and the IMPORT stamp, the partial-success behaviour - plus the handful
 * of M2/M4 guarantees that a change this shape could plausibly break without
 * anybody noticing:
 *
 *   a bulk row auto-approving, or landing as anything but PENDING
 *   a bulk REVISION escaping the revision-reason requirement because the row is
 *     stamped IMPORT and IMPORT is not in SOURCES_REQUIRING_REASON
 *   an opening salary silently taking the file's date instead of the rule's
 *   two rows for one employee both being created
 *   a row written on the strength of a validation that has since expired
 *   the unique pending key surfacing as a crashed batch rather than a row
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const buildSalaryUsecase = require("./employee_salary");
const { SOURCE } = require("./employee_salary");
const buildBulk = require("./salary_bulk_upload");
const { BULK_REVISION_REASON, ROW_TYPE, MAX_ROWS } = require("./salary_bulk_upload");

/** The same fixed clock the M2 and M4 suites use, and for the same reason. */
const NOW = "2026-09-11";

/** The opening floor in `config/statutory.js`. Every opening row lands here. */
const OPENING_FLOOR = "2026-04-01";

const EMPLOYEE = {
  employee_id: 42,
  employee_name: "Test Person",
  status: 1,
  pf_applicable: 1,
  esi_applicable: 0,
  previous_pf_member: 1,
  previous_eps_member: 1,
  dob: "1990-05-10",
  date_of_joining: "2019-06-01",
};

/** Somebody who joined AFTER the floor, so their opening date is their DOJ. */
const LATE_JOINER = {
  ...EMPLOYEE,
  employee_id: 77,
  employee_name: "Late Joiner",
  date_of_joining: "2026-07-15",
};

const ACTOR = { employeeId: 7 };

/** A stored row, in the shape the repository hands back. */
const row = (over) => ({
  salary_id: over.salary_id,
  employee_id: over.employee_id ?? 42,
  monthly_gross: 20000,
  status: "APPROVED",
  effective_from: OPENING_FLOOR,
  source: SOURCE.OPENING_SALARY,
  manual_override: 0,
  revision_reason: null,
  unresolved_notes: "[]",
  statutory_snapshot: "{}",
  ...over,
});

/**
 * The in-memory repository, filtered exactly as the real SQL filters - so a
 * test cannot pass on a condition the real query does not have.
 *
 * `onCreate` is the seam the race and duplicate-key cases need: it runs before
 * the insert, so a test can make the world change underneath a validation that
 * has already passed.
 */
function makeRepo(employees = [EMPLOYEE], rows = []) {
  let nextId = 1000;
  return {
    rows,
    employees,
    onCreate: null,
    createCalls: [],
    async getStatutoryContext(id) {
      const found = this.employees.find((e) => Number(e.employee_id) === Number(id));
      return found ? { ...found } : null;
    },
    async hasLiveSalary(id) {
      return this.rows.some((r) => Number(r.employee_id) === Number(id) && r.status !== "REJECTED");
    },
    async getPendingForEmployee(id) {
      return (
        this.rows
          .filter((r) => Number(r.employee_id) === Number(id) && r.status === "PENDING")
          .sort((a, b) => a.salary_id - b.salary_id)[0] || null
      );
    },
    async getActiveRevisionAt(id, date) {
      return (
        this.rows.find(
          (r) =>
            Number(r.employee_id) === Number(id) &&
            r.effective_from === date &&
            r.status !== "REJECTED"
        ) || null
      );
    },
    async getFutureRevisions(id, after) {
      return this.rows.filter(
        (r) =>
          Number(r.employee_id) === Number(id) && r.effective_from > after && r.status !== "REJECTED"
      );
    },
    async getCurrentSalary(id, asOf) {
      return (
        this.rows
          .filter(
            (r) =>
              Number(r.employee_id) === Number(id) &&
              r.status === "APPROVED" &&
              r.effective_from <= asOf
          )
          .sort((a, b) => (a.effective_from < b.effective_from ? 1 : -1))[0] || null
      );
    },
    async getHistory(id) {
      return this.rows.filter((r) => Number(r.employee_id) === Number(id));
    },
    async getById(salaryId) {
      return this.rows.find((r) => Number(r.salary_id) === Number(salaryId)) || null;
    },
    async create(record) {
      if (this.onCreate) await this.onCreate(record, this);
      this.createCalls.push(record);
      const id = ++nextId;
      this.rows.push({ ...record, salary_id: id });
      return id;
    },
  };
}

function build(repo) {
  const salary = buildSalaryUsecase(repo, { now: () => NOW });
  return { salary, bulk: buildBulk(repo, salary, { now: () => NOW }) };
}

/** Three cells, as a file hands them over: text, every one of them. */
const cell = (employeeId, gross, from) => ({
  employee_id: String(employeeId),
  monthly_gross: String(gross),
  effective_from: String(from),
});

/* ===================================================================== */
/* 1-2. The single-employee path, which M5 must not have disturbed       */
/* ===================================================================== */

describe("the opening-salary path M5 reuses", () => {
  it("1. an opening create is PENDING, and takes the RESOLVED opening date", async () => {
    const repo = makeRepo();
    const { salary } = build(repo);

    const created = await salary.createInitialSalary(42, { monthly_gross: 25000 }, ACTOR);

    assert.equal(created.status, "PENDING");
    assert.equal(created.source, SOURCE.OPENING_SALARY);
    assert.equal(created.effective_from, OPENING_FLOOR);
    assert.equal(repo.createCalls[0].status, "PENDING");
    assert.equal(repo.createCalls[0].approved_by, undefined);
  });

  it("1b. the opening date is the later of the floor and the date of joining", async () => {
    const repo = makeRepo([LATE_JOINER]);
    const { salary } = build(repo);

    const created = await salary.createInitialSalary(77, { monthly_gross: 25000 }, ACTOR);
    assert.equal(created.effective_from, "2026-07-15");
  });

  it("2. a caller cannot choose an opening salary's effective date", async () => {
    const repo = makeRepo();
    const { salary } = build(repo);

    // The Employee Master must DISPLAY the server's date rather than offer one,
    // and this is why: a date sent for an opening salary is not honoured, so a
    // screen that let somebody type one would show them a date the record does
    // not carry.
    const created = await salary.createInitialSalary(
      42,
      { monthly_gross: 25000, effective_from: "2026-08-01" },
      ACTOR
    );
    assert.equal(created.effective_from, OPENING_FLOOR);
    assert.equal(repo.createCalls[0].effective_from, OPENING_FLOOR);
  });

  it("2b. the preview resolves the same opening date when none is sent", async () => {
    const repo = makeRepo();
    const { salary } = build(repo);

    const preview = await salary.calculateForEmployee(42, { monthly_gross: 25000 });
    assert.equal(preview.effective_from, OPENING_FLOOR);
  });
});

/* ===================================================================== */
/* 3-5. Classification, and the opening date CHECK                       */
/* ===================================================================== */

describe("row classification", () => {
  it("3. a rejected-only history is still NO salary, so the row is an Opening", async () => {
    const repo = makeRepo([EMPLOYEE], [row({ salary_id: 1, status: "REJECTED" })]);
    const { bulk } = build(repo);

    const result = await bulk.validate([cell(42, 25000, OPENING_FLOOR)]);

    assert.equal(result.rows[0].valid, true, result.rows[0].error_reason);
    assert.equal(result.rows[0].type, ROW_TYPE.OPENING_SALARY);
    assert.equal(result.rows[0].revision_reason, null);
  });

  it("4. a live salary makes the row a Revision", async () => {
    const repo = makeRepo([EMPLOYEE], [row({ salary_id: 1, status: "APPROVED" })]);
    const { bulk } = build(repo);

    const result = await bulk.validate([cell(42, 30000, "2026-10-01")]);

    assert.equal(result.rows[0].valid, true, result.rows[0].error_reason);
    assert.equal(result.rows[0].type, ROW_TYPE.REVISION);
    assert.equal(result.rows[0].revision_reason, BULK_REVISION_REASON);
  });

  it("4b. a PENDING row is live too — but the pending rule refuses it first", async () => {
    const repo = makeRepo([EMPLOYEE], [row({ salary_id: 1, status: "PENDING" })]);
    const { bulk } = build(repo);

    const result = await bulk.validate([cell(42, 30000, "2026-10-01")]);
    assert.equal(result.rows[0].valid, false);
    assert.match(result.rows[0].error_reason, /already pending/i);
  });

  it("5. an opening row whose Effective From is not the rule's is INVALID", async () => {
    const repo = makeRepo();
    const { bulk } = build(repo);

    const result = await bulk.validate([cell(42, 25000, "2026-05-01")]);

    assert.equal(result.rows[0].valid, false);
    assert.equal(result.rows[0].error_reason, `Opening salary Effective From must be ${OPENING_FLOOR}`);
    assert.equal(result.invalid_rows, 1);
  });

  it("5b. the wrong date is REPORTED, never silently replaced", async () => {
    const repo = makeRepo();
    const { bulk } = build(repo);

    const result = await bulk.submit([cell(42, 25000, "2026-05-01")], ACTOR);

    assert.equal(result.created_rows, 0);
    assert.equal(repo.createCalls.length, 0, "nothing was written with a corrected date");
    // The row still echoes what the file said, so a corrected re-upload starts
    // from what somebody typed.
    assert.equal(result.rows[0].effective_from, "2026-05-01");
  });

  it("5c. a late joiner's opening date is their DOJ, and the file must say so", async () => {
    const repo = makeRepo([LATE_JOINER]);
    const { bulk } = build(repo);

    const wrong = await bulk.validate([cell(77, 25000, OPENING_FLOOR)]);
    assert.equal(wrong.rows[0].valid, false);
    assert.equal(wrong.rows[0].error_reason, "Opening salary Effective From must be 2026-07-15");

    const right = await bulk.validate([cell(77, 25000, "2026-07-15")]);
    assert.equal(right.rows[0].valid, true, right.rows[0].error_reason);
  });
});

/* ===================================================================== */
/* 6. The stamp and the automatic reason                                 */
/* ===================================================================== */

describe("what a bulk row is stamped with", () => {
  it("6. a bulk REVISION is stored with source IMPORT and the automatic reason", async () => {
    const repo = makeRepo([EMPLOYEE], [row({ salary_id: 1, status: "APPROVED" })]);
    const { bulk } = build(repo);

    const result = await bulk.submit([cell(42, 30000, "2026-10-01")], ACTOR);

    assert.equal(result.created_rows, 1, result.rows[0].error_reason);
    const written = repo.createCalls[0];
    assert.equal(written.source, SOURCE.IMPORT);
    assert.equal(written.revision_reason, BULK_REVISION_REASON);
    // NOT the override reason and NOT the rejection reason: three questions,
    // three columns, and the bulk sentence answers exactly one of them.
    assert.equal(written.override_reason, null);
    assert.equal(written.rejection_reason, undefined);
  });

  it("6b. a bulk OPENING salary is stamped IMPORT and carries NO reason", async () => {
    const repo = makeRepo();
    const { bulk } = build(repo);

    const result = await bulk.submit([cell(42, 25000, OPENING_FLOOR)], ACTOR);

    assert.equal(result.created_rows, 1, result.rows[0].error_reason);
    const written = repo.createCalls[0];
    assert.equal(written.source, SOURCE.IMPORT);
    assert.equal(written.revision_reason, null, "an opening salary changes nothing, so says nothing");
    assert.equal(written.effective_from, OPENING_FLOOR);
  });

  it("6c. the IMPORT stamp does not let a revision escape the reason rule", async () => {
    // IMPORT is not in SOURCES_REQUIRING_REASON, so a lifecycle that read the
    // STAMP rather than the classification would let every bulk revision
    // through with no reason at all. This is the assertion that catches it.
    const repo = makeRepo([EMPLOYEE], [row({ salary_id: 1, status: "APPROVED" })]);
    const { salary } = build(repo);

    await assert.rejects(
      () =>
        salary.createInitialSalary(
          42,
          { monthly_gross: 30000, effective_from: "2026-10-01" },
          ACTOR,
          { source: SOURCE.IMPORT }
        ),
      /revision reason is required/i
    );
  });

  it("6d. the classification is reported beside the stamp", async () => {
    const repo = makeRepo([EMPLOYEE], [row({ salary_id: 1, status: "APPROVED" })]);
    const { salary } = build(repo);

    const created = await salary.createInitialSalary(
      42,
      { monthly_gross: 30000, effective_from: "2026-10-01", revision_reason: BULK_REVISION_REASON },
      ACTOR,
      { source: SOURCE.IMPORT }
    );
    assert.equal(created.source, SOURCE.IMPORT);
    assert.equal(created.classification, SOURCE.REVISION);
  });
});

/* ===================================================================== */
/* 7-10. The lifecycle refusals, per row                                 */
/* ===================================================================== */

describe("the refusals a row inherits from the lifecycle", () => {
  it("7. an employee with a PENDING proposal is invalid, and the row says what to do", async () => {
    const repo = makeRepo([EMPLOYEE], [row({ salary_id: 1, status: "PENDING" })]);
    const { bulk } = build(repo);

    const result = await bulk.validate([cell(42, 30000, "2026-10-01")]);

    assert.equal(result.rows[0].valid, false);
    assert.match(result.rows[0].error_reason, /amend, approve or reject it/i);
  });

  it("8. two rows for one employee are BOTH invalid, whatever their dates", async () => {
    const repo = makeRepo();
    const { bulk } = build(repo);

    const result = await bulk.validate([
      cell(42, 25000, OPENING_FLOOR),
      cell(42, 30000, "2026-10-01"),
    ]);

    assert.equal(result.valid_rows, 0, "neither of them is honoured");
    for (const r of result.rows) {
      assert.equal(r.valid, false);
      assert.equal(r.error_reason, "Duplicate Employee ID in upload");
    }
  });

  it("8b. a duplicate never reaches the create path either", async () => {
    const repo = makeRepo();
    const { bulk } = build(repo);

    await bulk.submit([cell(42, 25000, OPENING_FLOOR), cell(42, 30000, "2026-10-01")], ACTOR);
    assert.equal(repo.createCalls.length, 0);
  });

  it("9. a future-dated revision behind an existing one is invalid", async () => {
    const repo = makeRepo(
      [EMPLOYEE],
      [
        row({ salary_id: 1, status: "APPROVED", effective_from: OPENING_FLOOR }),
        row({ salary_id: 2, status: "APPROVED", effective_from: "2026-11-01" }),
      ]
    );
    const { bulk } = build(repo);

    const result = await bulk.validate([cell(42, 31000, "2026-12-01")]);

    assert.equal(result.rows[0].valid, false);
    assert.match(result.rows[0].error_reason, /future-dated salary revision/i);
    assert.match(result.rows[0].error_reason, /2026-11-01/);
  });

  it("10. a row landing on a date that already has a live revision is invalid", async () => {
    const repo = makeRepo(
      [EMPLOYEE],
      [
        row({ salary_id: 1, status: "APPROVED", effective_from: OPENING_FLOOR }),
        row({ salary_id: 2, status: "APPROVED", effective_from: "2026-08-01" }),
      ]
    );
    const { bulk } = build(repo);

    const result = await bulk.validate([cell(42, 31000, "2026-08-01")]);

    assert.equal(result.rows[0].valid, false);
    assert.match(result.rows[0].error_reason, /already exists for 2026-08-01/);
  });

  it("10b. an employee who does not exist is invalid, not a crash", async () => {
    const repo = makeRepo();
    const { bulk } = build(repo);

    const result = await bulk.validate([cell(999, 25000, OPENING_FLOOR)]);
    assert.equal(result.rows[0].valid, false);
    assert.match(result.rows[0].error_reason, /Employee 999 was not found/);
  });

  it("10c. the shape complaints are answered before any read", async () => {
    const repo = makeRepo();
    const { bulk } = build(repo);

    const result = await bulk.validate([
      { employee_id: "", monthly_gross: "1000", effective_from: OPENING_FLOOR },
      { employee_id: "E7", monthly_gross: "1000", effective_from: OPENING_FLOOR },
      { employee_id: "42", monthly_gross: "", effective_from: OPENING_FLOOR },
      { employee_id: "42", monthly_gross: "abc", effective_from: OPENING_FLOOR },
      { employee_id: "42", monthly_gross: "0", effective_from: OPENING_FLOOR },
      { employee_id: "42", monthly_gross: "1000", effective_from: "01/04/2026" },
      { employee_id: "42", monthly_gross: "1000", effective_from: "" },
    ]);

    assert.equal(result.valid_rows, 0);
    assert.deepEqual(
      result.rows.map((r) => r.error_reason),
      [
        "Employee ID is required",
        "Employee ID must be a whole number",
        "Monthly Gross Salary is required",
        "Monthly Gross Salary must be a number",
        "Monthly Gross Salary must be more than zero",
        "Effective From must be a date in YYYY-MM-DD form",
        "Effective From is required",
      ]
    );
  });

  it("10d. a spreadsheet's commas and padding are read, not refused", async () => {
    const repo = makeRepo();
    const { bulk } = build(repo);

    const result = await bulk.validate([
      { employee_id: " 42 ", monthly_gross: "1,25,000", effective_from: ` ${OPENING_FLOOR} ` },
    ]);
    assert.equal(result.rows[0].valid, true, result.rows[0].error_reason);
    assert.equal(result.rows[0].calculated.monthly_gross, 125000);
  });
});

/* ===================================================================== */
/* 11-13. Partial success, revalidation and the race                     */
/* ===================================================================== */

describe("validate all, then submit only what passed", () => {
  const twoEmployees = () => [EMPLOYEE, { ...EMPLOYEE, employee_id: 43, employee_name: "Second" }];

  it("11. valid and invalid rows coexist, and submit creates only the valid ones", async () => {
    const repo = makeRepo(twoEmployees());
    const { bulk } = build(repo);

    const file = [
      cell(42, 25000, OPENING_FLOOR), // good
      cell(43, 25000, "2026-05-01"), // wrong opening date
      cell(999, 25000, OPENING_FLOOR), // no such employee
    ];

    const preview = await bulk.validate(file);
    assert.equal(preview.total_rows, 3);
    assert.equal(preview.valid_rows, 1);
    assert.equal(preview.invalid_rows, 2);

    const result = await bulk.submit(file, ACTOR);
    assert.equal(result.created_rows, 1);
    assert.equal(result.failed_rows, 2);
    assert.equal(repo.createCalls.length, 1);
    assert.equal(Number(repo.createCalls[0].employee_id), 42);

    // The invalid rows come back with the three original columns and the one
    // sentence, which is exactly what the rejected-row export is built from.
    const failed = result.rows.filter((r) => !r.created);
    assert.deepEqual(
      failed.map((r) => [r.employee_id, r.monthly_gross, r.effective_from, Boolean(r.error_reason)]),
      [
        ["43", "25000", "2026-05-01", true],
        ["999", "25000", OPENING_FLOOR, true],
      ]
    );
  });

  it("11b. nothing is all-or-nothing: one bad row does not hold up the rest", async () => {
    const repo = makeRepo(twoEmployees());
    const { bulk } = build(repo);

    const result = await bulk.submit(
      [cell(999, 25000, OPENING_FLOOR), cell(42, 25000, OPENING_FLOOR), cell(43, 25000, OPENING_FLOOR)],
      ACTOR
    );
    assert.equal(result.created_rows, 2);
  });

  it("12. submit REVALIDATES — a proposal raised since the preview stops the row", async () => {
    const repo = makeRepo(twoEmployees());
    const { bulk } = build(repo);

    const file = [cell(42, 25000, OPENING_FLOOR), cell(43, 25000, OPENING_FLOOR)];

    const preview = await bulk.validate(file);
    assert.equal(preview.valid_rows, 2);

    // Somebody raises a proposal for 42 between the preview and the click.
    repo.rows.push(row({ salary_id: 5, employee_id: 42, status: "PENDING" }));

    const result = await bulk.submit(file, ACTOR);
    assert.equal(result.created_rows, 1);
    assert.equal(Number(repo.createCalls[0].employee_id), 43);
    const refused = result.rows.find((r) => r.employee_id === "42");
    assert.equal(refused.created, false);
    assert.match(refused.error_reason, /already pending/i);
  });

  it("13. the unique pending key surfaces as ONE row's failure, not a crashed batch", async () => {
    const repo = makeRepo([EMPLOYEE, { ...EMPLOYEE, employee_id: 43, employee_name: "Second" }]);
    const { bulk } = build(repo);

    // The final backstop: two requests race past the check and the database
    // refuses the second. The driver's error names an index; the person needs a
    // sentence.
    repo.onCreate = (record) => {
      if (Number(record.employee_id) === 42) {
        const err = new Error(
          "ER_DUP_ENTRY: Duplicate entry '42-1' for key 'uq_salary_pending_proposal'"
        );
        err.code = "ER_DUP_ENTRY";
        throw err;
      }
    };

    const result = await bulk.submit(
      [cell(42, 25000, OPENING_FLOOR), cell(43, 25000, OPENING_FLOOR)],
      ACTOR
    );

    assert.equal(result.created_rows, 1, "the other row still went in");
    const failed = result.rows.find((r) => r.employee_id === "42");
    assert.equal(failed.created, false);
    assert.match(failed.error_reason, /already pending for this employee/i);
    assert.ok(
      !/uq_salary_pending_proposal|ER_DUP_ENTRY/.test(failed.error_reason),
      "the index name is not what somebody is told to act on"
    );
  });
});

/* ===================================================================== */
/* 14-16. What bulk must never do                                        */
/* ===================================================================== */

describe("what bulk upload must never do", () => {
  it("14. NOTHING IS EVER AUTO-APPROVED, including by an administrator", async () => {
    const repo = makeRepo();
    const { bulk } = build(repo);

    const result = await bulk.submit([cell(42, 25000, OPENING_FLOOR)], {
      employeeId: 7,
      isAdmin: true,
      userType: 2,
    });

    assert.equal(result.rows[0].status_to_be_created, "PENDING");
    const written = repo.createCalls[0];
    assert.equal(written.status, "PENDING");
    assert.equal(written.approved_by, undefined);
    assert.equal(written.approved_at, undefined);

    // The module has no approval CODE - the word survives only in the sentence
    // a refused row is given ("amend, approve or reject it"), which is advice
    // and not a path.
    const src = fs.readFileSync(path.join(__dirname, "salary_bulk_upload.js"), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const forbidden of [
      "approveSalary", "approved_by", "approved_at", "STATUS.APPROVED", "approve(",
    ]) {
      assert.ok(!code.includes(forbidden), `the bulk module must not name ${forbidden}`);
    }
  });

  it("15. every amount on the row is the ENGINE's; the file supplies three cells", async () => {
    const repo = makeRepo();
    const { bulk } = build(repo);

    await bulk.submit([cell(42, 25000, OPENING_FLOOR)], ACTOR);
    const written = repo.createCalls[0];

    // The four components add up to the gross, the contributions are present,
    // and none of them came from the file - the file had no column for them.
    assert.equal(
      Number(written.basic) +
        Number(written.conveyance) +
        Number(written.hra) +
        Number(written.special_allowance),
      25000
    );
    assert.ok(written.pf_status, "the PF status is the engine's answer");
    assert.ok(written.statutory_snapshot, "the rates that produced it are stamped on the row");
    assert.equal(written.created_by, ACTOR.employeeId);
  });

  it("15b. a client-calculated figure on a row cannot reach the record", async () => {
    const repo = makeRepo();
    const { bulk } = build(repo);

    // Even if a caller got past the route's Joi schema, the usecase builds its
    // request to the lifecycle from three named cells - so an invented Basic or
    // CTC is not filtered out of the row, it never enters the path at all.
    await bulk.submit(
      [
        {
          ...cell(42, 25000, OPENING_FLOOR),
          basic: 99999,
          monthly_ctc: 1,
          employee_pf: 0,
          status: "APPROVED",
          source: "REVISION",
        },
      ],
      ACTOR
    );

    const written = repo.createCalls[0];
    assert.notEqual(Number(written.basic), 99999);
    assert.notEqual(Number(written.monthly_ctc), 1);
    assert.equal(written.status, "PENDING");
    assert.equal(written.source, SOURCE.IMPORT);
  });

  it("16. no legacy new_employee.salary write anywhere in the bulk path", () => {
    const src = fs.readFileSync(path.join(__dirname, "salary_bulk_upload.js"), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.ok(!/new_employee/.test(code), "the bulk usecase never names the employee table");
    assert.ok(!/\bsalary\s*:/.test(code), "and never puts a bare `salary` into a payload");
    assert.ok(!/\bUPDATE\b|\bINSERT\b|\bDELETE\b/i.test(code), "it issues no SQL of its own");
  });

  it("16b. it has no staging table and asks for no migration", () => {
    const migrations = fs.readdirSync(path.join(__dirname, "..", "migrations", "mysql", "migrations"));
    assert.ok(
      !migrations.some((f) => /bulk.*salary|salary.*bulk|salary.*import|m5/i.test(f)),
      "bulk upload is stateless: validate, then submit with a full revalidation"
    );
  });
});

/* ===================================================================== */
/* The file itself                                                       */
/* ===================================================================== */

describe("the file as a whole", () => {
  it("an empty upload, a non-list and an oversized one are refused whole", async () => {
    const { bulk } = build(makeRepo());

    await assert.rejects(() => bulk.validate([]), /no rows/i);
    await assert.rejects(() => bulk.validate(null), /list of rows/i);

    const tooMany = Array.from({ length: MAX_ROWS + 1 }, () => cell(42, 1000, OPENING_FLOOR));
    await assert.rejects(() => bulk.validate(tooMany), new RegExp(`at most ${MAX_ROWS} rows`));
  });

  it("every row is validated, including the ones after a bad one", async () => {
    const repo = makeRepo([EMPLOYEE, { ...EMPLOYEE, employee_id: 43 }]);
    const { bulk } = build(repo);

    const result = await bulk.validate([
      cell(999, 25000, OPENING_FLOOR),
      cell(42, 25000, OPENING_FLOOR),
      cell(43, 25000, OPENING_FLOOR),
    ]);
    assert.equal(result.total_rows, 3);
    assert.equal(result.valid_rows, 2);
    assert.deepEqual(result.rows.map((r) => r.row_number), [1, 2, 3]);
  });

  it("a valid row carries everything the preview table shows", async () => {
    const repo = makeRepo();
    const { bulk } = build(repo);

    const r = (await bulk.validate([cell(42, 25000, OPENING_FLOOR)])).rows[0];

    assert.equal(r.employee_id, "42");
    assert.equal(r.employee_name, "Test Person");
    assert.equal(r.type, ROW_TYPE.OPENING_SALARY);
    assert.equal(r.resolved_effective_from, OPENING_FLOOR);
    assert.equal(r.status_to_be_created, "PENDING");
    assert.equal(r.source, SOURCE.IMPORT);
    assert.ok(r.calculated.components.basic > 0);
    assert.ok("conveyance" in r.calculated.components);
    assert.ok("hra" in r.calculated.components);
    assert.ok("special_allowance" in r.calculated.components);
    assert.ok(r.calculated.pf, "employee and employer PF");
    assert.ok(r.calculated.esi, "the ESI answer, resolved or Pending");
    assert.ok("monthly_ctc" in r.calculated);
  });

  it("an unresolved contribution stays Pending and is never a fake zero", async () => {
    // ESI is charged on the wage actually paid in a period and there is no
    // monthly payroll yet, so the engine answers PENDING for an ESI-covered
    // employee rather than inventing a contribution. A bulk preview must carry
    // that answer through unchanged.
    const repo = makeRepo([{ ...EMPLOYEE, esi_applicable: 1 }]);
    const { bulk } = build(repo);

    const r = (await bulk.validate([cell(42, 15000, OPENING_FLOOR)])).rows[0];
    assert.equal(r.valid, true, r.error_reason);
    assert.ok(r.calculated.esi.status, "the ESI status is stated");
    assert.ok(Array.isArray(r.calculated.unresolved));
  });

  it("nothing about the employee beyond name and pay facts comes back", async () => {
    const repo = makeRepo();
    const { bulk } = build(repo);

    const r = (await bulk.validate([cell(42, 25000, OPENING_FLOOR)])).rows[0];
    const json = JSON.stringify(r);
    for (const forbidden of ["account_no", "ifsc", "pan_no", "aadhaar", "uan", "bank_name"]) {
      assert.ok(!new RegExp(forbidden, "i").test(json), `a bulk row must not carry ${forbidden}`);
    }
  });
});
