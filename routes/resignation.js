const router = require("express").Router();
const P = require("../constants/hr_permissions");
const Joi = require("@hapi/joi");
const respondError = require("../utils/http")

/**
 * THE LEGACY RESIGNATION MODULE IS READ-ONLY.
 *
 * Employee Master -> Resign / Rejoin is the official workflow: Resign records
 * the exit (resignation date, closed employment period, F&F month) and Rejoin
 * applies the rehire assessment (CONDITIONAL / NO need management approval
 * with a reason). The old create / delete changed `new_employee.status` and the
 * login directly - outside both - so they are refused here, on the server,
 * whatever the caller's permissions; edit is refused so historical records
 * stay as they are. Nothing is written by a refused request. The list and the
 * single-record reads stay available.
 */
const LEGACY_READ_ONLY = {
  code: 410,
  error: "LEGACY_RESIGNATION_READ_ONLY",
  msg:
    "Legacy resignation records are read-only. Record an exit with Resign, and a return with Rejoin, " +
    "in Employee Master.",
};
const legacyReadOnly = (req, res) => res.json(LEGACY_READ_ONLY);

class ResignationRoutes {
  constructor(resignationUsecase, permissions) {
    this.permissions = permissions;
    this.resignationUsecase = resignationUsecase;

    this.init();
  }

  init() {
    router.get("/", this.permissions.require(P.VIEW_RESIGNATION), async (req, res) => {
        try {
          const resignation = await this.resignationUsecase.get();
          res.json(resignation);
        } catch (err) {
            console.log(err);
          if (err.name === "ValidationError") {
            res.json({ code: 422, msg: err.toString() });
          } else {
            res.json({ code: 500, msg: "An error occurred !" });
          }
        }
  
        res.end();
      });
      // RETIRED WRITE (see LEGACY_READ_ONLY below): it reactivated the employee and their login.
      router.post("/resignation_id", this.permissions.require(P.VIEW_RESIGNATION), legacyReadOnly);
      router.get("/get/resignation_id", this.permissions.require(P.VIEW_RESIGNATION), async (req, res) => {
        try {
          const schema = {
            resignation_id: Joi.string().required(),
          }
          const resignation = req.query;
          const isValid = Joi.validate(resignation, schema);
          if (isValid.error !== null) {
            throw isValid.error;
          }
          const data = await this.resignationUsecase.getResignationByResigId(resignation.resignation_id);
          res.json(data);
        } catch (err) {
          console.log(err);
          if (err.name === "ValidationError") {
            res.json({ code: 422, msg: err.toString() });
          } else {
            res.json({ code: 500, msg: "An error occurred !" });
          }
        }
  
        res.end();
      });
      router.get("/employee_name", this.permissions.require(P.VIEW_RESIGNATION), async (req, res) => {
        try {
          const schema = {
            employee_name: Joi.string().required(),
          }
          const resignation = req.query;
          const isValid = Joi.validate(resignation, schema);
          if (isValid.error !== null) {
            throw isValid.error;
          }
          const data = await this.resignationUsecase.getResignationById(resignation.employee_name);
          res.json(data);
        } catch (err) {
          console.log(err);
          if (err.name === "ValidationError") {
            res.json({ code: 422, msg: err.toString() });
          } else {
            res.json({ code: 500, msg: "An error occurred !" });
          }
        }
  
        res.end();
      });
      // RETIRED WRITE: edited a historical resignation record.
      router.post("/update-resignation", this.permissions.require(P.ADD_RESIGNATION), legacyReadOnly);
    // RETIRED WRITE: it deactivated the employee and their login outside the lifecycle.
    router.post("/create", this.permissions.require(P.ADD_RESIGNATION), legacyReadOnly);
  }
  getRouter() {
    return router;
  }
}   

module.exports = (resignationUsecase, permissions) => {
  return new ResignationRoutes(resignationUsecase, permissions);
};
module.exports.LEGACY_READ_ONLY = LEGACY_READ_ONLY;
