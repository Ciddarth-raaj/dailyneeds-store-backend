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
        const categories = await this.categoryUsecase.getAll();
        res.json(categories);
      } catch (err) {
        res.status(500).json({ code: 500, msg: "An error occurred !" });
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
