
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
      updateEmployeeDetails(employee) {
        return new Promise(async (resolve, reject) => {
          try {
            const employee_id = seller.employee_id; 
            const { code } = await this.sellerRepo.updateCustomerSupport(employee.employee_details, employee_id);
          
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
                for(let i = 0; i < employee.files.length - 1; i++) {
                    await this.documentUsecase.create({
                        card_type: employee.files[i].id_card,
                        card_no: employee.files[i].id_card_no,
                        card_name: employee.files[i].id_card_name,
                        expiry_date: employee.files[i].expiry_date,
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
