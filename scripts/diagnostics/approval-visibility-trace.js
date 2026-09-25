/**
 * READ-ONLY: is each of an employee's approval requests visible to its
 * CURRENT approver - under production's queue predicate, and under the
 * corrected one?
 *
 *   NODE_ENV=production DN_CONFIG=~/dailyneeds-store-backend/config.json \
 *     node scripts/diagnostics/approval-visibility-trace.js --approver 106
 *   ... or --employee 106
 *
 * TWO DIRECTIONS, and they answer different questions:
 *
 *   --approver X  the approver's PENDING queue: every pending request, raised
 *                 by ANYBODY, whose CURRENT step names X
 *                 (`attendance_approval_step.approver_employee_id = X`) or
 *                 carries a role X holds. For each: would X's "pending with
 *                 me" list and count include it - under the deployed predicate
 *                 and under the corrected one - and, when a predicate drops it,
 *                 WHICH of its conjuncts is the one that fails.
 *   --employee X  the requests X raised, judged against THEIR current approver.
 *
 * For every REGULARIZATION / REGULARIZATION_WITH_OT / OT / SHIFT_CHANGE
 * request of the employee it prints the request, its current stage, who that
 * stage's approver is (the named employee, or every holder of the stage's
 * role), each approver's outlet and branch scope resolved exactly as
 * `middlewares/employee_branch_scope.js` resolves it, and then counts the row
 * through BOTH predicates, with the same FROM/JOIN `countApprovals` uses:
 *
 *   production_visible   `_approvalScope` as deployed at e6d6dbc (copied
 *                        verbatim below as `productionScope`)
 *   corrected_visible    `_approvalScope` of THIS checkout (the fix branch)
 *
 * A PENDING request is judged with status PENDING (the "pending with me"
 * queue); a decided one with status ALL (the history tab).
 *
 * Writes nothing: see `lib/read_only_db.js`.
 */
const { openReadOnly, arg, out } = require("./lib/read_only_db");
const { APPROVER_ROLE } = require("../../utils/attendance_approval_chain");

const approverArg = arg("approver");
const employeeId = Number(arg("employee"));
const approverId = Number(approverArg);
const APPROVER_MODE = approverArg !== null;
if (APPROVER_MODE ? !(Number.isInteger(approverId) && approverId > 0) : !(Number.isInteger(employeeId) && employeeId > 0)) {
  console.error("usage: --approver <employee_id>   |   --employee <employee_id>");
  process.exit(2);
}

const ADMIN_USER_TYPE = 2;
const ALL_BRANCHES_KEY = "employee_scope_all_branches";

