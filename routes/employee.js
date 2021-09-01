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
	          esi: Joi.number().allow('').required(),
	          esi_number: Joi.number().allow('').optional(),
	          pf: Joi.number().allow('').optional(),
	          pf_number: Joi.number().allow('').optional(),
	          UAN: Joi.number().allow('').optional(),
            additional_course: Joi.string().optional(),
            spouse_name: Joi.string().allow('').optional(),
            online_portal: Joi.number().required(),
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
  }
  getRouter() {
    return router;
  }
}   

module.exports = (employeeUsecase) => {
  return new EmployeeRoutes(employeeUsecase);
};
