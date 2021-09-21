
class EmployeeUsecase {
  constructor(employeeRepo, documentUsecase) {
    this.employeeRepo = employeeRepo;
    this.documentUsecase = documentUsecase;
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
        
        if (employee.employee_details.files[0].card_type !== undefined) {
          for (let i = 0; i <= employee.employee_details.files.length; i++) {
            await this.documentUsecase.create({
              card_type: employee.files[i].id_card,
              card_no: employee.files[i].id_card_no,
              card_name: employee.files[i].id_card_name,
              expiry_date: employee.files[i].expiry_date,
              file: employee.files[i].file,
              employee_id: id,
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
        for (let i = 0; i <= employee.files.length - 1; i++) {
          await this.documentUsecase.create({
            card_type: employee.files[i].id_card,
            card_no: employee.files[i].id_card_no,
            card_name: employee.files[i].id_card_name,
            expiry_date: employee.files[i].expiry_date == "" ? null : employee.files[i].expiry_date,
            file: employee.files[i].file,
            employee_id: id,
          })
        }
        resolve(200);
      } catch (err) {
        reject(err);
        console.log(err);
      }
    });
  }
}

module.exports = (employeeRepo, documentUsecase) => {
  return new EmployeeUsecase(employeeRepo, documentUsecase);
};
