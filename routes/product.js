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
        const schema = {
          limit: Joi.number().required(),
          offset: Joi.number().required(),
        };

        const data = req.query;

        const product = await this.productUsecase.get(data.limit, data.offset);
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
            product_id: Joi.number().allow(null).allow('').optional(),
            return_prod: Joi.number().allow(null).allow('').optional(),
            de_packaging_type: Joi.string().allow(null).allow('').optional(),
            cleaning: Joi.number().allow(null).allow('').optional(),
            sticker: Joi.number().allow(null).allow('').optional(),
            grinding: Joi.number().allow(null).allow('').optional(),
            cover_type: Joi.string().allow(null).allow('').optional(),
            cover_sizes: Joi.string().allow(null).allow('').optional(),
            gf_description: Joi.string().allow(null).allow('').optional(),
            gf_detailed_description: Joi.string().allow(null).allow('').optional(),
            de_distributor: Joi.string().allow(null).allow('').optional(),
            keywords: Joi.string().allow(null).allow('').optional(),
          }).optional(),
        };

        const product = req.body;
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
    
    router.get("/prodcount", async (req, res) => {
      try {
        const product = await this.productUsecase.getProductCount();
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
    router.get("/filter", async (req, res) => {
      try {
        const schema = {
          filter: Joi.string().required(),
          limit: Joi.number().required(),
          offset: Joi.number().required(),
        }
        const product = req.query;
        const isValid = Joi.validate(product, schema);
        if (isValid.error !== null) {
          throw isValid.error;
        }
        const data = await this.productUsecase.getProductByFilter(product.filter, product.limit, product.offset);
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
