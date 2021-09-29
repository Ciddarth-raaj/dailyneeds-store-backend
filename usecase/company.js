class companyUsecase {
    constructor(companyRepo) {
      this.companyRepo = companyRepo;
    }
  
    get(company_id) {
      return new Promise(async (resolve, reject) => {
        try {
          const data = await this.companyRepo.get(company_id);
          resolve(data);
        } catch (err) {
          reject(err);
        }
      });
    }
    create(file) {
      return new Promise(async (resolve, reject) => {
        try {
          await this.companyRepo.create(file);
          resolve(200);
        } catch (err) {
          reject(err);
        }
      });
    }
    updateStatus(file) {
      return new Promise(async (resolve, reject) => {
        try {
          await this.companyRepo.updateStatus(file);
          resolve(200);
        } catch (err) {
          reject(err);
        }
      });
    }
  }
  
  module.exports = (companyRepo) => {
    return new companyUsecase(companyRepo);
  };
  