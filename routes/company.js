const router = require("express").Router();
const Joi = require("@hapi/joi");

class companyRoutes {
  constructor(companyUsecase) {
    this.companyUsecase = companyUsecase;
    this.init();
  }

  init() {
    router.get("/company_id", async (req, res) => {
      try {
        const schema = {
          company_id: Joi.number().required(),
        }
        const company = req.query;
        const isValid = Joi.validate(company, schema);
        if (isValid.error !== null) {
          throw isValid.error;
        }
        const data = await this.companyUsecase.get(company.company_id);
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
    router.post("/update-status", async (req, res) => {
      try {
        const schema = {
          company_id: Joi.number().required(),
          status: Joi.number().required(),
        };

        const company = req.body;
        const isValid = Joi.validate(company, schema);
        if (isValid.error !== null) {
          throw isValid.error;
        }

        const code = await this.companyUsecase.updateStatus(company);
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
    router.post("/", async (req, res) => {
        try {
          const schema = {
              company_name: Joi.string().optional(),
              reg_address: Joi.string().optional(),
              contact_number: Joi.string().optional(),
              gst_number: Joi.string().required(),
              pan_number: Joi.string().optional(),
              tan_number: Joi.string().optional(),
              pf_number: Joi.string().optional(),
              esi_number: Joi.string().allow('').optional(),
          };
          const company = req.body;
          const isValid = Joi.validate(company, schema);
          if (isValid.error !== null) {
            console.log({erro: isValid.error})
            throw isValid.error;
          }
  
          const code = await this.companyUsecase.create(company);
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
  }
  getRouter() {
    return router;
  }
}

module.exports = (companyUsecase) => {
  return new companyRoutes(companyUsecase);
};
