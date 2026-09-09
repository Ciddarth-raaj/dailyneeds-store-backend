const router = require("express").Router();
const P = require("../constants/hr_permissions");
const Joi = require("@hapi/joi");
const respondError = require("../utils/http");

/**
 * The new payroll/attendance shift master, mounted at /work-shift.
 *
 * Deliberately separate from /shift: those routes belong to the legacy
 * `shift_master` table that the live system and `new_employee.shift_id` still
 * use, and they are not repointed here. Nothing on this router touches
 * `shift_master`, and no employee is mapped onto a work shift - that is a
 * later, manual phase.
 *
 * Permissions reuse the existing VIEW_SHIFT / ADD_SHIFTS keys: whoever
 * maintains shifts today maintains work shifts, and a permission redesign is
 * not part of this phase.
 *
 * Joi checks the shape only. The field-by-field rules - allowed enums, OT
 * rates, non-negative minutes, the complete-week requirement and the
 * authoritative normal_work_minutes calculation - live in utils/workShift.js
 * so there is one copy of them rather than one here and one there.
 */
class WorkShiftRoutes {
  constructor(workShiftUsecase, permissions) {
    this.permissions = permissions;
    this.workShiftUsecase = workShiftUsecase;

    this.init();
  }

  init() {
    // List, configuration only. The weekly schedule comes from /details.
    router.get("/", this.permissions.require(P.VIEW_SHIFT), async (req, res) => {
      try {
        const data = await this.workShiftUsecase.get();
        res.json({ code: 200, data });
      } catch (err) {
        respondError(res, err);
      }

      res.end();
    });

    // Full configuration plus the 7-day weekly schedule, in one read.
    router.get("/details", this.permissions.require(P.VIEW_SHIFT), async (req, res) => {
      try {
        const schema = {
          work_shift_id: Joi.number().required(),
        };
        const isValid = Joi.validate(req.query, schema);
        if (isValid.error !== null) {
          throw isValid.error;
        }

        const data = await this.workShiftUsecase.getWorkShiftWithSchedule(
          req.query.work_shift_id
        );
        if (!data) {
          res.status(404).json({ code: 404, msg: "Work shift not found" });
          res.end();
          return;
        }
        res.json({ code: 200, data });
      } catch (err) {
        respondError(res, err);
      }

      res.end();
    });

    router.get("/weekly-schedule", this.permissions.require(P.VIEW_SHIFT), async (req, res) => {
      try {
        const schema = {
          work_shift_id: Joi.number().required(),
        };
        const isValid = Joi.validate(req.query, schema);
        if (isValid.error !== null) {
          throw isValid.error;
        }

        const data = await this.workShiftUsecase.getWeeklySchedule(req.query.work_shift_id);
        res.json({ code: 200, data });
      } catch (err) {
        respondError(res, err);
      }

      res.end();
    });

    // Create. The complete 7-day schedule is required and is written in the
    // same transaction as the shift itself.
    router.post("/create", this.permissions.require(P.ADD_SHIFTS), async (req, res) => {
      try {
        const result = await this.workShiftUsecase.create(req.body);
        res.json(result);
      } catch (err) {
        respondError(res, err);
      }

      res.end();
    });

    // Configuration and weekly schedule save atomically: send either half, or
    // both, and a failure in one leaves neither written. Omitting
    // weekly_schedule leaves the existing schedule exactly as it was.
    router.post("/update", this.permissions.require(P.ADD_SHIFTS), async (req, res) => {
      try {
        const schema = {
          work_shift_id: Joi.number().required(),
          work_shift_details: Joi.object().optional(),
          weekly_schedule: Joi.array().items(Joi.object()).optional(),
        };
        const isValid = Joi.validate(req.body, schema);
        if (isValid.error !== null) {
          throw isValid.error;
        }

        const result = await this.workShiftUsecase.update(req.body.work_shift_id, req.body);
        res.json(result);
      } catch (err) {
        respondError(res, err);
      }

      res.end();
    });

    // The whole week, always: all seven days or the save is rejected.
    router.post("/weekly-schedule", this.permissions.require(P.ADD_SHIFTS), async (req, res) => {
      try {
        const schema = {
          work_shift_id: Joi.number().required(),
          weekly_schedule: Joi.array().items(Joi.object()).required(),
        };
        const isValid = Joi.validate(req.body, schema);
        if (isValid.error !== null) {
          throw isValid.error;
        }

        const result = await this.workShiftUsecase.saveWeeklySchedule(
          req.body.work_shift_id,
          req.body.weekly_schedule
        );
        res.json(result);
      } catch (err) {
        respondError(res, err);
      }

      res.end();
    });

    router.post("/update-status", this.permissions.require(P.ADD_SHIFTS), async (req, res) => {
      try {
        const schema = {
          work_shift_id: Joi.number().required(),
          active: Joi.number().valid(0, 1).required(),
        };
        const isValid = Joi.validate(req.body, schema);
        if (isValid.error !== null) {
          throw isValid.error;
        }

        const result = await this.workShiftUsecase.updateStatus(
          req.body.work_shift_id,
          Number(req.body.active) === 1
        );
        res.json(result);
      } catch (err) {
        respondError(res, err);
      }

      res.end();
    });
  }

  getRouter() {
    return router;
  }
}

module.exports = (workShiftUsecase, permissions) => {
  return new WorkShiftRoutes(workShiftUsecase, permissions);
};
