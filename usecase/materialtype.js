
class MaterialTypeUsecase {
    constructor(materialtypeRepo) {
        this.materialtypeRepo = materialtypeRepo;
    }

    get() {
        return new Promise(async (resolve, reject) => {
            try {
                const data = await this.materialtypeRepo.get();
                resolve(data);
            } catch (err) {
                reject(err);
            }
        });
    }
    getType() {
      return new Promise(async (resolve, reject) => {
          try {
              const data = await this.materialtypeRepo.getType();
              resolve(data);
          } catch (err) {
              reject(err);
          }
      });
  }
  getSize() {
    return new Promise(async (resolve, reject) => {
        try {
            const data = await this.materialtypeRepo.getSize();
            resolve(data);
        } catch (err) {
            reject(err);
        }
    });
  }
    updateStatus(file) {
      return new Promise(async (resolve, reject) => {
        try {
          await this.materialtypeRepo.updateStatus(file);
          resolve(200);
        } catch (err) {
          reject(err);
        }
      });
    }
    updateMaterialDetails(material) {
        return new Promise(async (resolve, reject) => {
          try {
            const material_id = material.material_id;
            const { code } = await this.materialtypeRepo.updateMaterialDetails(material.material_details, material_id);  
            resolve(code);
          } catch (err) {
            reject(err);
          }
        });
      }
    getMaterialById(material_id) {
        return new Promise(async (resolve, reject) => {
          try {
            const data = await this.materialtypeRepo.getMaterialById(material_id);
            resolve(data);
          } catch (err) {
            console.log(err);
            reject(err);
          }
        });
      }
    create(material) {
        return new Promise(async (resolve, reject) => {
            try {
                this.materialtypeRepo.create(material);
                resolve(200);
            } catch (err) {
                reject(err);
            }
        });
    }
}

module.exports = (materialtypeRepo) => {
    return new MaterialTypeUsecase(materialtypeRepo);
};
