const router = require("express").Router();
const Joi = require("@hapi/joi");
const respondError = require("../utils/http")

class SalaryRoutes {
  constructor(salaryUsecase) {
    this.salaryUsecase = salaryUsecase;

    this.init();
  }

  init() {
    router.get("/", async (req, res) => {
        try {
          const salary = await this.salaryUsecase.get();
          res.json(salary);
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
      router.get("/store_id", async (req, res) => {
        try {
          const schema = {
            store_id: Joi.number().required(),
          }
          const store = req.query;
          const isValid = Joi.validate(store, schema);
          if (isValid.error !== null) {
            throw isValid.error;
          }
          const data = await this.storeUsecase.getStoreById(store.store_id);
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
            payment_id: Joi.number().required(),
            status: Joi.number().required(),
          };
  
          const salary = req.body;
          const isValid = Joi.validate(salary, schema);
          if (isValid.error !== null) {
            throw isValid.error;
          }
  
          const code = await this.salaryUsecase.updateStatus(salary);
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
      router.post("/update-paidstatus", async (req, res) => {
        try {
          const schema = {
            payment_id: Joi.number().required(),
            paid_status: Joi.number().required(),
          };
  
          const salary = req.body;
          const isValid = Joi.validate(salary, schema);
          if (isValid.error !== null) {
              console.log(isValid.error);
            throw isValid.error;
          }
  
          const code = await this.salaryUsecase.updatePaidStatus(salary);
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
      router.post("/update-payment", async (req, res) => {
        try {
          const schema = {
            payment_id: Joi.number().required(),

            payment_details: Joi.object({
              employee: Joi.string().required(),
              loan_amount: Joi.number().required(),
              installment_duration: Joi.number().required()
            }).optional(),
          };

          const salary = req.body;
          const isValid = Joi.validate(salary, schema);
          if (isValid.error !== null) {
            throw isValid.error;
          }
  
          const code = await this.salaryUsecase.updateSalaryDetails(salary);
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
      router.get("/payment_id", async (req, res) => {
        try {
          const schema = {
            payment_id: Joi.string().required(),
          }
          const salary = req.query;
          const isValid = Joi.validate(salary, schema);
          if (isValid.error !== null) {
            throw isValid.error;
          }
          const data = await this.salaryUsecase.getSalaryById(salary.payment_id);
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
            employee: Joi.string().required(),
            loan_amount: Joi.number().required(),
            installment_duration: Joi.number().required(),
            status: Joi.number().required()
          };
  
          const salary = req.body;
          const isValid = Joi.validate(salary, schema);
  
          if (isValid.error !== null) {
            console.log(isValid.error);
            throw isValid.error;
          }
          const response = await this.salaryUsecase.create(salary);
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

module.exports = (salaryUsecase) => {
  return new SalaryRoutes(salaryUsecase);
};
