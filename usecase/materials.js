class MaterialsUsecase {
  constructor(materialsRepo) {
    this.materialsRepo = materialsRepo;
  }

  // --- materials_latest ---
  getMaterials(offset, limit) {
    return new Promise(async (resolve, reject) => {
      try {
        const data = await this.materialsRepo.getMaterials(offset, limit);
        resolve(data);
      } catch (err) {
        reject(err);
      }
    });
  }

  getMaterialById(material_id) {
    return new Promise(async (resolve, reject) => {
      try {
        const data = await this.materialsRepo.getMaterialById(material_id);
        resolve(data);
      } catch (err) {
        reject(err);
      }
    });
  }

  createMaterial(material) {
    return new Promise(async (resolve, reject) => {
      try {
        const resp = await this.materialsRepo.createMaterial(material);
        resolve(resp);
      } catch (err) {
        reject(err);
      }
    });
  }

  updateMaterial(material_id, material) {
    return new Promise(async (resolve, reject) => {
      try {
        const resp = await this.materialsRepo.updateMaterial(
          material_id,
          material
        );
        resolve(resp);
      } catch (err) {
        reject(err);
      }
    });
  }

  deleteMaterial(material_id) {
    return new Promise(async (resolve, reject) => {
      try {
        const resp = await this.materialsRepo.deleteMaterial(material_id);
        resolve(resp);
      } catch (err) {
        reject(err);
      }
    });
  }

  // --- materials_category ---
  getCategories(offset, limit) {
    return new Promise(async (resolve, reject) => {
      try {
        const data = await this.materialsRepo.getCategories(offset, limit);
        resolve(data);
      } catch (err) {
        reject(err);
      }
    });
  }

  getCategoryById(material_category_id) {
    return new Promise(async (resolve, reject) => {
      try {
        const data = await this.materialsRepo.getCategoryById(
          material_category_id
        );
        resolve(data);
      } catch (err) {
        reject(err);
      }
    });
  }

  createCategory(category) {
    return new Promise(async (resolve, reject) => {
      try {
        const resp = await this.materialsRepo.createCategory(category);
        resolve(resp);
      } catch (err) {
        reject(err);
      }
    });
  }

  updateCategory(material_category_id, category) {
    return new Promise(async (resolve, reject) => {
      try {
        const resp = await this.materialsRepo.updateCategory(
          material_category_id,
          category
        );
        resolve(resp);
      } catch (err) {
        reject(err);
      }
    });
  }

  deleteCategory(material_category_id) {
    return new Promise(async (resolve, reject) => {
      try {
        const resp = await this.materialsRepo.deleteCategory(
          material_category_id
        );
        resolve(resp);
      } catch (err) {
        reject(err);
      }
    });
  }
}

module.exports = (materialsRepo) => {
  return new MaterialsUsecase(materialsRepo);
};
