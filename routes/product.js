const router = require("express").Router();
const Joi = require("@hapi/joi");
const respondError = require("../utils/http")

class ProductRoutes {
  constructor(productUsecase) {
    this.productUsecase = productUsecase;

    this.init();
  }

  init() {
    router.post("/create", async (req, res) => {
      try {
        const product = req.body;
        // const isValid = Joi.validate(product, schema);
        // if (isValid.error !== null) {
        //   throw isValid.error;
        // }
        const response = await this.productUsecase.create(product);

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
    router.get("/", async (req, res) => {
      try {
        const product = await this.productUsecase.get();
        res.json(product);
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

    router.post("/updatedata", async (req, res) => {
      try {
        const schema = {
          product_id: Joi.number().required(),

          product_details: Joi.object({
            product_id: Joi.number().optional(),
            return: Joi.number().optional(),
            packaging_type: Joi.number().optional(),
            cleaning: Joi.number().optional(),
            sticker: Joi.number().optional(),
            grinding: Joi.number().optional(),
            cover_type: Joi.number().optional(),
            cover_sizes: Joi.number().optional(),
            gf_description: Joi.string().optional(),
            gf_detailed_description: Joi.string().optional(),
            de_distributor: Joi.string().optional(),
            keywords: Joi.string().optional(),
            variant: Joi.number().optional(),
            variant_of: Joi.number().optional()
          }).optional(),
        };

        const product = req.body;
        console.log({ productipo: product });
        const isValid = Joi.validate(product, schema);
        if (isValid.error !== null) {
          console.log(isValid.error);
          throw isValid.error;
        }

        const code = await this.productUsecase.updateProductDetails(product);
        console.log({ code: code });
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
    router.get("/product_id", async (req, res) => {
      try {
        const schema = {
          product_id: Joi.string().required(),
        }
        const product = req.query;
        const isValid = Joi.validate(product, schema);
        if (isValid.error !== null) {
          throw isValid.error;
        }
        const data = await this.productUsecase.getProductById(product.product_id);
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
  }
  getRouter() {
    return router;
  }
}

module.exports = (productUsecase) => {
  return new ProductRoutes(productUsecase);
};
