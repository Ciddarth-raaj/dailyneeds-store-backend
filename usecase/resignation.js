
/**
 * LEGACY RESIGNATION RECORDS - READ ONLY. Exits are recorded with Employee
 * Master -> Resign and returns with Rejoin (which applies the rehire
 * assessment); see routes/resignation.js. The old create / edit / delete
 * writes, which changed employee and login status outside that workflow, are
 * gone.
 */
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

}

module.exports = (resignationRepo, employeeRepo, userRepo) => {
    return new ResignationUsecase(resignationRepo, employeeRepo, userRepo);
};
