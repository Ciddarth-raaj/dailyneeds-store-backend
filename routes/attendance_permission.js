/**
 * Attendance PERMISSION - the DIRECT (management) grant and the register.
 *
 *   POST /attendance/permissions/preview                  who a grant reaches; writes nothing
 *   POST /attendance/permissions/apply                    grant exactly what was previewed
 *   GET  /attendance/permissions                          the Permission register
 *   POST /attendance/permissions/:id/revoke               revoke one direct grant
 *   GET  /attendance/permissions/bulk-operations          bulk grants, newest first
 *   GET  /attendance/permissions/bulk-operations/:id      one bulk grant, per employee
 *   POST /attendance/permissions/bulk-operations/:id/revoke  revoke what is left of one
 *
 * REQUESTED permissions are raised, decided and revoked through the approval
 * routes (`routes/attendance_regularization.js`).
 *
 * RIGHTS. Granting to ONE named employee needs `grant_attendance_permission`;
 * several employees, an outlet or everybody in scope needs
 * `grant_attendance_permission_bulk` as well - the same one/bulk split the
 * shift assignment screen draws. Revoking needs `revoke_attendance_permission`;
 * reading needs `view_attendance_permissions`. No role name is consulted.
 *
 * SCOPE. Every route resolves the caller's outlet scope with
 * `employeeBranchScope.listFilters` from the server's own facts and hands the
 * usecase the store ids it may touch; naming an outlet outside it is refused,
 * and it fails closed without the middleware. Employees outside the scope are
 * never candidates, and a permission outside it reads as "not found".
 */
const express = require("express");
const Joi = require("@hapi/joi");
const P = require("../constants/hr_permissions");
const respondError = require("../utils/http");

class AttendancePermissionRoutes {
  constructor(permissionUsecase, permissions, sensitive, branchScope = null) {
    this.usecase = permissionUsecase;
    this.permissions = permissions;
    this.sensitive = sensitive;
    this.branchScope = branchScope;
    this.router = express.Router();
    this.init();
  }

  static _forbidden(res) {
    return res.status(403).json({ code: 403, msg: "You do not have permission to perform this action" });
  }

  static _respond(res, err) {
    if (err && err.name === "ForbiddenError") return res.status(403).json({ code: 403, msg: err.message });
    return respondError(res, err);
  }

  _actor(req) {
    const num = (v) => (v === null || v === undefined ? null : Number(v));
    return { employee_id: num(req.decoded.employee_id), user_id: num(req.decoded.id), user_type: req.decoded.user_type };
  }

  /**
   * The store ids this call may touch: null = every outlet, a list = those.
   * Sends the refusal itself and answers `undefined` when the caller has no
   * scope or named an outlet outside it.
   */
  async _scope(req, res, requestedOutletIds = null) {
    if (!this.branchScope || typeof this.branchScope.listFilters !== "function") {
      AttendancePermissionRoutes._forbidden(res);
      return undefined;
    }
    const outcome = await this.branchScope.listFilters(req, requestedOutletIds);
    if (!outcome.ok) {
      this.branchScope.refuse(res, outcome);
      return undefined;
    }
    return outcome.store_ids === undefined ? null : outcome.store_ids;
  }

  /** ONE named employee needs the grant key; anything wider needs the bulk key too. */
  async _grantKeys(req, res) {
    const wide =
      req.body.target_mode !== "EMPLOYEES" ||
      !Array.isArray(req.body.employee_ids) ||
      req.body.employee_ids.length !== 1;
    const keys = wide
      ? [P.GRANT_ATTENDANCE_PERMISSION, P.GRANT_ATTENDANCE_PERMISSION_BULK]
      : [P.GRANT_ATTENDANCE_PERMISSION];
    if (await this.permissions.hasAll(req, ...keys)) return true;
    AttendancePermissionRoutes._forbidden(res);
    return false;
  }

