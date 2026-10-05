const express = require("express");
const Joi = require("@hapi/joi");

const P = require("../constants/hr_permissions");

/**
 * Master → Company Details.
 *
 *   GET  /company                       every company + the payslip company status
 *   GET  /company/company_id            one company (raw row)
 *   POST /company                       create
 *   PUT  /company/:company_id           edit
 *   POST /company/:company_id/payslip   make it THE payslip company
 *   POST /company/update-status         legacy: set `status` (1 = Active for Payslip)
 *
 * EVERY ROUTE TAKES `manage_company_details`. The company record is who every
 * payslip says it is from, plus the company's PAN / TAN / statutory codes, so
 * neither reading nor writing it is for ordinary employees. The key is
 * declared by its migration and granted to nobody; administrators hold it
 * through the user_type 2 bypass.
 */
const ID = Joi.number().integer().positive().required();
const BODY = Joi.object({
  company_name: Joi.string().allow("").max(200).optional(),
  reg_address: Joi.string().allow("").max(2000).optional(),
  contact_number: Joi.string().allow("").max(200).optional(),
  gst_number: Joi.string().allow("").max(200).optional(),
  pan_number: Joi.string().allow("").max(200).optional(),
  tan_number: Joi.string().allow("").max(200).optional(),
  pf_number: Joi.string().allow("").max(200).optional(),
  esi_number: Joi.string().allow("").max(200).optional(),
  payslip_active: Joi.boolean().optional(),
});

class companyRoutes {
  constructor(companyUsecase, permissions) {
    this.companyUsecase = companyUsecase;
    this.permissions = permissions;
    this.router = express.Router();
    this.init();
  }

  _fail(res, err) {
    if (err && err.name === "ValidationError") {
      res.status(422).json({ code: 422, msg: err.message, errors: err.errors || undefined });
    } else if (err && err.name === "NotFoundError") {
      res.status(404).json({ code: 404, msg: err.message });
    } else {
      console.log(err);
      res.status(500).json({ code: 500, msg: "An error occurred !" });
    }
  }

  init() {
    const guard = this.permissions.require(P.MANAGE_COMPANY_DETAILS);

    this.router.get("/", guard, async (req, res) => {
      try {
        res.json({ code: 200, ...(await this.companyUsecase.list()) });
      } catch (err) {
        this._fail(res, err);
      }
    });

    this.router.get("/company_id", guard, async (req, res) => {
      try {
        const isValid = Joi.validate(req.query, { company_id: ID });
        if (isValid.error !== null) throw isValid.error;
        res.json(await this.companyUsecase.get(Number(req.query.company_id)));
      } catch (err) {
        this._fail(res, err);
      }
    });

    this.router.post("/update-status", guard, async (req, res) => {
      try {
        const isValid = Joi.validate(req.body, { company_id: ID, status: Joi.number().valid(0, 1).required() });
        if (isValid.error !== null) throw isValid.error;
        res.json({ code: await this.companyUsecase.updateStatus(req.body) });
      } catch (err) {
        this._fail(res, err);
      }
    });

    this.router.post("/", guard, async (req, res) => {
      try {
        const isValid = Joi.validate(req.body, BODY);
        if (isValid.error !== null) throw isValid.error;
        res.json({ code: 200, ...(await this.companyUsecase.create(req.body)) });
      } catch (err) {
        this._fail(res, err);
      }
    });

    this.router.put("/:company_id", guard, async (req, res) => {
      try {
        const id = Joi.validate(req.params.company_id, ID);
        if (id.error !== null) throw id.error;
        const isValid = Joi.validate(req.body, BODY);
        if (isValid.error !== null) throw isValid.error;
        res.json({ code: 200, ...(await this.companyUsecase.update(Number(req.params.company_id), req.body)) });
      } catch (err) {
        this._fail(res, err);
      }
    });

    this.router.post("/:company_id/payslip", guard, async (req, res) => {
      try {
        const id = Joi.validate(req.params.company_id, ID);
        if (id.error !== null) throw id.error;
        res.json({ code: 200, ...(await this.companyUsecase.setPayslipCompany(Number(req.params.company_id))) });
      } catch (err) {
        this._fail(res, err);
      }
    });
  }

  getRouter() {
    return this.router;
  }
}

module.exports = (companyUsecase, permissions) => {
  return new companyRoutes(companyUsecase, permissions);
};
