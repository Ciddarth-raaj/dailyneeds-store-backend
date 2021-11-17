const router = require("express").Router();
const Joi = require("@hapi/joi");

class CategoryRoutes {
  constructor(categoryUsecase) {
    this.categoryUsecase = categoryUsecase;
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

        const categories = await this.categoryUsecase.getAll(data.limit, data.offset);
        res.json(categories);
      } catch (err) {
        res.status(500).json({ code: 500, msg: "An error occurred !" });
      }
    });

    router.get("/catcount", async (req, res) => {
      try {
        const categories = await this.categoryUsecase.getCategoryCount();
        res.json(categories);
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

module.exports = (categoryUsecase) => {
  return new CategoryRoutes(categoryUsecase);
};
