
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
          /*
           * NOT A BACK DOOR AROUND REJOIN. Deleting a legacy resignation
           * reactivates the employee and their login. When the employee
           * lifecycle has recorded an exit (Resign: resignation_date set /
           * employment period closed), that is a rejoin, and only Rejoin may
           * do it - Rejoin applies the rehire assessment (CONDITIONAL / NO
           * need management approval with a reason) and opens a new
           * employment period. Refused here before anything is written.
           */
          if (this.exitGuard) {
            const exit = await this.exitGuard.lifecycleExitOf(employee_id);
            if (exit && (exit.resignation_date || exit.latest_period_state === "closed")) {
              resolve({
                code: 409,
                error: "EXIT_RECORDED_USE_REJOIN",
                msg:
                  "This employee's exit is recorded in the employee lifecycle. Deleting the resignation cannot reactivate them; " +
                  "use Rejoin on the employee's profile, which applies the rehire assessment.",
              });
              return;
            }
          }
          await this.employeeRepo.updateStatus({status: 1, employee_id: employee_id});
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
                await this.employeeRepo.updateStatus({status: 0, employee_id: employee_id});
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
