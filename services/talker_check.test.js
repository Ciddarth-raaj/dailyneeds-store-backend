const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { deriveVerdict } = require("./talker_check");

/** A photo where everything checks out. */
function clean(overrides = {}) {
  return {
    talker_present: true,
    talker_readable: true,
    brand_match: true,
    price_match: true,
    product_visible: true,
    verdict_hint: "accept",
    reason: "",
    confidence: 0.95,
    ...overrides,
  };
}

describe("deriveVerdict", () => {
  it("accepts when every check passes", () => {
    assert.equal(deriveVerdict(clean()).verdict, "accept");
  });

  it("rejects a missing talker - this is the management problem", () => {
    assert.equal(deriveVerdict(clean({ talker_present: false })).verdict, "reject");
  });

  it("rejects a brand mismatch", () => {
    assert.equal(deriveVerdict(clean({ brand_match: false })).verdict, "reject");
  });

  it("rejects a price mismatch - the live complaint source", () => {
    assert.equal(deriveVerdict(clean({ price_match: false })).verdict, "reject");
  });

  it("asks for a retake when the text is unreadable - a staff problem, not a reject", () => {
    assert.equal(deriveVerdict(clean({ talker_readable: false })).verdict, "retake");
  });

  it("asks for a retake on low confidence rather than accepting", () => {
    assert.equal(deriveVerdict(clean({ confidence: 0.4 })).verdict, "retake");
  });

  it("does not fail a photo just because placement could not be confirmed", () => {
    const result = deriveVerdict(clean({ product_visible: false }));
    assert.equal(result.verdict, "accept");
    assert.match(result.reason, /placement/i);
  });

  it("ignores the model's own verdict_hint - rules live in code", () => {
    // Model says accept, but the booleans say the sign is missing.
    const result = deriveVerdict(clean({ talker_present: false, verdict_hint: "accept" }));
    assert.equal(result.verdict, "reject");
  });

  it("flags a low-confidence reject so it can escalate before being shown", () => {
    const result = deriveVerdict(clean({ talker_present: false, confidence: 0.3 }));
    assert.equal(result.verdict, "reject");
    assert.equal(result.lowConfidence, true);
  });

  it("does not flag a confident reject for escalation", () => {
    const result = deriveVerdict(clean({ talker_present: false, confidence: 0.98 }));
    assert.equal(result.verdict, "reject");
    assert.equal(result.lowConfidence, false);
  });

  it("treats a missing/garbled confidence as low confidence", () => {
    assert.equal(deriveVerdict(clean({ confidence: undefined })).verdict, "retake");
    assert.equal(deriveVerdict(clean({ confidence: "abc" })).verdict, "retake");
  });

  it("checks readability before brand/price - an unreadable sign is a retake", () => {
    // Unreadable AND mismatched: staff can fix the photo, so ask for that first.
    const result = deriveVerdict(
      clean({ talker_readable: false, brand_match: false })
    );
    assert.equal(result.verdict, "retake");
  });

  it("survives a null observation without throwing", () => {
    assert.equal(deriveVerdict(null).verdict, "reject");
  });
});
