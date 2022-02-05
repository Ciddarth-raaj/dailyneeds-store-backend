
class ResignationUsecase {
    constructor(resignationRepo, employeeRepo, userRepo) {
        this.resignationRepo = resignationRepo;
        this.employeeRepo = employeeRepo;
        this.userRepo = userRepo;
    }

    get() {
        return new Promise(async (resolve, reject) => {
            try {
                const data = await this.resignationRepo.get();
                resolve(data);
            } catch (err) {
                reject(err);
            }
        });
    }
    updateResignationDetails(resignation) {
      return new Promise(async (resolve, reject) => {
        try {
          const resignation_id = resignation.resignation_id;
          const { code } = await this.resignationRepo.updateResignationDetails(resignation.resignation_details, resignation_id);
          resolve(code);
        } catch (err) {
          reject(err);
        }
      });
    }
    deleteResignation(resignation_id) {
      return new Promise(async (resolve, reject) => {
        try {
          const employee_id = await this.employeeRepo.getEmployeeIdByDelete(resignation_id);
          await this.userRepo.updateStatus({status: 1, employee_id: employee_id});
          const { code } = await this.resignationRepo.deleteResignation(resignation_id);
          resolve(code);
        } catch (err) {
          console.log(err);
          reject(err);
        }
      });
    }
 
    getResignationByResigId(resignation_id) {
      return new Promise(async (resolve, reject) => {
        try {
          const data = await this.resignationRepo.getResignationByResigId(resignation_id);
          resolve(data);
        } catch (err) {
          console.log(err);
          reject(err);
        }
      });
    }
    getResignationById(employee_name) {
        return new Promise(async (resolve, reject) => {
          try {
            const data = await this.resignationRepo.getResignationById(employee_name);
            resolve(data);
          } catch (err) {
            console.log(err);
            reject(err);
          }
        });
      }
    create(resignation) {
        return new Promise(async (resolve, reject) => {
            try {
                const employee_id = await this.employeeRepo.getEmployeeIdByName(resignation.employee_name);
                await this.userRepo.updateStatus({status: 0, employee_id: employee_id});
                this.resignationRepo.create(resignation);
                resolve(200);
            } catch (err) {
                reject(err);
            }
        });
    }

}

module.exports = (resignationRepo, employeeRepo, userRepo) => {
    return new ResignationUsecase(resignationRepo, employeeRepo, userRepo);
};
