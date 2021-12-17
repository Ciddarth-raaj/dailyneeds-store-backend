const router = require("express").Router();
const Joi = require("@hapi/joi");

class IndentRoutes {
  constructor(indentUsecase) {
    this.indentUsecase = indentUsecase;

    this.init();
  }

  init() {
    router.get("/", async (req, res) => {
      try {
        const schema = {
          limit: Joi.number().required(),
          offset: Joi.number().required(),
        };
        const data = req.query;
        const isValid = Joi.validate(data, schema);

        if (isValid.error !== null) {
          console.log(isValid.error);
          throw isValid.error;
        }
        const indent = await this.indentUsecase.get(data.limit, data.offset);
        res.json(indent);
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
    router.get("/despatch", async (req, res) => {
      try {
        const schema = {
          limit: Joi.number().required(),
          offset: Joi.number().required(),
        };
        const data = req.query;
        const isValid = Joi.validate(data, schema);

        if (isValid.error !== null) {
          console.log(isValid.error);
          throw isValid.error;
        }
        const indent = await this.indentUsecase.getDespatch(data.limit, data.offset);
        res.json(indent);
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
          indent_number: Joi.string().required(),
          store_id: Joi.string().required(),
          store_to: Joi.string().required(),
          bags: Joi.string().required(),
          boxes: Joi.string().required(),
          crates: Joi.string().required(),
          taken_by: Joi.string().required(),
          checked_by: Joi.string().required(),
        };

        const indent = req.body;
        const isValid = Joi.validate(indent, schema);
        if (isValid.error !== null) {
          console.log(isValid.error);
          throw isValid.error;
        }
        const response = await this.indentUsecase.createIndent(indent);

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

    router.get("/indentcount", async (req, res) => {
      try {
        const indent = await this.indentUsecase.getIndentCount();
        res.json(indent);
      } catch (err) {
          console.log(err);
        if (err.name === "ValidationError") {
          res.json({ code: 422, msg: err.toString() });
        } else {
          res.json({ code: 500, msg: "An error occurred !" });
        }
      }
    });
  }
  getRouter() {
    return router;
  }
}

module.exports = (indentUsecase) => {
  return new IndentRoutes(indentUsecase);
};