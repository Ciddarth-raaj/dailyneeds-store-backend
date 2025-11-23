const router = require("express").Router();
const Joi = require("@hapi/joi");
const respondError = require("../utils/http");

class TelegramDepartmentsRoutes {
  constructor(telegramDepartmentsUsecase) {
    this.telegramDepartmentsUsecase = telegramDepartmentsUsecase;
    this.init();
  }

  init() {
    // Create department
    router.post("/", async (req, res) => {
      try {
        const schema = {
          department: Joi.string().max(100).required(),
          telegram_chat_id: Joi.number().integer().allow(null).optional(),
        };

        const department = req.body;
        const isValid = Joi.validate(department, schema);
        if (isValid.error !== null) {
          throw isValid.error;
        }

        const response = await this.telegramDepartmentsUsecase.create(
          department
        );
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

    // Get all departments
    router.get("/", async (req, res) => {
      try {
        const schema = {
          limit: Joi.number().integer().min(1).max(100).default(20),
          offset: Joi.number().integer().min(0).default(0),
        };

        const query = req.query;
        const isValid = Joi.validate(query, schema);
        if (isValid.error !== null) {
          throw isValid.error;
        }

        const limit = parseInt(query.limit) || 20;
        const offset = parseInt(query.offset) || 0;

        const departments = await this.telegramDepartmentsUsecase.getAll(
          limit,
          offset
        );
        const count = await this.telegramDepartmentsUsecase.getCount();

        res.json({
          departments,
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

    // Get department by ID
    router.get("/:id(\\d+)", async (req, res) => {
      try {
        const id = parseInt(req.params.id);
        if (isNaN(id)) {
          throw new Error("Invalid department id");
        }

        const department = await this.telegramDepartmentsUsecase.getById(id);
        if (!department) {
          res.status(404).json({ code: 404, msg: "Department not found" });
        } else {
          res.json(department);
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

    // Update department
    router.put("/:id(\\d+)", async (req, res) => {
      try {
        const id = parseInt(req.params.id);
        if (isNaN(id)) {
          throw new Error("Invalid department id");
        }

        const schema = {
          department: Joi.string().max(100).optional(),
          telegram_chat_id: Joi.number().integer().allow(null).optional(),
        };

        const department = req.body;
        const isValid = Joi.validate(department, schema);
        if (isValid.error !== null) {
          throw isValid.error;
        }

        const result = await this.telegramDepartmentsUsecase.update(
          id,
          department
        );
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

    // Delete department
    router.delete("/:id(\\d+)", async (req, res) => {
      try {
        const id = parseInt(req.params.id);
        if (isNaN(id)) {
          throw new Error("Invalid department id");
        }

        const result = await this.telegramDepartmentsUsecase.delete(id);
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

module.exports = (telegramDepartmentsUsecase) => {
  return new TelegramDepartmentsRoutes(telegramDepartmentsUsecase);
};

