const router = require("express").Router();
const Joi = require("@hapi/joi");
const respondError = require("../utils/http");

class PeopleRoutes {
  constructor(peopleUsecase) {
    this.peopleUsecase = peopleUsecase;

    this.init();
  }

  init() {
    // Create a new person
    router.post("/", async (req, res) => {
      try {
        const schema = {
          name: Joi.string().required(),
          primary_phone: Joi.string().allow(null).required(),
          secondary_phone: Joi.string().allow("").allow(null).optional(),
          person_type: Joi.number().required(),
          store_ids: Joi.array().items(Joi.number().required()).required(),
        };

        const isValid = Joi.validate(req.body, schema);

        if (isValid.error !== null) {
          console.log(isValid.error);
          throw isValid.error;
        }

        const result = await this.peopleUsecase.createPerson(req.body);
        res.status(200).json(result);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Update a person
    router.put("/:id", async (req, res) => {
      try {
        const idSchema = {
          id: Joi.number().required(),
        };

        const bodySchema = {
          name: Joi.string().required(),
          primary_phone: Joi.string().allow(null),
          secondary_phone: Joi.string().allow(null),
          person_type: Joi.number().required(),
        };

        const isValidId = Joi.validate(
          { id: parseInt(req.params.id) },
          idSchema
        );
        const isValidBody = Joi.validate(req.body, bodySchema);

        if (isValidId.error !== null) {
          console.log(isValidId.error);
          throw isValidId.error;
        }

        if (isValidBody.error !== null) {
          console.log(isValidBody.error);
          throw isValidBody.error;
        }

        const person = {
          ...req.body,
          person_id: req.params.id,
        };
        const result = await this.peopleUsecase.updatePerson(person);
        res.status(200).json(result);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Delete a person
    router.delete("/:id", async (req, res) => {
      try {
        const schema = {
          id: Joi.number().required(),
        };

        const isValid = Joi.validate({ id: parseInt(req.params.id) }, schema);

        if (isValid.error !== null) {
          console.log(isValid.error);
          throw isValid.error;
        }

        const result = await this.peopleUsecase.deletePerson(req.params.id);
        res.status(200).json(result);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Get all people
    router.get("/", async (req, res) => {
      try {
        const people = await this.peopleUsecase.getAllPeople();
        res.status(200).json(people);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });
  }

  getRouter() {
    return router;
  }
}

module.exports = (peopleUsecase) => {
  return new PeopleRoutes(peopleUsecase);
};
