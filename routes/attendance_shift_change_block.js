const express = require("express");
const Joi = require("@hapi/joi");
const P = require("../constants/hr_permissions");
const respondError = require("../utils/http");

/**
 * THE HR SHIFT CHANGE BLOCK API - the WRITE side of the eligibility report.
 *
 * ================== WHY IT IS A ROUTER OF ITS OWN =========================
 *
 * The Shift Change Eligibility Report's router is READ-ONLY, and a test
 * asserts that it declares two GET routes and nothing else. That guarantee is
 * worth more than the convenience of putting these two POSTs beside it: a
 * report anybody can prove writes nothing is a different thing from a report
 * that merely happens not to today. So the writes live here, behind their own
 * key, and the report keeps its proof.
 *
 * ========================================================= AUTHORIZATION ===
 *
 * THREE GATES, ALL ON THE SERVER, none of them the report's read key:
 *
 *   MAY THIS PERSON BLOCK AT ALL?  `manage_shift_change_eligibility`, a WRITE
 *                                  key granted to nobody by migration.
 *                                  Holding `view_shift_change_eligibility_report`
 *                                  grants NOTHING here.
 *   WHICH EMPLOYEES?               the EMPLOYEE BRANCH SCOPE, resolved by the
 *                                  shared middleware from the caller's own
 *                                  identity, and applied TWICE. Once HERE, as
 *                                  `requireEmployeeInScope()`, which refuses
 *                                  an out-of-branch employee and a
 *                                  non-existent id with the SAME answer so
 *                                  ids cannot be enumerated. And again inside
 *                                  the write transaction, against the
 *                                  employee's CURRENT store read under
 *                                  `FOR UPDATE` - which is what actually
 *                                  authorizes the write and closes the
 *                                  branch-transfer race the outer guard
 *                                  cannot see.
 *   IS THE ACTION MEANINGFUL?      re-decided in the usecase from live facts -
 *                                  never from the report row the browser is
 *                                  holding.
 *
 * NO OUTLET OR STORE ID IS ACCEPTED FROM THE CALLER. The schemas below have no
 * field for one: the employee's branch is a fact the server looks up, so there
 * is nothing for a crafted request to lie about.
 *
 * ======================================================= NOT AN APPROVAL ===
 *
 * Nothing here approves, rejects or alters a shift change request. A block is
 * not a rejection - usually there is no request at all - and where one IS
 * pending the usecase refuses and points at the approval queue, which is the
 * authority for a request that exists.
 */

const DATE = Joi.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/**
 * Mark an employee/date not eligible. `reason` is MANDATORY - a block nobody
 * explained is one nobody can review later, and the screen makes it required
 * for the same reason the schema does.
 */
const BLOCK_SCHEMA = {
  employee_id: Joi.number().integer().positive().required(),
  attendance_date: DATE.required(),
  reason: Joi.string().min(5).max(500).required(),
};

/** Remove a block. The removal reason is mandatory too, and for the same reason. */
const UNBLOCK_SCHEMA = {
  employee_id: Joi.number().integer().positive().required(),
  attendance_date: DATE.required(),
  removal_reason: Joi.string().min(5).max(500).required(),
};

const HISTORY_SCHEMA = {
  employee_id: Joi.number().integer().positive().required(),
  attendance_date: DATE.required(),
};

class AttendanceShiftChangeBlockRoutes {
  constructor(usecase, permissions, sensitive, branchScope) {
    this.usecase = usecase;
    this.permissions = permissions;
    this.sensitive = sensitive;
    this.branchScope = branchScope;
    this.router = express.Router();
    this.init();
  }

  /**
   * The actor and their branch scope, both resolved from the SESSION by the
   * shared middleware - never from the request body.
   */
  async _actor(req) {
    if (!this.branchScope || typeof this.branchScope.actorFor !== "function") {
      return { actor: null, scope: { kind: "NONE", store_ids: [] } };
    }
    // `middlewares/employee_branch_scope.js#actorFor` returns
    // `permissions.actorFor`'s camelCase actor with the resolved scope under
    // `branch_scope`. Both are the SERVER's answer about who is calling.
    const resolved = await this.branchScope.actorFor(req);
    return {
      actor: {
        employee_id:
          resolved && resolved.employeeId !== undefined ? resolved.employeeId : null,
        user_id: resolved && resolved.userId !== undefined ? resolved.userId : null,
      },
      scope:
        resolved && resolved.branch_scope ? resolved.branch_scope : { kind: "NONE", store_ids: [] },
    };
  }

