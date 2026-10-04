/**
 * The joining-date entry window on the LEGACY employee writes - POST /employee
 * (create), POST /employee/updatedata (update) and the bulk upsert - called
 * directly, the way any API client can call them without the browser.
 *
 *   node --test usecase/employee_joining_date_window.test.js
 *
 * The rule is the same module `POST /hr/employee` uses
 * (`utils/joining_date_window.js`); what is under test here is that these
 * paths apply it, that a refused request writes NOTHING, and that a stored
 * historical date riding along unchanged is not judged.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const employeeUsecaseFactory = require("./employee");

const TODAY = "2026-10-04";
const EARLY = "Joining date cannot be more than 30 days before today.";
const LATE = "Joining date cannot be more than 30 days after today.";

/** A stand-in repository that records every write and holds one stored employee. */
function world(stored = { 1500: "2015-06-15" }) {
  const writes = { created: [], updated: [], bulk: [] };
  const employeeRepo = {
    create: async (employee) => {
      writes.created.push(employee);
      return { code: 200, id: 2001 };
    },
    getJoiningDate: async (id) =>
      Object.prototype.hasOwnProperty.call(stored, id)
        ? { found: true, date_of_joining: stored[id] }
        : { found: false },
    updateEmployeeDetails: async (data, id) => {
      writes.updated.push({ id, data: { ...data } });
      return { code: 200 };
    },
    updateEmployeeImage: async () => {
      writes.image = true;
    },
    bulkCreate: async (rows) => {
      writes.bulk.push(rows);
      return { affectedRows: rows.length };
    },
  };
  const documentUsecase = {
    create: async () => {
      writes.document = true;
    },
    update: async () => {
      writes.document = true;
    },
  };
  const userRepo = {
    createLogin: async () => {},
    createLoginIfNeeded: async () => {},
  };
  const uc = employeeUsecaseFactory(employeeRepo, documentUsecase, userRepo, {});
  uc.today = () => TODAY;
  return { uc, writes };
}

const refusedWith = (message) => (err) => {
  assert.equal(err.name, "ValidationError");
  assert.equal(err.message, message);
  return true;
};

describe("12. POST /employee (legacy create), called directly", () => {
  it("creates with a joining date inside the window", async () => {
    const { uc, writes } = world();
    assert.equal(await uc.create({ employee_name: "A", date_of_joining: "2026-10-03" }), 200);
    assert.equal(writes.created.length, 1);
  });

  it("refuses the 03/10/2006 typo and writes nothing", async () => {
    const { uc, writes } = world();
    await assert.rejects(() => uc.create({ employee_name: "A", date_of_joining: "2006-10-03" }), refusedWith(EARLY));
    assert.equal(writes.created.length, 0);
  });

  it("refuses a date more than 30 days ahead", async () => {
    const { uc, writes } = world();
    await assert.rejects(() => uc.create({ employee_name: "A", date_of_joining: "2026-11-04" }), refusedWith(LATE));
    assert.equal(writes.created.length, 0);
  });

  it("refuses a create with no joining date at all - the gap that let undated hires in", async () => {
    const { uc, writes } = world();
    await assert.rejects(() => uc.create({ employee_name: "A", date_of_joining: "" }), /YYYY-MM-DD/);
    await assert.rejects(() => uc.create({ employee_name: "A" }), /YYYY-MM-DD/);
    assert.equal(writes.created.length, 0);
  });
});

describe("POST /employee/updatedata (legacy update), called directly", () => {
  const update = (uc, details, id = 1500) => uc.updateEmployeeDetails({ employee_id: id, employee_details: details });

  it("9. a 2015 employee's phone-number edit is allowed", async () => {
    const { uc, writes } = world();
    await update(uc, { primary_contact_number: 9000000001 });
    assert.deepEqual(writes.updated[0].data, { primary_contact_number: 9000000001 });
  });

  it("10. the unchanged 2015 joining date in the payload is allowed, and not rewritten", async () => {
    const { uc, writes } = world();
    await update(uc, { primary_contact_number: 9000000002, date_of_joining: "2015-06-15" });
    assert.deepEqual(writes.updated[0].data, { primary_contact_number: 9000000002 });
  });

  it("11. changing the joining date to 2010 is refused before anything is written", async () => {
    const { uc, writes } = world();
    await assert.rejects(
      () => update(uc, { primary_contact_number: 9000000003, date_of_joining: "2010-01-01", modified_employee_image: "x" }),
      refusedWith(EARLY)
    );
    assert.equal(writes.updated.length, 0);
    assert.equal(writes.image, undefined, "no image written either");
  });

  it("even a change inside the window is refused here - it belongs to the joining-date action", async () => {
    const { uc, writes } = world();
    await assert.rejects(() => update(uc, { date_of_joining: "2026-10-03" }), /corrected through the joining-date action/);
    assert.equal(writes.updated.length, 0);
  });

  it("clearing a stored joining date is a change, and is refused", async () => {
    const { uc, writes } = world();
    await assert.rejects(() => update(uc, { date_of_joining: "" }), /corrected through the joining-date action/);
    assert.equal(writes.updated.length, 0);
  });

  it("legacy API cannot bypass the historical-correction permission: an old date for a missing DOJ is refused", async () => {
    // This route has no permission, reason or audit for a historical
    // correction, so it must not be a way to record one.
    const { uc, writes } = world({ 1500: "2015-06-15", 1600: null });
    await assert.rejects(() => update(uc, { date_of_joining: "2012-04-01" }, 1600), refusedWith(EARLY));
    await assert.rejects(
      () => update(uc, { date_of_joining: "2015-06-01", correction_reason: "HR file shows 1 June 2015" }),
      refusedWith(EARLY)
    );
    assert.equal(writes.updated.length, 0);
  });

  it("an employee with no stored date may still save other fields with the blank resent", async () => {
    const { uc, writes } = world({ 1600: null });
    await update(uc, { primary_contact_number: 9000000004, date_of_joining: "" }, 1600);
    assert.deepEqual(writes.updated[0].data, { primary_contact_number: 9000000004 });
  });
});

describe("13. the bulk upsert follows the same rule", () => {
  it("refuses the whole batch when any row's joining date is outside the window, writing nothing", async () => {
    const { uc, writes } = world();
    await uc.bulkCreate([
      { employee_id: 3001, date_of_joining: "2026-10-01" },
      { employee_id: 3002, date_of_joining: "2006-10-03" },
    ]);
    assert.equal(writes.bulk.length, 0);
  });

  it("writes a batch whose joining dates are all inside the window", async () => {
    const { uc, writes } = world();
    await uc.bulkCreate([{ employee_id: 3001, date_of_joining: "2026-10-01" }]);
    assert.equal(writes.bulk.length, 1);
  });
});
