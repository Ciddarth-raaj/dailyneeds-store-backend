
class MaterialUsecase {
    constructor(materialRepo) {
        this.materialRepo = materialRepo;
    }

    get() {
        return new Promise(async (resolve, reject) => {
            try {
                const data = await this.materialRepo.get();
                resolve(data);
            } catch (err) {
                reject(err);
            }
        });

    }
    updateStatus(file) {
      return new Promise(async (resolve, reject) => {
        try {
          await this.materialRepo.updateStatus(file);
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
            const { code } = await this.materialRepo.updateMaterialDetails(material.material_details, material_id);  
            resolve(code);
          } catch (err) {
            reject(err);
          }
        });
      }
    getMaterialById(material_id) {
        return new Promise(async (resolve, reject) => {
          try {
            const data = await this.materialRepo.getMaterialById(material_id);
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
                this.materialRepo.create(material);
                resolve(200);
            } catch (err) {
                reject(err);
            }
        });
    }
}

module.exports = (materialRepo) => {
    return new MaterialUsecase(materialRepo);
};