  /**
   * THE OUTER PRIVACY GUARD, the shared one and not a second implementation.
   *
   * `middlewares/employee_branch_scope.js#requireEmployeeInScope` reads the
   * employee from `:employee_id`, then `query.employee_id`, then
   * `body.employee_id` - which is the POSTs' body and the GET's query with no
   * custom reader needed - and gives a branch-scoped caller ONE refusal for
   * an employee in another branch AND for an id that does not exist. That is
   * the point of it: answering "no such employee" for one and "not your
   * branch" for the other lets a branch manager enumerate employee ids by
   * watching which answer comes back.
   *
   * IT DOES NOT REPLACE THE LOCKED CHECK IN THE REPOSITORY. This runs before
   * the handler, against a read that holds no lock, so an employee
   * transferred between here and the write would slip past it. The
   * authoritative decision is still made inside the write transaction, under
   * `SELECT ... FOR UPDATE` on the employee's own row. The two are different
   * jobs: this one hides WHETHER an employee exists, that one decides whether
   * the write may happen.
   *
   * A router built without the middleware (some route tests) keeps its old
   * behaviour and is authorized by the usecase and the locked check alone.
   */
  _inScope() {
    if (!this.branchScope || typeof this.branchScope.requireEmployeeInScope !== "function") {
      return (req, res, next) => next();
    }
    return this.branchScope.requireEmployeeInScope();
  }

  init() {
    const base = "/attendance/shift-change-eligibility/block";

    if (this.sensitive) {
      this.router.use(base, this.sensitive.filterResponse);
    }

    /** MARK NOT ELIGIBLE / BLOCK FURTHER REQUESTS. */
    this.router.post(
      base,
      this.permissions.require(P.MANAGE_SHIFT_CHANGE_ELIGIBILITY),
      this._inScope(),
      async (req, res) => {
        try {
          const isValid = Joi.validate(req.body, BLOCK_SCHEMA);
          if (isValid.error !== null) throw isValid.error;

          const { actor, scope } = await this._actor(req);
          const result = await this.usecase.blockDate({
            actor,
            scope,
            employee_id: req.body.employee_id,
            attendance_date: req.body.attendance_date,
            reason: req.body.reason,
          });
          res.setHeader("Cache-Control", "no-store");
          res.json({ code: 200, ...result });
        } catch (err) {
          respondError(res, err);
        }
      }
    );

    /** REMOVE BLOCK. */
    this.router.post(
      `${base}/remove`,
      this.permissions.require(P.MANAGE_SHIFT_CHANGE_ELIGIBILITY),
      this._inScope(),
      async (req, res) => {
        try {
          const isValid = Joi.validate(req.body, UNBLOCK_SCHEMA);
          if (isValid.error !== null) throw isValid.error;

          const { actor, scope } = await this._actor(req);
          const result = await this.usecase.unblockDate({
            actor,
            scope,
            employee_id: req.body.employee_id,
            attendance_date: req.body.attendance_date,
            removal_reason: req.body.removal_reason,
          });
          res.setHeader("Cache-Control", "no-store");
          res.json({ code: 200, ...result });
        } catch (err) {
          respondError(res, err);
        }
      }
    );

    /**
     * THE HISTORY of one employee/date - every block and every removal, newest
     * first. Behind the same key: it names who blocked whom and why, which is
     * not something the report's read key alone should disclose.
     */
    this.router.get(
      `${base}/history`,
      this.permissions.require(P.MANAGE_SHIFT_CHANGE_ELIGIBILITY),
      this._inScope(),
      async (req, res) => {
        try {
          const isValid = Joi.validate(req.query, HISTORY_SCHEMA);
          if (isValid.error !== null) throw isValid.error;

          const { scope } = await this._actor(req);
          const result = await this.usecase.history({
            scope,
            employee_id: req.query.employee_id,
            attendance_date: req.query.attendance_date,
          });
          res.setHeader("Cache-Control", "no-store");
          res.json({ code: 200, ...result });
        } catch (err) {
          respondError(res, err);
        }
      }
    );
  }

  getRouter() {
    return this.router;
  }
}

module.exports = (usecase, permissions, sensitive, branchScope) =>
  new AttendanceShiftChangeBlockRoutes(usecase, permissions, sensitive, branchScope);
module.exports.AttendanceShiftChangeBlockRoutes = AttendanceShiftChangeBlockRoutes;
module.exports.BLOCK_SCHEMA = BLOCK_SCHEMA;
module.exports.UNBLOCK_SCHEMA = UNBLOCK_SCHEMA;
