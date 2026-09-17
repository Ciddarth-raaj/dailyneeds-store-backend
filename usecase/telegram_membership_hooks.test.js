/**
 * WHERE RECONCILIATION IS ENQUEUED, AND THAT IT IS ATOMIC. Phase 3C.
 *
 *   node --test usecase/telegram_membership_hooks.test.js
 *
 * THE RULE: a business change that can move somebody between Telegram groups
 * enqueues its reconciliation INSIDE THE SAME TRANSACTION. Not after it.
 * "Commit, then enqueue" loses the work whenever the process dies in the
 * gap - and what is lost is somebody's group access, with nothing recording
 * that it should have gone.
 *
 * These read the source rather than booting a server, because what is being
 * asserted IS the source: which call sits inside which transaction.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { JOB_REASON, MAPPING_RELEVANT_FIELDS } = require("../constants/telegram_membership_claim");

const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const strip = (source) => source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");

/**
 * The body of one method.
 *
 * The parameter list is skipped by paren-matching FIRST, because a
 * destructured signature - `async foo({ a, b })` - contains braces, and
 * counting from the signature would end the "body" at the end of the
 * parameters and quietly assert against nothing.
 */
function methodBody(source, signature) {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `${signature} not found`);
  let i = source.indexOf("(", start);
  let parens = 0;
  for (; i < source.length; i += 1) {
    if (source[i] === "(") parens += 1;
    else if (source[i] === ")") {
      parens -= 1;
      if (parens === 0) break;
    }
  }
  const bodyStart = source.indexOf("{", i);
  let depth = 0;
  for (let j = bodyStart; j < source.length; j += 1) {
    if (source[j] === "{") depth += 1;
    if (source[j] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, j + 1);
    }
  }
  return source.slice(start);
}

