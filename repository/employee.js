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
    
    getNameById(username) {
      return new Promise((resolve, reject) => {
        this.db.query(`SELECT new_employee.employee_name, designation.designation_name, new_employee.employee_image FROM new_employee LEFT JOIN designation ON designation.designation_id = new_employee.designation_id WHERE primary_contact_number = ?`, 
        [username], 
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.EMPLOYEE",
              code: "REPOSITORY.EMPLOYEE.GET-NAME",
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
    getnewJoinee(limit, offset) {
      return new Promise((resolve, reject) => {
        this.db.query(`SELECT employee_id, employee_name, date_of_joining FROM new_employee WHERE MONTH(date_of_joining)=MONTH(now()) LIMIT ${offset},${limit}`, 
        [], 
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.EMPLOYEE",
              code: "REPOSITORY.EMPLOYEE.GET-JOINEE",
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
    getEmployeeByStore(store_id) {
      return new Promise((resolve, reject) => {
        this.db.query(
          "SELECT count(employee_id) as store_count FROM new_employee WHERE store_id = ?",
          [store_id],
          (err, docs) => {
            if (err) {
              logger.Log({
                level: logger.LEVEL.ERROR,
                component: "REPOSITORY.EMPLOYEE",
                code: "REPOSITORY.EMPLOYEE.GET-BY-STORE",
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
    updateStatus(file) {
      return new Promise((resolve, reject) => {
        this.db.query(
          "UPDATE new_employee SET status = ? WHERE employee_id = ?",
          [file.status, file.employee_id],
          (err, docs) => {
            if (err) {
              logger.Log({
                level: logger.LEVEL.ERROR,
                component: "REPOSITORY.EMPLOYEE",
                code: "REPOSITORY.EMPLOYEE.UPDATE-STATUS",
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
    updateEmployeeImage(data, employee_id) {
      return new Promise((resolve, reject) => {
        this.db.query("UPDATE new_employee SET employee_image = ? WHERE employee_id = ?",
        [data, employee_id], 
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.EMPLOYEE",
              code: "REPOSITORY.EMPLOYEE.UPDATE-EMPLOYEE-IMAGE",
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
    getEmployeeByFilter(filter) {
      return new Promise((resolve, reject) => {
        this.db.query(`SELECT new_employee.employee_id, new_employee.employee_name, new_employee.father_name, new_employee.dob, new_employee.gender, new_employee.marital_status, 
        new_employee.employee_image, new_employee.marriage_date, new_employee.spouse_name, new_employee.permanent_address, new_employee.residential_address, 
        new_employee.primary_contact_number, new_employee.alternate_contact_number, new_employee.email_id, new_employee.blood_group, new_employee.qualification,
        new_employee.introducer_name, new_employee.introducer_details, new_employee.salary, new_employee.bank_name, new_employee.ifsc, new_employee.account_no, 
        new_employee.esi_number, new_employee.pf_number, new_employee.uan, new_employee.uniform_qty, new_employee.store_id, new_employee.department_id, 
        new_employee.designation_id, new_employee.shift_id, new_employee.previous_experience, new_employee.additional_course, new_employee.date_of_joining,
        new_employee.pan_no, new_employee.payment_type, new_employee.status, designation.designation_name, outlets.outlet_name as store_name, 
        department.department_name, shift_master.shift_name FROM new_employee LEFT JOIN department ON department.department_id = new_employee.department_id
        LEFT JOIN outlets ON outlets.outlet_id = new_employee.store_id LEFT JOIN designation ON designation.designation_id  = new_employee.designation_id
        LEFT JOIN shift_master ON shift_master.shift_id = new_employee.shift_id WHERE new_employee.employee_name LIKE "%${filter}%" OR new_employee.employee_id 
        LIKE "%${filter}%" OR outlets.outlet_name LIKE "%${filter}%"`,
        [filter], 
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.EMPLOYEE",
              code: "REPOSITORY.EMPLOYEE.GET-FILTER",
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
    get(resignation) {
      return new Promise((resolve, reject) => {
        this.db.query(`SELECT new_employee.employee_id, new_employee.employee_name, new_employee.father_name, new_employee.dob, new_employee.gender, new_employee.marital_status, 
        new_employee.employee_image, new_employee.marriage_date, new_employee.spouse_name, new_employee.permanent_address, new_employee.residential_address, 
        new_employee.primary_contact_number, new_employee.alternate_contact_number, new_employee.email_id, new_employee.blood_group, new_employee.qualification,
        new_employee.introducer_name, new_employee.introducer_details, new_employee.salary, new_employee.bank_name, new_employee.ifsc, new_employee.account_no, 
        new_employee.esi_number, new_employee.pf_number, new_employee.uan, new_employee.uniform_qty, new_employee.store_id, new_employee.department_id, 
        new_employee.designation_id, new_employee.shift_id, new_employee.previous_experience, new_employee.additional_course, new_employee.date_of_joining,
        new_employee.pan_no, new_employee.payment_type, new_employee.status, designation.designation_name, outlets.outlet_name as store_name, 
        department.department_name, shift_master.shift_name, resignation.resignation_date FROM new_employee LEFT JOIN designation ON designation.designation_id  = new_employee.designation_id
        LEFT JOIN department ON department.department_id = new_employee.department_id LEFT JOIN outlets ON outlets.outlet_id = new_employee.store_id 
        LEFT JOIN shift_master ON shift_master.shift_id = new_employee.shift_id LEFT JOIN resignation ON resignation.employee_name = 
        new_employee.employee_name where new_employee.employee_name NOT IN (?)`,
        [resignation], 
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
        this.db.query("SELECT count(employee_id) as head_count, created_at FROM new_employee GROUP BY MONTH(DATE(created_at))" ,
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
    getFamilyDet() {
      return new Promise((resolve, reject) => {
        this.db.query("SELECT employee_id, employee_name, employee_image FROM new_employee",
        [], 
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.EMPLOYEE",
              code: "REPOSITORY.EMPLOYEE.GET-FAMILY-DET",
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
    getBankDetails() {
      return new Promise((resolve, reject) => {
        this.db.query("SELECT * FROM new_employee WHERE payment_type = 2",
        [], 
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.EMPLOYEE",
              code: "REPOSITORY.EMPLOYEE.GET-BANK",
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

    getEmployeeBirthday() {
      return new Promise((resolve, reject) => {
        this.db.query("SELECT dob, employee_name AS birthday FROM new_employee WHERE WEEK(dob) = WEEK(now())",
        [], 
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.EMPLOYEE",
              code: "REPOSITORY.EMPLOYEE.GET-BIRTHDAY",
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

    getJoiningAnniversary() {
      return new Promise((resolve, reject) => {
        this.db.query("SELECT date_of_joining, employee_name AS anniversary FROM new_employee WHERE WEEK(date_of_joining)=WEEK(now())",
        [], 
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.EMPLOYEE",
              code: "REPOSITORY.EMPLOYEE.GET-ANNIVERSARY",
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
        this.db.query("SELECT * FROM new_employee LEFT JOIN department ON new_employee.department_id = department.department_id LEFT JOIN designation ON new_employee.designation_id = designation.designation_id LEFT JOIN outlets ON new_employee.store_id = outlets.outlet_id LEFT JOIN shift_master ON new_employee.shift_id = shift_master.shift_id WHERE employee_id = ?",
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