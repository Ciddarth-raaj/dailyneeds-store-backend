const express = require("express");
const Joi = require("@hapi/joi");
const P = require("../constants/hr_permissions");
const { EDITABLE_FIELDS } = require("../repository/employee_master");

const router = express.Router();

/**
 * Stage 0C / C2 — the local employee-master API, mounted at /hr.
 *
 * A separate router rather than four more routes bolted onto the 600-line
 * employee router: these are the lifecycle actions, they carry their own
 * permissions, and keeping them together is what lets C3 find them.
 *
 * B3 IS UNCHANGED AND STILL AUTHORITATIVE. `filterResponse` and `guardWrite`
 * are applied to this router exactly as they are to /employee, so a caller
 * without `view_employee_sensitive` never sees salary, bank, PAN, Aadhaar,
 * UAN, PF or ESI here, and a body that so much as mentions one of them is
 * refused unless the caller holds `edit_employee_sensitive`. HR owning the
 * employee record does not make HR entitled to everything on it.
 */
class EmployeeMasterRoutes {
  constructor(employeeMasterUsecase, permissions, sensitive) {
    this.usecase = employeeMasterUsecase;
    this.permissions = permissions;
    this.sensitive = sensitive;
    this.setupRoutes();
  }

  /** Errors carry their own status; anything else is a 500 without detail. */
  _fail(res, err) {
    if (err && err.httpCode) {
      res.json({ code: err.httpCode, msg: err.message });
      return;
    }
    if (err && err.name === "ValidationError") {
      res.json({ code: 422, msg: err.toString() });
      return;
    }
    console.log(err);
    res.json({ code: 500, msg: "An error occurred !" });
  }

  /** The acting employee, for the lifecycle event's actor column. */
  _actor(req) {
    const id = req.auth && req.auth.employeeId;
    return Number.isInteger(Number(id)) && Number(id) > 0 ? Number(id) : null;
  }

  setupRoutes() {
    router.use(this.sensitive.filterResponse);
    router.use(this.sensitive.guardWrite);

    /* ------------------------------------------------------------ create */
    router.post("/employee", this.permissions.require(P.EMPLOYEE_CREATE), async (req, res) => {
      try {
        const schema = Joi.object()
          .keys({
            employee_name: Joi.string().trim().min(1).required(),
            date_of_joining: Joi.string().required(),
            store_id: Joi.number().integer().positive().required(),
            designation_id: Joi.number().integer().positive().required(),
            department_id: Joi.number().integer().positive().required(),
            shift_id: Joi.number().integer().positive().optional(),
            primary_contact_number: Joi.string().trim().optional(),
            father_name: Joi.string().allow("", null).optional(),
            dob: Joi.string().allow("", null).optional(),
            gender: Joi.string().allow("", null).optional(),
            marital_status: Joi.string().allow("", null).optional(),
            marriage_date: Joi.string().allow("", null).optional(),
            spouse_name: Joi.string().allow("", null).optional(),
            permanent_address: Joi.string().allow("", null).optional(),
            residential_address: Joi.string().allow("", null).optional(),
            alternate_contact_number: Joi.string().allow("", null).optional(),
            email_id: Joi.string().trim().allow("", null).optional(),
            blood_group: Joi.string().allow("", null).optional(),
            qualification: Joi.string().allow("", null).optional(),
            introducer_name: Joi.string().allow("", null).optional(),
            introducer_details: Joi.string().allow("", null).optional(),
            previous_experience: Joi.string().allow("", null).optional(),
            additional_course: Joi.string().allow("", null).optional(),
            uniform_qty: Joi.number().allow("", null).optional(),
            employee_image: Joi.string().allow("", null).optional(),
            telegram_username: Joi.string().allow("", null).optional(),
            online_portal: Joi.number().optional(),
          })
          // employee_id is absent on purpose: the database allocates it, and
          // accepting one from a client is what would make identity guessable.
          .unknown(false);

        const isValid = Joi.validate(req.body, schema);
        if (isValid.error !== null) throw isValid.error;

        res.json(await this.usecase.createEmployee(req.body, { actorEmployeeId: this._actor(req) }));
      } catch (err) {
        this._fail(res, err);
      }
      res.end();
    });

    /* -------------------------------------------------------------- edit */
    router.post("/employee/:employee_id/edit", this.permissions.require(P.EMPLOYEE_EDIT), async (req, res) => {
      try {
        const employeeId = Number(req.params.employee_id);
        if (!Number.isInteger(employeeId) || employeeId <= 0) {
          res.json({ code: 422, msg: "employee_id must be a positive integer" });
          res.end();
          return;
        }
        // Every editable column, and nothing else. A body naming employee_id,
        // status or a lifecycle date is refused by the usecase with a message
        // pointing at the right action.
        const keys = {};
        for (const f of EDITABLE_FIELDS) keys[f] = Joi.any().optional();
        const isValid = Joi.validate(req.body, Joi.object().keys(keys).unknown(true));
        if (isValid.error !== null) throw isValid.error;

        res.json(
          await this.usecase.editEmployee(employeeId, req.body, { actorEmployeeId: this._actor(req) })
        );
      } catch (err) {
        this._fail(res, err);
      }
      res.end();
    });

    /* ------------------------------------------------------------ resign */
    router.post("/employee/:employee_id/resign", this.permissions.require(P.EMPLOYEE_RESIGN), async (req, res) => {
      try {
        const employeeId = Number(req.params.employee_id);
        const schema = {
          resignation_date: Joi.string().required(),
          reason_type: Joi.string().allow("", null).optional(),
          reason: Joi.string().allow("", null).optional(),
        };
        const isValid = Joi.validate(req.body, schema);
        if (isValid.error !== null) throw isValid.error;

        res.json(
          await this.usecase.resignEmployee(employeeId, req.body, { actorEmployeeId: this._actor(req) })
        );
      } catch (err) {
        this._fail(res, err);
      }
      res.end();
    });

    /* ------------------------------------------------------------ rejoin */
    router.post("/employee/:employee_id/rejoin", this.permissions.require(P.EMPLOYEE_REJOIN), async (req, res) => {
      try {
        const employeeId = Number(req.params.employee_id);
        const schema = {
          date_of_joining: Joi.string().required(),
          previous_ended_on: Joi.string().allow("", null).optional(),
        };
        const isValid = Joi.validate(req.body, schema);
        if (isValid.error !== null) throw isValid.error;

        res.json(
          await this.usecase.rejoinEmployee(employeeId, req.body, { actorEmployeeId: this._actor(req) })
        );
      } catch (err) {
        this._fail(res, err);
      }
      res.end();
    });

    /* --------------------------------------------------- lifecycle reads */
    router.get(
      "/employee/:employee_id/lifecycle",
      this.permissions.require(P.VIEW_EMPLOYEE_LIFECYCLE),
      async (req, res) => {
        try {
          res.json(await this.usecase.getLifecycleHistory(Number(req.params.employee_id)));
        } catch (err) {
          this._fail(res, err);
        }
        res.end();
      }
    );

    router.get("/lifecycle/review", this.permissions.require(P.VIEW_EMPLOYEE_LIFECYCLE), async (req, res) => {
      try {
        const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 500);
        const offset = Math.max(Number(req.query.offset) || 0, 0);
        res.json(await this.usecase.getReviewList({ limit, offset }));
      } catch (err) {
        this._fail(res, err);
      }
      res.end();
    });
  }

  getRouter() {
    return router;
  }
}

module.exports = (employeeMasterUsecase, permissions, sensitive) =>
  new EmployeeMasterRoutes(employeeMasterUsecase, permissions, sensitive);
