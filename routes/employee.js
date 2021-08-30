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
            gender: Joi.string().required(),
            marital_status: Joi.string().required(),
            permanent_address: Joi.string().required(),
            residential_address: Joi.string().allow('').required(),
            primary_contact_number: Joi.number().min(1000000000).max(99999999999).required(),
            alternate_contact_number: Joi.string().min(1000000000).allow('').max(99999999999).optional(),
            email_id: Joi.string().trim().email().required(),
            blood_group: Joi.string().required(),
            qualification: Joi.string().allow('').required(),
            introducer_name: Joi.string().allow('').optional(),
            introducer_details: Joi.string().allow('').optional(),
            id_number: Joi.number().allow('').required(),
            salary: Joi.number().required(),
            uniform_qty: Joi.number().allow('').optional(),
            store_id: Joi.number().required(),
            department_id: Joi.number().required(),
            designation_id: Joi.number().required(),
            previous_experience: Joi.string().allow('').optional(),
            shift_id: Joi.number().required(),
            spouse_name: Joi.string().allow('').optional(),
            date_of_joining: Joi.string().allow('').optional(),
	          bank_name: Joi.string().allow('').optional(),
	          ifsc: Joi.number().allow('').optional(),
	          account_no: Joi.number().allow('').optional(),
	          esi: Joi.number().allow('').required(),
	          esi_number: Joi.number().allow('').optional(),
	          pf: Joi.number().allow('').optional(),
	          pf_number: Joi.number().allow('').optional(),
	          UAN: Joi.number().allow('').optional(),
            date_of_termination: Joi.string().allow('').optional(),
            employee_image: Joi.string().required(),
            online_portal: Joi.number().required(),
            file: Joi.array()
            .items({
                    id_card: Joi.string().required(),
                    id_card_no: Joi.number().required(),
                    file: Joi.string().required(),
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
  }
  getRouter() {
    return router;
  }
}   

module.exports = (employeeUsecase) => {
  return new EmployeeRoutes(employeeUsecase);
};
