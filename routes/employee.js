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
            alternate_contact_number: Joi.number().min(100000000).allow('').max(99999999999).optional(),
            email_id: Joi.string().trim().email().required(),
            qualification: Joi.string().allow('').required(),
            introducer_name: Joi.string().allow('').optional(),
            introducer_details: Joi.string().allow('').optional(),
            salary: Joi.number().required(),
            uniform_qty: Joi.number().allow('').optional(),
            previous_experience: Joi.string().allow('').optional(),
            date_of_joining: Joi.string().allow('').optional(),
            gender: Joi.string().required(),
            payment_type: Joi.number().required(),
            blood_group: Joi.string().required(),
            designation_id: Joi.number().required(),
            store_id: Joi.number().required(),
            shift_id: Joi.number().required(),
            department_id: Joi.number().required(),
            marital_status: Joi.string().required(),
            marriage_date: Joi.string().allow('').optional(),
            employee_image: Joi.string().required(),
            pan_no: Joi.string().required(),
            bank_name: Joi.string().allow('').optional(),
	          ifsc: Joi.number().allow('').optional(),
	          account_no: Joi.number().allow('').optional(),
	          esi: Joi.number().allow('').optional(),
	          esi_number: Joi.number().allow('').optional(),
	          pf: Joi.number().allow('').optional(),
	          pf_number: Joi.number().allow('').optional(),
	          UAN: Joi.number().allow('').optional(),
            additional_course: Joi.string().optional(),
            spouse_name: Joi.string().allow('').optional(),
            online_portal: Joi.number().optional(),
            files: Joi.array()
            .items({
                    id_card: Joi.string().allow('').required(),
                    id_card_no: Joi.number().allow('').required(),
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
      router.post("/updatedata", async (req, res) => {
        try {
          const schema = {
            employee_id: Joi.number().required(),

            employee_details: Joi.object({
                employee_name: Joi.string().optional(),
                father_name: Joi.string().optional(),
                dob: Joi.string().optional(),
                permanent_address: Joi.string().optional(),
                residential_address: Joi.string().optional(),
                primary_contact_number: Joi.number().min(100000000).max(99999999999).optional(),
                alternate_contact_number: Joi.number().min(100000000).allow('').max(99999999999).optional(),
                email_id: Joi.string().trim().email().optional(),
                qualification: Joi.string().allow('').optional(),
                introducer_name: Joi.string().allow('').optional(),
                introducer_details: Joi.string().allow('').optional(),
                salary: Joi.number().optional(),
                uniform_qty: Joi.number().allow('').optional(),
                previous_experience: Joi.string().allow('').optional(),
                date_of_joining: Joi.string().allow('').optional(),
                gender: Joi.string().optional(),
                payment_type: Joi.number().optional(),
                blood_group: Joi.string().optional(),
                designation_id: Joi.number().optional(),
                store_id: Joi.number().optional(),
                shift_id: Joi.number().optional(),
                department_id: Joi.number().optional(),
                marital_status: Joi.string().optional(),
                marriage_date: Joi.string().allow('').allow(null).optional(),
                employee_image: Joi.string().optional(),
                pan_no: Joi.string().optional(),
                bank_name: Joi.string().allow('').allow(null).optional(),
	              ifsc: Joi.string().allow('').allow(null).optional(),
	              account_no: Joi.string().allow('').allow(null).optional(),
	              esi: Joi.number().allow('').allow(null).optional(),
	              esi_number: Joi.number().allow('').allow(null).optional(),
	              pf: Joi.number().allow('').allow(null).optional(),
	              pf_number: Joi.number().allow('').allow(null).optional(),
	              UAN: Joi.string().allow('').allow(null).optional(),
                additional_course: Joi.string().optional(),
                spouse_name: Joi.string().allow('').allow(null).optional(),
                online_portal: Joi.number().allow(null).optional(),
                files: Joi.array()
                .items({
                    id_card: Joi.string().allow('').required(),
                    id_card_no: Joi.number().allow('').required(),
                    id_card_name: Joi.string().allow('').required(),
                    expiry_date: Joi.date().allow("").allow(null).optional(),
                    file: Joi.string().allow('').required(),
                })
                .optional(),
            }).optional(),
          };

          const employee = req.body;
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
