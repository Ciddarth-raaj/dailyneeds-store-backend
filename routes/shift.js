const router = require("express").Router();
const P = require("../constants/hr_permissions");
const Joi = require("@hapi/joi");
const respondError = require("../utils/http")

class ShiftRoutes {
  constructor(shiftUsecase, permissions) {
    this.permissions = permissions;
    this.shiftUsecase = shiftUsecase;

    this.init();
  }

  init() {
    router.get("/", this.permissions.require(P.VIEW_SHIFT), async (req, res) => {
        try {
          const shift = await this.shiftUsecase.get();
          res.json(shift);
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
      router.post("/update-status", this.permissions.require(P.ADD_SHIFTS), async (req, res) => {
        try {
          const schema = {
            shift_id: Joi.number().required(),
            status: Joi.number().required(),
          };
  
          const shift = req.body;
          const isValid = Joi.validate(shift, schema);
          if (isValid.error !== null) {
            throw isValid.error;
          }
  
          const code = await this.shiftUsecase.updateStatus(shift);
          res.json({ code: code });
        } catch (err) {
          if (err.name === "ValidationError") {
            res.json({ code: 422, msg: err.toString() });
          } else {
            console.log(err);
            res.json({ code: 500, msg: "An error occurred !" });
          }
        }
        res.end();
      });
      // Configuration and weekly schedule save atomically: send either half,
      // or both, and a failure in one leaves neither written.
      //
      // Joi checks the shape only. The field-by-field rules - allowed enums,
      // OT rates, non-negative minutes, and the authoritative
      // normal_work_minutes calculation - live in utils/shiftSchedule.js so
      // there is one copy of them rather than one here and one there.
      router.post("/update-shift", this.permissions.require(P.ADD_SHIFTS), async (req, res) => {
        try {
          const schema = {
            shift_id: Joi.number().required(),
            shift_details: Joi.object().optional(),
            weekly_schedule: Joi.array().items(Joi.object()).optional(),
          };

          const shift = req.body;
          const isValid = Joi.validate(shift, schema);
          if (isValid.error !== null) {
            throw isValid.error;
          }
  
          const code = await this.shiftUsecase.updateShiftDetails(shift);
          res.json({ code: code });
        } catch (err) {
          if (err.name === "ValidationError") {
            res.json({ code: 422, msg: err.toString() });
          } else {
            console.log(err);
            res.json({ code: 500, msg: "An error occurred !" });
          }
        }
        res.end();
      });
      router.get("/shift_id", this.permissions.require(P.VIEW_SHIFT), async (req, res) => {
        try {
          const schema = {
            shift_id: Joi.string().required(),
          }
          const shift = req.query;
          const isValid = Joi.validate(shift, schema);
          if (isValid.error !== null) {
            throw isValid.error;
          }
          const data = await this.shiftUsecase.getShiftById(shift.shift_id);
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
      // Accepts the legacy body (shift_name / shift_in_time / shift_out_time /
      // status) and the Phase 1 one (shift_code, start_time, end_time, active
      // and the lateness, OT, attendance and regularization settings), plus an
      // optional weekly_schedule saved in the same transaction. Validation is
      // in utils/shiftSchedule.js rather than a Joi schema listing every field
      // twice.
      router.post("/create", this.permissions.require(P.ADD_SHIFTS), async (req, res) => {
        try {
          const response = await this.shiftUsecase.create(req.body);
          res.json(response);
        } catch (err) {
          if (err.name === "ValidationError") {
            res.json({ code: 422, msg: err.toString() });
          } else {
            console.log(err);
            res.json({ code: 500, msg: err.message });
          }
        }

        res.end();
      });

      // Full configuration plus the weekly schedule, in one read.
      router.get("/details", this.permissions.require(P.VIEW_SHIFT), async (req, res) => {
        try {
          const schema = {
            shift_id: Joi.number().required(),
          };
          const isValid = Joi.validate(req.query, schema);
          if (isValid.error !== null) {
            throw isValid.error;
          }

          const data = await this.shiftUsecase.getShiftWithSchedule(req.query.shift_id);
          if (!data) {
            res.status(404).json({ code: 404, msg: "Shift not found" });
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
            shift_id: Joi.number().required(),
          };
          const isValid = Joi.validate(req.query, schema);
          if (isValid.error !== null) {
            throw isValid.error;
          }

          const data = await this.shiftUsecase.getWeeklySchedule(req.query.shift_id);
          res.json({ code: 200, data });
        } catch (err) {
          respondError(res, err);
        }

        res.end();
      });

      // The rows sent are the shift's whole week: a weekday present is
      // written, a weekday left out is removed.
      router.post("/weekly-schedule", this.permissions.require(P.ADD_SHIFTS), async (req, res) => {
        try {
          const schema = {
            shift_id: Joi.number().required(),
            weekly_schedule: Joi.array().items(Joi.object()).required(),
          };
          const isValid = Joi.validate(req.body, schema);
          if (isValid.error !== null) {
            throw isValid.error;
          }

          const result = await this.shiftUsecase.saveWeeklySchedule(
            req.body.shift_id,
            req.body.weekly_schedule
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

module.exports = (shiftUsecase, permissions) => {
  return new ShiftRoutes(shiftUsecase, permissions);
};
