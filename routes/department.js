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
    /**
     * The department picker list — an id, a label and the status.
     *
     * Authenticated, and deliberately NOT gated on `view_department`. Holding that
     * permission means ADMINISTERING the department master; it was never a
     * prerequisite for being ASSIGNED one. Gating the picker on it left an HR
     * user holding `employee_edit` looking at an empty dropdown on the employee
     * profile, so the field could not be changed at all — the same failure
     * `GET /outlet/directory` was added to fix, and this follows that
     * precedent: return less rather than hand back the permission.
     *
     * It grants nothing administrative — no write of any kind, and none of the
     * master's other columns.
     *
     * INACTIVE ROWS ARE INCLUDED, with their status. An employee assigned to a
     * department that has since been switched off must still see it and must still
     * have it preselected when editing; excluding it would silently blank a
     * real assignment.
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
              // status: Joi.number().required(),
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
