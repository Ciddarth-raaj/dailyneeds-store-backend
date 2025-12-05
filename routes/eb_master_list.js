const router = require("express").Router();
const Joi = require("@hapi/joi");

class EbMasterListRoutes {
  constructor(ebMasterListUsecase) {
    this.ebMasterListUsecase = ebMasterListUsecase;
    this.init();
  }

  init() {
    // Create EB Master List record
    router.post("/", async (req, res) => {
      try {
        const schema = {
          machine_number: Joi.string().max(20).required(),
          nickname: Joi.string().max(50).allow(null, "").optional(),
          store_id: Joi.number().integer().positive().required(),
          is_active: Joi.boolean().optional(),
        };

        const machine = req.body;
        const isValid = Joi.validate(machine, schema);
        if (isValid.error !== null) {
          throw isValid.error;
        }

        const response = await this.ebMasterListUsecase.create(machine);
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

    // Get all EB Master List records with filters
    router.get("/", async (req, res) => {
      try {
        const schema = {
          limit: Joi.number().integer().min(1).default(20),
          offset: Joi.number().integer().min(0).default(0),
          store_id: Joi.number().integer().positive().optional(),
          is_active: Joi.boolean().optional(),
          search: Joi.string().optional(),
        };

        const query = req.query;
        const isValid = Joi.validate(query, schema);
        if (isValid.error !== null) {
          throw isValid.error;
        }

        const validatedQuery = isValid.value;

        const filters = {
          store_id: validatedQuery.store_id,
          is_active: validatedQuery.is_active,
          search: validatedQuery.search,
        };

        // Remove undefined filters
        Object.keys(filters).forEach(
          (key) => filters[key] === undefined && delete filters[key]
        );

        const limit = validatedQuery.limit || 20;
        const offset = validatedQuery.offset || 0;

        const machines = await this.ebMasterListUsecase.getAll(
          filters,
          limit,
          offset
        );
        const count = await this.ebMasterListUsecase.getCount(filters);

        res.json({
          machines,
          count,
          limit,
          offset,
        });
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

    // Get EB Master List record by ID
    router.get("/:id(\\d+)", async (req, res) => {
      try {
        const id = parseInt(req.params.id);
        if (isNaN(id)) {
          throw new Error("Invalid eb_machine_id");
        }

        const machine = await this.ebMasterListUsecase.getById(id);
        if (!machine) {
          res
            .status(404)
            .json({ code: 404, msg: "EB Master List record not found" });
        } else {
          res.json(machine);
        }
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

    // Update EB Master List record
    router.put("/:id(\\d+)", async (req, res) => {
      try {
        const id = parseInt(req.params.id);
        if (isNaN(id)) {
          throw new Error("Invalid eb_machine_id");
        }

        const schema = {
          machine_number: Joi.string().max(20).optional(),
          nickname: Joi.string().max(50).allow(null, "").optional(),
          store_id: Joi.number().integer().positive().optional(),
          is_active: Joi.boolean().optional(),
        };

        const machine = req.body;
        const isValid = Joi.validate(machine, schema);
        if (isValid.error !== null) {
          throw isValid.error;
        }

        const result = await this.ebMasterListUsecase.update(id, machine);
        res.json(result);
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

    // Delete EB Master List record
    router.delete("/:id(\\d+)", async (req, res) => {
      try {
        const id = parseInt(req.params.id);
        if (isNaN(id)) {
          throw new Error("Invalid eb_machine_id");
        }

        const result = await this.ebMasterListUsecase.delete(id);
        res.json(result);
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

module.exports = (ebMasterListUsecase) => {
  return new EbMasterListRoutes(ebMasterListUsecase);
};
