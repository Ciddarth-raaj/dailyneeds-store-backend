/**
 * INDIAN MOBILE NORMALISATION.
 *
 *   node --test utils/mobile_number.test.js
 *
 * Every accepted spelling must reach the SAME canonical value, and everything
 * that is not a mobile must reach null - because null is what makes a
 * comparison fail, and a comparison that accidentally succeeds is an employee
 * verified as somebody else.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizeIndianMobile,
  isValidIndianMobile,
  mobilesMatch,
} = require("./mobile_number");

describe("accepted spellings", () => {
  // The four the specification names, plus the ones real employee records
  // actually hold.
  const SAME = [
    "9876543210",
    "+919876543210",
    "919876543210",
    "+91 9876543210",
    "+91 98765 43210",
    "98765-43210",
    "+91-98765-43210",
    "091-98765-43210",
    "09876543210",
    "0919876543210",
    "0091 98765 43210",
    " 9876543210 ",
    "(98765) 43210",
    "98765.43210",
    9876543210,
  ];

  for (const value of SAME) {
    it(`${JSON.stringify(value)} normalises to 9876543210`, () => {
      assert.equal(normalizeIndianMobile(value), "9876543210");
    });
  }

  it("every accepted spelling equals every other", () => {
    const canonical = SAME.map(normalizeIndianMobile);
    assert.equal(new Set(canonical).size, 1);
    for (const a of SAME) {
      for (const b of SAME) assert.ok(mobilesMatch(a, b));
    }
  });

  it("accepts each of the four Indian mobile series", () => {
    for (const first of ["6", "7", "8", "9"]) {
      assert.equal(normalizeIndianMobile(`${first}876543210`), `${first}876543210`);
    }
  });
});

describe("refused values", () => {
  const REFUSED = {
    empty: "",
    blank: "   ",
    null: null,
    undefined: undefined,
    "too short": "987654321",
    "too long": "98765432109",
    "landline series 1": "1234567890",
    "landline series 2": "2345678901",
    "series 5": "5876543210",
    "series 0 after stripping": "0000000000",
    letters: "98765abcde",
    "letters mixed in": "98765 4321O",
    "a word": "not a number",
    "two plus signs": "++919876543210",
    "plus in the middle": "9876+43210",
    "91 without ten digits": "919876",
    "91 with eleven digits": "9198765432100",
    "an object": {},
    "an array": [],
    "a boolean": true,
    "landline with std": "+914132234567",
  };

  for (const [name, value] of Object.entries(REFUSED)) {
    it(`refuses ${name}`, () => {
      assert.equal(normalizeIndianMobile(value), null);
      assert.equal(isValidIndianMobile(value), false);
    });
  }
});

describe("matching", () => {
  it("matches across formats", () => {
    assert.ok(mobilesMatch("+919876543210", "9876543210"));
    assert.ok(mobilesMatch("98765 43210", "+91-98765-43210"));
  });

  it("does not match two different numbers", () => {
    assert.equal(mobilesMatch("9876543210", "9876543211"), false);
  });

  // THE ONE THAT MATTERS MOST. Two unusable values are not a match: an
  // employee with no recorded mobile must never be verifiable by somebody who
  // shared nothing, which is exactly what `normalize(a) === normalize(b)`
  // would do with two nulls.
  it("NEVER matches when either side is unusable", () => {
    assert.equal(mobilesMatch(null, null), false);
    assert.equal(mobilesMatch("", ""), false);
    assert.equal(mobilesMatch("junk", "junk"), false);
    assert.equal(mobilesMatch(undefined, undefined), false);
    assert.equal(mobilesMatch("9876543210", null), false);
    assert.equal(mobilesMatch(null, "9876543210"), false);
    assert.equal(mobilesMatch("9876543210", "not a number"), false);
  });
});

describe("it never rewrites anything", () => {
  it("is a pure read - the input object is untouched", () => {
    const employee = { primary_contact_number: "+91 98765 43210" };
    normalizeIndianMobile(employee.primary_contact_number);
    mobilesMatch("9876543210", employee.primary_contact_number);
    assert.equal(employee.primary_contact_number, "+91 98765 43210");
  });
});