  init() {
    if (this.sensitive) {
      this.router.use("/attendance/permissions", this.sensitive.filterResponse);
      this.router.use("/attendance/permissions", this.sensitive.guardWrite);
    }

    const grantSchema = {
      attendance_date: Joi.string().regex(/^\d{4}-\d{2}-\d{2}$/).required(),
      from_time: Joi.string().regex(/^\d{2}:\d{2}$/).required(),
      to_time: Joi.string().regex(/^\d{2}:\d{2}$/).optional(),
      to_shift_end: Joi.boolean().optional(),
      target_mode: Joi.string().valid("EMPLOYEES", "OUTLETS", "ALL").required(),
      employee_ids: Joi.array().items(Joi.number().integer().min(1)).max(2000).optional(),
      outlet_ids: Joi.array().items(Joi.number().integer().min(1)).max(500).optional(),
      reason: Joi.string().trim().min(5).max(500).required(),
      remarks: Joi.string().allow("").max(500).optional(),
    };
    const validateGrant = (body, extra = {}) => {
      const isValid = Joi.validate(body, { ...grantSchema, ...extra });
      if (isValid.error !== null) throw isValid.error;
      if (!body.to_shift_end && !body.to_time) {
        const err = new Error("Give to_time, or choose until the shift end");
        err.name = "ValidationError";
        throw err;
      }
    };
    const grantArgs = (req) => ({
      attendance_date: req.body.attendance_date,
      from_time: req.body.from_time,
      to_time: req.body.to_time || null,
      to_shift_end: Boolean(req.body.to_shift_end),
      target_mode: req.body.target_mode,
      employee_ids: req.body.employee_ids || [],
      outlet_ids: req.body.outlet_ids || [],
      reason: req.body.reason,
      remarks: req.body.remarks || null,
    });

    this.router.post(
      "/attendance/permissions/preview",
      this.permissions.require(P.GRANT_ATTENDANCE_PERMISSION),
      async (req, res) => {
        try {
          validateGrant(req.body);
          if (!(await this._grantKeys(req, res))) return undefined;
          const scope = await this._scope(req, res, req.body.target_mode === "OUTLETS" ? req.body.outlet_ids : null);
          if (scope === undefined) return undefined;
          const result = await this.usecase.preview({ actor: this._actor(req), scope_store_ids: scope, ...grantArgs(req) });
          return res.json(result);
        } catch (err) {
          return AttendancePermissionRoutes._respond(res, err);
        }
      }
    );

    this.router.post(
      "/attendance/permissions/apply",
      this.permissions.require(P.GRANT_ATTENDANCE_PERMISSION),
      async (req, res) => {
        try {
          validateGrant(req.body, { fingerprint: Joi.string().length(64).required() });
          if (!(await this._grantKeys(req, res))) return undefined;
          const scope = await this._scope(req, res, req.body.target_mode === "OUTLETS" ? req.body.outlet_ids : null);
          if (scope === undefined) return undefined;
          const result = await this.usecase.apply({
            actor: this._actor(req),
            scope_store_ids: scope,
            fingerprint: req.body.fingerprint,
            ...grantArgs(req),
          });
          return res.status(result.code === 409 ? 409 : 200).json(result);
        } catch (err) {
          return AttendancePermissionRoutes._respond(res, err);
        }
      }
    );

    this.router.get(
      "/attendance/permissions",
      this.permissions.require(P.VIEW_ATTENDANCE_PERMISSIONS),
      async (req, res) => {
        try {
          const schema = {
            from_date: Joi.string().regex(/^\d{4}-\d{2}-\d{2}$/).required(),
            to_date: Joi.string().regex(/^\d{4}-\d{2}-\d{2}$/).required(),
            outlet_ids: Joi.string().allow("").optional(),
            employee_id: Joi.number().integer().min(1).optional(),
            source: Joi.string().valid("REQUEST", "DIRECT").optional(),
            bulk_operation_id: Joi.string().max(36).optional(),
            limit: Joi.number().integer().min(1).max(500).optional(),
            offset: Joi.number().integer().min(0).optional(),
          };
          const isValid = Joi.validate(req.query, schema);
          if (isValid.error !== null) throw isValid.error;
          const scope = await this._scope(req, res, req.query.outlet_ids || null);
          if (scope === undefined) return undefined;
          const result = await this.usecase.list({
            scope_store_ids: scope,
            from_date: req.query.from_date,
            to_date: req.query.to_date,
            employee_id: req.query.employee_id ? Number(req.query.employee_id) : null,
            source: req.query.source || null,
            bulk_operation_id: req.query.bulk_operation_id || null,
            limit: req.query.limit ? Number(req.query.limit) : 200,
            offset: req.query.offset ? Number(req.query.offset) : 0,
          });
          return res.json(result);
        } catch (err) {
          return AttendancePermissionRoutes._respond(res, err);
        }
      }
    );

    this.router.get(
      "/attendance/permissions/bulk-operations",
      this.permissions.require(P.VIEW_ATTENDANCE_PERMISSIONS),
      async (req, res) => {
        try {
          const scope = await this._scope(req, res, null);
          if (scope === undefined) return undefined;
          return res.json(await this.usecase.listBulkOperations({ scope_store_ids: scope }));
        } catch (err) {
          return AttendancePermissionRoutes._respond(res, err);
        }
      }
    );

    this.router.get(
      "/attendance/permissions/bulk-operations/:bulk_operation_id",
      this.permissions.require(P.VIEW_ATTENDANCE_PERMISSIONS),
      async (req, res) => {
        try {
          const scope = await this._scope(req, res, null);
          if (scope === undefined) return undefined;
          return res.json(
            await this.usecase.getBulkOperationItems({
              scope_store_ids: scope,
              bulk_operation_id: String(req.params.bulk_operation_id),
            })
          );
        } catch (err) {
          return AttendancePermissionRoutes._respond(res, err);
        }
      }
    );

    const revokeSchema = { reason: Joi.string().trim().min(5).max(500).required() };

    this.router.post(
      "/attendance/permissions/bulk-operations/:bulk_operation_id/revoke",
      this.permissions.require(P.REVOKE_ATTENDANCE_PERMISSION),
      async (req, res) => {
        try {
          const isValid = Joi.validate(req.body, revokeSchema);
          if (isValid.error !== null) throw isValid.error;
          const scope = await this._scope(req, res, null);
          if (scope === undefined) return undefined;
          const result = await this.usecase.revokeBulkOperation({
            actor: this._actor(req),
            scope_store_ids: scope,
            bulk_operation_id: String(req.params.bulk_operation_id),
            reason: req.body.reason,
          });
          return res.json(result);
        } catch (err) {
          return AttendancePermissionRoutes._respond(res, err);
        }
      }
    );

    this.router.post(
      "/attendance/permissions/:attendance_permission_id/revoke",
      this.permissions.require(P.REVOKE_ATTENDANCE_PERMISSION),
      async (req, res) => {
        try {
          const isValid = Joi.validate(req.body, revokeSchema);
          if (isValid.error !== null) throw isValid.error;
          const id = Number(req.params.attendance_permission_id);
          if (!Number.isInteger(id) || id <= 0) return res.status(404).json({ code: 404, msg: "No such permission" });
          const scope = await this._scope(req, res, null);
          if (scope === undefined) return undefined;
          const result = await this.usecase.revoke({
            actor: this._actor(req),
            scope_store_ids: scope,
            attendance_permission_id: id,
            reason: req.body.reason,
          });
          const status = result.code === 404 ? 404 : result.code === 409 ? 409 : 200;
          return res.status(status).json(result);
        } catch (err) {
          return AttendancePermissionRoutes._respond(res, err);
        }
      }
    );
  }

  getRouter() {
    return this.router;
  }
}

module.exports = (permissionUsecase, permissions, sensitive, branchScope) =>
  new AttendancePermissionRoutes(permissionUsecase, permissions, sensitive, branchScope);
module.exports.AttendancePermissionRoutes = AttendancePermissionRoutes;
