/**
 * Stage 0C / C2 — the bank name comparison.
 *
 *   node --test utils/name_match.test.js
 *
 * Two failure modes, pulling opposite ways. Too strict and HR is asked to
 * confirm "R KUMAR" against "Ramesh Kumar" every single time, learns to click
 * through, and the check stops meaning anything. Too loose and a payment goes
 * to the wrong person. So the cases below are mostly REAL shapes Indian bank
 * records take, and the last group is the one that must never pass.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { compareNames, compareNameAtBank, tokenise } = require("./name_match");

const verdict = (a, b) => compareNames(a, b).verdict;

describe("the same person, spelled differently, is a MATCH", () => {
  it("case and spacing", () => {
    assert.equal(verdict("RAMESH KUMAR", "Ramesh Kumar"), "MATCH");
    assert.equal(verdict("ramesh   kumar ", "  Ramesh Kumar"), "MATCH");
  });

  it("an initial standing for a full first name", () => {
    assert.equal(verdict("R KUMAR", "Ramesh Kumar"), "MATCH");
    assert.equal(verdict("R. Kumar", "Ramesh Kumar"), "MATCH");
  });

  it("surname first, as many banks store it", () => {
    assert.equal(verdict("KUMAR RAMESH", "Ramesh Kumar"), "MATCH");
  });

  it("an honorific the bank added", () => {
    assert.equal(verdict("MR RAMESH KUMAR", "Ramesh Kumar"), "MATCH");
    assert.equal(verdict("Smt. Priya Sharma", "Priya Sharma"), "MATCH");
  });

  it("punctuation in a surname", () => {
    assert.equal(verdict("D'SOUZA MARIA", "Maria DSouza"), "MATCH");
    assert.equal(verdict("Anita Smith-Jones", "Anita Smith Jones"), "MATCH");
  });

  it("a middle name present on one side only", () => {
    assert.equal(verdict("RAMESH KUMAR", "Ramesh Prasad Kumar"), "MATCH");
    assert.equal(verdict("RAMESH PRASAD KUMAR", "Ramesh Kumar"), "MATCH");
  });

  it("extra whitespace, dots and mixed case together", () => {
    assert.equal(verdict("  MR.  R.  KUMAR  ", "ramesh kumar"), "MATCH");
  });
});

describe("plausible but uncertain is REVIEW, not a silent pass", () => {
  it("only initials on both sides", () => {
    assert.equal(verdict("R K", "Ramesh Kumar"), "REVIEW");
    assert.equal(verdict("R.K.", "Ramesh Kumar"), "REVIEW");
  });

  it("one name of two matching", () => {
    assert.equal(verdict("RAMESH SHARMA", "Ramesh Kumar"), "REVIEW");
  });

  it("an empty name on one side", () => {
    assert.equal(verdict("", "Ramesh Kumar"), "REVIEW");
    assert.equal(verdict("RAMESH KUMAR", null), "REVIEW");
  });

  it("many extra name parts", () => {
    assert.equal(verdict("RAMESH", "Ramesh Kumar Prasad Sharma Nair"), "REVIEW");
  });
});

describe("a different person is a MISMATCH, and can never be confirmed", () => {
  it("no overlap at all", () => {
    assert.equal(verdict("PRIYA SHARMA", "Ramesh Kumar"), "MISMATCH");
    assert.equal(verdict("ACME TRADING COMPANY", "Ramesh Kumar"), "MISMATCH");
  });

  it("a same-letter initial is not a match on its own", () => {
    // "R" could be Ramesh or Rajesh; one letter and nothing else is not
    // evidence, and this is the case that must not quietly pass.
    assert.equal(verdict("R SHARMA", "Ramesh Kumar"), "REVIEW");
    assert.notEqual(verdict("R SHARMA", "Ramesh Kumar"), "MATCH");
  });

  it("a similar-looking but different name", () => {
    assert.equal(verdict("RAJESH KUMAR", "Ramesh Kumar"), "REVIEW");
    assert.notEqual(verdict("RAJESH KUMAR", "Ramesh Kumar"), "MATCH");
  });
});

describe("comparing against both the record and the Aadhaar", () => {
  it("the best verdict wins, so a shortened HR spelling does not block a match", () => {
    const res = compareNameAtBank("RAMESH KUMAR SHARMA", {
      employeeName: "Priya Nair",
      aadhaarName: "Ramesh Kumar Sharma",
    });
    assert.equal(res.verdict, "MATCH");
    assert.equal(res.matched_against, "aadhaar_name");
  });

  it("both comparisons are reported, whichever won", () => {
    const res = compareNameAtBank("RAMESH KUMAR", {
      employeeName: "Ramesh Kumar",
      aadhaarName: "Ramesh Kumar",
    });
    assert.equal(res.compared.length, 2);
    assert.deepEqual(res.compared.map((c) => c.source).sort(), ["aadhaar_name", "employee_name"]);
    assert.equal(res.matched_against, "aadhaar_name", "the verified name is the one reported on a tie");
  });

  it("no Aadhaar simply means one comparison", () => {
    const res = compareNameAtBank("RAMESH KUMAR", { employeeName: "Ramesh Kumar" });
    assert.equal(res.verdict, "MATCH");
    assert.equal(res.compared.length, 1);
  });

  it("nothing to compare against is REVIEW, never MATCH", () => {
    const res = compareNameAtBank("RAMESH KUMAR", {});
    assert.equal(res.verdict, "REVIEW");
    assert.equal(res.compared.length, 0);
  });

  it("a mismatch against both stays a mismatch", () => {
    const res = compareNameAtBank("ACME TRADING", {
      employeeName: "Ramesh Kumar",
      aadhaarName: "Ramesh Kumar Sharma",
    });
    assert.equal(res.verdict, "MISMATCH");
  });
});

describe("tokenising", () => {
  it("strips honorifics and punctuation and lower-cases", () => {
    assert.deepEqual(tokenise("Mr. R.K. D'Souza-Nair"), ["r", "k", "dsouza", "nair"]);
    assert.deepEqual(tokenise("SMT PRIYA SHARMA"), ["priya", "sharma"]);
  });

  it("survives nothing at all", () => {
    assert.deepEqual(tokenise(null), []);
    assert.deepEqual(tokenise(""), []);
    assert.deepEqual(tokenise("   ...   "), []);
  });

  it("is order-insensitive by construction, so the caller need not sort", () => {
    assert.equal(compareNames("Ramesh Kumar Sharma", "Sharma Kumar Ramesh").verdict, "MATCH");
    // All-initials on both sides is still REVIEW, whatever the order: three
    // single letters are not evidence of anything.
    assert.equal(compareNames("A B C", "C B A").verdict, "REVIEW");
  });
});
