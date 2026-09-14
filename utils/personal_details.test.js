/**
 * Personal Details mandatory-field rules.
 *
 *   node --test utils/personal_details.test.js
 *
 * The rules that matter most here are the NEGATIVE ones: what must NOT block
 * a save. Blood Group and Email are optional; Spouse Name and Marriage Date
 * are optional for anybody who is not married; and a patch that does not
 * touch Personal Details at all is not a Personal Details save and is never
 * judged as one - which is what keeps a 2013 employee with no date of birth
 * on file viewable and editable everywhere else.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const v = require("./personal_details");

const complete = () => ({
  employee_name: "Anitha R",
  father_name: "Ramesh",
  dob: "1994-02-11",
  gender: "F",
  marital_status: "Single",
  primary_contact_number: "9876543210",
  alternate_contact_number: "9876500000",
  permanent_address: "12 Main Street",
  residential_address: "12 Main Street",
});

const fields = (row) => v.missingPersonalDetails(row).map((m) => m.field);

describe("missingPersonalDetails", () => {
  it("accepts a complete unmarried record", () => {
    assert.deepEqual(fields(complete()), []);
  });

  it("names every always-mandatory field that is blank", () => {
    assert.deepEqual(fields({}), [
      "employee_name",
      "father_name",
      "dob",
      "gender",
      "marital_status",
      "primary_contact_number",
      "alternate_contact_number",
      "permanent_address",
      "residential_address",
    ]);
  });

  it("treats whitespace as blank", () => {
    assert.ok(fields({ ...complete(), father_name: "   " }).includes("father_name"));
  });

  it("does NOT require blood group or email", () => {
    const row = { ...complete(), blood_group: "", email_id: "" };
    assert.deepEqual(fields(row), []);
    for (const f of v.NEVER_REQUIRED) {
      assert.ok(!v.ALWAYS_REQUIRED.some(([key]) => key === f), `${f} must not be always-required`);
    }
  });

  it("requires spouse name and marriage date only when married", () => {
    const married = { ...complete(), marital_status: "Married" };
    assert.deepEqual(fields(married), ["spouse_name", "marriage_date"]);
    assert.deepEqual(
      fields({ ...married, spouse_name: "Karthik", marriage_date: "2019-05-02" }),
      []
    );
  });

  it("does not require them for single, widowed or divorced", () => {
    for (const status of ["Single", "Widowed", "Divorced"]) {
      assert.deepEqual(fields({ ...complete(), marital_status: status }), [], status);
    }
  });

  it("matches Married however it is cased or padded", () => {
    assert.equal(v.isMarried(" married "), true);
    assert.equal(v.isMarried("MARRIED"), true);
    assert.equal(v.isMarried("Single"), false);
    assert.equal(v.isMarried(null), false);
  });
});

describe("isPersonalDetailsWrite", () => {
  it("is false for a patch that touches no personal field", () => {
    assert.equal(v.isPersonalDetailsWrite({ qualification: "B.Com" }), false);
    assert.equal(v.isPersonalDetailsWrite({ designation_id: 4, store_id: 2 }), false);
    assert.equal(v.isPersonalDetailsWrite({}), false);
    assert.equal(v.isPersonalDetailsWrite(null), false);
  });

  it("is true for any one of them, even set to blank", () => {
    assert.equal(v.isPersonalDetailsWrite({ email_id: "" }), true);
    assert.equal(v.isPersonalDetailsWrite({ dob: "1990-01-01" }), true);
  });
});

describe("mergeForValidation", () => {
  it("judges the row the save will produce, not the patch alone", () => {
    const before = complete();
    const merged = v.mergeForValidation(before, { email_id: "a@b.c" });
    assert.deepEqual(fields(merged), [], "an unrelated edit does not invent missing fields");
  });

  it("lets a patch CLEAR a mandatory field, and then refuses it", () => {
    const merged = v.mergeForValidation(complete(), { father_name: "" });
    assert.deepEqual(fields(merged), ["father_name"]);
  });

  it("ignores non-personal keys in the patch", () => {
    const merged = v.mergeForValidation(complete(), { designation_id: 9 });
    assert.equal(merged.designation_id, undefined);
  });
});

describe("missingMessage", () => {
  it("names every missing field in one sentence", () => {
    const msg = v.missingMessage(v.missingPersonalDetails({ ...complete(), dob: "" }));
    assert.match(msg, /Date of Birth is required/);
  });

  it("is null when nothing is missing", () => {
    assert.equal(v.missingMessage([]), null);
  });
});
