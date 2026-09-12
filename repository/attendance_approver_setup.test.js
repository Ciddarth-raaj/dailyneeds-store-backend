/**
 * The SQL the approver setup and the approval scope actually issue, captured
 * from a fake pool. What matters is what the WHERE clauses refuse to touch.
 *
 *   node --test repository/attendance_approver_setup.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const buildSetupRepo = require("./attendance_approver_setup");
const buildRegRepo = require("./attendance_regularization");

const norm = (s) => String(s).replace(/\s+/g, " ").trim();

/** A pool whose connection records every statement and answers with canned rows. */
function fakeDb(answers = () => []) {
  const log = [];
  const connection = {
    query: (sql, params, cb) => { log.push({ sql: norm(sql), params }); cb(null, answers(norm(sql), params, log.length)); },
    beginTransaction: (cb) => { log.push({ sql: "BEGIN" }); cb(null); },
    commit: (cb) => { log.push({ sql: "COMMIT" }); cb(null); },
    rollback: (cb) => { log.push({ sql: "ROLLBACK" }); cb(); },
    release: () => {},
  };
  return { log, db: { query: connection.query, getConnection: (cb) => cb(null, connection) } };
}

describe("approver setup repository", () => {
  it("lists ACTIVE employees only, filtered by department, store, designation, employee and search", async () => {
    const { db, log } = fakeDb();
    const repo = buildSetupRepo(db);
    await repo.listEmployeesWithSetup({ department_id: 2, store_id: 3, designation_id: 5, employee_id: 7, search: "raj", limit: 50, offset: 100 });
    const { sql, params } = log[0];
    assert.match(sql, /WHERE ne\.status = 1 AND ne\.department_id = \? AND ne\.store_id = \? AND ne\.designation_id = \? AND ne\.employee_id = \? AND \(ne\.employee_name LIKE \? OR CAST\(ne\.employee_id AS CHAR\) LIKE \?\)/);
    assert.deepEqual(params, [2, 3, 5, 7, "%raj%", "%raj%", 50, 100]);
    assert.match(sql, /LEFT JOIN attendance_approver_setup s ON s\.employee_id = ne\.employee_id AND s\.is_active = 1/);
    assert.ok(!/salary|bank|aadhaar|pan_no|contact/i.test(sql), "no personal fields");
  });

  it("saveSetup upserts ONE row per employee and appends the audit in the same transaction", async () => {
    const { db, log } = fakeDb();
    const repo = buildSetupRepo(db);
    await repo.saveSetup({
      setup: { employee_id: 1, first_level_approver_employee_id: 11, second_level_approver_employee_id: null, final_approver_employee_id: 33 },
      action_type: "SET", actor_employee_id: 500,
      audit: [{ approval_level: "FIRST", old_approver_employee_id: null, new_approver_employee_id: 11 }],
    });
    assert.deepEqual(log.map((l) => l.sql.split(" ")[0]), ["BEGIN", "INSERT", "INSERT", "COMMIT"]);
    assert.match(log[1].sql, /INSERT INTO attendance_approver_setup .* ON DUPLICATE KEY UPDATE/);
    assert.match(log[2].sql, /INSERT INTO attendance_approver_setup_audit/);
    assert.deepEqual(log[2].params[0][0], [1, "FIRST", null, 11, "SET", 500]);
  });

  it("29-31. the audit table is only ever INSERTed into", async () => {
    const { db, log } = fakeDb(() => ({ affectedRows: 1 }));
    const repo = buildSetupRepo(db);
    await repo.saveSetup({ setup: { employee_id: 1, final_approver_employee_id: 33 }, action_type: "BULK_SET", actor_employee_id: 1, audit: [{ approval_level: "FINAL", new_approver_employee_id: 33 }] });
    await repo.replaceApprover({ level: "FINAL", old_approver_employee_id: 33, new_approver_employee_id: 44, setup_employee_ids: [1], step_ids: [], actor_employee_id: 1 });
    log.filter((l) => /attendance_approver_setup_audit/.test(l.sql)).forEach((l) => assert.match(l.sql, /^INSERT INTO attendance_approver_setup_audit/));
    assert.ok(!log.some((l) => /(UPDATE|DELETE).*attendance_approver_setup_audit/.test(l.sql)));
    assert.ok(log.some((l) => /INSERT INTO attendance_approver_setup_audit/.test(l.sql) && l.params[0][0][4] === "BULK_SET"));
    assert.ok(log.some((l) => /INSERT INTO attendance_approver_setup_audit/.test(l.sql) && l.params[0][0][4] === "REPLACE"));
  });

  it("finds only UNDECIDED steps of PENDING Regularization/OT requests naming the approver at the level", async () => {
    const { db, log } = fakeDb();
    await buildSetupRepo(db).findPendingStepsWithApprover("SECOND", 22);
    const { sql, params } = log[0];
    assert.match(sql, /r\.status = 'PENDING'/);
    assert.match(sql, /s\.decision = 'PENDING'/);
    assert.match(sql, /s\.approver_employee_id = \?/);
    assert.match(sql, /s\.approval_level = \?/);
    assert.match(sql, /r\.request_type IN \('REGULARIZATION','OT'\)/);
    assert.deepEqual(params, [22, "SECOND"]);
  });

  it("24-25. replaceApprover guards every UPDATE: never an approved/rejected/skipped step, never a closed request, never a master row that no longer names the old approver", async () => {
    const { db, log } = fakeDb((sql) => (/SELECT/.test(sql) ? [{ attendance_approval_step_id: 901, attendance_approval_request_id: 90, requested_for_employee_id: 1 }] : { affectedRows: 1 }));
    const res = await buildSetupRepo(db).replaceApprover({ level: "SECOND", old_approver_employee_id: 22, new_approver_employee_id: 44, setup_employee_ids: [1, 2], step_ids: [901, 902], actor_employee_id: 500 });
    const master = log.find((l) => /UPDATE attendance_approver_setup SET/.test(l.sql));
    assert.match(master.sql, /WHERE is_active = 1 AND employee_id IN \(\?\) AND `second_level_approver_employee_id` = \?/);
    assert.deepEqual(master.params, [44, 500, [1, 2], 22]);
    const lock = log.find((l) => /FOR UPDATE/.test(l.sql));
    assert.match(lock.sql, /r\.status = 'PENDING' AND s\.decision = 'PENDING' AND s\.approver_employee_id = \? AND s\.approval_level = \?/);
    const step = log.find((l) => /UPDATE attendance_approval_step SET approver_employee_id/.test(l.sql));
    assert.match(step.sql, /WHERE attendance_approval_step_id IN \(\?\) AND decision = 'PENDING' AND approver_employee_id = \?/);
    assert.deepEqual(step.params, [44, [901], 22]);
    log.filter((l) => /^UPDATE/.test(l.sql)).forEach((l) => {
      const setClause = l.sql.slice(l.sql.indexOf(" SET "), l.sql.indexOf(" WHERE "));
      assert.ok(!/decided_by_employee_id|decided_at|remarks|decision/.test(setClause), `decision columns untouched: ${setClause}`);
    });
    const stepAudit = log.filter((l) => /INSERT INTO attendance_approver_setup_audit/.test(l.sql)).pop();
    assert.deepEqual(stepAudit.params[0][0], [1, "SECOND", 22, 44, "REPLACE", 90, 901, 500]);
    assert.equal(log[0].sql, "BEGIN");
    assert.equal(log[log.length - 1].sql, "COMMIT");
    assert.deepEqual(res, { code: 200, setups_updated: 1, pending_steps_updated: 1 });
  });

  it("34. never touches a Biomax table", async () => {
    const { db, log } = fakeDb((sql) => (/^SELECT/.test(sql) ? [] : { affectedRows: 0 }));
    const repo = buildSetupRepo(db);
    await repo.listEmployeesWithSetup({});
    await repo.listCurrentApprovers();
    await repo.listAudit({});
    await repo.replaceApprover({ level: "FIRST", old_approver_employee_id: 1, new_approver_employee_id: 2, setup_employee_ids: [3], step_ids: [4] });
    log.forEach((l) => assert.ok(!/biomax/i.test(l.sql), l.sql));
  });
});

