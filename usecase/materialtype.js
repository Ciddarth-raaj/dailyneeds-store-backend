
class MaterialTypeUsecase {
    constructor(materialtypeRepo) {
        this.materialtypeRepo = materialtypeRepo;
    }

    get(offset, limit) {
        return new Promise(async (resolve, reject) => {
            try {
                const data = await this.materialtypeRepo.get(offset, limit);
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
  getTypeCount() {
    return new Promise(async (resolve, reject) => {
      try {
        const data = await this.materialtypeRepo.getTypeCount();
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
    updatePackMaterialTypeDetails(material) {
      return new Promise(async (resolve, reject) => {
        try {
          const type_id = material.type_id;
          const { code } = await this.materialtypeRepo.updatePackMaterialTypeDetails(material.material_type_details, type_id);
          resolve(code);
        } catch (err) {
          reject(err);
        }
      });
    }
    getMaterialById(type_id) {
        return new Promise(async (resolve, reject) => {
          try {
            const data = await this.materialtypeRepo.getMaterialById(type_id);
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
