const express = require("express");
const Joi = require("@hapi/joi");
const P = require("../constants/hr_permissions");
const respondError = require("../utils/http");

/**
 * Attendance Approver Setup - the API behind `/attendance/approver-setup`.
 *
 * EVERY endpoint, reads included, is behind `manage_attendance_approvers`:
 * the project has no separate view/edit pattern for the approval screens,
 * and the list already names who approves whom for the whole company.
 * Administrators reach it through the middleware's user_type 2 bypass, as
 * everywhere else; the migration grants the key to nobody.
 *
 * The shapes are ids in, ids plus resolved names out. No endpoint accepts a
 * name, and none returns a contact, bank, statutory or salary field.
 */
const ID = Joi.number().integer().positive();
const OPTIONAL_ID = Joi.alternatives().try(ID, Joi.valid(null, "")).optional();

class AttendanceApproverSetupRoutes {
  constructor(usecase, permissions) {
    this.usecase = usecase;
    this.permissions = permissions;
    this.router = express.Router();
    this.init();
  }

  static _respond(res, err) {
    if (err && err.name === "ValidationError") {
      res.status(400).json({ code: 400, msg: err.message, errors: err.details || [err.message] });
      return;
    }
    respondError(res, err);
  }

  init() {
    const guard = this.permissions.require(P.MANAGE_ATTENDANCE_APPROVERS);
    const actorOf = (req) => ({ employee_id: Number(req.decoded.employee_id), user_type: req.decoded.user_type });

    /** The setup screen's list. */
    this.router.get("/attendance/approver-setup", guard, async (req, res) => {
      try {
        const schema = {
          department_id: ID.optional(),
          store_id: ID.optional(),
          designation_id: ID.optional(),
          employee_id: ID.optional(),
          search: Joi.string().allow("").max(100).optional(),
          limit: Joi.number().integer().min(1).max(1000).optional(),
          offset: Joi.number().integer().min(0).optional(),
        };
        const isValid = Joi.validate(req.query, schema);
        if (isValid.error !== null) throw isValid.error;
        res.json({ code: 200, ...(await this.usecase.list(req.query)) });
      } catch (err) {
        AttendanceApproverSetupRoutes._respond(res, err);
      }
    });

    /** Approver picker: active employees; `include_inactive=1` for the Replace flow's current-approver search. */
    this.router.get("/attendance/approver-setup/options", guard, async (req, res) => {
      try {
        const schema = {
          include_inactive: Joi.any().valid("1", "0", "true", "false", 1, 0, true, false).optional(),
          search: Joi.string().allow("").max(100).optional(),
        };
        const isValid = Joi.validate(req.query, schema);
        if (isValid.error !== null) throw isValid.error;
        const includeInactive = ["1", "true", 1, true].includes(req.query.include_inactive);
        const employees = await this.usecase.options({ include_inactive: includeInactive, search: req.query.search || null });
        res.json({ code: 200, employees, include_inactive: includeInactive });
      } catch (err) {
        AttendanceApproverSetupRoutes._respond(res, err);
      }
    });

    /** Everybody currently an approver somewhere, active or resigned. */
    this.router.get("/attendance/approver-setup/current-approvers", guard, async (req, res) => {
      try {
        res.json({ code: 200, approvers: await this.usecase.currentApprovers() });
      } catch (err) {
        AttendanceApproverSetupRoutes._respond(res, err);
      }
    });

    /** The append-only audit. */
    this.router.get("/attendance/approver-setup/audit", guard, async (req, res) => {
      try {
        const schema = {
          employee_id: ID.optional(),
          approver_employee_id: ID.optional(),
          limit: Joi.number().integer().min(1).max(500).optional(),
        };
        const isValid = Joi.validate(req.query, schema);
        if (isValid.error !== null) throw isValid.error;
        const rows = await this.usecase.audit({
          employee_id: req.query.employee_id ? Number(req.query.employee_id) : null,
          approver_employee_id: req.query.approver_employee_id ? Number(req.query.approver_employee_id) : null,
          limit: req.query.limit ? Number(req.query.limit) : 100,
        });
        res.json({ code: 200, rows });
      } catch (err) {
        AttendanceApproverSetupRoutes._respond(res, err);
      }
    });

    /** BULK_SET: the same three approvers for many employees, each validated on its own. */
    this.router.post("/attendance/approver-setup/bulk", guard, async (req, res) => {
      try {
        const schema = {
          employee_ids: Joi.array().items(ID).min(1).max(1000).required(),
          first_level_approver_employee_id: OPTIONAL_ID,
          second_level_approver_employee_id: OPTIONAL_ID,
          final_approver_employee_id: ID.required(),
        };
        const isValid = Joi.validate(req.body, schema);
        if (isValid.error !== null) throw isValid.error;
        const result = await this.usecase.bulkSet({ actor: actorOf(req), ...req.body });
        res.json(result);
      } catch (err) {
        AttendanceApproverSetupRoutes._respond(res, err);
      }
    });

    /** REPLACE: one approver by another at one level, master rows and undecided pending steps together. */
    this.router.post("/attendance/approver-setup/replace", guard, async (req, res) => {
      try {
        const schema = {
          current_approver_employee_id: ID.required(),
          approval_level: Joi.string().valid("FIRST", "SECOND", "FINAL").required(),
          new_approver_employee_id: ID.required(),
          preview: Joi.boolean().optional(),
        };
        const isValid = Joi.validate(req.body, schema);
        if (isValid.error !== null) throw isValid.error;
        const result = await this.usecase.replace({ actor: actorOf(req), ...req.body, preview: req.body.preview === true });
        res.json(result);
      } catch (err) {
        AttendanceApproverSetupRoutes._respond(res, err);
      }
    });

    /** One employee's setup, with the employee named for the edit dialog. */
    this.router.get("/attendance/approver-setup/:employee_id", guard, async (req, res) => {
      try {
        const isValid = Joi.validate({ employee_id: req.params.employee_id }, { employee_id: ID.required() });
        if (isValid.error !== null) throw isValid.error;
        res.json({ code: 200, ...(await this.usecase.get(Number(req.params.employee_id))) });
      } catch (err) {
        AttendanceApproverSetupRoutes._respond(res, err);
      }
    });

    /** SET: save or update one employee. */
    this.router.put("/attendance/approver-setup/:employee_id", guard, async (req, res) => {
      try {
        const isValidParam = Joi.validate({ employee_id: req.params.employee_id }, { employee_id: ID.required() });
        if (isValidParam.error !== null) throw isValidParam.error;
        const schema = {
          first_level_approver_employee_id: OPTIONAL_ID,
          second_level_approver_employee_id: OPTIONAL_ID,
          final_approver_employee_id: ID.required(),
        };
        const isValid = Joi.validate(req.body, schema);
        if (isValid.error !== null) throw isValid.error;
        const result = await this.usecase.save({
          actor: actorOf(req),
          employee_id: Number(req.params.employee_id),
          ...req.body,
        });
        res.json(result);
      } catch (err) {
        AttendanceApproverSetupRoutes._respond(res, err);
      }
    });
  }

  getRouter() {
    return this.router;
  }
}

module.exports = (usecase, permissions) => new AttendanceApproverSetupRoutes(usecase, permissions);
module.exports.AttendanceApproverSetupRoutes = AttendanceApproverSetupRoutes;
