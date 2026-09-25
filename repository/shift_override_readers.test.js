/**
 * EVERY reader of `attendance_date_shift_override` that decides which shift
 * applied on a date skips an override whose authorising request was revoked.
 *
 *   node --test repository/shift_override_readers.test.js
 *
 * A revoked (CANCELLED) SHIFT_CHANGE keeps its override row as history; the
 * row stops applying only because each reader includes
 * `utils/shift_override_active.js#activeOverrideCondition`. A new reader that
 * forgets it would quietly put a revoked shift back on the date - this test
 * fails first.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { activeOverrideCondition } = require("../utils/shift_override_active");

// The reads that are NOT "which shift applies": the revocation's own lookup
// of the override ids it withdraws, recorded in the audit.
const EXEMPT = { "attendance_regularization.js": 1 };

describe("override readers", () => {
  const dir = __dirname;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".js") && !f.endsWith(".test.js"));

  it("every SELECT from the override table carries the active-override condition", () => {
    let readers = 0;
    for (const f of files) {
      const src = fs.readFileSync(path.join(dir, f), "utf8");
      const reads = (src.match(/FROM attendance_date_shift_override\b/g) || []).length;
      if (reads === 0) continue;
      const guarded = (src.match(/\$\{activeOverrideCondition\("o"\)\}/g) || []).length;
      assert.equal(reads - (EXEMPT[f] || 0), guarded, `${f}: ${reads} read(s), ${guarded} guarded`);
      readers += guarded;
    }
    assert.ok(readers >= 5, "the engine, dashboard, payrun and both propagation reads");
  });

  it("the condition is null-safe: a direct management edit (no request) always applies", () => {
    const sql = activeOverrideCondition("o");
    assert.match(sql, /^NOT EXISTS \(/);
    assert.match(sql, /revoked_req\.attendance_approval_request_id = o\.attendance_approval_request_id/);
    assert.match(sql, /revoked_req\.status = 'CANCELLED'/);
  });
});
