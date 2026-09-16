const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  UPDATE_FIELD_KEYS,
  fieldForLabel,
  resolveSelectedFields,
  buildMasterIndex,
  parseDateCell,
  displayDate,
  isBlankCell,
} = require("./employee_bulk_fields");

describe("employee bulk field catalogue", () => {
  it("offers exactly the six approved update fields, and not Shift", () => {
    assert.deepEqual(UPDATE_FIELD_KEYS, [
      "store_id",
      "department_id",
      "designation_id",
      "employment_type",
      "grade",
      "date_of_joining",
    ]);
  });

  it("matches header labels case- and space-insensitively", () => {
    assert.equal(fieldForLabel("  employee id ").key, "employee_id");
    assert.equal(fieldForLabel("Date of Joining").key, "date_of_joining");
    assert.equal(fieldForLabel("Salary"), null);
    assert.equal(fieldForLabel("status"), null);
  });

  it("refuses a field key that is not in the catalogue", () => {
    const out = resolveSelectedFields(["grade", "salary"]);
    assert.equal(out.ok, false);
    assert.deepEqual(out.unknown, ["salary"]);
  });

  it("returns selected fields in catalogue order, not the caller's", () => {
    const out = resolveSelectedFields(["grade", "store_id"]);
    assert.deepEqual(out.fields.map((f) => f.key), ["store_id", "grade"]);
  });
});

describe("master labelling and resolution", () => {
  const outlets = [
    { id: 1, name: "ECR", active: 1 },
    { id: 2, name: "Muthialpet", active: 1 },
    { id: 3, name: "Muthialpet", active: 1 },
    { id: 4, name: "Closed Branch", active: 0 },
  ];
  const index = buildMasterIndex(outlets);

  it("labels every row as 'Name [ID]', duplicated names included", () => {
    assert.equal(index.labelForId(1), "ECR [1]");
    assert.equal(index.labelForId(2), "Muthialpet [2]");
    assert.equal(index.labelForId(3), "Muthialpet [3]");
  });

  it("ROUND-TRIPS: an untouched exported label always resolves back to its own row", () => {
    // The defect that motivated `Name [ID]`. Under the old `Name [CODE]`
    // labelling, two same-named masters with NULL codes - which is every
    // department and designation created since the Digisme sync was removed -
    // exported as the SAME bare label, so re-uploading an UNEDITED export was
    // refused as ambiguous. The primary key cannot do that.
    for (const row of outlets) {
      const outcome = index.resolve(index.labelForId(row.id));
      assert.equal(outcome.status, "OK", `${index.labelForId(row.id)} did not round-trip`);
      assert.equal(outcome.row.id, row.id);
    }
  });

  it("does not depend on a master code column at all", () => {
    // Built from id/name/active only. A master row carrying no code - the
    // normal case for department and designation - is fully usable.
    const noCodes = buildMasterIndex([{ id: 7, name: "Accounts", active: 1 }]);
    assert.equal(noCodes.labelForId(7), "Accounts [7]");
    assert.equal(noCodes.resolve("Accounts [7]").status, "OK");
    assert.deepEqual(Object.keys(noCodes.rows[0]).sort(), ["active", "id", "name"]);
  });

  it("offers only active rows as dropdown values", () => {
    assert.deepEqual(index.activeLabels(), ["ECR [1]", "Muthialpet [2]", "Muthialpet [3]"]);
  });

  it("resolves the bracketed form, tolerating case and spacing", () => {
    assert.equal(index.resolve("Muthialpet [3]").row.id, 3);
    assert.equal(index.resolve("  muthialpet [3]  ").row.id, 3);
    assert.equal(index.resolve("Muthialpet [ 3 ]").row.id, 3);
  });

  it("resolves a bare name only when it is unambiguous", () => {
    assert.equal(index.resolve("ECR").row.id, 1);
    assert.equal(index.resolve("  ecr  ").row.id, 1);
    assert.equal(index.resolve("Muthialpet").status, "AMBIGUOUS");
    assert.equal(index.resolve("Muthialpet").rows.length, 2);
  });

  it("NEVER TRUSTS THE ID ALONE: a name that no longer matches is refused", () => {
    // The master was renamed after the file was exported, or somebody edited
    // the label and left the id behind. Either way the file and the database
    // disagree about what this id means.
    const outcome = index.resolve("Old Name [1]");
    assert.equal(outcome.status, "NAME_MISMATCH");
    assert.equal(outcome.row.id, 1);
    assert.equal(outcome.claimed, "Old Name");
  });

  it("refuses a bracketed id that does not exist, rather than reporting a mismatch", () => {
    assert.equal(index.resolve("Anything [999]").status, "UNKNOWN");
  });

  it("reports an unknown name as UNKNOWN and a blank cell as BLANK", () => {
    assert.equal(index.resolve("Nowhere").status, "UNKNOWN");
    assert.equal(index.resolve("   ").status, "BLANK");
  });

  it("still labels an employee sitting on an inactive branch", () => {
    // Readable export is not the same decision as assignability; the usecase
    // refuses assignment TO an inactive row.
    assert.equal(index.labelForId(4), "Closed Branch [4]");
    assert.equal(index.resolve("Closed Branch [4]").status, "OK");
  });
});

describe("date cells", () => {
  it("reads dd/mm/yyyy, with / - or . as the separator", () => {
    assert.equal(parseDateCell("15/06/2024").date, "2024-06-15");
    assert.equal(parseDateCell("1-6-2024").date, "2024-06-01");
    assert.equal(parseDateCell("15.06.2024").date, "2024-06-15");
  });

  it("reads a genuine Excel date cell and an Excel serial", () => {
    assert.equal(parseDateCell(new Date("2024-06-15T00:00:00Z")).date, "2024-06-15");
    // 45458 is 2024-06-15 in the 1900 date system.
    assert.equal(parseDateCell(45458).date, "2024-06-15");
    assert.equal(parseDateCell("45458").date, "2024-06-15");
  });

  it("reads the ISO form the API itself emits, so an untouched cell round-trips", () => {
    assert.equal(parseDateCell("2024-06-15").date, "2024-06-15");
    assert.equal(parseDateCell("2024-06-15T00:00:00.000Z").date, "2024-06-15");
  });

  it("refuses a date that does not exist rather than rolling it over", () => {
    assert.equal(parseDateCell("31/02/2024").status, "INVALID");
    assert.equal(parseDateCell("2024-13-01").status, "INVALID");
  });

  it("refuses unreadable text", () => {
    assert.equal(parseDateCell("last June").status, "INVALID");
    assert.equal(parseDateCell("15/06/24").status, "INVALID");
  });

  it("treats every shape of empty cell as BLANK, never as a date", () => {
    for (const blank of [null, undefined, "", "   "]) {
      assert.equal(parseDateCell(blank).status, "BLANK");
      assert.equal(isBlankCell(blank), true);
    }
  });

  it("displays a date as dd/mm/yyyy", () => {
    assert.equal(displayDate("2024-06-15"), "15/06/2024");
    assert.equal(displayDate(null), "");
  });
});
