
class ResignationUsecase {
    constructor(resignationRepo) {
        this.resignationRepo = resignationRepo;
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
            const { code } = await this.resignationRepo.updateResignationDetails(department.resignation_details, resignation_id);  
            resolve(code);
          } catch (err) {
            reject(err);
          }
        });
      }
    getResignationById(resignation_id) {
        return new Promise(async (resolve, reject) => {
          try {
            const data = await this.resignationRepo.getResignationById(resignation_id);
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
                this.resignationRepo.create(resignation);
                resolve(200);
            } catch (err) {
                reject(err);
            }
        });
    }

}

module.exports = (resignationRepo) => {
    return new ResignationUsecase(resignationRepo);
};
