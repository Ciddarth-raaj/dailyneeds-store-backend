
const moment = require("moment");
class EmployeeUsecase {
  constructor(employeeRepo, documentUsecase, userRepo) {
    this.employeeRepo = employeeRepo;
    this.documentUsecase = documentUsecase;
    this.userRepo = userRepo;
  }

  get() {
    return new Promise(async (resolve, reject) => {
      try {
        const data = await this.employeeRepo.get();
        resolve(data);
      } catch (err) {
        reject(err);
      }
    });
  }

  getHeadCount() {
    return new Promise(async (resolve, reject) => {
      try {
        const data = await this.employeeRepo.getHeadCount();
        resolve(data);
      } catch (err) {
        reject(err);
      }
    });
  }
  getResignedEmployee() {
    return new Promise(async (resolve, reject) => {
      try {
        const data = await this.employeeRepo.getResignedEmployee();
        resolve(data);
      } catch (err) {
        reject(err);
      }
    });
  }
  getEmployeeBirthday() {
    return new Promise(async (resolve, reject) => {
      try {
        const data = await this.employeeRepo.getEmployeeBirthday();
        resolve(data);
      } catch (err) {
        reject(err);
      }
    });
  }
  getEmployeeByFilter(filter) {
    return new Promise(async (resolve, reject) => {
      try {
        const data = await this.employeeRepo.getEmployeeByFilter(filter);
        resolve(data);
      } catch (err) {
        reject(err);
      }
    })
  }
  getnewJoinee(limit, offset) {
    return new Promise(async (resolve, reject) => {
      try {
        const data = await this.employeeRepo.getnewJoinee(limit, offset);
        resolve(data);
      } catch (err) {
        reject(err);
      }
    });
  }
  getFamilyDet() {
    return new Promise(async (resolve, reject) => {
      try {
        const data = await this.employeeRepo.getFamilyDet();
        resolve(data);
      } catch (err) {
        reject(err);
      }
    });
  }
  updateStatus(file) {
    return new Promise(async (resolve, reject) => {
      try {
        await this.employeeRepo.updateStatus(file);
        resolve(200);
      } catch (err) {
        reject(err);
      }
    });
  }
  getBankDetails() {
    return new Promise(async (resolve, reject) => {
      try {
        const data = await this.employeeRepo.getBankDetails();
        resolve(data);
      } catch (err) {
        reject(err);
      }
    });
  }
  getJoiningAnniversary() {
    return new Promise(async (resolve, reject) => {
      try {
        const data = await this.employeeRepo.getJoiningAnniversary();
        resolve(data);
      } catch (err) {
        reject(err);
      }
    });
  }
  getNewJoiner() {
    return new Promise(async (resolve, reject) => {
      try {
        const data = await this.employeeRepo.getNewJoiner();
        resolve(data);
      } catch (err) {
        reject(err);
      }
    });
  }
  
  getEmployeeByStore(store_id) {
    return new Promise(async (resolve, reject) => {
      try {
        const data = await this.employeeRepo.getEmployeeByStore(store_id);
        resolve(data);
      } catch (err) {
        reject(err);
      }
    });
  }
  getEmployeeById(employee_id) {
    return new Promise(async (resolve, reject) => {
      try {
        const data = await this.employeeRepo.getById(employee_id);
        resolve(data);
      } catch (err) {
        reject(err);
      }
    });
  }
  updateEmployeeDetails(employee) {
    return new Promise(async (resolve, reject) => {
      try {
        const employee_id = employee.employee_id;
        if(employee.employee_details.docupdate.length !== 0) {
          for (let i = 0; i < employee.employee_details.docupdate.length; i++) {
          await this.documentUsecase.update({ 
            data: employee.employee_details.docupdate[i],
            card_type: employee.employee_details.docupdate[i].card_type,
            employee_id: employee_id,
          })
        }
        }
        const id_card_name = employee.employee_details.files[0].id_card_name;
        if (id_card_name !== '') {
          for (let i = 0; i <= employee.employee_details.files.length - 1; i++) {
            await this.documentUsecase.create({
              card_type: employee.employee_details.files[i].id_card,
              card_no: employee.employee_details.files[i].id_card_no,
              card_name: employee.employee_details.files[i].id_card_name,
              expiry_date: employee.employee_details.files[i].expiry_date == "" ? null : moment(employee.employee_details.files[i].expiry_date).format("YYYY-MM-DD"),
              file: employee.employee_details.files[i].file,
              employee_id: employee_id,
            })
          }
        }
        if(employee.employee_details.modified_employee_image !== "") {
            await this.employeeRepo.updateEmployeeImage(employee.employee_details.modified_employee_image, employee_id);
        }
        delete employee.employee_details.docupdate;
        delete employee.employee_details.modified_employee_image;
        const { code } = await this.employeeRepo.updateEmployeeDetails(employee.employee_details, employee_id);
        resolve(code); 
      } catch (err) {
        reject(err);
      }
    });
  }
  create(employee) {
    return new Promise(async (resolve, reject) => {
      try {
        const { code, id } = await this.employeeRepo.create(employee);
        const id_card = employee.files[0].id_card;
        if (id_card !== '') {
        for (let i = 0; i <= employee.files.length - 1; i++) {
          await this.documentUsecase.create({
            card_type: employee.files[i].id_card,
            card_no: employee.files[i].id_card_no,
            card_name: employee.files[i].id_card_name,
            expiry_date: employee.files[i].expiry_date == "" ? null : moment(employee.files[i].expiry_date).format("YYYY-MM-DD"),
            file: employee.files[i].file,
            employee_id: id,
          })
        }
        }
        const data = await this.userRepo.createLogin(employee.primary_contact_number, '1', id, 'password');
        resolve(200);
      } catch (err) {
        reject(err);
        console.log(err);
      }
    });
  }
}

module.exports = (employeeRepo, documentUsecase, userRepo) => {
  return new EmployeeUsecase(employeeRepo, documentUsecase, userRepo);
};
