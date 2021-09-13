const logger = require("../utils/logger");

class EmployeeRepository {
  constructor(db) {
    this.db = db;
  }

  create(employee) {
    return new Promise((resolve, reject) => {
        this.db.query(
          "INSERT INTO new_employee (employee_name, father_name, dob, permanent_address, residential_address, primary_contact_number, alternate_contact_number, email_id, qualification, introducer_name, introducer_details, salary, uniform_qty, previous_experience, date_of_joining, gender, blood_group, designation_id, store_id, shift_id, department_id, marital_status, marriage_date, employee_image, bank_name, ifsc, account_no, esi, esi_number, pf, pan_no, payment_type, pf_number, UAN, additional_course, spouse_name, online_portal) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [
              employee.employee_name,
              employee.father_name,
              employee.dob,
              employee.permanent_address,
              employee.residential_address,
              employee.primary_contact_number,
              employee.alternate_contact_number,
              employee.email_id,
              employee.qualification,
              employee.introducer_name,
              employee.introducer_details,
              employee.salary,
              employee.uniform_qty,
              employee.previous_experience,
              employee.date_of_joining,
              employee.gender,
              employee.blood_group,
              employee.designation_id,
              employee.store_id,
              employee.shift_id,
              employee.department_id,
              employee.marital_status,
              employee.marriage_date,
              employee.employee_image,
              employee.bank_name,
              employee.ifsc,
              employee.account_no,
              employee.esi,
              employee.esi_number,
              employee.pf,
              employee.pan_no,
              employee.payment_type,
              employee.pf_number,
              employee.UAN,
              employee.additional_course,
              employee.spouse_name,
              employee.online_portal,
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
    get() {
      return new Promise((resolve, reject) => {
        this.db.query("SELECT * FROM new_employee",
        [], 
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.EMPLOYEE",
              code: "REPOSITORY.EMPLOYEE.GET",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }
          resolve(docs);
        });
      });
    }
    getHeadCount() {
      return new Promise((resolve, reject) => {
        this.db.query("SELECT count(employee_id) as head_count FROM new_employee",
        [], 
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.EMPLOYEE",
              code: "REPOSITORY.EMPLOYEE.GET-HEAD-COUNT",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }
          resolve(docs);
        });
      });
    }
    getResignedEmployee() {
      return new Promise((resolve, reject) => {
        this.db.query("SELECT count(employee_id) as Resigned_employee FROM new_employee where resignation_date IS NOT NULL",
        [], 
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.EMPLOYEE",
              code: "REPOSITORY.EMPLOYEE.GET-RESIGNED-EMPLOYEE",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }
          resolve(docs);
        });
      });
    }

    getNewJoiner() {
      return new Promise((resolve, reject) => {
        this.db.query("select count(employee_id) as new_joiners from new_employee where MONTH(date_of_joining)=MONTH(now())",
        [], 
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.EMPLOYEE",
              code: "REPOSITORY.EMPLOYEE.GET-NEW-JOINER",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }
          resolve(docs);
        });
      });
    }
    getById(employee_id) {
      return new Promise((resolve, reject) => {
        this.db.query("SELECT * FROM new_employee where employee_id = ?",
        [employee_id], 
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.EMPLOYEE",
              code: "REPOSITORY.EMPLOYEE.GET-ID",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }
          resolve(docs);
        });
      });
    }
    updateEmployeeDetails(data, employee_id) {
      delete data['files'];
      return new Promise((resolve, reject) => {
        this.db.query(
          `UPDATE new_employee SET ? WHERE employee_id = ?`,
          [data, employee_id],
          (err, res) => {
            if (err) {
              console.log(this.db.query),
                logger.Log({
                  level: logger.LEVEL.ERROR,
                  component: "REPOSITORY.EMPLOYEE",
                  code: "REPOSITORY.EMPLOYEE.UPDATE-EMPLOYEE-DETAILS",
                  description: err.toString(),
                  category: "",
                  ref: {},
                });
              reject(err);
              return;
            }
            resolve({ code: 200 });
          }
        );
      });
    }
}

module.exports = (db) => {
    return new EmployeeRepository(db);
  };