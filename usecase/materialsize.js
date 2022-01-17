
class materialSizeUsecase {
    constructor(materialsizeRepo) {
        this.materialsizeRepo = materialsizeRepo;
    }

    get(offset, limit) {
        return new Promise(async (resolve, reject) => {
            try {
                const data = await this.materialsizeRepo.get(offset, limit);
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
    getMaterialById(size_id) {
        return new Promise(async (resolve, reject) => {
          try {
            const data = await this.materialsizeRepo.getMaterialById(size_id);
            resolve(data);
          } catch (err) {
            console.log(err);
            reject(err);
          }
        });
      }
    updateMaterialDetails(material) {
        return new Promise(async (resolve, reject) => {
          try {
            const size_id = material.size_id;
            const { code } = await this.materialsizeRepo.updateMaterialDetails(material.material_details, size_id);
            resolve(code);
          } catch (err) {
            reject(err);
          }
        });
      }
    getSizeCount() {
        return new Promise(async (resolve, reject) => {
          try {
            const data = await this.materialsizeRepo.getSizeCount();
            resolve(data);
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
