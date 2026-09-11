const router = require("express").Router();
const P = require("../constants/hr_permissions");
const Joi = require("@hapi/joi");
const respondError = require("../utils/http")

class DepartmentRoutes {
  constructor(departmentUsecase, permissions) {
    this.permissions = permissions;
    this.departmentUsecase = departmentUsecase;

    this.init();
  }

  init() {
    router.get("/", this.permissions.require(P.VIEW_DEPARTMENT), async (req, res) => {
        try {
          const department = await this.departmentUsecase.get();
          res.json(department);
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
      /**
       * The department PICKER: `{ department_id, department_name }` only.
       *
       * `GET /` above stays behind `view_department`. This is the same
       * return-less-rather-than-hand-back-the-permission answer as
       * `GET /outlet/directory`, so that an Employee Master editor holding
       * `employee_edit` has something to choose from. No image, no status, no
       * write.
       */
      router.get("/directory", async (req, res) => {
        try {
          res.json(await this.departmentUsecase.getDirectory());
        } catch (err) {
          console.log(err);
          res.json({ code: 500, msg: "An error occurred !" });
        }

        res.end();
      });
      router.get("/product-department", this.permissions.require(P.VIEW_DEPARTMENT), async (req, res) => {
        try {
          const department = await this.departmentUsecase.getProductDepartment();
          res.json(department);
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
      router.post("/imageupload", this.permissions.require(P.ADD_DEPARTMENT), async (req, res) => {
        try {
          const schema = {
            image_url: Joi.string().required(),
            department_id: Joi.number().required()
          };
          const department = req.body;
  
          const isValid = Joi.validate(department, schema);
  
          if (isValid.error !== null) {
            console.log(isValid.error);
            throw isValid.error;
          }
          const response = await this.departmentUsecase.uploadDepartmentImage(department.image_url, department.department_id);
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
      router.post("/update-status", this.permissions.require(P.ADD_DEPARTMENT), async (req, res) => {
        try {
          const schema = {
            department_id: Joi.number().required(),
            status: Joi.number().required(),
          };
  
          const department = req.body;
          const isValid = Joi.validate(department, schema);
          if (isValid.error !== null) {
            throw isValid.error;
          }
  
          const code = await this.departmentUsecase.updateStatus(department);
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
      
      router.post("/update-prodstatus", this.permissions.require(P.ADD_DEPARTMENT), async (req, res) => {
        try {
          const schema = {
            department_id: Joi.number().required(),
            status: Joi.number().required(),
          };
  
          const department = req.body;
          const isValid = Joi.validate(department, schema);
          if (isValid.error !== null) {
            throw isValid.error;
          }
  
          const code = await this.departmentUsecase.updateProductDepartmentStatus(department);
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
      router.post("/update-department", this.permissions.require(P.ADD_DEPARTMENT), async (req, res) => {
        try {
          const schema = {
            department_id: Joi.number().required(),

            department_details: Joi.object({
              department_name: Joi.string().required(),
              // Active (1) or Inactive (0). Commented out until now, which is
              // why the master screen could rename a department but not retire
              // one: Joi rejects unknown keys, so a body carrying `status` was
              // refused outright and the only way to change it was the separate
              // `/update-status` call.
              //
              // Optional rather than required, unlike the designation route's
              // equivalent, so a caller sending only a name still validates -
              // `UPDATE department SET ?` simply leaves the column alone.
              status: Joi.number().valid(0, 1).optional(),
            }).optional(),
          };

          const department = req.body;
          const isValid = Joi.validate(department, schema);
          if (isValid.error !== null) {
            throw isValid.error;
          }
  
          const code = await this.departmentUsecase.updateDepartmentDetails(department);
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
      router.get("/department_id", this.permissions.require(P.VIEW_DEPARTMENT), async (req, res) => {
        try {
          const schema = {
            department_id: Joi.string().required(),
          }
          const department = req.query;
          const isValid = Joi.validate(department, schema);
          if (isValid.error !== null) {
            throw isValid.error;
          }
          const data = await this.departmentUsecase.getDepartmentById(department.department_id);
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
    router.post("/create", this.permissions.require(P.ADD_DEPARTMENT), async (req, res) => {
        try {
          const schema = {
            // status: Joi.string().required(),
            department_name: Joi.string().required(),
          };
  
          const department = req.body;
          const isValid = Joi.validate(department, schema);
  
          if (isValid.error !== null) {
            console.log(isValid.error);
            throw isValid.error;
          }
          const response = await this.departmentUsecase.create(department);
  
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

module.exports = (departmentUsecase, permissions) => {
  return new DepartmentRoutes(departmentUsecase, permissions);
};
