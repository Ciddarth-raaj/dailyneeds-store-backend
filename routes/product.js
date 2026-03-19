const router = require("express").Router();
const Joi = require("@hapi/joi");
const respondError = require("../utils/http");

class ProductRoutes {
  constructor(productUsecase, synker) {
    this.productUsecase = productUsecase;
    this.synker = synker;
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
        const createdBy =
          req.decoded && req.decoded.employee_id
            ? req.decoded.employee_id
            : null;
        const response = await this.productUsecase.create(product, createdBy);

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

    router.get("/all", async (req, res) => {
      try {
        const product = await this.productUsecase.getAllProductData();
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

    router.get("/", async (req, res) => {
      try {
        const schema = {
          limit: Joi.number().required(),
          offset: Joi.number().required(),
          fetchAll: Joi.boolean().optional().default(false),
        };

        const data = req.query;

        const product = await this.productUsecase.get(data.limit, data.offset, data.fetchAll);
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
            product_id: Joi.number().allow(null).allow("").optional(),
            return_prod: Joi.number().allow(null).allow("").optional(),
            de_packaging_type: Joi.string().allow(null).allow("").optional(),
            cleaning: Joi.number().allow(null).allow("").optional(),
            sticker: Joi.number().allow(null).allow("").optional(),
            grinding: Joi.number().allow(null).allow("").optional(),
            cover_type: Joi.string().allow(null).allow("").optional(),
            cover_sizes: Joi.string().allow(null).allow("").optional(),
            gf_description: Joi.string().allow(null).allow("").optional(),
            gf_detailed_description: Joi.string()
              .allow(null)
              .allow("")
              .optional(),
            de_distributor: Joi.string().allow(null).allow("").optional(),
            keywords: Joi.string().allow(null).allow("").optional(),
            purchase_uom: Joi.number().integer().allow(null).optional(),
            store_uom: Joi.number().integer().allow(null).optional(),
            repln_mode: Joi.string().max(255).allow(null).allow("").optional(),
          }).optional(),

          images: Joi.array()
            .items(
              Joi.object({
                image_url: Joi.string().required(),
                priority: Joi.number().optional().default(0),
              })
            )
            .optional(),
        };

        const product = req.body;
        const isValid = Joi.validate(product, schema);
        if (isValid.error !== null) {
          console.log(isValid.error);
          throw isValid.error;
        }

        const createdBy =
          req.decoded && req.decoded.employee_id
            ? req.decoded.employee_id
            : null;
        const code = await this.productUsecase.updateProductDetails(
          product,
          createdBy
        );
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

    router.post("/sync", async (req, res) => {
      try {
        if (!this.synker || typeof this.synker.syncProducts !== "function") {
          res.status(503).json({
            code: 503,
            msg: "Product sync is not available"
          });
          res.end();
          return;
        }
        const result = await this.synker.syncProducts();
        res.json({
          code: 200,
          msg: "Sync completed",
          ...result
        });
      } catch (err) {
        console.error(err);
        respondError(res, err);
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
        };
        const product = req.query;
        const isValid = Joi.validate(product, schema);
        if (isValid.error !== null) {
          throw isValid.error;
        }
        const data = await this.productUsecase.getProductByFilter(
          product.filter,
          product.limit,
          product.offset
        );
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
        };
        const product = req.query;
        const isValid = Joi.validate(product, schema);
        if (isValid.error !== null) {
          throw isValid.error;
        }
        const data = await this.productUsecase.getProductById(
          product.product_id
        );
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

module.exports = (productUsecase, synker) => {
  return new ProductRoutes(productUsecase, synker);
};
