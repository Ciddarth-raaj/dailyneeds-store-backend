const router = require("express").Router();
const Joi = require("@hapi/joi");

class SubCategoryRoutes {
  constructor(subCategoryUsecase) {
    this.subCategoryUsecase = subCategoryUsecase;
    this.init();
  }

  init() {
    router.get("/", async (req, res) => {
      try {
        const subCategories = await this.subCategoryUsecase.getAll();
        res.json(subCategories);
      } catch (err) {
        res.status(500).json({ code: 500, msg: "An error occurred !" });
      }
    });
  }

  getRouter() {
    return router;
  }
}

module.exports = (subCategoryUsecase) => {
  return new SubCategoryRoutes(subCategoryUsecase);
};
