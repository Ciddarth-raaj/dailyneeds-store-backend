
class materialSizeUsecase {
    constructor(materialsizeRepo) {
        this.materialsizeRepo = materialsizeRepo;
    }

    get() {
        return new Promise(async (resolve, reject) => {
            try {
                const data = await this.materialsizeRepo.get();
                resolve(data);
            } catch (err) {
                reject(err);
            }
        });
    }
    updateStatus(file) {
      return new Promise(async (resolve, reject) => {
        try {
          await this.materialsizeRepo.updateStatus(file);
          resolve(200);
        } catch (err) {
          reject(err);
        }
      });
    }
    create(material) {
        return new Promise(async (resolve, reject) => {
            try {
                this.materialsizeRepo.create(material);
                resolve(200);
            } catch (err) {
                reject(err);
            }
        });
    }
}

module.exports = (materialsizeRepo) => {
    return new materialSizeUsecase(materialsizeRepo);
};
