const express = require("express");
const Joi = require("@hapi/joi");
const P = require("../constants/hr_permissions");
const { EDITABLE_FIELDS } = require("../repository/employee_master");
const { getClientIp } = require("../utils/ip");

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
  constructor(employeeMasterUsecase, permissions, sensitive, aadhaarUsecase) {
    this.usecase = employeeMasterUsecase;
    this.permissions = permissions;
    this.sensitive = sensitive;
    this.aadhaar = aadhaarUsecase || null;
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
            // Stage 0C / C2. When present, the employee is created with a
            // verified Aadhaar identity attached in the same transaction.
            aadhaar_verification_id: Joi.number().integer().positive().optional(),
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

    /* ------------------------------------------------------------ Aadhaar */
    /**
     * Verify an Aadhaar and find out whether we already know this person.
     *
     * Gated on `employee_create` at the route, and on `edit_employee_sensitive`
     * by B3 - the body carries `aadhaar_number`, which is a sensitive field,
     * so `guardWrite` refuses the request outright without that permission.
     * Two layers, neither of them new.
     */
    router.post("/aadhaar/verify", this.permissions.require(P.EMPLOYEE_CREATE), async (req, res) => {
      try {
        if (!this.aadhaar) {
          res.json({ code: 503, msg: "Aadhaar verification is not configured on this server" });
          res.end();
          return;
        }
        const schema = {
          aadhaar_number: Joi.string().required(),
          consent_given: Joi.boolean().required(),
          provider: Joi.string().allow("", null).optional(),
          provider_reference: Joi.string().allow("", null).optional(),
          demographics: Joi.object()
            .keys({
              name: Joi.string().allow("", null).optional(),
              dob: Joi.string().allow("", null).optional(),
              gender: Joi.string().allow("", null).optional(),
              address: Joi.string().allow("", null).optional(),
            })
            .optional(),
        };
        const isValid = Joi.validate(req.body, schema);
        if (isValid.error !== null) throw isValid.error;

        res.json(
          await this.aadhaar.verify(req.body, {
            actorEmployeeId: this._actor(req),
            ip: getClientIp(req),
          })
        );
      } catch (err) {
        this._fail(res, err);
      }
      res.end();
    });

    /** The display record: last four and provenance. Never the number. */
    router.get(
      "/employee/:employee_id/aadhaar",
      this.permissions.require(P.VIEW_EMPLOYEE_LIFECYCLE),
      async (req, res) => {
        try {
          if (!this.aadhaar) {
            res.json({ code: 503, msg: "Aadhaar verification is not configured on this server" });
            res.end();
            return;
          }
          const row = await this.aadhaar.getIdentity(Number(req.params.employee_id));
          res.json(row || { code: 404, msg: "no Aadhaar on record for this employee" });
        } catch (err) {
          this._fail(res, err);
        }
        res.end();
      }
    );

    /**
     * The full number, for PF and ESI filing.
     *
     * BOTH keys, not either: `view_employee_sensitive` is what B3 requires to
     * let an Aadhaar value through `filterResponse` at all, and
     * `view_aadhaar_full` is the additional, specific decision that this
     * caller may read all twelve digits rather than the last four. Requiring
     * only the second would mean B3 silently stripped the very field the
     * route exists to return - the two layers must agree, and `requireAll`
     * is how that is said.
     *
     * Every read is logged with who read it.
     */
    router.get(
      "/employee/:employee_id/aadhaar/full",
      this.permissions.requireAll(P.VIEW_EMPLOYEE_SENSITIVE, P.VIEW_AADHAAR_FULL),
      async (req, res) => {
        try {
          if (!this.aadhaar) {
            res.json({ code: 503, msg: "Aadhaar verification is not configured on this server" });
            res.end();
            return;
          }
          res.json(
            await this.aadhaar.revealFullNumber(Number(req.params.employee_id), {
              actorEmployeeId: this._actor(req),
            })
          );
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

module.exports = (employeeMasterUsecase, permissions, sensitive, aadhaarUsecase) =>
  new EmployeeMasterRoutes(employeeMasterUsecase, permissions, sensitive, aadhaarUsecase);