/** `repository/attendance_regularization.js#_approvalScope` AS DEPLOYED at e6d6dbc. */
function productionScope({
  request_type, status, approver_roles, outlet_id, actor_employee_id, is_admin,
  filter_outlet_ids = null, filter_employee_id = null, filter_designation_id = null, permitted_outlet_ids = null,
}) {
  const roles = Array.isArray(approver_roles) ? approver_roles : [];
  const types = Array.isArray(request_type) ? request_type : [request_type];
  const where = ["r.request_type IN (?)"];
  const params = [types];
  const outlet = outlet_id === undefined ? null : outlet_id;

  if (status === "PENDING") {
    where.push("r.status = 'PENDING'");
    where.push("s.decision = 'PENDING'");
    if (!is_admin) {
      if (roles.length === 0) where.push("s.approver_employee_id = ?");
      else {
        where.push(
          `((s.approver_employee_id IS NULL AND s.approver_role IN (?)
             AND (s.approver_role <> 'STORE_MANAGER' OR s.outlet_id = ?))
            OR s.approver_employee_id = ?)`
        );
        params.push(roles, outlet);
      }
      params.push(actor_employee_id);
    }
  } else {
    if (status === "APPROVED" || status === "REJECTED") {
      where.push("r.status = ?");
      params.push(status);
    } else {
      where.push("r.status <> 'CANCELLED'");
    }
    if (!is_admin) {
      if (roles.length === 0) {
        where.push(
          `EXISTS (SELECT 1 FROM attendance_approval_step x
                    WHERE x.attendance_approval_request_id = r.attendance_approval_request_id
                      AND x.approver_employee_id = ?)`
        );
        params.push(actor_employee_id);
      } else {
        where.push(
          `EXISTS (SELECT 1 FROM attendance_approval_step x
                    WHERE x.attendance_approval_request_id = r.attendance_approval_request_id
                      AND ((x.approver_employee_id IS NULL AND x.approver_role IN (?)
                            AND (x.approver_role <> 'STORE_MANAGER' OR x.outlet_id = ?))
                           OR x.approver_employee_id = ?))`
        );
        params.push(roles, outlet, actor_employee_id);
      }
    }
  }
  if (!is_admin) {
    where.push("r.requested_for_employee_id <> ?");
    where.push("r.requested_by_employee_id <> ?");
    params.push(actor_employee_id, actor_employee_id);
  }
  if (Array.isArray(permitted_outlet_ids)) {
    if (permitted_outlet_ids.length === 0) where.push("1 = 0");
    else {
      where.push("r.outlet_id IN (?)");
      params.push(permitted_outlet_ids);
    }
  }
  if (Array.isArray(filter_outlet_ids) && filter_outlet_ids.length > 0) {
    where.push("r.outlet_id IN (?)");
    params.push(filter_outlet_ids);
  }
  if (filter_employee_id) {
    where.push("r.requested_for_employee_id = ?");
    params.push(Number(filter_employee_id));
  }
  if (filter_designation_id) {
    where.push("ne.designation_id = ?");
    params.push(Number(filter_designation_id));
  }
  return { where: where.join(" AND "), params };
}

/**
 * A scope's WHERE, split into its TOP-LEVEL conjuncts, each with its own
 * params - so a row one predicate drops can be tested against every conjunct
 * alone and the failing one NAMED. Splits on " AND " at parenthesis depth 0
 * only (the chain predicates carry their own ANDs inside parentheses), and
 * hands each part as many params as it has `?` placeholders.
 */
function conjuncts({ where, params }) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < where.length; i += 1) {
    const c = where[i];
    if (c === "(") depth += 1;
    else if (c === ")") depth -= 1;
    else if (depth === 0 && where.startsWith(" AND ", i)) {
      parts.push(where.slice(start, i));
      start = i + 5;
      i += 4;
    }
  }
  parts.push(where.slice(start));
  let p = 0;
  return parts.map((sql) => {
    const n = (sql.match(/\?/g) || []).length;
    const own = params.slice(p, p + n);
    p += n;
    return { sql: sql.replace(/\s+/g, " ").trim(), params: own };
  });
}

/** The tab a request is shown on: Attendance also carries the legacy WITH_OT rows. */
const typesForTab = (type) =>
  type === "REGULARIZATION" || type === "REGULARIZATION_WITH_OT"
    ? ["REGULARIZATION", "REGULARIZATION_WITH_OT"]
    : [type];

