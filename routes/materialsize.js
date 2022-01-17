const router = require("express").Router();
const Joi = require("@hapi/joi");
const respondError = require("../utils/http");

class materialSizeRoutes {
  constructor(materialsizeUsecase) {
    this.materialsizeUsecase = materialsizeUsecase;

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

        const material = await this.materialsizeUsecase.get(data.offset, data.limit);
        res.json(material);
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
    router.get("/sizecount", async (req, res) => {
      try {
        const material = await this.materialsizeUsecase.getSizeCount();
        res.json(material);
      } catch (err) {
          console.log(err);
        if (err.name === "ValidationError") {
          res.json({ code: 422, msg: err.toString() });
        } else {
          res.json({ code: 500, msg: "An error occurred !" });
        }
      }
    });
    router.get("/type", async (req, res) => {
      try {
        const material = await this.materialsizeUsecase.getType();
        res.json(material);
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
    router.get("/size", async (req, res) => {
      try {
        const material = await this.materialsizeUsecase.getSize();
        res.json(material);
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
          material_id: Joi.number().required(),
          status: Joi.number().required(),
        };

        const material = req.body;
        const isValid = Joi.validate(material, schema);
        if (isValid.error !== null) {
          throw isValid.error;
        }

        const code = await this.materialsizeUsecase.updateStatus(material);
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


    router.post("/update-materialsize", async (req, res) => {
      try {
        const schema = {
          size_id: Joi.number().required(),
          material_details: Joi.object({
            material_size: Joi.string().required(),
						weight: Joi.number().required(),
						cost: Joi.number().required(),
						description: Joi.string().required(),
          }).optional(),
        };

        const material = req.body;
        const isValid = Joi.validate(material, schema);
        if (isValid.error !== null) {
          throw isValid.error;
        }

        const code = await this.materialsizeUsecase.updateMaterialDetails(material);
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

    router.get("/size_id", async (req, res) => {
      try {
        const schema = {
          size_id: Joi.string().required(),
        };
        const material = req.query;
        const isValid = Joi.validate(material, schema);
        if (isValid.error !== null) {
          throw isValid.error;
        }
        const data = await this.materialsizeUsecase.getMaterialById(
          material.size_id
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

    router.post("/create", async (req, res) => {
      try {
        const schema = {
          material_size: Joi.string().optional(),
          weight: Joi.string().optional(),
          cost: Joi.string().optional(),
          description: Joi.string().allow("").allow(null).optional(),
        };

        const material = req.body;
        const isValid = Joi.validate(material, schema);

        if (isValid.error !== null) {
          console.log(isValid.error);
          throw isValid.error;
        }
        const response = await this.materialsizeUsecase.create(material);
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

module.exports = (materialsizeUsecase) => {
  return new materialSizeRoutes(materialsizeUsecase);
};
