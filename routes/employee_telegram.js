const express = require("express");
const Joi = require("@hapi/joi");
const P = require("../constants/hr_permissions");

/**
 * EMPLOYEE TELEGRAM SETUP. Mounted at /hr, beside the other employee routers.
 *
 *   POST /employee/:employee_id/telegram/link-token   employee_create OR employee_edit
 *   GET  /employee/:employee_id/telegram              view_employees
 *   POST /employee/:employee_id/telegram/disconnect   employee_create OR employee_edit
 *
 * EVERY ROUTE NAMES AN EMPLOYEE, AND EVERY ROUTE CARRIES
 * `requireEmployeeInScope()` immediately after its permission check. That is
 * not belt and braces: the permission key says WHAT a caller may do, and the
 * branch scope says WHICH employees they may do it to. HR and administrators
 * are company-wide; everybody else is their own store, decided in SQL from the
 * caller's live branch assignment rather than from anything in the request. A
 * non-existent employee id is refused the same way as an out-of-branch one, so
 * ids cannot be enumerated by watching the answer change.
 *
 * `permissions.require(A, B)` IS ALREADY OR. It is the existing helper's
 * documented behaviour (`keys.some(...)`), so "employee_create OR
 * employee_edit" needs no new middleware - which matters, because the approved
 * rule is precisely that finishing Telegram setup for an EXISTING employee
 * must not require the right to CREATE employees.
 *
 * A SEPARATE ROUTER, NOT AN ADDITION TO `routes/employee_master.js`. That file
 * holds a module-level `router` shared by the module and mounts B3's
 * `filterResponse`/`guardWrite` across everything on it; these three endpoints
 * return no sensitive employee column at all, so they are kept apart rather
 * than threaded through a filter with nothing to strip.
 *
 * WHAT THESE ENDPOINTS NEVER RETURN: a token or its hash, a Telegram user id,
 * a chat id, or any mobile number. The link is returned exactly once, to the
 * caller who asked for it, and is stored only as a hash.
 */
class EmployeeTelegramRoutes {
  constructor(usecase, permissions, branchScope, membershipUsecase, mappingRepo) {
    if (!branchScope) {
      throw new Error("routes/employee_telegram: the employee branch scope is required");
    }
    this.usecase = usecase;
    this.permissions = permissions;
    this.branchScope = branchScope;
    // Phase 3B. Optional so the routes still mount without it - the
    // existing identity endpoints are unaffected by group membership.
    this.membership = membershipUsecase || null;
    this.mappingRepo = mappingRepo || null;
    this.router = express.Router();
    this.init();
  }

  _fail(res, err) {
    if (err && err.name === "ValidationError") {
      res.json({ code: 422, msg: err.toString() });
      return;
    }
    res.json({ code: 500, msg: "An error occurred !" });
  }

  /** The signed-in user, for the audit trail. It carries no authority. */
  _actorUserId(req) {
    const id = req.auth && req.auth.userId !== undefined ? req.auth.userId : req.decoded && req.decoded.user_id;
    return Number.isInteger(Number(id)) && Number(id) > 0 ? Number(id) : null;
  }

  _employeeId(req, res) {
    const employeeId = Number(req.params.employee_id);
    if (!Number.isInteger(employeeId) || employeeId <= 0) {
      res.json({ code: 422, msg: "employee_id must be a positive integer" });
      res.end();
      return null;
    }
    return employeeId;
  }