describe("the approval scope after the employee-level chain", () => {
  const capture = async (fn) => { const { db, log } = fakeDb(() => [{ n: 0 }]); await fn(buildRegRepo(db)); return log[0]; };

  it("26-27. 'pending with me' is the actor's own snapshotted steps OR their role steps - so a reassigned step moves queues and counts together", async () => {
    const withRole = await capture((r) => r.countApprovals({ request_type: "OT", status: "PENDING", approver_roles: ["HR"], outlet_id: 3, actor_employee_id: 44, is_admin: false }));
    assert.match(withRole.sql, /\(\(s\.approver_employee_id IS NULL AND s\.approver_role IN \(\?\) AND \(s\.approver_role <> 'STORE_MANAGER' OR s\.outlet_id = \?\)\) OR s\.approver_employee_id = \?\)/);
    assert.deepEqual(withRole.params, ["OT", ["HR"], 3, 44, 44, 44]);
    const noRole = await capture((r) => r.countApprovals({ request_type: "REGULARIZATION", status: "PENDING", approver_roles: [], outlet_id: 3, actor_employee_id: 44, is_admin: false }));
    assert.match(noRole.sql, /s\.approver_employee_id = \?/);
    assert.ok(!/1 = 0/.test(noRole.sql), "a person with no role still has an employee-level queue");
    assert.deepEqual(noRole.params, ["REGULARIZATION", 44, 44, 44]);
  });

  it("a role-based step stays with its role; an employee-level step is never matched by role", async () => {
    const { sql } = await capture((r) => r.listPendingFor({ approver_roles: ["STORE_MANAGER"], outlet_id: 3, actor_employee_id: 11 }));
    assert.match(sql, /\(s\.approver_employee_id IS NULL AND s\.approver_role IN \(\?\) AND \(s\.approver_role <> 'STORE_MANAGER' OR s\.outlet_id = \?\)\) OR s\.approver_employee_id = \?/);
  });

  it("history is scoped the same way, and the list and count share the clause", async () => {
    const list = await capture((r) => r.listApprovals({ request_type: "OT", status: "APPROVED", approver_roles: [], outlet_id: null, actor_employee_id: 44, is_admin: false, limit: 10, offset: 0 }));
    assert.match(list.sql, /EXISTS \(SELECT 1 FROM attendance_approval_step x WHERE x\.attendance_approval_request_id = r\.attendance_approval_request_id AND x\.approver_employee_id = \?\)/);
    assert.match(list.sql, /r\.chain_source, s\.approver_employee_id AS current_stage_approver_employee_id/);
  });

  it("20b. createRequest snapshots approver_employee_id, approval_level and chain_source", async () => {
    const { db, log } = fakeDb(() => ({ insertId: 9 }));
    await buildRegRepo(db).createRequest({
      request: { request_type: "OT", requested_for_employee_id: 1, requested_by_employee_id: 1, attendance_date: "2026-09-10", outlet_id: 3, requester_class: "STORE_EMPLOYEE", reason: "x", candidate_ot_minutes: 30, auto_created: false, chain_source: "EMPLOYEE" },
      chain: [{ stage_no: 1, approver_role: "EMPLOYEE", outlet_id: null, approver_employee_id: 11, approval_level: "FIRST" }, { stage_no: 2, approver_role: "EMPLOYEE", outlet_id: null, approver_employee_id: 33, approval_level: "FINAL" }],
      punch: null,
    });
    const req = log.find((l) => /INSERT INTO attendance_approval_request/.test(l.sql));
    assert.match(req.sql, /chain_source\) VALUES/);
    assert.equal(req.params[req.params.length - 1], "EMPLOYEE");
    const steps = log.find((l) => /INSERT INTO attendance_approval_step/.test(l.sql));
    assert.match(steps.sql, /approver_employee_id, approval_level\) VALUES \?/);
    assert.deepEqual(steps.params[0], [[9, 1, "EMPLOYEE", null, 11, "FIRST"], [9, 2, "EMPLOYEE", null, 33, "FINAL"]]);
    log.forEach((l) => assert.ok(!/biomax/i.test(l.sql)));
  });
});
