const router = require("express").Router();
const Joi = require("@hapi/joi");
const respondError = require("../utils/http");

class DesignationRoutes {
  constructor(designationUsecase) {
    this.designationUsecase = designationUsecase;

    this.init();
  }

  init() {
    router.get("/", async (req, res) => {
      try {
        const designation = await this.designationUsecase.get();
        res.json(designation);
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
    router.post("/update-designation", async (req, res) => {
      try {
        const schema = {
          designation_id: Joi.number().required(),

          designation_details: Joi.object({
            designation_name: Joi.string().required(),
            status: Joi.number().required(),
          }).optional(),
        };

        const designation = req.body;
        const isValid = Joi.validate(designation, schema);
        if (isValid.error !== null) {
          throw isValid.error;
        }

        const code = await this.designationUsecase.updateDesignationDetails(designation);
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
    router.get("/designation_id", async (req, res) => {
      try {
        const schema = {
          designation_id: Joi.string().required(),
        }
        const designation = req.query;
        const isValid = Joi.validate(designation, schema);
        if (isValid.error !== null) {
          throw isValid.error;
        }
        const data = await this.designationUsecase.getDesignationById(designation.designation_id);
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
    router.post("/create", async (req, res) => {
      try {
        const schema = {
          status: Joi.number().required(),
          designation_name: Joi.string().required(),
          online_portal: Joi.number().required(),
          permissions: Joi.array().items(Joi.string().optional()).required(),
        };

        const designation = req.body;
        const isValid = Joi.validate(designation, schema);

        if (isValid.error !== null) {
          throw isValid.error;
        }

        const response = await this.designationUsecase.create(designation);
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

module.exports = (designationUsecase) => {
  return new DesignationRoutes(designationUsecase);
};
