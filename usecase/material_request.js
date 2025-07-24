class MaterialRequestUsecase {
  constructor(materialRequestRepo, outletRepo) {
    this.materialRequestRepo = materialRequestRepo;
    this.outletRepo = outletRepo;
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
        if (!data) return resolve(undefined);
        let outlet = null;
        try {
          const outletData = await this.outletRepo.getOutletByOutletId(
            data.outlet_id
          );
          outlet = outletData && outletData.length > 0 ? outletData[0] : null;
        } catch (outletErr) {
          // Optionally log error
        }
        resolve({ ...data, outlet });
      } catch (err) {
        reject(err);
      }
    });
  }

  getAllMaterialRequests() {
    return new Promise(async (resolve, reject) => {
      try {
        const data = await this.materialRequestRepo.getAllMaterialRequests();
        const results = [];
        for (const req of data) {
          let outlet = null;
          try {
            const outletData = await this.outletRepo.getOutletByOutletId(
              req.outlet_id
            );
            outlet = outletData && outletData.length > 0 ? outletData[0] : null;
          } catch (outletErr) {
            // Optionally log error
          }
          results.push({ ...req, outlet });
        }
        resolve(results);
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

module.exports = (materialRequestRepo, outletRepo) => {
  return new MaterialRequestUsecase(materialRequestRepo, outletRepo);
};
