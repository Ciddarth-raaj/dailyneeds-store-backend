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
        const schema = {
          limit: Joi.number().required(),
          offset: Joi.number().required(),
        };
        const data = req.query;

        const subCategories = await this.subCategoryUsecase.getAll(data.limit, data.offset);
        res.json(subCategories);
      } catch (err) {
        res.status(500).json({ code: 500, msg: "An error occurred !" });
      }
    });
    router.get("/subcatcount", async (req, res) => {
      try {
        const subcategories = await this.subCategoryUsecase.getSubCategoryCount();
        res.json(subcategories);
      } catch (err) {
          console.log(err);
        if (err.name === "ValidationError") {
          res.json({ code: 422, msg: err.toString() });
        } else {
          res.json({ code: 500, msg: "An error occurred !" });
        }
      }
    });
    router.post("/imageupload", async (req, res) => {
      try {
        const schema = {
          image_url: Joi.string().required(),
          subcategory_id: Joi.number().required()
        };
        const subcategories = req.body;

        const isValid = Joi.validate(subcategories, schema);

        if (isValid.error !== null) {
          console.log(isValid.error);
          throw isValid.error;
        }
        const response = await this.subCategoryUsecase.uploadSubCategoryImage(subcategories.image_url, subcategories.subcategory_id);
        res.json(response);
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

module.exports = (subCategoryUsecase) => {
  return new SubCategoryRoutes(subCategoryUsecase);
};
