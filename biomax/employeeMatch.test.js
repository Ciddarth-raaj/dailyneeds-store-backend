/**
 * D4: numeric-lenient matching with strict validation, and never 0.
 *
 *   node --test biomax/employeeMatch.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { parseEmployeeCode } = require("./employeeMatch");

describe("parseEmployeeCode", () => {
  it("matches plain and zero-padded numeric codes", () => {
    assert.equal(parseEmployeeCode("1952"), 1952);
    assert.equal(parseEmployeeCode("0042"), 42);
    assert.equal(parseEmployeeCode("000000001"), 1);
    assert.equal(parseEmployeeCode("999999"), 999999);
  });

  const NEVER = [
    ["zero", "0"],
    ["zeros", "000"],
    ["blank", ""],
    ["letters", "A123"],
    ["trailing space", "12 "],
    ["leading space", " 12"],
    ["exponent", "1e3"],
    ["negative", "-5"],
    ["decimal", "1.0"],
    ["plus sign", "+42"],
    ["full-width digits", "１９５２"],
    ["arabic-indic digits", "١٢٣"],
    ["ten digits", "1234567890"],
    ["hex", "0x1F"],
    ["not a string", 1952],
    ["null", null],
    ["undefined", undefined],
  ];

  for (const [label, value] of NEVER) {
    it(`never matches ${label} (${JSON.stringify(value)})`, () => {
      assert.equal(parseEmployeeCode(value), null);
    });
  }

  it("can never produce 0 or a negative", () => {
    for (const v of ["0", "00", "-0", "-1", "0000000000"]) {
      const r = parseEmployeeCode(v);
      assert.ok(r === null || r > 0, v);
    }
  });
});
