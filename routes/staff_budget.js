const express = require("express");
const Joi = require("@hapi/joi");
const P = require("../constants/hr_permissions");
const respondError = require("../utils/http");

/**
 * The Staff Budget Master, mounted at /staff-budget.
 *
 * PERMISSIONS ARE ENFORCED HERE, NOT ONLY IN THE MENU. Every endpoint on this
 * router carries a guard, through the existing middlewares/permissions.js:
 *
 *   read   `view_staff_budget`
 *   write  `edit_staff_budget`
 *
 * Hiding the screen is presentation; these are what actually refuse the
 * request. Administrators (`user_type` 2) pass through the middleware's
 * existing bypass, exactly as everywhere else.
 *
 * NOT THE LEGACY /store-budget. That router, its `budget` table and its
 * `view_store_budget` key are untouched by this feature.
 *
 * Joi checks the shape only. What makes a combination legitimate - four real,
 * active master records - is usecase/staff_budget.js, and the arithmetic is
 * utils/staffBudget.js, so there is one copy of each rule.
 */
class StaffBudgetRoutes {
  constructor(staffBudgetUsecase, permissions) {
    this.staffBudgetUsecase = staffBudgetUsecase;
    this.permissions = permissions;
    this.router = express.Router();

    this.init();
  }

  init() {
    const canView = () => this.permissions.require(P.VIEW_STAFF_BUDGET);
    const canEdit = () => this.permissions.require(P.EDIT_STAFF_BUDGET);

    // The whole screen: Location -> Department -> Designation -> Shift, with
    // the totals and the Opening/Peak/Closing coverage already computed.
    //
    // `?outlet_id=` narrows it to one location. Absent, every location comes
    // back, which is how the collapsible hierarchy is first drawn.
    this.router.get("/", canView(), async (req, res) => {
      try {
        const schema = Joi.object()
          .keys({ outlet_id: Joi.number().integer().positive().optional() })
          .unknown(true);
        const isValid = Joi.validate(req.query, schema);
        if (isValid.error !== null) throw isValid.error;

        const data = await this.staffBudgetUsecase.getBudget({
          outlet_id: req.query.outlet_id === undefined ? undefined : Number(req.query.outlet_id),
        });
        res.json({ code: 200, data });
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    // The active master records for the pickers - names to show, ids to send
    // back. A read of the plan's own masters, so it is the read key.
    this.router.get("/masters", canView(), async (req, res) => {
      try {
        const data = await this.staffBudgetUsecase.getMasters();
        res.json({ code: 200, data });
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    // What an approved headcount used to be, and who changed it.
    this.router.get("/history", canView(), async (req, res) => {
      try {
        const schema = { staff_budget_id: Joi.number().integer().positive().required() };
        const isValid = Joi.validate(req.query, schema);
        if (isValid.error !== null) throw isValid.error;

        const data = await this.staffBudgetUsecase.getHistory(
          Number(req.query.staff_budget_id)
        );
        if (data === null) {
          res.status(404).json({ code: 404, msg: "Staff budget row not found" });
          res.end();
          return;
        }
        res.json({ code: 200, data });
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    // The configured monthly rates. A read, so the read key - seeing what a
    // shift is budgeted at is part of reading the plan.
    this.router.get("/rates", canView(), async (req, res) => {
      try {
        const data = await this.staffBudgetUsecase.getRates();
        res.json({ code: 200, data });
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    // Set the approved headcount for ONE combination.
    //
    // There is no separate create and update: the combination is the
    // identity, the database holds one row per combination, and the caller
    // says what the number should be.
    this.router.post("/", canEdit(), async (req, res) => {
      try {
        const schema = {
          outlet_id: Joi.number().integer().positive().required(),
          department_id: Joi.number().integer().positive().required(),
          designation_id: Joi.number().integer().positive().required(),
          work_shift_id: Joi.number().integer().positive().required(),
          // Integer and non-negative here as well as in the usecase: this
          // refuses 3.5 before it reaches the database, and the usecase is
          // what guarantees it for every caller.
          approved_headcount: Joi.number().integer().min(0).required(),
        };
        const isValid = Joi.validate(req.body, schema);
        if (isValid.error !== null) throw isValid.error;

        const result = await this.staffBudgetUsecase.saveBudget(
          req.body,
          req.decoded.employee_id
        );
        res.json(result);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    // A designation's whole shift grid in one save, which is how the screen
    // edits it.
    this.router.post("/bulk", canEdit(), async (req, res) => {
      try {
        const schema = {
          rows: Joi.array()
            .items(
              Joi.object({
                outlet_id: Joi.number().integer().positive().required(),
                department_id: Joi.number().integer().positive().required(),
                designation_id: Joi.number().integer().positive().required(),
                work_shift_id: Joi.number().integer().positive().required(),
                approved_headcount: Joi.number().integer().min(0).required(),
              })
            )
            .min(1)
            .required(),
        };
        const isValid = Joi.validate(req.body, schema);
        if (isValid.error !== null) throw isValid.error;

        const result = await this.staffBudgetUsecase.saveBudgetBulk(
          req.body.rows,
          req.decoded.employee_id
        );
        res.json(result);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    // Take a combination out of the plan. Soft: the row and its history stay.
    this.router.post("/remove", canEdit(), async (req, res) => {
      try {
        const schema = { staff_budget_id: Joi.number().integer().positive().required() };
        const isValid = Joi.validate(req.body, schema);
        if (isValid.error !== null) throw isValid.error;

        const result = await this.staffBudgetUsecase.removeBudget(
          Number(req.body.staff_budget_id),
          req.decoded.employee_id
        );
        res.status(result.code === 200 ? 200 : result.code).json(result);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    // Configure one monthly rate, for a designation and work shift picked on
    // the rate screen.
    //
    // THERE IS NO "apply the standard rates" ENDPOINT, deliberately. An action
    // that found the two designations by name and the five shifts by their
    // timings would be a production write choosing for itself which master
    // record real money attaches to. The agreed amounts are offered as
    // suggestions on the screen; a person picks the master records and
    // confirms, and only ids are stored.
    this.router.post("/rates", canEdit(), async (req, res) => {
      try {
        const schema = {
          designation_id: Joi.number().integer().positive().required(),
          work_shift_id: Joi.number().integer().positive().required(),
          monthly_rate: Joi.number().min(0).required(),
        };
        const isValid = Joi.validate(req.body, schema);
        if (isValid.error !== null) throw isValid.error;

        const result = await this.staffBudgetUsecase.saveRate(
          req.body,
          req.decoded.employee_id
        );
        res.json(result);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

  }

  getRouter() {
    return this.router;
  }
}

module.exports = (staffBudgetUsecase, permissions) => {
  return new StaffBudgetRoutes(staffBudgetUsecase, permissions);
};