  init() {
    const r = this.router;
    const gate = this.permissions;

    /**
     * Generate the employee's one-time deep link.
     *
     * The body must be empty. Nothing about this request may be supplied by
     * the browser except which employee it is for - and that is checked
     * against the caller's branch before the handler runs.
     */
    r.post(
      "/employee/:employee_id/telegram/link-token",
      gate.require(P.EMPLOYEE_CREATE, P.EMPLOYEE_EDIT),
      this.branchScope.requireEmployeeInScope(),
      async (req, res) => {
        try {
          const employeeId = this._employeeId(req, res);
          if (employeeId === null) return;

          const isValid = Joi.validate(req.body || {}, Joi.object().keys({}).unknown(false));
          if (isValid.error !== null) throw isValid.error;

          res.json(
            await this.usecase.startLink(employeeId, { actorUserId: this._actorUserId(req) })
          );
        } catch (err) {
          this._fail(res, err);
        }
        res.end();
      }
    );

    /**
     * The employee's Telegram state, for the onboarding and profile screens.
     *
     * `view_employees`, the same key as every other status on those screens -
     * whether somebody's Telegram is connected is the same kind of fact as
     * whether their Aadhaar is verified, and it names no identifier.
     */
    r.get(
      "/employee/:employee_id/telegram",
      gate.require(P.VIEW_EMPLOYEES),
      this.branchScope.requireEmployeeInScope(),
      async (req, res) => {
        try {
          const employeeId = this._employeeId(req, res);
          if (employeeId === null) return;
          res.json(await this.usecase.getStatus(employeeId));
        } catch (err) {
          this._fail(res, err);
        }
        res.end();
      }
    );

    /**
     * Retire the employee's Telegram identity.
     *
     * IN THIS PHASE BECAUSE RECONNECT NEEDS IT. A wrong account connected
     * after a mistyped mobile must be undoable by the same people who set it
     * up, without a database edit. It writes history rather than deleting it,
     * and starts no group action - nothing in this phase does.
     */
    r.post(
      "/employee/:employee_id/telegram/disconnect",
      gate.require(P.EMPLOYEE_CREATE, P.EMPLOYEE_EDIT),
      this.branchScope.requireEmployeeInScope(),
      async (req, res) => {
        try {
          const employeeId = this._employeeId(req, res);
          if (employeeId === null) return;

          const isValid = Joi.validate(req.body || {}, Joi.object().keys({}).unknown(false));
          if (isValid.error !== null) throw isValid.error;

          res.json(
            await this.usecase.disconnect(employeeId, { actorUserId: this._actorUserId(req) })
          );
        } catch (err) {
          this._fail(res, err);
        }
        res.end();
      }
    );

    /* -------------------------------- Phase 3B: required group membership */

    if (!this.membership) return;

    /**
     * The employee's required groups and where they stand in each.
     *
     * `view_employees`, like every other status on these screens, plus the
     * SAME branch guard: which groups somebody must be in, and whether they
     * are, is information about that employee, so a manager may read it for
     * their own branch and nobody else's.
     *
     * IT COSTS TELEGRAM CALLS - readiness and membership for each required
     * group - so it is deliberately a per-employee screen endpoint and is
     * never called from a list or a dashboard.
     */
    r.get(
      "/employee/:employee_id/telegram/groups",
      gate.require(P.VIEW_EMPLOYEES),
      this.branchScope.requireEmployeeInScope(),
      async (req, res) => {
        try {
          const employeeId = this._employeeId(req, res);
          if (employeeId === null) return;
          const employee = await this.mappingRepo.getEmployeeForMatching(employeeId);
          res.json({ code: 200, data: await this.membership.getGroups(employeeId, employee) });
        } catch (err) {
          this._fail(res, err);
        }
        res.end();
      }
    );

    /**
     * Issue this employee's join link for one group.
     *
     * The mutation pair the rest of Telegram onboarding uses -
     * `employee_create OR employee_edit` - plus the branch guard, so a
     * manager cannot generate a link for another branch's employee.
     *
     * THE BODY MUST BE EMPTY. Nothing about this request may come from the
     * browser except which employee and which group, and both are checked
     * against current state by the usecase before anything is created.
     */
    r.post(
      "/employee/:employee_id/telegram/groups/:telegram_group_id(\\d+)/join-link",
      gate.require(P.EMPLOYEE_CREATE, P.EMPLOYEE_EDIT),
      this.branchScope.requireEmployeeInScope(),
      async (req, res) => {
        try {
          const employeeId = this._employeeId(req, res);
          if (employeeId === null) return;

          const isValid = Joi.validate(req.body || {}, Joi.object().keys({}).unknown(false));
          if (isValid.error !== null) throw isValid.error;

          const employee = await this.mappingRepo.getEmployeeForMatching(employeeId);
          res.json(
            await this.membership.createJoinLink(
              employeeId,
              parseInt(req.params.telegram_group_id, 10),
              employee,
              { actorUserId: this._actorUserId(req) }
            )
          );
        } catch (err) {
          this._fail(res, err);
        }
        res.end();
      }
    );
  }

  getRouter() {
    return this.router;
  }
}

module.exports = (usecase, permissions, branchScope, membershipUsecase, mappingRepo) =>
  new EmployeeTelegramRoutes(usecase, permissions, branchScope, membershipUsecase, mappingRepo);
module.exports.EmployeeTelegramRoutes = EmployeeTelegramRoutes;
