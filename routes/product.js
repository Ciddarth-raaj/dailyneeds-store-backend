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
        const isValid = Joi.validate(product, schema);
        if (isValid.error !== null) {
          console.log(isValid.error);
          throw isValid.error;
        }
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
    router.post("/updatedata", async (req, res) => {
        try {
          const schema = {
            product_id: Joi.number().required(),

            product_details: Joi.object({
              variant: Joi.string().optional(),
              variant_of: Joi.string().optional(),
              gf_item_name: Joi.string().optional(),
              gf_description: Joi.string().optional(),
              gf_detailed_description: Joi.string().optional(),
              gf_weight_grams: Joi.string().optional(),
              gf_applies_online: Joi.string().optional(),
              gf_item_product_type: Joi.string().optional(),
              gf_manufacturer: Joi.string().optional(),
              gf_food_type: Joi.string().optional(),
              gf_tax_id: Joi.number().optional(),
              gf_status: Joi.string().optional(),
              de_distrubutor: Joi.string().optional(),
              brand_id: Joi.number().optional(),
              category_id: Joi.number().optional(),
              subcategory_id: Joi.number().optional(),
              measure: Joi.string().optional(),  
              measure_in: Joi.string().optional(),
              packaging_type: Joi.number().optional(),
              cleaning: Joi.number().optional(),
              sticker: Joi.number().optional(),
              grinding: Joi.number().optional(),   
              cover_type: Joi.string().optional(),
              cover_sizes: Joi.string().optional(),
              return: Joi.number().optional(),   
              created_at: Joi.string().optional(),
              updated_at: Joi.string().optional(),
            }).optional(),
          };

          const product = req.body;

          const isValid = Joi.validate(product, schema);
          if (isValid.error !== null) {
            console.log(isValid.error);
            throw isValid.error;
          }
  
          const code = await this.productUsecase.updateProductDetails(product);
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

module.exports = (productUsecase) => {
  return new ProductRoutes(productUsecase);
};
