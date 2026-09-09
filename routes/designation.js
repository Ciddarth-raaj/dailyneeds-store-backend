const router = require("express").Router();
const P = require("../constants/hr_permissions");
const Joi = require("@hapi/joi");
const respondError = require("../utils/http");

class DesignationRoutes {
  constructor(designationUsecase, permissions) {
    this.permissions = permissions;
    this.designationUsecase = designationUsecase;

    this.init();
  }

  init() {
    router.get("/", this.permissions.require(P.VIEW_DESIGNATION), async (req, res) => {
      try {
        const designation = await this.designationUsecase.get();
        res.json(designation);
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
    router.get("/budget", this.permissions.require(P.VIEW_DESIGNATION), async (req, res) => {
      try {
        const designation =
          await this.designationUsecase.getDesignationByBudget();
        res.json(designation);
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
    router.post("/update-status", this.permissions.require(P.ADD_DESIGNATION), async (req, res) => {
      try {
        const schema = {
          designation_id: Joi.number().required(),
          status: Joi.number().required(),
        };

        const designation = req.body;
        const isValid = Joi.validate(designation, schema);
        if (isValid.error !== null) {
          throw isValid.error;
        }

        const code = await this.designationUsecase.updateStatus(designation);
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
    router.get("/permissions", async (req, res) => {
      try {
        const designation_id = req.decoded.designation_id;
        const user_type = req.decoded.user_type;
        const isValid = Joi.validate(designation_id);
        if (isValid.error !== null) {
          throw isValid.error;
        }

        const permission = await this.designationUsecase.getPermissionById(
          designation_id,
          user_type
        );
        res.json(permission);
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
    router.get("/count", this.permissions.require(P.VIEW_DESIGNATION), async (req, res) => {
      try {
        const designation = await this.designationUsecase.getDesignationCount();
        res.json(designation);
      } catch (err) {
        console.log(err);
        if (err.name === "ValidationError") {
          res.json({ code: 422, msg: err.toString() });
        } else {
          res.json({ code: 500, msg: "An error occurred !" });
        }
      }
    });
    router.post("/update-designation", this.permissions.require(P.ADD_DESIGNATION), async (req, res) => {
      try {
        const schema = {
          designation_id: Joi.number().required(),
          // OPTIONAL, and this matters. `usecase.updateDesignationDetails`
          // DELETES every permission row for the designation and recreates it
          // from this array - but only `if (designation.permissions)`. The
          // usecase has always handled an absent list correctly; the schema was
          // the only thing forcing one.
          //
          // Requiring it meant any caller that wanted to change just the name
          // or the status had to send the full permission set back, and getting
          // that wrong - an empty array from a screen that never loaded them -
          // silently revoked every permission the designation had. A master
          // screen editing a name should not be able to do that.
          permissions: Joi.array().items(Joi.string()).optional(),
          designation_details: Joi.object({
            online_portal: Joi.number().required(),
            designation_name: Joi.string().required(),
            login_access: Joi.number().required(),
            status: Joi.number().required(),
          }).optional(),
        };

        const designation = req.body;
        const isValid = Joi.validate(designation, schema);
        if (isValid.error !== null) {
          throw isValid.error;
        }

        const code = await this.designationUsecase.updateDesignationDetails(
          designation
        );
        // Stage 0B / B2: the permission cache is keyed by designation and
        // trusted for a minute. Without this, revoking a permission left it
        // working for up to that long. Dropped here, in the route, so the
        // usecase and repository never see the request or the middleware.
        this.permissions.invalidate(designation.designation_id);
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
    router.get("/designation_id", this.permissions.require(P.VIEW_DESIGNATION), async (req, res) => {
      try {
        const schema = {
          designation_id: Joi.string().required(),
        };
        const designation = req.query;
        const isValid = Joi.validate(designation, schema);
        if (isValid.error !== null) {
          throw isValid.error;
        }
        const data = await this.designationUsecase.getDesignationById(
          designation.designation_id
        );
        console.log(data);
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
    router.post("/create", this.permissions.require(P.ADD_DESIGNATION), async (req, res) => {
      try {
        const schema = {
          // status: Joi.number().required(),
          designation_name: Joi.string().required(),
          login_access: Joi.number().required(),
          status: Joi.number().required(),
          online_portal: Joi.number().required(),
          permissions: Joi.array().items(Joi.string().optional()).required(),
        };

        const designation = req.body;
        const isValid = Joi.validate(designation, schema);

        if (isValid.error !== null) {
          throw isValid.error;
        }

        const response = await this.designationUsecase.create(designation);
        // A new designation cannot be cached yet, but an id can be reused
        // after a delete; clearing costs one query per designation at most.
        this.permissions.invalidate();
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

module.exports = (designationUsecase, permissions) => {
  return new DesignationRoutes(designationUsecase, permissions);
};
