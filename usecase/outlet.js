
class OutletUsecase {
  constructor(outletRepo, budgetRepo) {
    this.outletRepo = outletRepo;
    this.budgetRepo = budgetRepo
  }

  get() {
    return new Promise(async (resolve, reject) => {
      try {
        const data = await this.outletRepo.get();
        resolve(data);
      } catch (err) {
        reject(err);
      }
    });
  }
  updateStatus(file) {
    return new Promise(async (resolve, reject) => {
      try {
        await this.outletRepo.updateStatus(file);
        resolve(200);
      } catch (err) {
        reject(err);
      }
    });
  }
  getOutletById(outlet_id) {
    return new Promise(async (resolve, reject) => {
      try {
        const data = await this.outletRepo.getOutletById(outlet_id);
        resolve(data);
      } catch (err) {
        reject(err);
      }
    });
  }
  getOutletByOutletId(outlet_id) {
    return new Promise(async (resolve, reject) => {
      try {
        const data = await this.outletRepo.getOutletByOutletId(outlet_id);
        resolve(data);
      } catch (err) {
        reject(err);
      }
    });
  }
  updateOutletDetails(outlet) {
    return new Promise(async (resolve, reject) => {
      try {
        const outlet_id = outlet.outlet_id;
        const { code } = await this.outletRepo.updateOutletDetails(outlet.outlet_details, outlet_id);
        resolve(code);
      } catch (err) {
        reject(err);
      }
    });
  }
  create(outlet) {
    return new Promise(async (resolve, reject) => {
      try {
        const id  = await this.outletRepo.create(outlet.outlet_details);
        for (let i = 0; i <= outlet.budget.length - 1; i++) {
          this.budgetRepo.create({
            store_id: id.id,
            designation_name: Object.keys(outlet.budget[i])[0],
            budget: Object.values(outlet.budget[i])[0]
          });
        }
        resolve(200);
      } catch (err) {
        reject(err);
      }
    });
  }
}
module.exports = (outletRepo, budgetRepo) => {
  return new OutletUsecase(outletRepo, budgetRepo);
};
