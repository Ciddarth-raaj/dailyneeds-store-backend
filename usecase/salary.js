
class SalaryUsecase {
    constructor(salaryRepo) {
        this.salaryRepo = salaryRepo;
    }

    get() {
        return new Promise(async (resolve, reject) => {
            try {
                const data = await this.salaryRepo.get();
                resolve(data);
            } catch (err) {
                reject(err);
            }
        });

    }
    updateStatus(file) {
      return new Promise(async (resolve, reject) => {
        try {
          await this.salaryRepo.updateStatus(file);
          resolve(200);
        } catch (err) {
          reject(err);
        }
      });
    }
    updatePaidStatus(file) {
        return new Promise(async (resolve, reject) => {
          try {
            await this.salaryRepo.updatePaidStatus(file);
            resolve(200);
          } catch (err) {
            reject(err);
          }
        });
      }
    updateSalaryDetails(payment) {
        return new Promise(async (resolve, reject) => {
          try {
            const payment_id = payment.payment_id;
            const { code } = await this.salaryRepo.updateSalaryDetails(payment.payment_details, payment_id);  
            resolve(code);
          } catch (err) {
            reject(err);
          }
        });
      }
    getSalaryById(payment_id) {
        return new Promise(async (resolve, reject) => {
          try {
            const data = await this.salaryRepo.getSalaryById(payment_id);
            resolve(data);
          } catch (err) {
            console.log(err);
            reject(err);
          }
        });
      }
    create(salary) {
        return new Promise(async (resolve, reject) => {
            try {
                this.salaryRepo.create(salary);
                resolve(200);
            } catch (err) {
                reject(err);
            }
        });
    }

}

module.exports = (salaryRepo) => {
    return new SalaryUsecase(salaryRepo);
};
