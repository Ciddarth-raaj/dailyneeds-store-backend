const router = require("express").Router();
const Joi = require("@hapi/joi");
const respondError = require("../utils/http")

class EmployeeRoutes {
  constructor(employeeUsecase) {
    this.employeeUsecase = employeeUsecase;

    this.init();
  }

  init() {
    router.post("/", async (req, res) => {
      try {
        const schema = {
          employee_name: Joi.string().required(),
          father_name: Joi.string().required(),
          dob: Joi.string().required(),
          permanent_address: Joi.string().required(),
          residential_address: Joi.string().required(),
          primary_contact_number: Joi.number().min(100000000).max(99999999999).required(),
          alternate_contact_number: Joi.number().min(100000000).allow('').allow(null).max(99999999999).optional(),
          email_id: Joi.string().trim().allow('').allow(null).email().optional(),
          qualification: Joi.string().allow('').allow(null).required(),
          introducer_name: Joi.string().allow('').allow(null).optional(),
          introducer_details: Joi.string().allow('').allow(null).optional(),
          salary: Joi.number().required(), 
          uniform_qty: Joi.number().allow('').allow(null).optional(),
          previous_experience: Joi.string().allow('').allow(null).optional(),
          date_of_joining: Joi.string().allow('').allow(null).optional(),
          gender: Joi.string().required(),
          payment_type: Joi.number().required(),
          blood_group: Joi.string().allow('').allow(null).optional(),
          designation_id: Joi.number().required(),
          store_id: Joi.number().required(),
          shift_id: Joi.number().allow('').allow(null).optional(),
          department_id: Joi.number().required(),
          marital_status: Joi.string().required(),
          marriage_date: Joi.string().allow('').allow(null).optional(),
          employee_image: Joi.string().required(),
          pan_no: Joi.string().allow('').allow(null).optional(),
          bank_name: Joi.string().allow('').allow(null).optional(),
          ifsc: Joi.string().allow('').optional(),
          account_no: Joi.string().allow('').allow(null).optional(),
          esi: Joi.string().allow('').optional(),
          esi_number: Joi.string().allow('').allow(null).optional(),
          pf: Joi.string().allow('').optional(),
          pf_number: Joi.string().allow('').allow(null).optional(),
          UAN: Joi.string().allow('').allow(null).optional(),
          additional_course: Joi.string().allow('').allow(null).optional(),
          spouse_name: Joi.string().allow('').allow(null).optional(),
          online_portal: Joi.number().optional(),
          files: Joi.array()
            .items({
              id_card: Joi.string().allow('').allow(null).required(),
              id_card_no: Joi.string().allow('').required(),
              id_card_name: Joi.string().allow('').required(),
              expiry_date: Joi.date().allow("").allow(null).optional(),
              file: Joi.string().allow('').required(),
            })
            .required(),
        };

        const employee = req.body;
        const isValid = Joi.validate(employee, schema);
        if (isValid.error !== null) {
          console.log(isValid.error);
          throw isValid.error;
        }
        const response = await this.employeeUsecase.create(employee);

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
    router.get("/employees", async (req, res) => {
      try {
        const employee = await this.employeeUsecase.get();
        res.json(employee);
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

    router.get("/headcount", async (req, res) => {
      try {
        const employee = await this.employeeUsecase.getHeadCount();
        res.json(employee);
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
    router.get("/familydet", async (req, res) => {
      try {
        const employee = await this.employeeUsecase.getFamilyDet();
        res.json(employee);
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
    router.get("/bank", async (req, res) => {
      try {
        const employee = await this.employeeUsecase.getBankDetails();
        res.json(employee);
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
    router.get("/resignedemp", async (req, res) => {
      try {
        const employee = await this.employeeUsecase.getResignedEmployee();
        res.json(employee);
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
    router.get("/newjoiner", async (req, res) => {
      try {
        const employee = await this.employeeUsecase.getNewJoiner();
        res.json(employee);
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

    router.get("/birthday", async (req, res) => {
      try {
        const employee = await this.employeeUsecase.getEmployeeBirthday();
        res.json(employee);
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

    router.get("/anniversary", async (req, res) => {
      try {
        const employee = await this.employeeUsecase.getJoiningAnniversary();
        res.json(employee);
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
    
    router.get("/store_id", async (req, res) => {
      try {
        const schema = {
          store_id: Joi.number().required(),
        }
        const employee = req.query;
        const isValid = Joi.validate(employee, schema);
        if (isValid.error !== null) {
          throw isValid.error;
        }
        const data = await this.employeeUsecase.getEmployeeByStore(employee.store_id);
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
    router.get("/employee_id", async (req, res) => {
      try {
        const schema = {
          employee_id: Joi.number().required(),
        }
        const employee = req.query;
        const isValid = Joi.validate(employee, schema);
        if (isValid.error !== null) {
          throw isValid.error;
        }
        const data = await this.employeeUsecase.getEmployeeById(employee.employee_id);
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
    router.post("/update-status", async (req, res) => {
      try {
        const schema = {
          employee_id: Joi.number().required(),
          status: Joi.number().required(),
        };

        const employee = req.body;
        const isValid = Joi.validate(employee, schema);
        if (isValid.error !== null) {
          throw isValid.error;
        }

        const code = await this.employeeUsecase.updateStatus(employee);
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
    router.post("/updatedata", async (req, res) => {
        try {
          const schema = {
            employee_id: Joi.number().required(),

            employee_details: Joi.object({
              employee_name: Joi.string().allow('').allow(null).optional(),
              father_name: Joi.string().allow('').allow(null).optional(),
              dob: Joi.string().allow('').allow(null).optional(),
              permanent_address: Joi.string().allow('').allow(null).optional(),
              residential_address: Joi.string().allow('').allow(null).optional(),
              primary_contact_number: Joi.number().min(100000000).max(99999999999).optional(),
              alternate_contact_number: Joi.number().min(100000000).allow('').allow(null).max(99999999999).optional(),
              email_id: Joi.string().trim().email().allow(null).optional(),
              qualification: Joi.string().allow('').allow(null).optional(),
              introducer_name: Joi.string().allow('').allow(null).optional(),
              introducer_details: Joi.string().allow('').allow(null).optional(),
              salary: Joi.number().allow('').allow(null).optional(),
              uniform_qty: Joi.number().allow('').allow(null).optional(),
              previous_experience: Joi.string().allow('').allow(null).optional(),
              date_of_joining: Joi.string().allow('').allow(null).optional(),
              gender: Joi.string().allow('').allow(null).optional(),
              payment_type: Joi.number().allow('').allow(null).optional(),
              blood_group: Joi.string().allow('').allow(null).optional(),
              designation_id: Joi.number().allow('').allow(null).optional(),
              store_id: Joi.number().allow('').allow(null).optional(),
              shift_id: Joi.number().allow('').allow(null).optional(),
              department_id: Joi.number().allow('').allow(null).optional(),
              marital_status: Joi.string().allow('').allow(null).optional(),
              marriage_date: Joi.string().allow('').allow(null).optional(),
              pan_no: Joi.string().allow('').allow(null).optional(),
              bank_name: Joi.string().allow('').allow(null).optional(),
              ifsc: Joi.string().allow('').allow(null).optional(),
              account_no: Joi.string().allow('').allow(null).optional(),
              esi: Joi.string().allow('').allow(null).optional(),
              esi_number: Joi.string().allow('').allow(null).optional(),
              pf: Joi.string().allow('').allow(null).optional(),
              pf_number: Joi.string().allow('').allow(null).optional(),
              UAN: Joi.string().allow('').allow(null).optional(),
              additional_course: Joi.string().allow('').allow(null).optional(),
              spouse_name: Joi.string().allow('').allow(null).optional(),
              online_portal: Joi.number().allow(null).optional(),
              modified_employee_image: Joi.string().allow('').allow(null).optional(),
              files: Joi.array()
                .items({
                    id_card: Joi.string().allow('').required(),
                    id_card_no: Joi.number().allow('').required(),
                    id_card_name: Joi.string().allow('').required(),
                    expiry_date: Joi.date().allow("").allow(null).optional(),
                    file: Joi.string().allow('').required(),
                })
                .optional(),
              docupdate: Joi.array()
              .items({
                card_name: Joi.string().allow('').allow(null).optional(),
                card_no: Joi.string().allow('').allow(null).optional(),
                card_type: Joi.string().allow('').allow(null).required(),
                file: Joi.string().allow('').allow(null).optional(),
              })
              .optional(),
            }).optional(),
          };

          const employee = req.body;
          for(let i=0; i <= employee.employee_details.docupdate.length - 1; i++) {
            if(employee.employee_details.docupdate[i].file === "") {
              delete employee.employee_details.docupdate[i].file
            }
          }
          const isValid = Joi.validate(employee, schema);
          if (isValid.error !== null) {
            console.log(isValid.error);
            throw isValid.error;
          }
          const code = await this.employeeUsecase.updateEmployeeDetails(employee);
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

module.exports = (employeeUsecase) => {
  return new EmployeeRoutes(employeeUsecase);
};
