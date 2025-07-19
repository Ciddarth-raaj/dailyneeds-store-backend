// usecase/material_request.js
const materialRequestRepo = require("../repository/material_request");

class MaterialRequestUsecase {
  constructor(materialRequestRepo) {
    this.materialRequestRepo = materialRequestRepo;
  }

  createMaterialRequest(data, items) {
    return new Promise(async (resolve, reject) => {
      try {
        const id = await this.materialRequestRepo.createMaterialRequest(
          data,
          items
        );
        resolve(id);
      } catch (err) {
        reject(err);
      }
    });
  }

  getMaterialRequestById(id) {
    return new Promise(async (resolve, reject) => {
      try {
        const data = await this.materialRequestRepo.getMaterialRequestById(id);
        resolve(data);
      } catch (err) {
        reject(err);
      }
    });
  }

  getAllMaterialRequests() {
    return new Promise(async (resolve, reject) => {
      try {
        const data = await this.materialRequestRepo.getAllMaterialRequests();
        resolve(data);
      } catch (err) {
        reject(err);
      }
    });
  }

  updateMaterialRequest(id, data, items) {
    return new Promise(async (resolve, reject) => {
      try {
        const resp = await this.materialRequestRepo.updateMaterialRequest(
          id,
          data,
          items
        );
        resolve(resp);
      } catch (err) {
        reject(err);
      }
    });
  }

  deleteMaterialRequest(id) {
    return new Promise(async (resolve, reject) => {
      try {
        const resp = await this.materialRequestRepo.deleteMaterialRequest(id);
        resolve(resp);
      } catch (err) {
        reject(err);
      }
    });
  }
}

module.exports = (materialRequestRepo) => {
  return new MaterialRequestUsecase(materialRequestRepo);
};
