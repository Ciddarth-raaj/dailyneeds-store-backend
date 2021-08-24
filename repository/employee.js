const logger = require("../utils/logger");

class EmployeeRepository {
  constructor(db) {
    this.db = db;
  }

  create(employee) {
    return new Promise((resolve, reject) => {
        this.db.query(
          "INSERT INTO EMPLOYEE (employee_name, father_name, dob, gender, marital_status, residential_address, permanent_address, primary_contact_number, alternate_contact_number, email_id, blood_group, qualification, introducer_name, introducer_details, id_number, salary, uniform_qty, store_id, department_id, designation_id, previous_experience, shift_id, date_of_joining, date_of_termination, id_card, id_card_no, employee_image, card_image, bank_name, ifsc, account_no, esi, esi_number, pf, pf_number, UAN, spouse_name, online_portal ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [
            employee.employee_name,
            employee.father_name,
            employee.dob,
            employee.gender,
            employee.marital_status,
            employee.permanent_address,
            employee.residential_address,
            employee.primary_contact_number,
            employee.alternate_contact_number,
            employee.email_id,
            employee.blood_group,
            employee.qualification,
            employee.introducer_name,
            employee.introducer_details,
            employee.id_number,
            employee.salary,
            employee.uniform_qty,
            employee.store_id,
            employee.department_id,
            employee.designation_id,
            employee.previous_experience,
            employee.shift_id,
            employee.date_of_joining,
            employee.date_of_termination,
            employee.id_card,
            employee.id_card_no,
            employee.employee_image,
            employee.card_image,
            employee.bank_name,
            employee.ifsc,
            employee.account_no,
            employee.esi,
            employee.esi_number,
            employee.pf,
            employee.pf_number,
            employee.UAN,
            employee.spouse_name,
            employee.online_portal
          ],
          (err, res) => {
            if (err) {
              if (err.code === "ER_DUP_ENTRY") {
                resolve({ code: 101 });
                return;
              }
              logger.Log({
                level: logger.LEVEL.ERROR,
                component: "REPOSITORY.EMPLOYEE",
                code: "REPOSITORY.EMPLOYEE.CREATE",
                description: err.toString(),
                category: "",
                ref: {},
              });
              reject(err);
              return;
            }
            resolve({ code: 200, id: res.insertId });
          }
        );
      });
    }
}

module.exports = (db) => {
    return new EmployeeRepository(db);
  };