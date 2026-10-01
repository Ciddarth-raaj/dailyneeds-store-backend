/**
 * Credit Purchase bill reference normalisation.
 *
 *   node --test utils/credit_purchase.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { cleanBillReference, billReferenceKey } = require("./credit_purchase");

describe("the duplicate key", () => {
  it("treats the usual spellings of one bill as one", () => {
    const keys = ["KF/2026/101", "kf-2026-101", " KF 2026 101 ", "Kf.2026.101", "KF_2026_101", "KF#2026/101"].map(
      billReferenceKey
    );
    assert.equal(new Set(keys).size, 1);
    assert.equal(keys[0], "KF2026101");
  });

  it("keeps genuinely different bills apart", () => {
    assert.notEqual(billReferenceKey("KF/2026/101"), billReferenceKey("KF/2026/1010"));
    assert.notEqual(billReferenceKey("INV-101"), billReferenceKey("INV-102"));
  });

  it("has nothing left for a reference of only separators", () => {
    assert.equal(billReferenceKey(" / - "), "");
    assert.equal(billReferenceKey(null), "");
  });

  it("stores the reference as entered, tidied", () => {
    assert.equal(cleanBillReference("  KF/2026   101 "), "KF/2026 101");
  });
});
