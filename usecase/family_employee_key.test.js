/**
 * `employee_family` moving off `employee_name` and onto `employee_id` — step
 * one, through the REAL usecase over a fake repository.
 *
 *   node --test usecase/family_employee_key.test.js
 *
 * The name was the only link from a family record to its employee, so a name
 * correction orphaned every one of that employee's records and two employees
 * sharing a name shared their family. Migration
 * 20260926120000-employee-family-key added the column; this step makes the
 * application write it.
 *
 * What these tests protect is the resolution rule, because it is the only
 * place the new column can be got WRONG. Writing no id is recoverable - HR
 * attaches the record by hand, and the migration reports which ones. Writing
 * somebody else's id is not: the record silently belongs to the wrong person
 * and nothing flags it. So an ambiguous name must yield null, never a guess.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const buildUsecase = require("./family");

/** Two employees share "Amit P"; "Asha K" is unique; nobody is "Ghost". */
const EMPLOYEES = [
  { employee_id: 42, employee_name: "Asha K" },
  { employee_id: 77, employee_name: "Amit P" },
  { employee_id: 78, employee_name: "Amit P" },
];

function build() {
  const written = { created: [], updated: [] };
  const repo = {
    written,
    findEmployeeIdByName: async (name) => {
      const matches = EMPLOYEES.filter((e) => e.employee_name === name);
      return matches.length === 1 ? matches[0].employee_id : null;
    },
    create: async (row) => {
      written.created.push(row);
      return { code: 200, id: 500 + written.created.length };
    },
    updateFamilyDetails: async (details, family_id) => {
      written.updated.push({ family_id, details });
      return { code: 200 };
    },
    getFamilyByEmployeeId: async (id) => [{ family_id: 1, employee_id: id, name: "child" }],
    getFamilyByEmployee: async (name) => [{ family_id: 1, employee_name: name, name: "child" }],
    get: async () => [],
    getFamilyById: async (id) => [{ family_id: id }],
  };
  return { usecase: buildUsecase(repo), repo, written };
}

const MEMBER = {
  name: "Child One", dob: "2015-01-01", gender: "F", blood_group: "O+",
  relation: "Daughter", nationality: "Indian", profession: "Student", remarks: "",
};

describe("creating a record attaches it to an employee id", () => {
  it("an id sent by the caller is used as given", async () => {
    const { usecase, written } = build();
    await usecase.create({ ...MEMBER, employee_id: 78, employee_name: "Amit P" });
    assert.equal(written.created[0].employee_id, 78, "the caller knew which namesake");
    assert.equal(written.created[0].employee_name, "Amit P", "and the name is still written");
  });

  it("a unique name resolves to that employee", async () => {
    const { usecase, written } = build();
    await usecase.create({ ...MEMBER, employee_name: "Asha K" });
    assert.equal(written.created[0].employee_id, 42);
  });

  it("AN AMBIGUOUS NAME RESOLVES TO NULL, never to a guess", async () => {
    const { usecase, written } = build();
    await usecase.create({ ...MEMBER, employee_name: "Amit P" });
    assert.equal(
      written.created[0].employee_id,
      null,
      "attaching this to 77 or 78 would give one employee another's family"
    );
    assert.equal(written.created[0].employee_name, "Amit P", "still findable by name, as before");
  });

  it("a name no employee holds resolves to null", async () => {
    const { usecase, written } = build();
    await usecase.create({ ...MEMBER, employee_name: "Ghost" });
    assert.equal(written.created[0].employee_id, null);
  });

  it("a junk id is not trusted - it falls back to the name", async () => {
    const { usecase, written } = build();
    for (const bad of ["0", 0, -3, "abc", 1.5, null]) {
      const w = build();
      await w.usecase.create({ ...MEMBER, employee_id: bad, employee_name: "Asha K" });
      assert.equal(w.written.created[0].employee_id, 42, `${JSON.stringify(bad)} must not be written as an id`);
    }
    assert.equal(written.created.length, 0);
  });
});

describe("editing a record keeps the two columns in agreement", () => {
  it("moving it to another employee moves the id with it", async () => {
    const { usecase, written } = build();
    await usecase.updateFamilyDetails({ family_id: 9, family_details: { employee_name: "Asha K" } });
    assert.equal(written.updated[0].details.employee_id, 42);
  });

  it("an explicit id wins on an edit too", async () => {
    const { usecase, written } = build();
    await usecase.updateFamilyDetails({
      family_id: 9,
      family_details: { employee_name: "Amit P", employee_id: 77 },
    });
    assert.equal(written.updated[0].details.employee_id, 77);
  });

  it("moving it to an ambiguous name detaches the id rather than leaving a stale one", async () => {
    const { usecase, written } = build();
    await usecase.updateFamilyDetails({ family_id: 9, family_details: { employee_name: "Amit P" } });
    assert.equal(
      written.updated[0].details.employee_id,
      null,
      "a row reading correctly by name and wrongly by id is worse than one unattached"
    );
  });

  it("an edit that does not touch the employee leaves the id alone", async () => {
    const { usecase, written } = build();
    await usecase.updateFamilyDetails({ family_id: 9, family_details: { remarks: "typo fixed" } });
    assert.equal("employee_id" in written.updated[0].details, false, "no employee column was sent, none is written");
  });
});

describe("reading", () => {
  it("by id works and is validated", async () => {
    const { usecase } = build();
    const rows = await usecase.getFamilyByEmployeeId(42);
    assert.equal(rows[0].employee_id, 42);
    for (const bad of [0, -1, "abc", null, undefined]) {
      await assert.rejects(usecase.getFamilyByEmployeeId(bad), /employee_id/);
    }
  });

  it("by name still works, because unattached rows are only findable that way", async () => {
    const { usecase } = build();
    const rows = await usecase.getFamilyByEmployee("Amit P");
    assert.equal(rows[0].employee_name, "Amit P");
  });
});

describe("a failed write is no longer reported as a save", () => {
  it("the repository's duplicate code reaches the caller", async () => {
    const repo = {
      findEmployeeIdByName: async () => 42,
      create: async () => ({ code: 101 }),
    };
    const usecase = buildUsecase(repo);
    assert.equal(await usecase.create({ ...MEMBER, employee_name: "Asha K" }), 101);
  });

  it("and a rejected insert rejects instead of resolving 200", async () => {
    // create() used to call the repository without awaiting it and resolve
    // 200 unconditionally, so the screen said "Successfully Added" whatever
    // happened.
    const repo = {
      findEmployeeIdByName: async () => 42,
      create: async () => { throw new Error("ER_NO_REFERENCED_ROW_2"); },
    };
    const usecase = buildUsecase(repo);
    await assert.rejects(usecase.create({ ...MEMBER, employee_name: "Asha K" }), /ER_NO_REFERENCED_ROW_2/);
  });
});