describe("the employee master hooks", () => {
  const source = strip(read("usecase/employee_master.js"));

  const HOOKS = [
    ["async createEmployee(", JOB_REASON.EMPLOYEE_CREATED],
    ["async editEmployee(", JOB_REASON.EMPLOYEE_EDITED],
    ["async correctJoiningDate(", JOB_REASON.JOINING_DATE_CORRECTED],
    ["async resignEmployee(", JOB_REASON.RESIGNED],
    ["async rejoinEmployee(", JOB_REASON.REJOINED],
  ];

  for (const [signature, reason] of HOOKS) {
    it(`${signature.replace("async ", "").replace("(", "")} enqueues ${reason} INSIDE its transaction`, () => {
      const body = methodBody(source, signature);
      assert.match(body, new RegExp(`_enqueueMembership\\(tx, employeeId, JOB_REASON\\.${reason}`));

      // Inside the transaction callback, not after it: the enqueue must
      // appear before the `withTransaction` block closes.
      const txStart = body.indexOf("withTransaction");
      const enqueueAt = body.indexOf("_enqueueMembership(tx");
      assert.ok(txStart !== -1 && enqueueAt > txStart, `${signature} must enqueue inside the transaction`);
    });
  }

  it("the enqueue takes the transaction, and is NOT best-effort", () => {
    const helper = methodBody(source, "async _enqueueMembership(");
    assert.match(helper, /\{ tx \}/);
    // No try/catch: a change that silently loses its cleanup is worse than a
    // change that failed.
    assert.ok(!/try\s*\{/.test(helper), "a swallowed enqueue is a lost cleanup");
  });

  it("AN ORDINARY EDIT ENQUEUES NOTHING - only a mapping-relevant one does", () => {
    const body = methodBody(source, "async editEmployee(");
    assert.match(body, /MAPPING_RELEVANT_FIELDS\.includes\(k\)/);
    assert.match(body, /String\(patch\[k\]\) !== String\(before\[k\]\)/);
    assert.match(body, /if \(mappingRelevant\.length > 0\)/);
    assert.deepEqual(MAPPING_RELEVANT_FIELDS, ["store_id", "department_id", "designation_id"]);
  });

  it("BULK UPDATE NEEDS NO HOOK OF ITS OWN, because it goes through these", () => {
    const bulk = strip(read("usecase/employee_bulk_update.js"));
    assert.ok(!/_enqueueMembership|membershipQueue/.test(bulk));
    assert.match(bulk, /editEmployee|correctJoiningDate/);
  });

  it("no Telegram call is made on any of these paths", () => {
    assert.ok(!/services\/telegram|banChatMember|getChatMember/.test(source));
  });
});

describe("the identity hooks", () => {
  const source = strip(read("repository/employee_telegram.js"));

  it("connect and reconnect enqueue inside finalizeVerification's transaction", () => {
    const body = methodBody(source, "async finalizeVerification(");
    assert.match(body, /_enqueueMembership\(\s*connection/);
    assert.match(body, /JOB_REASON\.TELEGRAM_RECONNECTED/);
    assert.match(body, /JOB_REASON\.TELEGRAM_CONNECTED/);
    // Before the commit, on the same connection.
    assert.ok(
      body.indexOf("_enqueueMembership") < body.lastIndexOf("commitAsync"),
      "the enqueue must be inside the transaction, not after the commit"
    );
  });

  it("A RECONNECT IS DISTINGUISHED FROM A FIRST CONNECT", () => {
    const body = methodBody(source, "async finalizeVerification(");
    assert.match(body, /reconnect \?\s*JOB_REASON\.TELEGRAM_RECONNECTED/);
  });

  it("disconnect became transactional rather than staying a lone statement", () => {
    const body = methodBody(source, "async disconnectActiveIdentity(");
    assert.match(body, /beginTransactionAsync/);
    assert.match(body, /_enqueueMembership\(connection, employeeId, JOB_REASON\.TELEGRAM_DISCONNECTED\)/);
    assert.match(body, /commitAsync/);
    assert.match(body, /rollbackAsync/);
  });

  it("every identity path still works with no queue wired", () => {
    assert.match(source, /if \(!this\.membershipQueue\) return;/);
    const body = methodBody(source, "async disconnectActiveIdentity(");
    assert.match(body, /if \(!this\.membershipQueue\) \{/);
  });
});

describe("the mapping hooks", () => {
  const source = strip(read("usecase/telegram_group_mapping.js"));

  it("adding a mapping enqueues a GROUP job in the same transaction", () => {
    const body = methodBody(source, "async addMapping(");
    assert.match(body, /withTransaction/);
    assert.match(body, /_enqueueGroup\(tx, group\.telegram_group_id, JOB_REASON\.MAPPING_ADDED/);
  });

  it("deleting a mapping does the same, and only when a row was really deleted", () => {
    const body = methodBody(source, "async deleteMapping(");
    assert.match(body, /withTransaction/);
    assert.match(body, /if \(!deleted \|\| !deleted\.affectedRows\) return deleted;/);
    assert.match(body, /_enqueueGroup\(tx, telegram_group_id, JOB_REASON\.MAPPING_REMOVED\)/);
  });

  it("PHASE 3A STILL SENDS NOTHING - no Telegram service reaches this file", () => {
    assert.ok(!/services\/telegram|banChatMember|createChatInviteLink/.test(source));
  });
});

describe("the registry hard-delete guard", () => {
  const source = strip(read("usecase/telegram_group_registry.js"));
  const body = methodBody(source, "async delete(");

  it("refuses while the group has mappings OR unresolved claims", () => {
    assert.match(body, /countForGroup/);
    assert.match(body, /countLiveForGroup/);
    assert.match(body, /if \(mappings > 0 \|\| claims > 0\)/);
    assert.match(body, /conflict\(/);
  });

  it("checks and deletes in ONE transaction", () => {
    assert.match(body, /withTransaction/);
    const txAt = body.indexOf("withTransaction");
    assert.ok(body.indexOf("countLiveForGroup") > txAt);
    assert.ok(body.indexOf("this.repo.delete") > txAt);
  });

  it("answers 409, not 500 - it is a refusal, not a fault", () => {
    assert.match(source, /err\.httpCode = 409/);
  });
});
