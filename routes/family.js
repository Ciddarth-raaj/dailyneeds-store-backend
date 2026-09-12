const router = require("express").Router();
const P = require("../constants/hr_permissions");
const Joi = require("@hapi/joi");
const respondError = require("../utils/http")

class FamilyRoutes {
  constructor(familyUsecase, permissions) {
    this.permissions = permissions;
    this.familyUsecase = familyUsecase;

    this.init();
  }

  init() {
    router.get("/", this.permissions.require(P.VIEW_FAMILY), async (req, res) => {
        try {
          const family = await this.familyUsecase.get();
          res.json(family);
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
      router.get("/family_id", this.permissions.require(P.VIEW_FAMILY), async (req, res) => {
        try {
          const schema = {
            family_id: Joi.string().required(),
          }
          const family = req.query;
          const isValid = Joi.validate(family, schema);
          if (isValid.error !== null) {
            throw isValid.error;
          }
          const data = await this.familyUsecase.getFamilyById(family.family_id);
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
      /**
       * The records of one employee, by their permanent id.
       *
       * `/employee_name` below still works and is still used where the caller
       * has only a name. This is the endpoint to prefer: a name correction
       * does not move a record away from it, and it tells two employees
       * sharing a name apart, which the name endpoint cannot. See
       * repository/family.js for the cutover plan.
       */
      router.get("/employee_id", this.permissions.require(P.VIEW_FAMILY), async (req, res) => {
        try {
          const schema = {
            employee_id: Joi.number().integer().positive().required(),
          }
          const family = req.query;
          const isValid = Joi.validate(family, schema);
          if (isValid.error !== null) {
            throw isValid.error;
          }
          const data = await this.familyUsecase.getFamilyByEmployeeId(family.employee_id);
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
      router.get("/employee_name", this.permissions.require(P.VIEW_FAMILY), async (req, res) => {
        try {
          const schema = {
            employee_name: Joi.string().required(),
          }
          const family = req.query;
          const isValid = Joi.validate(family, schema);
          if (isValid.error !== null) {
            throw isValid.error;
          }
          const data = await this.familyUsecase.getFamilyByEmployee(family.employee_name);
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
      router.post("/update-family", this.permissions.require(P.ADD_FAMILY), async (req, res) => {
        try {
          const schema = {
            family_id: Joi.number().required(),

            family_details: Joi.object({
              name: Joi.string().optional(),
              dob: Joi.date().optional(),
              gender: Joi.string().optional(),
              blood_group: Joi.string().optional(),
              // The employee this record belongs to. Sending the id is
              // preferred - it says which of two namesakes was meant. The
              // usecase resolves one from the name when only a name arrives,
              // and writes both columns either way.
              employee_id: Joi.number().integer().positive().optional(),
              employee_name: Joi.string().optional(),
              relation: Joi.string().optional(),
              nationality: Joi.string().optional(),
              profession: Joi.string().optional(),
              remarks: Joi.string().allow('').optional(),
            }).optional(),
          };

          const family = req.body;
          const isValid = Joi.validate(family, schema);
          if (isValid.error !== null) {
            console.log({erro: isValid.error})
            throw isValid.error;
          }
  
          const code = await this.familyUsecase.updateFamilyDetails(family);
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
    router.post("/create", this.permissions.require(P.ADD_FAMILY), async (req, res) => {
        try {
          const schema = {
            name: Joi.string().required(),
            dob: Joi.date().required(),
            gender: Joi.string().required(),
            blood_group: Joi.string().required(),
            // Optional, and preferred when the caller has it: the screen
            // picks the employee from a list carrying ids, so it knows which
            // namesake was meant. `employee_name` stays required while every
            // other reader still uses it.
            employee_id: Joi.number().integer().positive().optional(),
            employee_name: Joi.string().required(),
            relation: Joi.string().required(),
            nationality: Joi.string().required(),
            profession: Joi.string().required(),
            remarks: Joi.string().optional(),
          };
  
          const family = req.body;
          const isValid = Joi.validate(family, schema);
  
          if (isValid.error !== null) {
            console.log(isValid.error);
            throw isValid.error;
          }
          const response = await this.familyUsecase.create(family);
  
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

module.exports = (familyUsecase, permissions) => {
  return new FamilyRoutes(familyUsecase, permissions);
};
