const router = require("express").Router();
const Joi = require("@hapi/joi");
const respondError = require("../utils/http")

class IssueRoutes {
  constructor(issueUsecase) {
    this.issueUsecase = issueUsecase;

    this.init();
  }

  init() {
    router.get("/", async (req, res) => {
        try {
          const issue = await this.issueUsecase.get();
          res.json(issue);
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
            department_id: Joi.number().required(),
            status: Joi.number().required(),
          };
  
          const department = req.body;
          const isValid = Joi.validate(department, schema);
          if (isValid.error !== null) {
            throw isValid.error;
          }
  
          const code = await this.issueUsecase.updateStatus(department);
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
      
      router.get("/store_id", async (req, res) => {
        try {
          const schema = {
            store_id: Joi.string().required(),
          }
          const issue = req.query;
          const isValid = Joi.validate(issue, schema);
          if (isValid.error !== null) {
            throw isValid.error;
          }
          const data = await this.issueUsecase.getIssueByStoreId(issue.store_id);
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
      router.get("/from/store_id", async (req, res) => {
        try {
          const schema = {
            store_id: Joi.string().required(),
          }
          const issue = req.query;
          const isValid = Joi.validate(issue, schema);
          if (isValid.error !== null) {
            throw isValid.error;
          }
          const data = await this.issueUsecase.getIssueFromStoreId(issue.store_id);
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
      router.get("/issue_id", async (req, res) => {
        try {
          const schema = {
            issue_id: Joi.string().required(),
          }
          const issue = req.query;
          const isValid = Joi.validate(issue, schema);
          if (isValid.error !== null) {
            throw isValid.error;
          }
          const data = await this.issueUsecase.getDepartmentById(issue.issue_id);
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
            indent_id: Joi.string().required(),
            product_id: Joi.string().required(),
            sent: Joi.string().required(),
            received: Joi.string().required(),
            difference: Joi.string().required(),
          };

          const issue = req.body;
          const isValid = Joi.validate(issue, schema);
  
          if (isValid.error !== null) {
            console.log(isValid.error);
            throw isValid.error;
          }
          const response = await this.issueUsecase.create(issue);
  
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

module.exports = (issueUsecase) => {
  return new IssueRoutes(issueUsecase);
};
