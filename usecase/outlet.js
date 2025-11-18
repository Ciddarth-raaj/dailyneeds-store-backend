class OutletUsecase {
  constructor(outletRepo, budgetRepo) {
    this.outletRepo = outletRepo;
    this.budgetRepo = budgetRepo;
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
        const budget = await this.budgetRepo.getBudgetByStoreId(outlet_id);

        if (data.length > 0) {
          data[0].budget = budget;
        }

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
        const res = await this.outletRepo.updateOutletDetails(
          outlet.outlet_details,
          outlet_id
        );

        if (outlet.budget) {
          await Promise.all(
            outlet.budget
              .filter(
                (item) =>
                  item.count !== undefined && item.designation_id !== undefined
              )
              .map(async (budget) => {
                if (budget.budget_id) {
                  await this.budgetRepo.update({
                    budget: budget.count,
                    budget_id: budget.budget_id,
                    designation_id: budget.designation_id,
                  });
                } else {
                  await this.budgetRepo.create({
                    store_id: outlet_id,
                    designation_name: budget.designation,
                    designation_id: budget.designation_id,
                    budget: budget.count,
                  });
                }
              })
          );
        }

        resolve(res);
      } catch (err) {
        reject(err);
      }
    });
  }
  create(outlet) {
    return new Promise(async (resolve, reject) => {
      try {
        const id = await this.outletRepo.create(outlet.outlet_details);

        if (outlet.budget) {
          await Promise.all(
            outlet.budget.map(async (budget) => {
              await this.budgetRepo.create({
                store_id: id.id,
                designation_name: budget.designation,
                designation_id: budget.designation_id,
                budget: budget.count,
              });
            })
          );
        }
        resolve({ code: 200, msg: "Outlet created successfully" });
      } catch (err) {
        reject(err);
      }
    });
  }

  bulkCreate(rows) {
    return new Promise(async (resolve, reject) => {
      try {
        const response = await this.outletRepo.bulkCreate(rows);
        const branches = await this.get();
        resolve({
          code: 200,
          message: "Branches bulk insert completed successfully",
          branches: branches,
        });
      } catch (err) {
        reject(err);
      }
    });
  }
}
module.exports = (outletRepo, budgetRepo) => {
  return new OutletUsecase(outletRepo, budgetRepo);
};