(async () => {
  const { db, select, end } = openReadOnly();
  try {
    const regRepo = require("../../repository/attendance_regularization")(db);
    const correctedScope = (f) => regRepo._approvalScope(f);

    /** The branch scope `middlewares/employee_branch_scope.js#resolve` gives this employee's login. */
    const scopeFor = async (approverId) => {
      const [emp] = await select(
        `SELECT ne.employee_id, ne.employee_name, ne.status, ne.store_id, o.outlet_name, ne.designation_id,
                (SELECT MAX(u.user_type) FROM \`user\` u WHERE u.employee_id = ne.employee_id) AS user_type
           FROM new_employee ne LEFT JOIN outlets o ON o.outlet_id = ne.store_id
          WHERE ne.employee_id = ?`,
        [approverId]
      );
      if (!emp) return { employee_id: approverId, missing: true, kind: "NONE", permitted_outlet_ids: [] };
      const isAdmin = Number(emp.user_type) === ADMIN_USER_TYPE;
      const [key] = await select(
        `SELECT COUNT(*) AS n FROM permissions WHERE designation_id = ? AND is_active = 1 AND permission_key = ?`,
        [emp.designation_id, ALL_BRANCHES_KEY]
      );
      const hasAll = isAdmin || Number(key.n) > 0;
      let kind;
      let permitted;
      if (hasAll) { kind = "ALL_BRANCHES"; permitted = null; }
      else if (Number(emp.status) !== 1) { kind = "NONE (EMPLOYEE_INACTIVE)"; permitted = []; }
      else if (emp.store_id === null || emp.store_id === undefined) { kind = "NONE (NO_BRANCH_ASSIGNED)"; permitted = []; }
      else { kind = "OWN_BRANCHES"; permitted = [Number(emp.store_id)]; }
      const [role] = await select(
        `SELECT r.approver_role FROM new_employee ne
           LEFT JOIN attendance_approval_role r ON r.designation_id = ne.designation_id
          WHERE ne.employee_id = ?`,
        [approverId]
      );
      return {
        employee_id: Number(emp.employee_id), employee_name: emp.employee_name, status: Number(emp.status),
        approver_outlet_id: emp.store_id === null ? null : Number(emp.store_id), approver_outlet_name: emp.outlet_name,
        user_type: emp.user_type === null ? null : Number(emp.user_type), is_admin: isAdmin,
        has_all_branches_key: Number(key.n) > 0, kind, permitted_outlet_ids: permitted,
        approver_roles: role && role.approver_role ? [role.approver_role] : [],
      };
    };

    const visible = async (scopeFn, filters, requestId) => {
      const { where, params } = scopeFn(filters);
      const [row] = await select(
        `SELECT COUNT(*) AS n
           FROM attendance_approval_request r
           JOIN attendance_approval_step s
             ON s.attendance_approval_request_id = r.attendance_approval_request_id
            AND s.stage_no = r.current_stage_no
           LEFT JOIN new_employee ne ON ne.employee_id = r.requested_for_employee_id
          WHERE ${where} AND r.attendance_approval_request_id = ?`,
        [...params, requestId]
      );
      return Number(row.n) > 0;
    };

    /** Every conjunct of `scopeFn(filters)` that this ONE request fails. */
    const failing = async (scopeFn, filters, requestId) => {
      const failed = [];
      for (const part of conjuncts(scopeFn(filters))) {
        /* eslint-disable no-await-in-loop */
        const [row] = await select(
          `SELECT COUNT(*) AS n
             FROM attendance_approval_request r
             JOIN attendance_approval_step s
               ON s.attendance_approval_request_id = r.attendance_approval_request_id
              AND s.stage_no = r.current_stage_no
             LEFT JOIN new_employee ne ON ne.employee_id = r.requested_for_employee_id
            WHERE ${part.sql} AND r.attendance_approval_request_id = ?`,
          [...part.params, requestId]
        );
        /* eslint-enable no-await-in-loop */
        if (Number(row.n) === 0) failed.push({ predicate: part.sql, params: part.params });
      }
      return failed;
    };
    /** A whole queue's count, as `countApprovals` counts "pending with me". */
    const queueCount = async (scopeFn, filters) => {
      const { where, params } = scopeFn(filters);
      const [row] = await select(
        `SELECT COUNT(*) AS n
           FROM attendance_approval_request r
           JOIN attendance_approval_step s
             ON s.attendance_approval_request_id = r.attendance_approval_request_id
            AND s.stage_no = r.current_stage_no
           LEFT JOIN new_employee ne ON ne.employee_id = r.requested_for_employee_id
          WHERE ${where}`,
        params
      );
      return Number(row.n);
    };

    if (APPROVER_MODE) {
      const scope = await scopeFor(approverId);
      if (scope.missing) {
        out("approver", `No such employee: ${approverId}`);
        return;
      }
      const [designation] = await select(
        `SELECT d.designation_id, d.designation_name FROM new_employee ne
           LEFT JOIN designation d ON d.designation_id = ne.designation_id WHERE ne.employee_id = ?`,
        [approverId]
      );
      const keys = scope.is_admin
        ? "ADMIN (user_type 2): every key"
        : (
            await select(
              `SELECT permission_key FROM permissions
                WHERE designation_id = ? AND is_active = 1
                  AND permission_key IN ('view_attendance_approvals', 'approve_attendance_regularization',
                                         'approve_shift_change_request', 'view_shift_change_requests',
                                         'employee_scope_all_branches')`,
              [designation ? designation.designation_id : null]
            )
          ).map((k) => k.permission_key);
      const roles = scope.is_admin ? Object.values(APPROVER_ROLE) : scope.approver_roles;
      out("APPROVER (the actor whose Pending tab is empty)", {
        ...scope,
        designation: designation || null,
        approver_roles_used_by_queue: roles,
        relevant_permission_keys: keys,
        note:
          "The approval screen needs view_attendance_approvals to load at all; without it the page is refused, not empty.",
      });

      // Every PENDING request whose CURRENT step is this approver's: named on
      // it, or a role stage they hold (a Store Manager only for their outlet).
      const pending = await select(
        `SELECT r.attendance_approval_request_id AS request_id, r.request_type,
                DATE_FORMAT(r.attendance_date, '%Y-%m-%d') AS attendance_date,
                r.requested_for_employee_id, fe.employee_name AS requested_for_name,
                fe.store_id AS requested_for_outlet_id, fo.outlet_name AS requested_for_outlet_name,
                r.requested_by_employee_id, r.outlet_id AS request_outlet_id, r.chain_source,
                r.current_stage_no, r.total_stages,
                s.approval_level, s.approver_role, s.outlet_id AS step_outlet_id,
                s.approver_employee_id, s.decision AS current_step_decision
           FROM attendance_approval_request r
           JOIN attendance_approval_step s
             ON s.attendance_approval_request_id = r.attendance_approval_request_id
            AND s.stage_no = r.current_stage_no
           LEFT JOIN new_employee fe ON fe.employee_id = r.requested_for_employee_id
           LEFT JOIN outlets fo ON fo.outlet_id = fe.store_id
          WHERE r.status = 'PENDING'
            AND (s.approver_employee_id = ?
                 OR (s.approver_employee_id IS NULL AND s.approver_role IN (?)
                     AND (s.approver_role <> 'STORE_MANAGER' OR s.outlet_id = ?)))
          ORDER BY r.request_type, r.attendance_date DESC, r.attendance_approval_request_id DESC`,
        [approverId, roles.length ? roles : ["__none__"], scope.approver_outlet_id]
      );
      if (pending.length === 0) {
        out("pending requests whose current step is this approver's", "NONE in the database - the empty Pending tab is then correct");
      }

      const summary = [];
      for (const req of pending) {
        /* eslint-disable no-await-in-loop */
        const filters = {
          request_type: typesForTab(req.request_type),
          status: "PENDING",
          approver_roles: roles,
          outlet_id: scope.approver_outlet_id,
          actor_employee_id: approverId,
          is_admin: scope.is_admin,
          permitted_outlet_ids: scope.permitted_outlet_ids,
        };
        const production = await visible(productionScope, filters, req.request_id);
        const corrected = await visible(correctedScope, filters, req.request_id);
        const productionHides = production ? [] : await failing(productionScope, filters, req.request_id);
        const correctedHides = corrected ? [] : await failing(correctedScope, filters, req.request_id);
        out(`request #${req.request_id} ${req.request_type} ${req.attendance_date}`, {
          ...req,
          current_approver: req.approver_employee_id === null ? `role ${req.approver_role}` : Number(req.approver_employee_id),
          approver_outlet_id: scope.approver_outlet_id,
          approver_branch_scope: scope.kind,
          permitted_outlet_ids: scope.permitted_outlet_ids === null ? "ALL" : scope.permitted_outlet_ids,
          request_outlet_in_scope:
            scope.permitted_outlet_ids === null ? true : scope.permitted_outlet_ids.includes(Number(req.request_outlet_id)),
          production_visible: production,
          corrected_visible: corrected,
          production_hidden_by: productionHides,
          corrected_hidden_by: correctedHides,
        });
        summary.push({
          request_id: Number(req.request_id),
          type: req.request_type,
          date: req.attendance_date,
          requested_for: `${req.requested_for_employee_id} ${req.requested_for_name || ""}`.trim(),
          req_outlet: req.request_outlet_id,
          stage: `${req.current_stage_no}/${req.total_stages}`,
          level: req.approval_level || req.approver_role,
          current_approver: req.approver_employee_id === null ? `role:${req.approver_role}` : Number(req.approver_employee_id),
          approver_outlet: scope.approver_outlet_id,
          permitted: scope.permitted_outlet_ids === null ? "ALL" : JSON.stringify(scope.permitted_outlet_ids),
          production_visible: production,
          corrected_visible: corrected,
          production_hidden_by: productionHides.map((h) => h.predicate).join(" | ") || "-",
        });
        /* eslint-enable no-await-in-loop */
      }

      // The "pending with me" COUNT each tab would show, both ways.
      const counts = [];
      for (const type of ["REGULARIZATION", "OT", "SHIFT_CHANGE"]) {
        const filters = {
          request_type: typesForTab(type),
          status: "PENDING",
          approver_roles: roles,
          outlet_id: scope.approver_outlet_id,
          actor_employee_id: approverId,
          is_admin: scope.is_admin,
          permitted_outlet_ids: scope.permitted_outlet_ids,
        };
        /* eslint-disable no-await-in-loop */
        counts.push({
          tab: type,
          production_pending_with_me: await queueCount(productionScope, filters),
          corrected_pending_with_me: await queueCount(correctedScope, filters),
        });
        /* eslint-enable no-await-in-loop */
      }
      out("SUMMARY - one line per pending request whose current step is this approver's", "");
      console.table(summary);
      out("PENDING-WITH-ME COUNT per tab (deployed e6d6dbc vs fix branch)", "");
      console.table(counts);
      return;
    }

    const [employee] = await select(
      `SELECT ne.employee_id, ne.employee_name, ne.status, ne.store_id AS employee_outlet_id, o.outlet_name AS employee_outlet_name,
              ne.designation_id, d.designation_name, ne.attendance_required, ne.works_all_locations,
              ar.approver_role AS own_approver_role, ar.requester_class
         FROM new_employee ne
         LEFT JOIN outlets o ON o.outlet_id = ne.store_id
         LEFT JOIN designation d ON d.designation_id = ne.designation_id
         LEFT JOIN attendance_approval_role ar ON ar.designation_id = ne.designation_id
        WHERE ne.employee_id = ?`,
      [employeeId]
    );
    out("employee", employee || `No such employee: ${employeeId}`);
    out(
      "attendance approver setup",
      await select(
        `SELECT employee_id, first_level_approver_employee_id, second_level_approver_employee_id,
                final_approver_employee_id, is_active
           FROM attendance_approver_setup WHERE employee_id = ?`,
        [employeeId]
      )
    );

    const requests = await select(
      `SELECT attendance_approval_request_id AS request_id, request_type, status,
              DATE_FORMAT(attendance_date, '%Y-%m-%d') AS attendance_date, outlet_id AS request_outlet_id,
              chain_source, current_stage_no, total_stages, candidate_ot_minutes, approved_ot_minutes,
              closure_reason, requested_by_employee_id
         FROM attendance_approval_request
        WHERE requested_for_employee_id = ?
          AND request_type IN ('REGULARIZATION', 'REGULARIZATION_WITH_OT', 'OT', 'SHIFT_CHANGE')
        ORDER BY attendance_date DESC, attendance_approval_request_id DESC`,
      [employeeId]
    );
    if (requests.length === 0) out("requests", "NONE - no request was ever created for this employee (case A)");

    const summary = [];
    for (const req of requests) {
      /* eslint-disable no-await-in-loop */
      const steps = await select(
        `SELECT stage_no, approver_role, outlet_id AS step_outlet_id, approval_level, approver_employee_id, decision,
                decided_by_employee_id, DATE_FORMAT(decided_at, '%Y-%m-%d %H:%i') AS decided_at
           FROM attendance_approval_step WHERE attendance_approval_request_id = ? ORDER BY stage_no`,
        [req.request_id]
      );
      const current = steps.find((s) => Number(s.stage_no) === Number(req.current_stage_no)) || null;
      const status = req.status === "PENDING" ? "PENDING" : "ALL";

      // Who the current stage belongs to: the named employee, or every active
      // holder of its role (a Store Manager only for the step's outlet).
      let approverIds = [];
      if (current && current.approver_employee_id !== null) approverIds = [Number(current.approver_employee_id)];
      else if (current) {
        const holders = await select(
          `SELECT ne.employee_id FROM new_employee ne
             JOIN attendance_approval_role r ON r.designation_id = ne.designation_id
            WHERE ne.status = 1 AND r.approver_role = ?
              AND (r.approver_role <> 'STORE_MANAGER' OR ne.store_id = ?)`,
          [current.approver_role, current.step_outlet_id]
        );
        approverIds = holders.map((h) => Number(h.employee_id));
      }

      const approvers = [];
      for (const approverId of approverIds) {
        const scope = await scopeFor(approverId);
        const filters = {
          request_type: typesForTab(req.request_type),
          status,
          approver_roles: scope.is_admin ? Object.values(APPROVER_ROLE) : scope.approver_roles,
          outlet_id: scope.approver_outlet_id,
          actor_employee_id: approverId,
          is_admin: scope.is_admin,
          permitted_outlet_ids: scope.permitted_outlet_ids,
        };
        const production = await visible(productionScope, filters, req.request_id);
        const corrected = await visible(correctedScope, filters, req.request_id);
        approvers.push({
          ...scope,
          request_outlet_in_scope:
            scope.permitted_outlet_ids === null ? true : scope.permitted_outlet_ids.includes(Number(req.request_outlet_id)),
          queue_status_checked: status,
          production_visible: production,
          corrected_visible: corrected,
          hidden_by_production_branch_scope: !production && corrected,
        });
        summary.push({
          request_id: Number(req.request_id), request_type: req.request_type, status: req.status,
          attendance_date: req.attendance_date, current_stage_no: Number(req.current_stage_no),
          approval_level: current ? current.approval_level : null, approver_role: current ? current.approver_role : null,
          approver_employee_id: approverId, employee_outlet_id: employee ? employee.employee_outlet_id : null,
          request_outlet_id: req.request_outlet_id, approver_outlet_id: scope.approver_outlet_id,
          permitted_outlet_scope: scope.permitted_outlet_ids === null ? "ALL" : JSON.stringify(scope.permitted_outlet_ids),
          production_visible: production, corrected_visible: corrected,
        });
      }
      out(`request #${req.request_id} ${req.request_type} ${req.status} ${req.attendance_date}`, {
        request: req,
        steps,
        current_step: current,
        current_approvers: approvers.length ? approvers : "NONE - the current stage names nobody and no active employee holds its role (case B/C)",
      });
      /* eslint-enable no-await-in-loop */
    }
    out("SUMMARY (one line per request x current approver)", "");
    console.table(summary);
  } finally {
    await end();
  }
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
