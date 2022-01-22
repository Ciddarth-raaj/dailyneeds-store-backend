const router = require("express").Router();
const Joi = require("@hapi/joi");
const respondError = require("../utils/http")

class BudgetRoutes {
  constructor(budgetUsecase) {
    this.budgetUsecase = budgetUsecase;

    this.init();
  }

  init() {
    router.get("/id", async (req, res) => {
        try {
          const schema = {
            limit: Joi.number().required(),
            offset: Joi.number().required(),
            store_id: Joi.string().required(),
          }
          const budget = req.query;

          const isValid = Joi.validate(budget, schema);
          if (isValid.error !== null) {
            throw isValid.error;
          }
          const data = await this.budgetUsecase.get(budget.limit, budget.offset, budget.store_id);

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
      router.get("/budget_id", async (req, res) => {
        try {
          const schema = {
            budget_id: Joi.string().required(),
          }
          const budget = req.query;
          
          const isValid = Joi.validate(budget, schema);
          if (isValid.error !== null) {
            throw isValid.error;
          }
          const data = await this.budgetUsecase.getBudgetById(budget.budget_id);
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
      router.get("/store_id", async (req, res) => {
        try {
          const schema = {
            store_id: Joi.string().required(),
          }
          const budget = req.query;
          const isValid = Joi.validate(budget, schema);
          if (isValid.error !== null) {
            throw isValid.error;
          }
          const data = await this.budgetUsecase.getBudgetByStore(budget.store_id);
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
      router.get("/storedet", async (req, res) => {
        try {
          const schema = {
            store_id: Joi.string().required(),
          }
          const budget = req.query;
          const isValid = Joi.validate(budget, schema);
          if (isValid.error !== null) {
            throw isValid.error;
          }
          const data = await this.budgetUsecase.getBudgetByStoreId(budget.store_id);
          res.json(data);
        } catch (err) {
          console.log(err);
          if (err.name === "ValidationError") {
            res.json({ code: 422, msg: err.toString() });
          } else {
            res.json({ code: 500, msg: "An error occurred !", err: err });
          }
        }
  
        res.end();
      });
    router.post("/create", async (req, res) => {
        try {
          const schema = {
            store_id: Joi.number().required(),
            // designation_name: Joi.string().required(),
            budget: Joi.array().allow(null).allow('').required(),
            budget_id: Joi.array().allow(null).allow('').optional()
          };
  
          const budget = req.body;
          // console.lg(d);
          const isValid = Joi.validate(budget, schema);
  
          if (isValid.error !== null) {
            console.log(isValid.error);
            throw isValid.error;
          }
          const response = await this.budgetUsecase.create(budget);
  
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

module.exports = (budgetUsecase) => {
  return new BudgetRoutes(budgetUsecase);
};
