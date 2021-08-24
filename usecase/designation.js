
class DesignationUsecase {
    constructor(designationRepo) {
        this.designationRepo = designationRepo;
    }

    get() {
        return new Promise(async (resolve, reject) => {
            try {
                const data = await this.designationRepo.get();
                resolve(data);
            } catch (err) {
                reject(err);
            }
        });
    }

    create(designation) {
        return new Promise(async (resolve, reject) => {
            try {
                this.designationRepo.create(designation);
                resolve({ code: 200 });
            } catch (err) {
                reject(err);
            }
        });
    }

}

module.exports = (designationRepo) => {
    return new DesignationUsecase(designationRepo);
};
