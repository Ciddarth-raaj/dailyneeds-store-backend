/**
 * THE APPROVAL QUEUE'S OUTLET SCOPE NEVER HIDES A STAGE THE CHAIN ADDRESSES
 * TO THE ACTOR - the clause, without a database.
 *
 *   node --test repository/attendance_approval_branch_scope.test.js
 *
 * The behaviour is proven against real SQL in
 * `attendance_approval_branch_scope.mysql.test.js` (employee 106's shape).
 * This file pins the SHAPE of the clause so a run with no database still
 * notices if the branch scope goes back to a flat `r.outlet_id IN (...)`.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const buildRegRepo = require("./attendance_regularization");

function capture() {
  const log = [];
  const db = {
    query(sql, params, cb) {
      log.push({ sql: sql.replace(/\s+/g, " ").trim(), params });
      cb(null, [{ n: 0 }]);
    },
  };
  return { repo: buildRegRepo(db), log };
}

const PENDING_AUTHORITY =
  "((s.approver_employee_id IS NULL AND s.approver_role IN (?) AND (s.approver_role <> 'STORE_MANAGER' OR s.outlet_id = ?)) OR s.approver_employee_id = ?)";

describe("approval scope: branch scope OR the chain's authority", () => {
  it("PENDING, with a role: the outlet scope is ORed with the actor's stage, list and count alike", async () => {
    for (const method of ["listApprovals", "countApprovals"]) {
      const { repo, log } = capture();
      await repo[method]({
        request_type: ["REGULARIZATION", "REGULARIZATION_WITH_OT"], status: "PENDING",
        approver_roles: ["HR"], outlet_id: 7, actor_employee_id: 202, is_admin: false,
        permitted_outlet_ids: [7], limit: 10, offset: 0,
      });
      const { sql, params } = log[0];
      assert.ok(sql.includes(`(r.outlet_id IN (?) OR ${PENDING_AUTHORITY})`), `${method}: ${sql}`);
      assert.ok(!/AND r\.outlet_id IN \(\?\) AND/.test(sql), `${method}: no flat outlet predicate`);
      assert.deepEqual(
        params.slice(0, 10),
        [["REGULARIZATION", "REGULARIZATION_WITH_OT"], ["HR"], 7, 202, 202, 202, [7], ["HR"], 7, 202]
      );
    }
  });

  it("PENDING, no role (a named approver only): the scope is ORed with `s.approver_employee_id = ?`", async () => {
    const { repo, log } = capture();
    await repo.countApprovals({
      request_type: ["OT"], status: "PENDING", approver_roles: [], outlet_id: 5,
      actor_employee_id: 201, is_admin: false, permitted_outlet_ids: [5],
    });
    assert.ok(log[0].sql.includes("(r.outlet_id IN (?) OR s.approver_employee_id = ?)"));
    assert.deepEqual(log[0].params, [["OT"], 201, 201, 201, [5], 201]);
  });

  it("history: the scope is ORed with 'a step of this chain is mine'", async () => {
    const { repo, log } = capture();
    await repo.countApprovals({
      request_type: ["OT"], status: "ALL", approver_roles: [], outlet_id: 5,
      actor_employee_id: 201, is_admin: false, permitted_outlet_ids: [5],
    });
    assert.match(
      log[0].sql,
      /\(r\.outlet_id IN \(\?\) OR EXISTS \(SELECT 1 FROM attendance_approval_step x WHERE x\.attendance_approval_request_id = r\.attendance_approval_request_id AND x\.approver_employee_id = \?\)\)/
    );
  });

  it("an EMPTY scope still fails closed - `1 = 0` - for anything the chain does not address", async () => {
    const { repo, log } = capture();
    await repo.countApprovals({
      request_type: ["OT"], status: "PENDING", approver_roles: [], outlet_id: 5,
      actor_employee_id: 201, is_admin: false, permitted_outlet_ids: [],
    });
    assert.ok(log[0].sql.includes("(1 = 0 OR s.approver_employee_id = ?)"));
  });

  it("an administrator's scope is unchanged: no authority clause, the flat outlet predicate if one is given", async () => {
    const { repo, log } = capture();
    await repo.countApprovals({
      request_type: ["OT"], status: "PENDING", approver_roles: ["ADMIN"], outlet_id: null,
      actor_employee_id: 1, is_admin: true, permitted_outlet_ids: [3],
    });
    assert.ok(log[0].sql.includes("AND r.outlet_id IN (?)"));
    assert.ok(!log[0].sql.includes("approver_employee_id = ?"));
    assert.deepEqual(log[0].params, [["OT"], [3]]);
  });

  it("a CHOSEN outlet is still a plain narrowing filter on top", async () => {
    const { repo, log } = capture();
    await repo.countApprovals({
      request_type: ["OT"], status: "PENDING", approver_roles: [], outlet_id: 5,
      actor_employee_id: 201, is_admin: false, permitted_outlet_ids: [5], filter_outlet_ids: [9],
    });
    assert.ok(log[0].sql.endsWith("AND r.outlet_id IN (?)"));
    assert.deepEqual(log[0].params.slice(-1), [[9]]);
  });
});
