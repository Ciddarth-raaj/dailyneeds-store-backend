/**
 * Transporter Master field rules.
 *
 *   node --test utils/transporter.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const T = require("./transporter");

describe("the duplicate-protection key", () => {
  it("ignores case and spacing", () => {
    assert.equal(T.nameKey("  VRL   Logistics "), "vrl logistics");
    assert.equal(T.nameKey("vrl logistics"), T.nameKey("VRL LOGISTICS"));
    assert.equal(T.cleanName("  VRL   Logistics "), "VRL Logistics");
  });
});

describe("contact numbers", () => {
  it("accepts mobiles in any common spelling, stored as ten digits", () => {
    for (const v of ["9876543210", "+91 98765 43210", "098765-43210", "(98765) 43210"]) {
      assert.equal(T.normalizeContact(v), "9876543210", v);
    }
  });

  it("accepts landlines with STD code and service numbers", () => {
    assert.equal(T.normalizeContact("044-2345 6789"), "04423456789");
    assert.equal(T.normalizeContact("1800 123 4567"), "18001234567");
  });

  it("refuses anything that cannot be dialled", () => {
    for (const v of ["", null, undefined, "12345", "23456789", "98765abc10", "5876543210", "98765432101234"]) {
      assert.equal(T.normalizeContact(v), null, String(v));
    }
  });
});

describe("validateTransporter", () => {
  it("requires a name and a valid contact number on create", () => {
    const { errors } = T.validateTransporter({});
    assert.ok(errors.transporter_name);
    assert.ok(errors.contact_no);
  });

  it("keeps optional fields optional, and empties them to null", () => {
    const { value, errors } = T.validateTransporter({
      transporter_name: "KPN",
      contact_no: "9123456789",
      alternate_contact_no: "",
      contact_person: "  ",
      remarks: "Night service",
    });
    assert.deepEqual(errors, {});
    assert.equal(value.alternate_contact_no, null);
    assert.equal(value.contact_person, null);
    assert.equal(value.remarks, "Night service");
  });

  it("rejects an invalid alternate number and one equal to the main number", () => {
    assert.ok(T.validateTransporter({ transporter_name: "A", contact_no: "9123456789", alternate_contact_no: "1" }).errors.alternate_contact_no);
    assert.ok(
      T.validateTransporter({ transporter_name: "A", contact_no: "9123456789", alternate_contact_no: "+91 91234 56789" }).errors
        .alternate_contact_no
    );
  });

  it("on edit, checks only what was sent", () => {
    assert.deepEqual(T.validateTransporter({ is_active: false }, { partial: true }), { value: { is_active: false }, errors: {} });
    assert.ok(T.validateTransporter({ contact_no: "x" }, { partial: true }).errors.contact_no);
  });

  it("labels a transporter by name and contact", () => {
    assert.equal(T.transporterLabel({ transporter_name: "VRL", contact_no: "9876543210" }), "VRL (9876543210)");
  });
});
