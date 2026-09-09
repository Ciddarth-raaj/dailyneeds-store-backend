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
    /**
     * The shift picker list — an id, a label and the status.
     *
     * Authenticated, and deliberately NOT gated on `view_shift`, for the same
     * reason as `/department/directory` and `/designation/directory`: holding
     * that permission means administering the shift master, and it was never a
     * prerequisite for being assigned a shift. `useShifts` already documented
     * that HR "does not necessarily hold" it.
     *
     * Inactive rows are included, with their status, so an employee on a shift
     * that was later switched off still shows it and still preselects it.
     */
    router.get("/directory", async (req, res) => {
      try {
        res.json(await this.shiftUsecase.getDirectory());
      } catch (err) {
        console.log(err);
        res.json({ code: 500, msg: "An error occurred !" });
      }
      res.end();
    });

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
      router.post("/update-shift", this.permissions.require(P.ADD_SHIFTS), async (req, res) => {
        try {
          const schema = {
            shift_id: Joi.number().required(),

            shift_details: Joi.object({
              shift_name: Joi.string().required(),
              shift_in_time: Joi.string().required(),
              shift_out_time: Joi.string().required(),
            }).optional(),
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
      router.post("/create", this.permissions.require(P.ADD_SHIFTS), async (req, res) => {
        try {
          const schema = {
            shift_name: Joi.string().required(),
            shift_in_time: Joi.string().required(),
            status: Joi.number().optional(),
            shift_out_time: Joi.string().required(),
          };
  
          const shift = req.body;
          console.log(shift);
          const isValid = Joi.validate(shift, schema);
          
          if (isValid.error !== null) {
            throw isValid.error;
          }
  
          const response = await this.shiftUsecase.create(shift);
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
    }
  getRouter() {
    return router;
  }
}   

module.exports = (shiftUsecase, permissions) => {
  return new ShiftRoutes(shiftUsecase, permissions);
};
