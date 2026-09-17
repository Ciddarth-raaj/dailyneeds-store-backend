/**
 * WHICH GRNs THE VERIFICATION PROGRAMME COVERS.
 *
 *   node --test constants/grn_verification.test.js
 *
 * Verification started on a date and is not retrospective. The years of GRNs
 * already synced from GoFrugal were received and checked long before anybody
 * was asked to sign one off, and calling them all "Pending Verification"
 * would invent a backlog nobody owes.
 *
 * The boundary is the part worth pinning: the start date itself is IN scope
 * (it is the first day the feature applies), the day before is not, and the
 * comparison is on the GRN's own calendar date with no timezone in it - so
 * which bills are in scope cannot change with where the reader is sitting.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  VERIFICATION_START_DATE,
  isGrnVerifiable,
} = require("./grn_verification");

describe("isGrnVerifiable", () => {
  it("covers the start date itself and everything after it", () => {
    assert.equal(isGrnVerifiable(VERIFICATION_START_DATE), true);
    assert.equal(isGrnVerifiable("2026-09-18"), true);
    assert.equal(isGrnVerifiable("2027-01-01"), true);
  });

  it("excludes the day before, and every older bill", () => {
    assert.equal(isGrnVerifiable("2026-09-16"), false);
    assert.equal(isGrnVerifiable("2026-08-31"), false);
    assert.equal(isGrnVerifiable("2024-04-01"), false);
  });

  it("reads a timestamp by its calendar day", () => {
    // The repository normalises to YYYY-MM-DD, but a fuller value must not
    // silently fall out of scope.
    assert.equal(isGrnVerifiable("2026-09-17T00:00:00Z"), true);
    assert.equal(isGrnVerifiable("2026-09-17 14:30:00"), true);
    assert.equal(isGrnVerifiable("2026-09-16T23:59:59Z"), false);
  });

  it("FAILS CLOSED on a date it cannot read", () => {
    // Inventing pending verification work for a row we cannot place in time
    // is worse than leaving it out of the programme.
    assert.equal(isGrnVerifiable(null), false);
    assert.equal(isGrnVerifiable(undefined), false);
    assert.equal(isGrnVerifiable(""), false);
    assert.equal(isGrnVerifiable("   "), false);
    assert.equal(isGrnVerifiable("17/09/2026"), false);
    assert.equal(isGrnVerifiable("not a date"), false);
  });
});
